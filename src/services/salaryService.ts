import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import {
  DEFAULT_WITHDRAWAL, SALARY_POLICY_DOC, SALARY_STATE_DOC, WITHDRAWAL_DOC,
  levelFor, normalizePolicy, normalizeWithdrawal, planOf, type SalaryLevel, type SalaryPeriod, type SalaryPolicy, type WithdrawalSettings,
} from '../config/salary';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { monthKey, periodEndsAt, periodKey } from './periods';
import { weekKey } from './roomLevels';

/**
 * Host salary, week by week.
 *
 *  - Gifts a person receives add diamonds to host_weeks/<week>_<uid> and host_months/<month>_<uid> (giftService, in the same transaction as the gift).
 *  - Every 5 minutes the server notes which owners are live in their room (the same two documents: live minutes and active days).
 *  - Every agency has a PERIOD, weekly or monthly, and its own targets (agencies/<id>.plan, set by the Super admin in Agencies -> Targets).
 *    An agency without its own plan uses the default host policy (app_settings/host_policy).
 *  - When a period ends (Monday for weekly, the 1st for monthly, India time) the server makes ONE salary record per host:
 *    salary_records/<period>_<hostUid>, status "pending" (or approved at once when the plan has autoCredit).
 *    The level is the highest target the host reached before the deadline. The agency commission is NOT a second salary: it is taken
 *    from the host's withdrawal and sent to the agency owner's PayPal (withdrawalService).
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

/** The plan an agency works with (its own or the default), and whether it is its own. */
export async function getAgencyPlan(agencyId: string): Promise<{ plan: SalaryPolicy; custom: boolean; commissionPercent: number; paypalEmail: string | null; agencyName: string }> {
  const [agency, fallback] = await Promise.all([db.doc(`agencies/${agencyId}`).get(), getPolicy()]);
  if (!agency.exists) throw new AppError(404, 'not-found', 'This agency does not exist.');
  const a = agency.data()!;
  return { ...planOf(a, fallback), commissionPercent: Number(a.commissionPercent ?? 0), paypalEmail: a.paypalEmail ? String(a.paypalEmail) : null, agencyName: String(a.name ?? 'Agency') };
}

/** Super admin: set the targets of one agency (input = null puts the agency back on the default policy). */
export async function saveAgencyPlan(actor: AuthedUser, agencyId: string, input: SalaryPolicy | null): Promise<SalaryPolicy | null> {
  const ref = db.doc(`agencies/${agencyId}`);
  if (!(await ref.get()).exists) throw new AppError(404, 'not-found', 'This agency does not exist.');
  const clean = input ? normalizePolicy(input) : null;
  await ref.update({ plan: clean ?? FieldValue.delete(), planUpdatedAt: FieldValue.serverTimestamp() });
  await logRef().create({
    actorUid: actor.uid, actorName: actor.name, action: clean ? 'set_agency_plan' : 'reset_agency_plan', collection: 'agencies', targetId: agencyId,
    details: clean ? { period: clean.period, levels: clean.levels.length, autoCredit: clean.autoCredit, minActiveDays: clean.minActiveDays, minLiveMinutes: clean.minLiveMinutes } : {}, at: FieldValue.serverTimestamp(),
  });
  return clean;
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
  const mk = monthKey();
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
    await db.doc(`host_months/${mk}_${hostUid}`).set(
      { uid: hostUid, month: mk, liveMinutes: FieldValue.increment(SAMPLE_MINUTES), days: FieldValue.arrayUnion(day), updatedAt: FieldValue.serverTimestamp() },
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
    // older records (before the commission moved to the withdrawal) still show their agency salary
    ...asOwner.docs.filter((d) => d.data().hostUid !== uid && Number(d.data().agentSalaryCents) > 0).map((d) => rowOf(d.id + '#agency', d.data(), 'agency')),
  ];
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 80);
}

