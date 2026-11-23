import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { getWithdrawalSettings } from './salaryService';

/**
 * Withdrawals of the salary balance (users.salaryAvailableCents), in cents.
 *
 *  - A person asks for an amount and gives UPI / bank / PayPal details. The amount LEAVES the available balance at once (it is "held"),
 *    so the same money can never be asked for twice.
 *  - One request at a time (a lock document), the limits come from the admin (app_settings/withdrawal), and the account must be active.
 *  - A Super admin pays outside the app, then approves with the payment reference (UTR / transaction id), or rejects with a reason:
 *    a rejection (or the person cancelling while pending) gives the held money back.
 *  - Every step writes wallet_transactions and admin_logs. A finished request (approved / rejected / cancelled) never changes again.
 * The app never changes a balance: it only sends the request.
 */

export type WithdrawalMethod = 'upi' | 'bank' | 'paypal';
export type WithdrawalDetails =
  | { method: 'upi'; upiId: string }
  | { method: 'bank'; accountName: string; accountNumber: string; ifsc: string }
  | { method: 'paypal'; paypalEmail: string };

const logRef = () => db.collection('admin_logs').doc();
const ms = (t: any): number | null => t?.toMillis?.() ?? null;

/** What the person (and the admin) sees instead of the full number, e.g. "UPI ra***@okaxis" or "Bank ****1234". */
function labelOf(d: WithdrawalDetails): string {
  if (d.method === 'upi') return `UPI ${d.upiId.slice(0, 2)}***${d.upiId.slice(d.upiId.indexOf('@'))}`;
  if (d.method === 'bank') return `Bank ****${d.accountNumber.slice(-4)} (${d.ifsc})`;
  return `PayPal ${d.paypalEmail.slice(0, 2)}***${d.paypalEmail.slice(d.paypalEmail.indexOf('@'))}`;
}

export type WithdrawalRow = {
  id: string; amountCents: number; method: WithdrawalMethod; label: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  paymentRef: string | null; reason: string | null; createdAt: number | null; decidedAt: number | null;
};

const rowOf = (id: string, w: FirebaseFirestore.DocumentData): WithdrawalRow => ({
  id, amountCents: Number(w.amountCents), method: w.method, label: String(w.label ?? ''), status: w.status,
  paymentRef: w.paymentRef ?? null, reason: w.reason ?? null, createdAt: ms(w.createdAt), decidedAt: ms(w.decidedAt),
});

export async function listMyWithdrawals(uid: string): Promise<WithdrawalRow[]> {
  const snap = await db.collection('withdrawals').where('uid', '==', uid).limit(60).get();
  return snap.docs.map((d) => rowOf(d.id, d.data())).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 30);
}

export async function requestWithdrawal(user: AuthedUser, amountCents: number, details: WithdrawalDetails): Promise<{ id: string; availableCents: number }> {
  const settings = await getWithdrawalSettings();
  if (!settings.enabled) throw new AppError(409, 'withdrawals-off', 'Withdrawals are paused right now. Please try again later.');
  if (!settings.methods.includes(details.method)) throw new AppError(400, 'method-off', 'This payment method is not available.');
  if (!Number.isInteger(amountCents) || amountCents < settings.minCents) throw new AppError(400, 'amount-low', `The smallest withdrawal is $${(settings.minCents / 100).toFixed(2)}.`);
  if (amountCents > settings.maxCents) throw new AppError(400, 'amount-high', `The largest single withdrawal is $${(settings.maxCents / 100).toFixed(2)}.`);

  // the amount asked in the last 24 hours (fraud check)
  const recent = await db.collection('withdrawals').where('uid', '==', user.uid).limit(60).get();
  const dayAgo = Date.now() - 24 * 3600_000;
  const asked = recent.docs
    .filter((d) => !['rejected', 'cancelled'].includes(d.data().status) && (ms(d.data().createdAt) ?? 0) > dayAgo)
    .reduce((s, d) => s + Number(d.data().amountCents), 0);
  if (asked + amountCents > settings.dailyLimitCents) throw new AppError(429, 'daily-limit', 'You have reached the withdrawal limit for today. Please try again tomorrow.');

  const userRef = db.doc(`users/${user.uid}`);
  const lockRef = db.doc(`withdrawal_locks/${user.uid}`);
  const ref = db.collection('withdrawals').doc();
  const available = await db.runTransaction(async (t) => {
    const [u, lock] = await Promise.all([t.get(userRef), t.get(lockRef)]);
    const x = u.data();
    if (!u.exists || !x) throw new AppError(404, 'user-not-found', 'This account does not exist.');
    if (x.status && x.status !== 'active') throw new AppError(403, 'account-blocked', 'This account cannot withdraw.');
    if (lock.exists) throw new AppError(409, 'pending-exists', 'You already have a withdrawal waiting. Wait for it to finish or cancel it.');
    const balance = Number(x.salaryAvailableCents ?? 0);
    if (amountCents > balance) throw new AppError(409, 'insufficient-balance', 'You do not have enough balance.');
    const after = balance - amountCents;
    const now = FieldValue.serverTimestamp();
    t.update(userRef, { salaryAvailableCents: after });
    t.create(lockRef, { withdrawalId: ref.id, at: now });
    t.create(ref, {
      uid: user.uid, userName: user.name, userId: String(x.userId ?? ''), amountCents, method: details.method, label: labelOf(details),
      details, status: 'pending', paymentRef: null, reason: null, createdAt: now,
    });
    t.create(db.doc(`wallet_transactions/${ref.id}_request`), {
      uid: user.uid, type: 'withdraw_request', currency: 'usd', amount: -amountCents, balanceAfter: after, refId: ref.id, note: labelOf(details), createdAt: now,
    });
    return after;
  });
  return { id: ref.id, availableCents: available };
}

