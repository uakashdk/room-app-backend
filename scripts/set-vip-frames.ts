// Puts the ornate frame pictures (scripts/vip-frames/*.webp) on the VIP levels, so a VIP member is drawn with them.
//   npm run vipframes:set
// The levels are sorted by tier; the lowest level gets silver, then rose gold, then gold, and every higher level royal.
// It only changes `frameImage` of each level, so it is safe to run again. You can still replace a picture later in the admin panel.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/config/firebase';

const FILES = ['silver', 'rosegold', 'gold', 'royal'];
const dataUrl = (name: string) => `data:image/webp;base64,${readFileSync(join(__dirname, 'vip-frames', `${name}.webp`)).toString('base64')}`;

async function main() {
  const snap = await db.collection('vip_levels').get();
  const levels = snap.docs.map((d) => ({ ref: d.ref, name: String(d.data().name ?? d.id), tier: Number(d.data().tier ?? 0) })).sort((a, b) => a.tier - b.tier);
  if (levels.length === 0) {
    console.log('There are no VIP levels yet. Add them in the admin panel (VIP page) first.');
    return;
  }
  for (const [i, l] of levels.entries()) {
    const file = FILES[Math.min(i, FILES.length - 1)];
    await l.ref.update({ frameImage: dataUrl(file) });
    console.log(`${l.name} (tier ${l.tier}) -> ${file}`);
  }
  console.log('Done.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
