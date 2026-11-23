import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Used when a frame has no price / days of its own. Each frame can have its own values in frames/<id> { priceCoins, days }. */
export const DEFAULT_FRAME_PRICE = 50;
export const DEFAULT_FRAME_DAYS = 7;

export type FrameResult = { balance: number; frameId: string; frameName: string; expiresAt: number; duplicate: boolean };

/**
 * A person (VIP or not) rents an avatar frame for some days with coins.
 *   - the SERVER takes the coins and sets users.customFrameId / customFrameExpiresAt (the app can never write them: the rules refuse it)
 *   - the same frame while it is still active -> the days are added after the current end
 *   - another frame                            -> the new frame starts now (the days left of the old one are not carried over)
 *   - the same requestId is never charged twice (a retry after a bad connection returns the first result)
 * Every purchase is written to frame_purchases and to wallet_transactions.
 */
export async function buyFrame(user: AuthedUser, frameId: string, requestId: string): Promise<FrameResult> {
  const userRef = db.doc(`users/${user.uid}`);
  const frameRef = db.doc(`frames/${frameId}`);
  const buyId = `${user.uid}_${requestId}`;
  const buyRef = db.doc(`frame_purchases/${buyId}`);

  return db.runTransaction(async (t) => {
    const [buySnap, userSnap, frameSnap] = await Promise.all([t.get(buyRef), t.get(userRef), t.get(frameRef)]);

    if (buySnap.exists) {
      const b = buySnap.data()!;
      return { balance: Number(b.balanceAfter ?? 0), frameId: String(b.frameId), frameName: String(b.frameName), expiresAt: b.expiresAt.toMillis(), duplicate: true };
    }
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'Your account was not found.');
    const u = userSnap.data()!;
    if (u.status && u.status !== 'active') throw new AppError(403, 'account-blocked', 'Your account cannot buy frames.');

    const f = frameSnap.data();
    const price = Number(f?.priceCoins ?? DEFAULT_FRAME_PRICE);
    const days = Number(f?.days ?? DEFAULT_FRAME_DAYS);
    if (!frameSnap.exists || f?.enabled === false || !Number.isInteger(price) || price < 0 || price > 1_000_000 || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new AppError(409, 'frame-not-available', 'This frame is not available right now.');
    }

    const coins = Number(u.coins ?? 0);
    if (coins < price) throw new AppError(402, 'insufficient-coins', 'You do not have enough coins for this frame.');

    const now = Date.now();
    const curExp: number = u.customFrameExpiresAt?.toMillis?.() ?? 0;
    const active = !!u.customFrameId && curExp > now;
    const start = active && u.customFrameId === frameId ? curExp : now;
    const expiresAt = start + days * DAY_MS;
    const balance = coins - price;
    const stamp = Timestamp.fromMillis(now);
    const name = String(f?.name ?? 'Frame');

    t.update(userRef, { coins: balance, customFrameId: frameId, customFrameExpiresAt: Timestamp.fromMillis(expiresAt) });
    t.create(buyRef, {
      uid: user.uid, frameId, frameName: name, priceCoins: price, days,
      startedAt: Timestamp.fromMillis(start), expiresAt: Timestamp.fromMillis(expiresAt), balanceAfter: balance, requestId, createdAt: stamp,
    });
    t.create(db.doc(`wallet_transactions/${buyId}_frame`), {
      uid: user.uid, type: 'frame_purchase', currency: 'coins', amount: -price, balanceAfter: balance,
      note: `${name} frame, ${days} days`, refId: buyId, createdAt: stamp,
    });
    return { balance, frameId, frameName: name, expiresAt, duplicate: false };
  });
}
