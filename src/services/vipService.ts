import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The looks and privileges a level can have. The app draws them; the admin chooses them. */
export const FRAME_STYLES = ['none', 'ring', 'double', 'glow'] as const;
export const ENTRY_EFFECTS = ['none', 'glow', 'sparkle', 'royal', 'fire'] as const;
export const CHAT_EFFECTS = ['none', 'name_color', 'bubble'] as const;

export type VipLevelInput = {
  name: string; tier: number; priceCoins: number; days: number; color: string; color2: string; badgeText: string;
  frameStyle: (typeof FRAME_STYLES)[number]; entryEffect: (typeof ENTRY_EFFECTS)[number]; entryMessage: string;
  chatEffect: (typeof CHAT_EFFECTS)[number]; perks: string[]; order: number; enabled: boolean;
};
export type VipLevelPatch = Partial<Omit<VipLevelInput, 'tier'>>; // the tier never changes: members point to it

const auditRef = () => db.collection('admin_logs').doc();

export type VipResult = { balance: number; tier: number; levelName: string; expiresAt: number; duplicate: boolean };

/**
 * Buy (or extend / upgrade) a VIP level with coins. Everything happens in ONE transaction:
 *   - the coins go down (never below zero) and the VIP fields of the user are set (only this server can write them)
 *   - a vip_subscriptions record and a wallet_transactions record are written (nobody can edit them)
 * Same level while VIP is active  -> the days are added after the current expiry.
 * Higher level                    -> the new level starts now (the days left of the lower level are not carried over).
 * Lower level while VIP is active -> refused.
 * The same requestId is never charged twice (a retry after a bad connection returns the first result).
 */
export async function purchaseVip(user: AuthedUser, levelId: string, requestId: string): Promise<VipResult> {
  const userRef = db.doc(`users/${user.uid}`);
  const levelRef = db.doc(`vip_levels/${levelId}`);
  const subId = `${user.uid}_${requestId}`;
  const subRef = db.doc(`vip_subscriptions/${subId}`);

  return db.runTransaction(async (t) => {
    const [subSnap, userSnap, levelSnap] = await Promise.all([t.get(subRef), t.get(userRef), t.get(levelRef)]);

    if (subSnap.exists) {
      const s = subSnap.data()!;
      return { balance: Number(s.balanceAfter ?? 0), tier: Number(s.tier), levelName: String(s.levelName), expiresAt: s.expiresAt.toMillis(), duplicate: true };
    }
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'Your account was not found.');
    const level = levelSnap.data();
    const price = Number(level?.priceCoins);
    const days = Number(level?.days);
    const tier = Number(level?.tier);
    if (!levelSnap.exists || level?.enabled === false || !Number.isInteger(price) || price < 0 || !Number.isInteger(days) || days < 1 || !Number.isInteger(tier) || tier < 1) {
      throw new AppError(409, 'vip-not-available', 'This VIP level is not available right now.');
    }

    const u = userSnap.data()!;
    const coins = Number(u.coins ?? 0);
    if (coins < price) throw new AppError(402, 'insufficient-coins', 'You do not have enough coins for this VIP.');

    const now = Date.now();
    const curExp: number = u.vipExpiresAt?.toMillis?.() ?? 0;
    const active = u.vip === true && curExp > now;
    const curTier = Number(u.vipTier ?? 0);
    if (active && tier < curTier) throw new AppError(409, 'already-higher', 'You already have a higher VIP level.');

    const start = active && tier === curTier ? curExp : now;
    const expiresAt = start + days * DAY_MS;
    const balance = coins - price;
    const stamp = Timestamp.fromMillis(now);

    t.update(userRef, { coins: balance, vip: true, vipTier: tier, vipLevelId: levelId, vipExpiresAt: Timestamp.fromMillis(expiresAt) });
    t.create(subRef, {
      uid: user.uid, levelId, levelName: String(level?.name ?? 'VIP'), tier, priceCoins: price, days,
      startedAt: Timestamp.fromMillis(start), expiresAt: Timestamp.fromMillis(expiresAt), balanceAfter: balance, requestId, source: 'coins', createdAt: stamp,
    });
    t.create(db.doc(`wallet_transactions/${subId}_vip`), {
      uid: user.uid, type: 'vip_purchase', currency: 'coins', amount: -price, balanceAfter: balance,
      note: `${String(level?.name ?? 'VIP')} VIP, ${days} days`, refId: subId, createdAt: stamp,
    });
    return { balance, tier, levelName: String(level?.name ?? 'VIP'), expiresAt, duplicate: false };
  });
}

