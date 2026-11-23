import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import {
  DEFAULT_WITHDRAWAL, SALARY_POLICY_DOC, SALARY_STATE_DOC, WITHDRAWAL_DOC,
  levelFor, normalizePolicy, normalizeWithdrawal, type SalaryLevel, type SalaryPolicy, type WithdrawalSettings,
} from '../config/salary';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { weekKey } from './roomLevels';

/**
 * Host salary, week by week.
 *
 *  - Gifts a person receives add diamonds to users.weekDiamonds (giftService; the counter belongs to users.salaryWeek and restarts by itself each week).
 *  - Every 5 minutes the server notes which owners are live in their room (host_weeks/<week>_<uid>: live minutes and active days).
 *  - Once a week (Monday, India time) the server makes ONE salary record per host:  salary_records/<week>_<hostUid>, status "pending".
 *    The level comes from the host policy (app_settings/host_policy), the money from that level: salary for the host, "agent salary" for the agency owner.
 *  - A Super admin approves (or rejects) the records. Approval puts the money in the available balance (users.salaryAvailableCents) and writes
 *    wallet_transactions. Nothing is paid before the admin approves, and an approved record can never be changed again.
 * All money is in cents. Only the server writes any of this; the app and the rules cannot.
 */

const SAMPLE_EVERY_MS = 5 * 60 * 1000;
const SAMPLE_MINUTES = SAMPLE_EVERY_MS / 60_000;
const CHECK_WEEK_EVERY_MS = 30 * 60 * 1000;
const logRef = () => db.collection('admin_logs').doc();
const ms = (t: any): number | null => t?.toMillis?.() ?? null;
const isActiveHost = (u: FirebaseFirestore.DocumentData | undefined) => u?.hostStatus === 'approved' && !!u?.agencyId;
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ settings
export async function getPolicy(): Promise<SalaryPolicy> {
  return normalizePolicy((await db.doc(SALARY_POLICY_DOC).get()).data());
}
export async function getWithdrawalSettings(): Promise<WithdrawalSettings> {
  return normalizeWithdrawal((await db.doc(WITHDRAWAL_DOC).get()).data() ?? DEFAULT_WITHDRAWAL);
}

export async function savePolicy(actor: AuthedUser, input: SalaryPolicy): Promise<SalaryPolicy> {
  const clean = normalizePolicy(input);
  await db.doc(SALARY_POLICY_DOC).set(clean);
  await logRef().create({ actorUid: actor.uid, actorName: actor.name, action: 'set_host_policy', collection: 'app_settings', targetId: 'host_policy', details: { levels: clean.levels.length, minActiveDays: clean.minActiveDays, minLiveMinutes: clean.minLiveMinutes }, at: FieldValue.serverTimestamp() });
  return clean;
}
export async function saveWithdrawalSettings(actor: AuthedUser, input: WithdrawalSettings): Promise<WithdrawalSettings> {
  const clean = normalizeWithdrawal(input);
  await db.doc(WITHDRAWAL_DOC).set(clean);
  await logRef().create({ actorUid: actor.uid, actorName: actor.name, action: 'set_withdrawal_rules', collection: 'app_settings', targetId: 'withdrawal', details: clean, at: FieldValue.serverTimestamp() });
  return clean;
}

