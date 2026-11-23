import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';

const EVERY_MS = 5 * 60 * 1000;

/** Turns VIP off for people whose time is over. (The app also checks the expiry date itself, so nobody keeps VIP in between.) */
export async function expireVips(now = Date.now()): Promise<number> {
  // only a range on ONE field, so no extra Firestore index is needed
  const snap = await db.collection('users').where('vipExpiresAt', '<', Timestamp.fromMillis(now)).limit(300).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const d of snap.docs) batch.update(d.ref, { vip: false, vipTier: 0, vipLevelId: FieldValue.delete(), vipExpiresAt: FieldValue.delete() });
  await batch.commit();
  return snap.size;
}

/** Ends the avatar frames (bought with coins) whose days are over. (The app also checks the date itself.) */
export async function expireFrames(now = Date.now()): Promise<number> {
  const snap = await db.collection('users').where('customFrameExpiresAt', '<', Timestamp.fromMillis(now)).limit(300).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const d of snap.docs) batch.update(d.ref, { customFrameId: FieldValue.delete(), customFrameExpiresAt: FieldValue.delete() });
  await batch.commit();
  return snap.size;
}

export function startVipExpiry(): void {
  const run = () =>
    Promise.all([expireVips(), expireFrames()]).then(([a, b]) => a + b)
      .then((n) => n > 0 && console.log(`VIP ended for ${n} user(s).`))
      .catch((e) => console.error('VIP expiry failed:', e?.message ?? e));
  run();
  setInterval(run, EVERY_MS).unref();
}