/**
 * Super admin creates a VIP level. The tier (1, 2, 3 ...) must be unique because a member's level is found by it.
 * Levels are never deleted (old subscriptions point to them): the admin only turns them off.
 */
export async function createVipLevel(actor: AuthedUser, input: VipLevelInput): Promise<{ id: string }> {
  const dup = await db.collection('vip_levels').where('tier', '==', input.tier).limit(1).get();
  if (!dup.empty) throw new AppError(409, 'tier-exists', `Tier ${input.tier} is already used by "${String(dup.docs[0].data().name)}".`);
  const ref = db.collection('vip_levels').doc();
  const batch = db.batch();
  batch.create(ref, { ...input, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  batch.create(auditRef(), {
    actorUid: actor.uid, actorName: actor.name, action: 'create_vip_level', collection: 'vip_levels', targetId: ref.id,
    details: { name: input.name, tier: input.tier, priceCoins: input.priceCoins, days: input.days }, at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { id: ref.id };
}

export async function updateVipLevel(actor: AuthedUser, id: string, patch: VipLevelPatch): Promise<void> {
  const ref = db.doc(`vip_levels/${id}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new AppError(404, 'not-found', 'This VIP level does not exist.');
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
    t.update(ref, { ...clean, updatedAt: FieldValue.serverTimestamp() });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'update_vip_level', collection: 'vip_levels', targetId: id, details: clean, at: FieldValue.serverTimestamp(),
    });
  });
}

/** Staff gives VIP for free (a gift, a reward, or fixing a problem). It is written as a normal subscription with price 0 and a note. */
export async function grantVip(actor: AuthedUser, targetUid: string, levelId: string, days: number, note: string): Promise<{ expiresAt: number }> {
  const userRef = db.doc(`users/${targetUid}`);
  const levelRef = db.doc(`vip_levels/${levelId}`);
  const subRef = db.collection('vip_subscriptions').doc();
  return db.runTransaction(async (t) => {
    const [userSnap, levelSnap] = await Promise.all([t.get(userRef), t.get(levelRef)]);
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'This user does not exist.');
    const level = levelSnap.data();
    const tier = Number(level?.tier);
    if (!levelSnap.exists || !level || !Number.isInteger(tier)) throw new AppError(404, 'level-not-found', 'This VIP level does not exist.');

    const u = userSnap.data()!;
    const now = Date.now();
    const curExp: number = u.vipExpiresAt?.toMillis?.() ?? 0;
    const active = u.vip === true && curExp > now;
    const start = active && tier === Number(u.vipTier ?? 0) ? curExp : now;
    const expiresAt = start + days * DAY_MS;
    const stamp = Timestamp.fromMillis(now);

    t.update(userRef, { vip: true, vipTier: tier, vipLevelId: levelId, vipExpiresAt: Timestamp.fromMillis(expiresAt) });
    t.create(subRef, {
      uid: targetUid, levelId, levelName: String(level.name ?? 'VIP'), tier, priceCoins: 0, days, source: 'admin', note, grantedBy: actor.uid,
      startedAt: Timestamp.fromMillis(start), expiresAt: Timestamp.fromMillis(expiresAt), createdAt: stamp,
    });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'grant_vip', collection: 'users', targetId: targetUid,
      details: { levelId, tier, days, note }, at: FieldValue.serverTimestamp(),
    });
    return { expiresAt };
  });
}

/** Staff ends someone's VIP right now. Coins are not touched (a refund, if any, is a separate wallet action). */
export async function revokeVip(actor: AuthedUser, targetUid: string, reason: string): Promise<void> {
  const userRef = db.doc(`users/${targetUid}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw new AppError(404, 'user-not-found', 'This user does not exist.');
    t.update(userRef, { vip: false, vipTier: 0, vipLevelId: FieldValue.delete(), vipExpiresAt: FieldValue.delete() });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'revoke_vip', collection: 'users', targetId: targetUid,
      details: { reason, hadTier: Number(snap.data()?.vipTier ?? 0) }, at: FieldValue.serverTimestamp(),
    });
  });
}

export type VipHistoryItem = {
  id: string; levelId: string; levelName: string; tier: number; priceCoins: number; days: number;
  startedAt: number | null; expiresAt: number | null; createdAt: number | null; source: 'coins' | 'admin'; note: string | null;
  uid?: string;
};
const toItem = (d: FirebaseFirestore.QueryDocumentSnapshot, withUid = false): VipHistoryItem => {
  const x = d.data();
  return {
    id: d.id, levelId: String(x.levelId ?? ''), levelName: String(x.levelName ?? 'VIP'), tier: Number(x.tier ?? 0), priceCoins: Number(x.priceCoins ?? 0),
    days: Number(x.days ?? 0), startedAt: x.startedAt?.toMillis?.() ?? null, expiresAt: x.expiresAt?.toMillis?.() ?? null,
    createdAt: x.createdAt?.toMillis?.() ?? null, source: x.source === 'admin' ? 'admin' : 'coins', note: x.note ? String(x.note) : null,
    ...(withUid ? { uid: String(x.uid ?? '') } : {}),
  };
};

/** My VIP purchases, newest first. Sorted here (not in the query), so no extra Firestore index is needed. */
export async function listMyVipHistory(uid: string): Promise<VipHistoryItem[]> {
  const snap = await db.collection('vip_subscriptions').where('uid', '==', uid).limit(100).get();
  return snap.docs.map((d) => toItem(d)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Staff: the latest VIP purchases of everybody (optionally one user), with the User ID and name added. */
export async function listAllVipSubscriptions(targetUid?: string): Promise<(VipHistoryItem & { userId: string; userName: string })[]> {
  const base = db.collection('vip_subscriptions');
  const snap = await (targetUid ? base.where('uid', '==', targetUid).limit(100) : base.orderBy('createdAt', 'desc').limit(100)).get();
  const items = snap.docs.map((d) => toItem(d, true)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const uids = [...new Set(items.map((i) => i.uid!).filter(Boolean))];
  const users = uids.length ? await db.getAll(...uids.map((u) => db.doc(`users/${u}`))) : [];
  const info = new Map(users.map((u) => [u.id, { userId: String(u.data()?.userId ?? ''), userName: String(u.data()?.name ?? 'User') }]));
  return items.map((i) => ({ ...i, userId: info.get(i.uid!)?.userId ?? '', userName: info.get(i.uid!)?.userName ?? 'User' }));
}

/** Staff: set which VIP tier a gift needs (0 = everybody). The gift server checks it on every send. */
export async function setGiftVipTier(actor: AuthedUser, giftId: string, minVipTier: number): Promise<void> {
  const ref = db.doc(`gifts/${giftId}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new AppError(404, 'not-found', 'This gift does not exist.');
    t.update(ref, { minVipTier });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'set_gift_vip_tier', collection: 'gifts', targetId: giftId,
      details: { from: Number(snap.data()?.minVipTier ?? 0), to: minVipTier }, at: FieldValue.serverTimestamp(),
    });
  });
}

/** The VIP tier that counts right now (0 when there is none or the time is over). */
export function activeVipTier(u: FirebaseFirestore.DocumentData | undefined, now = Date.now()): number {
  const exp: number = u?.vipExpiresAt?.toMillis?.() ?? 0;
  return u?.vip === true && exp > now ? Number(u?.vipTier ?? 0) : 0;
}