// ------------------------------------------------------------------ live time (server side, every 5 minutes)
/** Every live room whose OWNER is inside it gets 5 more live minutes this week, and today counts as an active day. */
export async function sampleLiveTime(): Promise<number> {
  const live = await db.collection('rooms').where('isLive', '==', true).get();
  const wk = weekKey();
  const day = istDay();
  let n = 0;
  for (const room of live.docs) {
    const hostUid = String(room.data().hostUid ?? '');
    if (!hostUid) continue;
    if (!(await room.ref.collection('members').doc(hostUid).get()).exists) continue; // the owner is not inside right now
    await db.doc(`host_weeks/${wk}_${hostUid}`).set(
      { uid: hostUid, week: wk, liveMinutes: FieldValue.increment(SAMPLE_MINUTES), days: FieldValue.arrayUnion(day), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ what a host / agency owner sees
export type SalaryRow = {
  id: string; week: string; role: 'host' | 'agency'; hostName: string; diamonds: number; level: number;
  amountCents: number; status: string; reason: string | null; createdAt: number | null; decidedAt: number | null;
};

const rowOf = (id: string, r: FirebaseFirestore.DocumentData, role: 'host' | 'agency'): SalaryRow => ({
  id, week: String(r.week), role, hostName: String(r.hostName ?? 'Host'), diamonds: Number(r.diamonds ?? 0), level: Number(r.level ?? 0),
  amountCents: Number(role === 'host' ? r.hostSalaryCents : r.agentSalaryCents) || 0,
  status: String(r.status), reason: r.reason ? String(r.reason) : null, createdAt: ms(r.createdAt), decidedAt: ms(r.decidedAt),
});

export async function listMyRecords(uid: string): Promise<SalaryRow[]> {
  const [mine, asOwner] = await Promise.all([
    db.collection('salary_records').where('hostUid', '==', uid).limit(100).get(),
    db.collection('salary_records').where('agencyOwnerUid', '==', uid).limit(300).get(),
  ]);
  const rows = [
    ...mine.docs.map((d) => rowOf(d.id, d.data(), 'host')),
    ...asOwner.docs.filter((d) => d.data().hostUid !== uid && Number(d.data().agentSalaryCents) > 0).map((d) => rowOf(d.id + '#agency', d.data(), 'agency')),
  ];
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 80);
}

export async function getHostCenter(uid: string) {
  const [userSnap, policy, settings] = await Promise.all([db.doc(`users/${uid}`).get(), getPolicy(), getWithdrawalSettings()]);
  const u = userSnap.data();
  if (!u) throw new AppError(404, 'user-not-found', 'This account does not exist.');
  const wk = weekKey();
  const diamonds = u.salaryWeek === wk ? Number(u.weekDiamonds ?? 0) : 0;
  const level = levelFor(diamonds, policy.levels);
  const next = policy.levels.find((l) => l.targetDiamonds > diamonds) ?? null;
  const [weekDoc, mine, asOwner, agencySnap] = await Promise.all([
    db.doc(`host_weeks/${wk}_${uid}`).get(),
    db.collection('salary_records').where('hostUid', '==', uid).limit(100).get(),
    db.collection('salary_records').where('agencyOwnerUid', '==', uid).limit(300).get(),
    u.agencyId ? db.doc(`agencies/${u.agencyId}`).get() : Promise.resolve(null),
  ]);
  const pendingCents =
    mine.docs.filter((d) => d.data().status === 'pending').reduce((s, d) => s + Number(d.data().hostSalaryCents ?? 0), 0) +
    asOwner.docs.filter((d) => d.data().status === 'pending' && d.data().hostUid !== uid).reduce((s, d) => s + Number(d.data().agentSalaryCents ?? 0), 0);
  const w = weekDoc.data();
  return {
    weekKey: wk,
    isHost: isActiveHost(u),
    isAgencyOwner: agencySnap?.exists === true && agencySnap.data()?.ownerUid === uid,
    availableCents: Number(u.salaryAvailableCents ?? 0),
    pendingCents,
    withdrawnCents: Number(u.salaryWithdrawnCents ?? 0),
    earnedCents: Number(u.salaryEarnedCents ?? 0),
    week: {
      diamonds,
      level: level?.level ?? 0,
      nextTarget: next?.targetDiamonds ?? null,
      nextLevel: next?.level ?? null,
      activeDays: Array.isArray(w?.days) ? w!.days.length : 0,
      liveMinutes: Math.round(Number(w?.liveMinutes ?? 0)),
    },
    policy: { levels: policy.levels, minActiveDays: policy.minActiveDays, minLiveMinutes: policy.minLiveMinutes },
    withdrawal: { enabled: settings.enabled, minCents: settings.minCents, maxCents: settings.maxCents, methods: settings.methods },
  };
}

/** The agency owner: every host of the agency with the week so far and what the owner would earn from it. */
export async function getAgencyEarnings(uid: string) {
  const me = (await db.doc(`users/${uid}`).get()).data();
  const agencyId = me?.agencyId ? String(me.agencyId) : '';
  const agency = agencyId ? (await db.doc(`agencies/${agencyId}`).get()).data() : null;
  if (!agency || agency.ownerUid !== uid) throw new AppError(403, 'not-agency-owner', 'Only an agency owner can see this.');
  const [policy, hosts] = await Promise.all([getPolicy(), db.collection('users').where('agencyId', '==', agencyId).where('hostStatus', '==', 'approved').limit(200).get()]);
  const wk = weekKey();
  const weeks = hosts.empty ? [] : await db.getAll(...hosts.docs.map((d) => db.doc(`host_weeks/${wk}_${d.id}`)));
  const rows = hosts.docs
    .filter((d) => d.id !== uid)
    .map((d, i) => {
      const x = d.data();
      const diamonds = x.salaryWeek === wk ? Number(x.weekDiamonds ?? 0) : 0;
      const level = levelFor(diamonds, policy.levels);
      const w = weeks[hosts.docs.findIndex((h) => h.id === d.id)]?.data();
      return {
        uid: d.id, userId: String(x.userId ?? ''), name: String(x.name ?? 'Host'), photoURL: x.photoURL ?? null, diamonds,
        level: level?.level ?? 0, agentCents: level?.agentSalaryCents ?? 0, activeDays: Array.isArray(w?.days) ? w.days.length : 0, liveMinutes: Math.round(Number(w?.liveMinutes ?? 0)),
        order: i,
      };
    })
    .sort((a, b) => b.diamonds - a.diamonds);
  return { weekKey: wk, agencyName: String(agency.name ?? 'Agency'), hosts: rows, projectedCents: rows.reduce((s, r) => s + r.agentCents, 0) };
}

// ------------------------------------------------------------------ the weekly run
/** Makes the salary records of a finished week. Safe to run again: a record that exists is never touched. */
export async function generateWeek(week: string): Promise<{ created: number; notEligible: number }> {
  const policy = await getPolicy();
  const got = await db.collection('users').where('salaryWeek', '==', week).get();
  const agencies = new Map<string, FirebaseFirestore.DocumentData | undefined>();
  let created = 0;
  let notEligible = 0;
  for (const d of got.docs) {
    const u = d.data();
    if (!isActiveHost(u)) continue; // only approved hosts of an agency are paid
    const diamonds = Number(u.weekDiamonds ?? 0);
    const level: SalaryLevel | null = levelFor(diamonds, policy.levels);
    if (!level) continue;
    const agencyId = String(u.agencyId);
    if (!agencies.has(agencyId)) agencies.set(agencyId, (await db.doc(`agencies/${agencyId}`).get()).data());
    const agency = agencies.get(agencyId);
    const w = (await db.doc(`host_weeks/${week}_${d.id}`).get()).data();
    const activeDays = Array.isArray(w?.days) ? w!.days.length : 0;
    const liveMinutes = Math.round(Number(w?.liveMinutes ?? 0));
    const reasons: string[] = [];
    if (activeDays < policy.minActiveDays) reasons.push(`Live on ${activeDays} days, needed ${policy.minActiveDays}`);
    if (liveMinutes < policy.minLiveMinutes) reasons.push(`Live ${liveMinutes} minutes, needed ${policy.minLiveMinutes}`);
    const eligible = reasons.length === 0;
    const ownerUid = agency?.ownerUid && agency.ownerUid !== d.id ? String(agency.ownerUid) : null;
    try {
      await db.doc(`salary_records/${week}_${d.id}`).create({
        hostUid: d.id, hostName: String(u.name ?? 'Host'), hostUserId: String(u.userId ?? ''), agencyId, agencyName: String(agency?.name ?? ''),
        agencyOwnerUid: ownerUid, week, diamonds, level: level.level, targetDiamonds: level.targetDiamonds,
        hostSalaryCents: level.hostSalaryCents, agentSalaryCents: ownerUid ? level.agentSalaryCents : 0, activeDays, liveMinutes,
        status: eligible ? 'pending' : 'rejected', reason: eligible ? null : reasons.join('. '), decidedBy: eligible ? null : 'system',
        createdAt: FieldValue.serverTimestamp(), ...(eligible ? {} : { decidedAt: FieldValue.serverTimestamp() }),
      });
      if (eligible) created++; else notEligible++;
    } catch (e: any) {
      if (e?.code !== 6 && !String(e?.message).includes('ALREADY_EXISTS')) throw e; // 6 = already made earlier
    }
  }
  return { created, notEligible };
}

// ------------------------------------------------------------------ admin: approve / reject
export async function decideSalary(actor: AuthedUser, ids: string[], decision: 'approve' | 'reject', reason: string | null): Promise<{ done: number; skipped: number }> {
  let done = 0;
  let skipped = 0;
  for (const id of ids.slice(0, 300)) {
    const ok = await db.runTransaction(async (t) => {
      const ref = db.doc(`salary_records/${id}`);
      const snap = await t.get(ref);
      const r = snap.data();
      if (!snap.exists || !r || r.status !== 'pending') return false;
      const now = FieldValue.serverTimestamp();
      if (decision === 'reject') {
        t.update(ref, { status: 'rejected', reason: reason ?? null, decidedBy: actor.uid, decidedAt: now });
        t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'reject_salary', collection: 'salary_records', targetId: id, details: { reason }, at: now });
        return true;
      }
      const hostRef = db.doc(`users/${r.hostUid}`);
      const ownerRef = r.agencyOwnerUid && Number(r.agentSalaryCents) > 0 ? db.doc(`users/${r.agencyOwnerUid}`) : null;
      const [hostSnap, ownerSnap] = await Promise.all([t.get(hostRef), ownerRef ? t.get(ownerRef) : Promise.resolve(null)]);
      if (!hostSnap.exists) return false;
      const hostCents = Number(r.hostSalaryCents);
      const hostAfter = Number(hostSnap.data()?.salaryAvailableCents ?? 0) + hostCents;
      t.update(hostRef, { salaryAvailableCents: hostAfter, salaryEarnedCents: FieldValue.increment(hostCents) });
      t.create(db.doc(`wallet_transactions/${id}_host`), {
        uid: r.hostUid, type: 'salary', currency: 'usd', amount: hostCents, balanceAfter: hostAfter, refId: id, note: `Week ${r.week}, level ${r.level}`, createdAt: now,
      });
      if (ownerRef && ownerSnap?.exists) {
        const agentCents = Number(r.agentSalaryCents);
        const ownerAfter = Number(ownerSnap.data()?.salaryAvailableCents ?? 0) + agentCents;
        t.update(ownerRef, { salaryAvailableCents: ownerAfter, salaryEarnedCents: FieldValue.increment(agentCents) });
        t.create(db.doc(`wallet_transactions/${id}_agent`), {
          uid: r.agencyOwnerUid, type: 'agency_commission', currency: 'usd', amount: agentCents, balanceAfter: ownerAfter, refId: id, note: `${r.hostName}, week ${r.week}`, createdAt: now,
        });
      }
      t.update(ref, { status: 'approved', decidedBy: actor.uid, decidedAt: now });
      t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'approve_salary', collection: 'salary_records', targetId: id, details: { hostCents, agentCents: Number(r.agentSalaryCents) }, at: now });
      return true;
    });
    if (ok) done++; else skipped++;
  }
  return { done, skipped };
}

