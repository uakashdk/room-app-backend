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

/** The agency commission of a withdrawal: taken from the amount and paid to the agency owner's PayPal. */
export type Split = { agencyId: string; agencyName: string; ownerUid: string; percent: number; agencyCents: number; hostCents: number; paypalEmail: string };

export type WithdrawalRow = {
  id: string; amountCents: number; method: WithdrawalMethod; label: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  paymentRef: string | null; reason: string | null; createdAt: number | null; decidedAt: number | null;
  split: { percent: number; agencyCents: number; hostCents: number; agencyName: string } | null; // the person sees only the amounts, never the owner's PayPal email
};

const rowOf = (id: string, w: FirebaseFirestore.DocumentData): WithdrawalRow => ({
  id, amountCents: Number(w.amountCents), method: w.method, label: String(w.label ?? ''), status: w.status,
  paymentRef: w.paymentRef ?? null, reason: w.reason ?? null, createdAt: ms(w.createdAt), decidedAt: ms(w.decidedAt),
  split: w.split ? { percent: Number(w.split.percent), agencyCents: Number(w.split.agencyCents), hostCents: Number(w.split.hostCents), agencyName: String(w.split.agencyName ?? '') } : null,
});

export async function listMyWithdrawals(uid: string): Promise<WithdrawalRow[]> {
  const snap = await db.collection('withdrawals').where('uid', '==', uid).limit(60).get();
  return snap.docs.map((d) => rowOf(d.id, d.data())).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 30);
}

export async function requestWithdrawal(user: AuthedUser, amountCents: number, details: WithdrawalDetails): Promise<{ id: string; availableCents: number; split: WithdrawalRow['split'] }> {
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
  const { available, split } = await db.runTransaction(async (t) => {
    const [u, lock] = await Promise.all([t.get(userRef), t.get(lockRef)]);
    const x = u.data();
    if (!u.exists || !x) throw new AppError(404, 'user-not-found', 'This account does not exist.');
    // the agency commission: a host who is not the owner pays the commission % of every withdrawal to the owner's PayPal; the rest is his
    let split: Split | null = null;
    if (x.hostStatus === 'approved' && x.agencyId && x.agencyRole !== 'owner') {
      const agencySnap = await t.get(db.doc(`agencies/${x.agencyId}`));
      const ag = agencySnap.data();
      const percent = Number(ag?.commissionPercent ?? 0);
      if (agencySnap.exists && ag && ag.ownerUid !== user.uid && percent > 0) {
        const agencyCents = Math.floor((amountCents * percent) / 100);
        if (agencyCents > 0) {
          const paypalEmail = String(ag.paypalEmail ?? '');
          if (!paypalEmail) throw new AppError(409, 'agency-paypal-missing', 'Your agency owner has not added a PayPal email yet, so the agency commission cannot be paid. Please ask the owner or support.');
          split = { agencyId: String(x.agencyId), agencyName: String(ag.name ?? 'Agency'), ownerUid: String(ag.ownerUid ?? ''), percent, agencyCents, hostCents: amountCents - agencyCents, paypalEmail };
        }
      }
    }
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
      details, status: 'pending', paymentRef: null, reason: null, createdAt: now, split,
    });
    t.create(db.doc(`wallet_transactions/${ref.id}_request`), {
      uid: user.uid, type: 'withdraw_request', currency: 'usd', amount: -amountCents, balanceAfter: after, refId: ref.id, note: labelOf(details), createdAt: now,
    });
    return { available: after, split };
  });
  return { id: ref.id, availableCents: available, split: split ? { percent: split.percent, agencyCents: split.agencyCents, hostCents: split.hostCents, agencyName: split.agencyName } : null };
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

export async function approveWithdrawal(actor: AuthedUser, id: string, paymentRef: string, agencyPaymentRef?: string): Promise<void> {
  await db.runTransaction(async (t) => {
    const ref = db.doc(`withdrawals/${id}`);
    const snap = await t.get(ref);
    const w = snap.data();
    if (!snap.exists || !w) throw new AppError(404, 'not-found', 'This withdrawal does not exist.');
    if (w.status !== 'pending') throw new AppError(409, 'already-done', 'This withdrawal is already finished.');
    const split = w.split as Split | null | undefined;
    if (split && (!agencyPaymentRef || agencyPaymentRef.trim().length < 3)) throw new AppError(400, 'agency-ref-needed', 'Write the PayPal payment reference of the agency commission too.');
    const now = FieldValue.serverTimestamp();
    t.update(db.doc(`users/${w.uid}`), { salaryWithdrawnCents: FieldValue.increment(Number(w.amountCents)) });
    t.update(ref, { status: 'approved', paymentRef, ...(split ? { agencyPaymentRef: agencyPaymentRef!.trim() } : {}), decidedBy: actor.uid, decidedAt: now });
    t.delete(db.doc(`withdrawal_locks/${w.uid}`));
    if (split) {
      // the commission is paid outside the app (PayPal), but it is recorded so the reports and the owner's dashboard can show it
      t.create(db.doc(`agency_commissions/${id}`), {
        withdrawalId: id, agencyId: split.agencyId, agencyName: split.agencyName, ownerUid: split.ownerUid, hostUid: w.uid, hostName: w.userName ?? '', percent: split.percent,
        amountCents: split.agencyCents, hostCents: split.hostCents, paypalEmail: split.paypalEmail, paymentRef: agencyPaymentRef!.trim(), paidBy: actor.uid, createdAt: now,
      });
      t.set(db.doc(`agencies/${split.agencyId}`), { commissionPaidCents: FieldValue.increment(split.agencyCents) }, { merge: true });
    }
    t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'approve_withdrawal', collection: 'withdrawals', targetId: id, details: { paymentRef, agencyPaymentRef: agencyPaymentRef ?? null, amountCents: w.amountCents, uid: w.uid, split: split ? { percent: split.percent, agencyCents: split.agencyCents } : null }, at: now });
  });
}

/** Admin list, with the payment details (needed to pay the person). */
export async function listWithdrawalsAdmin(status: string) {
  const snap = await db.collection('withdrawals').where('status', '==', status).limit(300).get();
  return snap.docs
    .map((d) => ({
      ...rowOf(d.id, d.data()), uid: d.data().uid, userName: d.data().userName, userId: d.data().userId, details: d.data().details,
      agencyPayout: d.data().split ? { agencyName: d.data().split.agencyName, percent: d.data().split.percent, agencyCents: d.data().split.agencyCents, hostCents: d.data().split.hostCents, paypalEmail: d.data().split.paypalEmail, paymentRef: d.data().agencyPaymentRef ?? null } : null,
    }))
    .sort((a, b) => (a.status === 'pending' ? (a.createdAt ?? 0) - (b.createdAt ?? 0) : (b.decidedAt ?? 0) - (a.decidedAt ?? 0)));
}
