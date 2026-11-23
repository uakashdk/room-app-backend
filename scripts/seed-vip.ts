// Creates the first VIP levels (only the ones that do not exist yet, so nothing you changed later is overwritten).
//   npx tsx scripts/seed-vip.ts
// The prices and days below are only a starting point. Change them in Firestore (vip_levels) or in the admin panel later.
import { db } from '../src/config/firebase';

const LEVELS = [
  {
    id: 'silver', name: 'Silver', tier: 1, priceCoins: 1000, days: 30, color: '#C0C7D1', color2: '#8E97A5', order: 1,
    badgeText: 'SILVER', frameStyle: 'ring', entryEffect: 'none', entryMessage: '', chatEffect: 'name_color',
    perks: ['Silver VIP badge', 'Silver name colour in room chat', 'Silver avatar frame'],
  },
  {
    id: 'gold', name: 'Gold', tier: 2, priceCoins: 2500, days: 30, color: '#F4C542', color2: '#B77713', order: 2,
    badgeText: 'GOLD', frameStyle: 'double', entryEffect: 'glow', entryMessage: 'entered the room', chatEffect: 'bubble',
    perks: ['Gold VIP badge', 'Gold avatar frame', 'Gold chat bubble', 'Room entry effect', 'Access to Gold VIP gifts'],
  },
  {
    id: 'platinum', name: 'Platinum', tier: 3, priceCoins: 5000, days: 30, color: '#B388FF', color2: '#6F3FD6', order: 3,
    badgeText: 'PLATINUM', frameStyle: 'glow', entryEffect: 'royal', entryMessage: 'has arrived', chatEffect: 'bubble',
    perks: ['Platinum VIP badge', 'Glowing avatar frame', 'Platinum chat bubble', 'Royal entry effect', 'Access to all VIP gifts'],
  },
];

// the fields that were added later: a level that already exists gets only these, if it does not have them yet
const LOOK_FIELDS = ['color2', 'badgeText', 'frameStyle', 'entryEffect', 'entryMessage', 'chatEffect'] as const;

async function main() {
  let added = 0;
  for (const { id, ...data } of LEVELS) {
    const ref = db.doc(`vip_levels/${id}`);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.create({ ...data, enabled: true });
      added++;
      console.log(`  ${id}: created (${data.priceCoins} coins, ${data.days} days)`);
      continue;
    }
    const have = snap.data() ?? {};
    const missing = Object.fromEntries(LOOK_FIELDS.filter((k) => have[k] === undefined).map((k) => [k, (data as Record<string, unknown>)[k]]));
    if (Object.keys(missing).length) {
      await ref.update(missing);
      console.log(`  ${id}: already there, added the missing look fields (${Object.keys(missing).join(', ')})`);
    } else {
      console.log(`  ${id}: already there, left as it is`);
    }
  }
  console.log(`Done. ${added} VIP level(s) added.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
