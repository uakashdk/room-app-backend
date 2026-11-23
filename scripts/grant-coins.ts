// Gives test coins to a user (until the Razorpay recharge is built). Only someone with the service account key can run it.
//   npm run grant:coins -- <6-digit User ID or uid> <amount> [note]
//   example: npm run grant:coins -- 482915 1000 "test coins"
// Every grant is written to wallet_transactions and admin_logs, so it is never a silent change.
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../src/config/firebase';

async function main() {
  const [target, amountText, ...noteParts] = process.argv.slice(2);
  const amount = Number(amountText);
  const note = noteParts.join(' ').slice(0, 100) || 'manual grant';
  if (!target || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000) {
    throw new Error('Usage: npm run grant:coins -- <6-digit User ID or uid> <amount 1..1000000> [note]');
  }

  let uid = target;
  if (/^[0-9]{6}$/.test(target)) {
    const id = await db.doc(`userIds/${target}`).get();
    if (!id.exists) throw new Error(`No user has the User ID ${target}.`);
    uid = String(id.data()?.uid);
  }

  const userRef = db.doc(`users/${uid}`);
  const balance = await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw new Error('User not found.');
    const after = Number(snap.data()?.coins ?? 0) + amount;
    const id = `grant_${Date.now()}_${uid.slice(0, 6)}`;
    t.update(userRef, { coins: after });
    t.create(db.doc(`wallet_transactions/${id}`), {
      uid, type: 'admin_grant', currency: 'coins', amount, balanceAfter: after, note, createdBy: 'script', createdAt: FieldValue.serverTimestamp(),
    });
    t.create(db.doc(`admin_logs/${id}`), {
      actorUid: 'script', action: 'grant_coins', targetUid: uid, amount, note, createdAt: FieldValue.serverTimestamp(),
    });
    return after;
  });
  console.log(`Done. ${amount} coins given to ${uid}. New balance: ${balance}.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