/** The numbers of one host for the running period: diamonds, active days, live minutes. */
async function periodStats(period: SalaryPeriod, uid: string) {
  const key = periodKey(period);
  const snap = await db.doc(`${period === 'monthly' ? 'host_months' : 'host_weeks'}/${key}_${uid}`).get();
  const x = snap.data();
  return { key, diamonds: Number(x?.diamonds ?? 0), activeDays: Array.isArray(x?.days) ? x!.days.length : 0, liveMinutes: Math.round(Number(x?.liveMinutes ?? 0)) };
}

export async function getHostCenter(uid: string) {
  const [userSnap, globalPolicy, settings] = await Promise.all([db.doc(`users/${uid}`).get(), getPolicy(), getWithdrawalSettings()]);
  const u = userSnap.data();
  if (!u) throw new AppError(404, 'user-not-found', 'This account does not exist.');
  const agencySnap = u.agencyId ? await db.doc(`agencies/${u.agencyId}`).get() : null;
  const agency = agencySnap?.exists ? agencySnap.data() : undefined;
  const { plan } = planOf(agency, globalPolicy); // the targets of MY agency (or the default ones)
  const isOwner = agency?.ownerUid === uid;
  const commissionPercent = Number(agency?.commissionPercent ?? 0);

  const st = await periodStats(plan.period, uid);
  const level = levelFor(st.diamonds, plan.levels);
  const next = plan.levels.find((l) => l.targetDiamonds > st.diamonds) ?? null;
  const [mine, asOwner] = await Promise.all([
    db.collection('salary_records').where('hostUid', '==', uid).limit(100).get(),
    db.collection('salary_records').where('agencyOwnerUid', '==', uid).limit(300).get(),
  ]);
  const pendingCents =
    mine.docs.filter((d) => d.data().status === 'pending').reduce((s, d) => s + Number(d.data().hostSalaryCents ?? 0), 0) +
    asOwner.docs.filter((d) => d.data().status === 'pending' && d.data().hostUid !== uid).reduce((s, d) => s + Number(d.data().agentSalaryCents ?? 0), 0);

  const last = mine.docs.map((d) => ({ id: d.id, ...d.data() }) as any).sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))[0];
  return {
    weekKey: st.key, // the running period (a week like 2026-W47, or a month like 2026-11)
    period: plan.period,
    isHost: isActiveHost(u),
    isAgencyOwner: isOwner,
    availableCents: Number(u.salaryAvailableCents ?? 0),
    pendingCents,
    withdrawnCents: Number(u.salaryWithdrawnCents ?? 0),
    earnedCents: Number(u.salaryEarnedCents ?? 0),
    lastWeek: last
      ? {
          week: String(last.week), level: Number(last.level ?? 0), diamonds: Number(last.diamonds ?? 0), salaryCents: Number(last.hostSalaryCents ?? 0), status: String(last.status),
          reason: last.reason ? String(last.reason) : null, commissionCents: isOwner ? 0 : Math.floor((Number(last.hostSalaryCents ?? 0) * Number(last.commissionPercent ?? commissionPercent)) / 100),
        }
      : null,
    week: {
      diamonds: st.diamonds,
      level: level?.level ?? 0,
      nextTarget: next?.targetDiamonds ?? null,
      nextLevel: next?.level ?? null,
      activeDays: st.activeDays,
      liveMinutes: st.liveMinutes,
      endsAt: periodEndsAt(plan.period), // the deadline of the targets
    },
    policy: {
      levels: plan.levels, period: plan.period, autoCredit: plan.autoCredit, minActiveDays: plan.minActiveDays, minLiveMinutes: plan.minLiveMinutes,
      agencyCommissionPercent: isOwner ? 0 : commissionPercent, // taken from the host's withdrawal, paid to the agency owner's PayPal
    },
    withdrawal: { enabled: settings.enabled, minCents: settings.minCents, maxCents: settings.maxCents, methods: settings.methods },
  };
}