export async function listSalaryAdmin(filter: { week?: string; status?: string }) {
  const col = db.collection('salary_records');
  const snap = filter.week ? await col.where('week', '==', filter.week).limit(400).get() : await col.where('status', '==', filter.status || 'pending').limit(400).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as any)
    .filter((r) => !filter.status || r.status === filter.status)
    .sort((a, b) => Number(b.diamonds) - Number(a.diamonds))
    .map((r) => ({
      id: r.id, week: r.week, hostUid: r.hostUid, hostName: r.hostName, hostUserId: r.hostUserId, agencyName: r.agencyName, diamonds: r.diamonds, level: r.level,
      hostSalaryCents: r.hostSalaryCents, agentSalaryCents: r.agentSalaryCents, activeDays: r.activeDays, liveMinutes: r.liveMinutes,
      status: r.status, reason: r.reason ?? null, createdAt: ms(r.createdAt), decidedAt: ms(r.decidedAt),
    }));
}

// ------------------------------------------------------------------ the job
async function checkWeek(): Promise<void> {
  const state = db.doc(SALARY_STATE_DOC);
  const now = weekKey();
  const last = (await state.get()).data()?.week as string | undefined;
  if (last === now) return;
  if (last) {
    const r = await generateWeek(last);
    console.log(`Salary records for ${last}: ${r.created} waiting for approval, ${r.notEligible} not eligible.`);
  }
  await state.set({ week: now, at: FieldValue.serverTimestamp() }); // the very first run only remembers the week
}

export function startSalaryJob(): void {
  const guard = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`${name} failed:`, e?.message ?? e));
  setInterval(guard('Live time sampling', sampleLiveTime), SAMPLE_EVERY_MS).unref();
  const week = guard('Weekly salary', checkWeek);
  week();
  setInterval(week, CHECK_WEEK_EVERY_MS).unref();
}
