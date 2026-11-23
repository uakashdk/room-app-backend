// Puts the starter avatar frames in the database (collection `frames`). Frames that already exist are NOT touched,
// so it is safe to run again after you changed a price in the Firebase console.
//   npm run frames:seed
// Every frame: priceCoins (50) and days (7) can be changed per frame. frameStyle: ring | double | glow. A picture frame
// can be added later by putting a `frameImage` (data:image/png;base64,...) in the document.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/config/firebase';

const dataUrl = (name: string) => `data:image/webp;base64,${readFileSync(join(__dirname, 'vip-frames', `${name}.webp`)).toString('base64')}`;

const FRAMES: { id: string; name: string; frameStyle: string; color: string; color2: string; image?: string }[] = [
  { id: 'gold_ring', name: 'Gold Ring', frameStyle: 'ring', color: '#F4C542', color2: '#FFE7A0' },
  { id: 'ocean_ring', name: 'Ocean Ring', frameStyle: 'ring', color: '#2F8CFF', color2: '#7FE3FF' },
  { id: 'rose_double', name: 'Rose Double', frameStyle: 'double', color: '#FF4F9A', color2: '#FFB3D6' },
  { id: 'emerald_double', name: 'Emerald Double', frameStyle: 'double', color: '#1DB97A', color2: '#8CF0C0' },
  { id: 'neon_glow', name: 'Neon Glow', frameStyle: 'glow', color: '#8A5CFF', color2: '#38E8FF' },
  { id: 'fire_glow', name: 'Fire Glow', frameStyle: 'glow', color: '#FF5A1F', color2: '#FFC93C' },
  // ornate picture frames (scripts/vip-frames)
  { id: 'silver_crown', name: 'Silver Crown', frameStyle: 'ring', color: '#A0AFC8', color2: '#F5FAFF', image: 'silver' },
  { id: 'rosegold_crown', name: 'Rose Gold Crown', frameStyle: 'ring', color: '#CD826E', color2: '#FFE1CD', image: 'rosegold' },
  { id: 'gold_crown', name: 'Gold Crown', frameStyle: 'ring', color: '#E6AA28', color2: '#FFF0AA', image: 'gold' },
  { id: 'royal_crown', name: 'Royal Crown', frameStyle: 'ring', color: '#825ADC', color2: '#E1CDFF', image: 'royal' },
];

async function main() {
  let added = 0;
  for (const [i, f] of FRAMES.entries()) {
    const ref = db.doc(`frames/${f.id}`);
    if ((await ref.get()).exists) continue;
    await ref.create({ name: f.name, frameStyle: f.frameStyle, color: f.color, color2: f.color2, ...(f.image ? { frameImage: dataUrl(f.image) } : {}), priceCoins: 50, days: 7, order: i + 1, enabled: true });
    added++;
  }
  console.log(`Done. ${added} frame(s) added, ${FRAMES.length - added} already existed.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