/** Gives the held money back. Used by "cancel" and by "reject". */
async function closeAndRefund(id: string, by: { uid: string; name: string; admin: boolean }, status: 'cancelled' | 'rejected', reason: string | null): Promise<void> {
  await db.runTransaction(async (t) => {
    const ref = db.doc(`withdrawals/${id}`);
    const snap = await t.get(ref);
    const w = snap.data();
    if (!snap.exists || !w) throw new AppError(404, 'not-found', 'This withdrawal does not exist.');
    if (!by.admin && w.uid !== by.uid) throw new AppError(403, 'forbidden', 'This withdrawal belongs to someone else.');
    if (w.status !== 'pending') throw new AppError(409, 'already-done', 'This withdrawal is already finished.');
    const userRef = db.doc(`users/${w.uid}`);
    const u = await t.get(userRef);
    const after = Number(u.data()?.salaryAvailableCents ?? 0) + Number(w.amountCents);
    const now = FieldValue.serverTimestamp();
    t.update(userRef, { salaryAvailableCents: after });
    t.update(ref, { status, reason, decidedBy: by.uid, decidedAt: now });
    t.delete(db.doc(`withdrawal_locks/${w.uid}`));
    t.create(db.doc(`wallet_transactions/${id}_refund`), {
      uid: w.uid, type: 'withdraw_refund', currency: 'usd', amount: Number(w.amountCents), balanceAfter: after, refId: id, note: status === 'rejected' ? 'Withdrawal rejected' : 'Withdrawal cancelled', createdAt: now,
    });
    if (by.admin) t.create(logRef(), { actorUid: by.uid, actorName: by.name, action: 'reject_withdrawal', collection: 'withdrawals', targetId: id, details: { reason, amountCents: w.amountCents, uid: w.uid }, at: now });
  });
}

export const cancelWithdrawal = (user: AuthedUser, id: string) => closeAndRefund(id, { uid: user.uid, name: user.name, admin: false }, 'cancelled', null);
export const rejectWithdrawal = (actor: AuthedUser, id: string, reason: string) => closeAndRefund(id, { uid: actor.uid, name: actor.name, admin: true }, 'rejected', reason);

export async function approveWithdrawal(actor: AuthedUser, id: string, paymentRef: string): Promise<void> {
  await db.runTransaction(async (t) => {
    const ref = db.doc(`withdrawals/${id}`);
    const snap = await t.get(ref);
    const w = snap.data();
    if (!snap.exists || !w) throw new AppError(404, 'not-found', 'This withdrawal does not exist.');
    if (w.status !== 'pending') throw new AppError(409, 'already-done', 'This withdrawal is already finished.');
    const now = FieldValue.serverTimestamp();
    t.update(db.doc(`users/${w.uid}`), { salaryWithdrawnCents: FieldValue.increment(Number(w.amountCents)) });
    t.update(ref, { status: 'approved', paymentRef, decidedBy: actor.uid, decidedAt: now });
    t.delete(db.doc(`withdrawal_locks/${w.uid}`));
    t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'approve_withdrawal', collection: 'withdrawals', targetId: id, details: { paymentRef, amountCents: w.amountCents, uid: w.uid }, at: now });
  });
}

/** Admin list, with the payment details (needed to pay the person). */
export async function listWithdrawalsAdmin(status: string) {
  const snap = await db.collection('withdrawals').where('status', '==', status).limit(300).get();
  return snap.docs
    .map((d) => ({ ...rowOf(d.id, d.data()), uid: d.data().uid, userName: d.data().userName, userId: d.data().userId, details: d.data().details }))
    .sort((a, b) => (a.status === 'pending' ? (a.createdAt ?? 0) - (b.createdAt ?? 0) : (b.decidedAt ?? 0) - (a.decidedAt ?? 0)));
}
