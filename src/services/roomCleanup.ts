import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';

// A real room whose host has sent no heartbeat for this long is dead (the host's phone crashed, lost the network or was switched off).
// The app already hides such a room after 3 minutes; here the server also closes it, so the admin panel does not show "Live: Yes" for a ghost room.
const STALE_MS = 10 * 60 * 1000;
const EVERY_MS = 2 * 60 * 1000;

export async function closeDeadRooms(now = Date.now()): Promise<number> {
  const snap = await db.collection('rooms').where('isLive', '==', true).get();
  const dead = snap.docs.filter((d) => {
    const x = d.data();
    const last: number | undefined = x.lastActiveAt?.toMillis?.();
    // sample rooms made in the admin panel have no host and no heartbeat: they are left alone
    return !!x.hostUid && !!last && now - last > STALE_MS;
  });
  for (let i = 0; i < dead.length; i += 400) {
    const batch = db.batch();
    for (const d of dead.slice(i, i + 400)) {
      batch.update(d.ref, { isLive: false, listeners: 0, closedBy: 'server', closedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
  return dead.length;
}

export function startRoomCleanup(): void {
  const run = () =>
    closeDeadRooms()
      .then((n) => n > 0 && console.log(`Closed ${n} dead room(s).`))
      .catch((e) => console.error('Room cleanup failed:', e?.message ?? e));
  run();
  setInterval(run, EVERY_MS).unref();
}