/** The agency owner: every host of the agency with the period so far and what the owner would earn from it. */
export async function getAgencyEarnings(uid: string) {
  const me = (await db.doc(`users/${uid}`).get()).data();
  const agencyId = me?.agencyId ? String(me.agencyId) : '';
  const agency = agencyId ? (await db.doc(`agencies/${agencyId}`).get()).data() : null;
  if (!agency || agency.ownerUid !== uid) throw new AppError(403, 'not-agency-owner', 'Only an agency owner can see this.');
  const [globalPolicy, hosts] = await Promise.all([getPolicy(), db.collection('users').where('agencyId', '==', agencyId).where('hostStatus', '==', 'approved').limit(200).get()]);
  const { plan } = planOf(agency, globalPolicy);
  const key = periodKey(plan.period);
  const col = plan.period === 'monthly' ? 'host_months' : 'host_weeks';
  const pct = Number(agency.commissionPercent ?? 0);
  const periods = hosts.empty ? [] : await db.getAll(...hosts.docs.map((d) => db.doc(`${col}/${key}_${d.id}`)));
  const rows = hosts.docs
    .map((d, i) => ({ d, w: periods[i]?.data() }))
    .filter(({ d }) => d.id !== uid)
    .map(({ d, w }) => {
      const x = d.data();
      const diamonds = Number(w?.diamonds ?? 0);
      const level = levelFor(diamonds, plan.levels);
      return {
        uid: d.id, userId: String(x.userId ?? ''), name: String(x.name ?? 'Host'), photoURL: x.photoURL ?? null, diamonds,
        level: level?.level ?? 0, agentCents: level ? Math.floor((level.hostSalaryCents * pct) / 100) : 0,
        activeDays: Array.isArray(w?.days) ? w.days.length : 0, liveMinutes: Math.round(Number(w?.liveMinutes ?? 0)),
      };
    })
    .sort((a, b) => b.diamonds - a.diamonds);
  return {
    weekKey: key, period: plan.period, endsAt: periodEndsAt(plan.period), agencyName: String(agency.name ?? 'Agency'), hosts: rows,
    projectedCents: rows.reduce((s, r) => s + r.agentCents, 0), commissionPercent: pct, commissionPaidCents: Number(agency.commissionPaidCents ?? 0),
    paypalEmail: agency.paypalEmail ? String(agency.paypalEmail) : null,
  };
}

// ------------------------------------------------------------------ the run when a period ends
const SYSTEM: AuthedUser = { uid: 'system', role: 'system', name: 'System (auto credit)', photoURL: null };

/**
 * Makes the salary records of a finished period ('weekly' key like 2026-W47, 'monthly' key like 2026-11) for the agencies that work with that period.
 * Safe to run again: a record that exists is never touched.
 */
