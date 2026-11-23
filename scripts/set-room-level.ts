// Sets the level of a room by hand (for tests, or to fix one room):   npm run room:level -- <roomId> <level>
import 'dotenv/config';
import { db } from '../src/config/firebase';
import { MAX_ROOM_LEVEL, partnerLimitForLevel, seatLimitForLevel } from '../src/config/roomLevels';

async function main() {
  const [roomId, raw] = process.argv.slice(2);
  const level = Number(raw);
  if (!roomId || !Number.isInteger(level) || level < 1 || level > MAX_ROOM_LEVEL) {
    console.error(`Use: npm run room:level -- <roomId> <level 1-${MAX_ROOM_LEVEL}>`);
    process.exit(1);
  }
  const ref = db.doc(`rooms/${roomId}`);
  if (!(await ref.get()).exists) {
    console.error('No room with this id.');
    process.exit(1);
  }
  await ref.update({ level });
  console.log(`Room ${roomId} is now level ${level}: up to ${seatLimitForLevel(level)} seats and ${partnerLimitForLevel(level)} partners.`);
  process.exit(0);
}
main();
