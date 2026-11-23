// Writes the lucky gift settings (only when they do not exist yet) and shows the average return:   npm run lucky:seed
// To change the odds later, edit the document app_settings/lucky_gift in Firestore (tiers: multiplier + weight).
import 'dotenv/config';
import { db } from '../src/config/firebase';
import { DEFAULT_LUCKY_TIERS, normalizeTiers, returnToPlayer } from '../src/config/luckyGift';

async function main() {
  const ref = db.doc('app_settings/lucky_gift');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ enabled: true, countForRoomLevel: false, tiers: DEFAULT_LUCKY_TIERS });
    console.log('Created app_settings/lucky_gift with the default table.');
  }
  const tiers = normalizeTiers((await ref.get()).data()?.tiers);
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  console.log('Lucky gift table (a 10 coin gift):');
  for (const t of tiers) console.log(`  x${t.multiplier}  ->  ${10 * t.multiplier} coins back  ${((t.weight / total) * 100).toFixed(2)}% of the time`);
  console.log(`Average return: ${(returnToPlayer(tiers) * 100).toFixed(1)}% of the spent coins come back (the rest stays with the app).`);
  process.exit(0);
}
main();
