// TEST ONLY: puts a fake person ("Test Receiver") into a room, so you can send a gift without a second phone.
//   add:     npx tsx scripts/test-receiver.ts <roomId>
//   remove:  npx tsx scripts/test-receiver.ts <roomId> remove
// The room id is in the app log:  [Room] opening <roomId>   (or the document id in Firestore -> rooms).
// The fake person is only a Firestore record (no login). Gifts sent to it are real records: coins are taken from you.
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../src/config/firebase';

const UID = 'testreceiver001';

async function main() {
  const [roomId, action] = process.argv.slice(2);
  if (!roomId || !/^[A-Za-z0-9]+$/.test(roomId)) throw new Error('Usage: npx tsx scripts/test-receiver.ts <roomId> [remove]');

  const room = await db.doc(`rooms/${roomId}`).get();
  if (!room.exists) throw new Error(`Room ${roomId} not found.`);
  const memberRef = db.doc(`rooms/${roomId}/members/${UID}`);

  if (action === 'remove') {
    await memberRef.delete();
    console.log('Done. Test Receiver left the room. (Its user record and wallet history are kept.)');
    return;
  }
  if (room.data()?.isLive !== true) throw new Error('This room is closed. Open a live room first.');

  const userRef = db.doc(`users/${UID}`);
  if (!(await userRef.get()).exists) {
    await userRef.create({
      userId: '000000', name: 'Test Receiver', photoURL: null, country: 'India', bio: 'Fake account for gift tests', level: 1,
      followers: 0, following: 0, coins: 0, diamonds: 0, vip: false, status: 'active', hostStatus: 'none', agencyId: null, agencyRole: 'none',
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await memberRef.set({ name: 'Test Receiver', photoURL: null, agoraUid: 999001, isHost: false, joinedAt: FieldValue.serverTimestamp() });
  console.log('Done. "Test Receiver" is now in the room. Open the gift sheet in the app and send it a gift.');
  console.log('Check the result in Firestore -> users -> testreceiver001 -> diamonds, and in the admin panel -> Transactions.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});