export async function generatePeriod(period: SalaryPeriod, key: string): Promise<{ created: number; notEligible: number; credited: number }> {
  const col = period === 'monthly' ? 'host_months' : 'host_weeks';
  const got = await db.collection(col).where(period === 'monthly' ? 'month' : 'week', '==', key).get();
  const fallback = await getPolicy();
  const agencies = new Map<string, FirebaseFirestore.DocumentData | undefined>();
  const autoIds: string[] = [];
  let created = 0;
  let notEligible = 0;
  for (const d of got.docs) {
    const w = d.data();
    const hostUid = String(w.uid ?? '');
    if (!hostUid) continue;
    const u = (await db.doc(`users/${hostUid}`).get()).data();
    if (!isActiveHost(u)) continue; // only approved hosts of an agency are paid
    const agencyId = String(u!.agencyId);
    if (!agencies.has(agencyId)) agencies.set(agencyId, (await db.doc(`agencies/${agencyId}`).get()).data());
    const agency = agencies.get(agencyId);
    const { plan } = planOf(agency, fallback);
    if (plan.period !== period) continue; // this agency is paid by the other period
    const diamonds = Number(w.diamonds ?? 0);
    const level: SalaryLevel | null = levelFor(diamonds, plan.levels);
    if (!level) continue;
    const activeDays = Array.isArray(w.days) ? w.days.length : 0;
    const liveMinutes = Math.round(Number(w.liveMinutes ?? 0));
    const reasons: string[] = [];
    if (activeDays < plan.minActiveDays) reasons.push(`Live on ${activeDays} days, needed ${plan.minActiveDays}`);
    if (liveMinutes < plan.minLiveMinutes) reasons.push(`Live ${liveMinutes} minutes, needed ${plan.minLiveMinutes}`);
    const eligible = reasons.length === 0;
    const ownerUid = agency?.ownerUid && agency.ownerUid !== hostUid ? String(agency.ownerUid) : null;
    const id = `${key}_${hostUid}`;
    try {
      await db.doc(`salary_records/${id}`).create({
        hostUid, hostName: String(u!.name ?? 'Host'), hostUserId: String(u!.userId ?? ''), agencyId, agencyName: String(agency?.name ?? ''),
        agencyOwnerUid: ownerUid, week: key, period, diamonds, level: level.level, targetDiamonds: level.targetDiamonds,
        hostSalaryCents: level.hostSalaryCents, agentSalaryCents: 0, commissionPercent: Number(agency?.commissionPercent ?? 0), // the agency share is taken at withdrawal
        activeDays, liveMinutes, status: eligible ? 'pending' : 'rejected', reason: eligible ? null : reasons.join('. '), decidedBy: eligible ? null : 'system',
        createdAt: FieldValue.serverTimestamp(), ...(eligible ? {} : { decidedAt: FieldValue.serverTimestamp() }),
      });
      if (eligible) {
        created++;
        if (plan.autoCredit) autoIds.push(id);
      } else notEligible++;
    } catch (e: any) {
      if (e?.code !== 6 && !String(e?.message).includes('ALREADY_EXISTS')) throw e; // 6 = already made earlier
    }
  }
  let credited = 0;
  for (let i = 0; i < autoIds.length; i += 300) credited += (await decideSalary(SYSTEM, autoIds.slice(i, i + 300), 'approve', null)).done;
  return { created, notEligible, credited };
}

/** Kept for the old admin button: a finished week. */
export const generateWeek = (week: string) => generatePeriod('weekly', week);

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
      id: r.id, week: r.week, period: r.period ?? 'weekly', hostUid: r.hostUid, hostName: r.hostName, hostUserId: r.hostUserId, agencyName: r.agencyName, diamonds: r.diamonds, level: r.level,
      hostSalaryCents: r.hostSalaryCents, agentSalaryCents: r.agentSalaryCents, activeDays: r.activeDays, liveMinutes: r.liveMinutes,
      status: r.status, reason: r.reason ?? null, createdAt: ms(r.createdAt), decidedAt: ms(r.decidedAt),
    }));
}

// ------------------------------------------------------------------ the job
async function checkPeriods(): Promise<void> {
  const state = db.doc(SALARY_STATE_DOC);
  const wk = weekKey();
  const mk = monthKey();
  const last = (await state.get()).data() ?? {};
  if (last.week && last.week !== wk) {
    const r = await generatePeriod('weekly', String(last.week));
    console.log(`Weekly salary records for ${last.week}: ${r.created} waiting for approval, ${r.credited} paid automatically, ${r.notEligible} not eligible.`);
  }
  if (last.month && last.month !== mk) {
    const r = await generatePeriod('monthly', String(last.month));
    console.log(`Monthly salary records for ${last.month}: ${r.created} waiting for approval, ${r.credited} paid automatically, ${r.notEligible} not eligible.`);
  }
  if (last.week !== wk || last.month !== mk) await state.set({ week: wk, month: mk, at: FieldValue.serverTimestamp() }); // only after the runs worked; the very first run only remembers
}

export function startSalaryJob(): void {
  const guard = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`${name} failed:`, e?.message ?? e));
  setInterval(guard('Live time sampling', sampleLiveTime), SAMPLE_EVERY_MS).unref();
  const periods = guard('Salary periods', checkPeriods);
  periods();
  setInterval(periods, CHECK_WEEK_EVERY_MS).unref();
}
