// Adds the starter gift catalog. Run once:  npm run seed:gifts
// A gift that already exists is NOT changed, so prices edited in the admin panel are safe.
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../src/config/firebase';

const GIFTS = [
  { id: 'rose', name: 'Rose', emoji: '🌹', category: 'popular', price: 10 },
  { id: 'heart', name: 'Heart', emoji: '❤️', category: 'love', price: 20 },
  { id: 'kiss', name: 'Kiss', emoji: '💋', category: 'love', price: 50 },
  { id: 'teddy', name: 'Teddy', emoji: '🧸', category: 'popular', price: 100 },
  { id: 'cake', name: 'Cake', emoji: '🎂', category: 'popular', price: 150 },
  { id: 'ring', name: 'Ring', emoji: '💍', category: 'love', price: 300 },
  { id: 'crown', name: 'Crown', emoji: '👑', category: 'luxury', price: 500 },
  { id: 'diamond', name: 'Diamond', emoji: '💎', category: 'luxury', price: 800 },
  { id: 'car', name: 'Sports Car', emoji: '🏎️', category: 'luxury', price: 1000 },
  { id: 'rocket', name: 'Rocket', emoji: '🚀', category: 'luxury', price: 2000 },
  { id: 'castle', name: 'Castle', emoji: '🏰', category: 'luxury', price: 5000 },
];

async function main() {
  let added = 0;
  for (const [i, g] of GIFTS.entries()) {
    const ref = db.doc(`gifts/${g.id}`);
    if ((await ref.get()).exists) continue;
    await ref.create({ name: g.name, emoji: g.emoji, imageUrl: null, category: g.category, price: g.price, enabled: true, order: i, createdAt: FieldValue.serverTimestamp() });
    added++;
  }
  const eco = db.doc('app_settings/economy');
  if (!(await eco.get()).exists) await eco.create({ giftReceiverPercent: 50, createdAt: FieldValue.serverTimestamp() }); // admin can change this later
  console.log(`Done. ${added} gift(s) added, ${GIFTS.length - added} already existed.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
