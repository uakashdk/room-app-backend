// One-time job: fills giftSpent, coinsBought and diamondsEarned for gifts and payments that happened BEFORE the counters existed.
// New gifts and payments update the counters by themselves (giftService.ts / paypalService.ts), so run this only once:
//   npm run rankings:backfill
// It SETS the three numbers (it does not add), so running it twice gives the same result. Run it when the app is quiet.
import { db } from '../src/config/firebase';

async function main() {
  const spent = new Map<string, number>();
  const earned = new Map<string, number>();
  const bought = new Map<string, number>();
  const add = (m: Map<string, number>, k: unknown, n: unknown) => {
    const key = String(k ?? '');
    const v = Number(n ?? 0);
    if (key && Number.isFinite(v) && v !== 0) m.set(key, (m.get(key) ?? 0) + v);
  };

  let gifts = 0;
  for await (const d of db.collection('gift_transactions').select('senderUid', 'totalCoins', 'receiverUid', 'receiverDiamonds').stream() as any) {
    const x = d.data();
    add(spent, x.senderUid, x.totalCoins);
    add(earned, x.receiverUid, x.receiverDiamonds); // a lucky gift has 0 diamonds, so it adds nothing here
    gifts++;
  }

  let payments = 0;
  for await (const d of db.collection('recharge_transactions').where('status', '==', 'completed').select('uid', 'coins').stream() as any) {
    const x = d.data();
    add(bought, x.uid, x.coins);
    payments++;
  }

  const uids = new Set<string>([...spent.keys(), ...earned.keys(), ...bought.keys()]);
  const writer = db.bulkWriter();
  let users = 0;
  let missing = 0;
  for (const uid of uids) {
    writer
      .update(db.doc(`users/${uid}`), { giftSpent: spent.get(uid) ?? 0, diamondsEarned: earned.get(uid) ?? 0, coinsBought: bought.get(uid) ?? 0 })
      .then(() => { users++; })
      .catch(() => { missing++; }); // a user that was deleted
  }
  await writer.close();
  console.log(`Done. Read ${gifts} gifts and ${payments} payments. Updated ${users} users (${missing} not found).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
