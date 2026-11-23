import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';

export type EconomyPatch = { coinsPerUSD?: number; coinsPerINR?: number; giftReceiverPercent?: number };
export type PackageInput = {
  name: string; currency: 'USD' | 'INR'; price: number; coins?: number; bonusCoins: number; enabled: boolean; order: number;
};
export type PackagePatch = Partial<PackageInput>;

const economyRef = () => db.doc('app_settings/economy');

/** One line in the audit log (the admin panel uses the same fields: actorUid, action, collection, targetId, at). */
function auditRef() {
  return db.collection('admin_logs').doc();
}

/**
 * Super admin changes the money -> coins rate (and the receiver percent of gifts).
 * Old recharge records keep the rate they were made with, so only FUTURE recharges use the new rate.
 * Every change is saved in economy_history (before / after) and in admin_logs.
 */
export async function updateEconomy(actor: AuthedUser, patch: EconomyPatch): Promise<Record<string, unknown>> {
  return db.runTransaction(async (t) => {
    const snap = await t.get(economyRef());
    const before = snap.data() ?? {};
    const after: Record<string, unknown> = {};
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      after[k] = v;
      if (before[k] !== v) changed[k] = { from: before[k] ?? null, to: v };
    }
    if (Object.keys(changed).length === 0) return { ...before, unchanged: true };

    t.set(economyRef(), { ...after, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: true });
    t.create(db.collection('economy_history').doc(), {
      actorUid: actor.uid, actorName: actor.name, changed, at: FieldValue.serverTimestamp(),
    });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'update_economy', collection: 'app_settings', targetId: 'economy',
      details: changed, at: FieldValue.serverTimestamp(),
    });
    return { ...before, ...after };
  });
}

/** coins = price x rate (rounded down). Used when the admin leaves "coins" empty. */
function coinsFromRate(currency: 'USD' | 'INR', price: number, economy: FirebaseFirestore.DocumentData | undefined): number {
  const rate = Number(currency === 'USD' ? economy?.coinsPerUSD : economy?.coinsPerINR);
  if (!Number.isFinite(rate) || rate <= 0) throw new AppError(409, 'rate-missing', `Set the ${currency} rate in Economy settings first.`);
  const coins = Math.floor(Number((price * rate).toFixed(6)));
  if (coins < 1) throw new AppError(400, 'coins-too-low', 'With this rate the package would give less than 1 coin.');
  return coins;
}

export async function createPackage(actor: AuthedUser, input: PackageInput): Promise<{ id: string }> {
  const ref = db.collection('recharge_packages').doc();
  await db.runTransaction(async (t) => {
    const eco = input.coins === undefined ? (await t.get(economyRef())).data() : undefined;
    const coins = input.coins ?? coinsFromRate(input.currency, input.price, eco);
    t.create(ref, {
      name: input.name, currency: input.currency, price: input.price, coins, bonusCoins: input.bonusCoins,
      enabled: input.enabled, order: input.order, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'create_coin_package', collection: 'recharge_packages', targetId: ref.id,
      details: { name: input.name, currency: input.currency, price: input.price, coins, bonusCoins: input.bonusCoins }, at: FieldValue.serverTimestamp(),
    });
  });
  return { id: ref.id };
}

/** Packages are never deleted (old payment records point to them): the admin only turns them off. */
export async function updatePackage(actor: AuthedUser, id: string, patch: PackagePatch): Promise<void> {
  const ref = db.doc(`recharge_packages/${id}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new AppError(404, 'not-found', 'This package does not exist.');
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
    t.update(ref, { ...clean, updatedAt: FieldValue.serverTimestamp() });
    t.create(auditRef(), {
      actorUid: actor.uid, actorName: actor.name, action: 'update_coin_package', collection: 'recharge_packages', targetId: id,
      details: clean, at: FieldValue.serverTimestamp(),
    });
  });
}
