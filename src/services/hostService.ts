import { randomInt } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';

/**
 * Hosts and agencies.
 *  - Nobody becomes a host alone: a person APPLIES to an agency, and the owner of that agency approves.
 *  - A host always belongs to one agency (hostStatus 'approved' AND agencyId set).
 *  - A host can choose one partner (a host of the same agency) who runs the room when the host is not there.
 * Everything here is written by the server only; the app never edits hostStatus, agencyId or partnerUid.
 */

export const isActiveHost = (u: FirebaseFirestore.DocumentData | undefined): boolean => u?.hostStatus === 'approved' && !!u?.agencyId;
const ms = (t: any): number | null => t?.toMillis?.() ?? null;
const logRef = () => db.collection('admin_logs').doc();

type Actor = { uid: string; name: string };
const actorOf = (a: AuthedUser): Actor => ({ uid: a.uid, name: a.name });

// ------------------------------------------------------------------ small readers

/** The room of a host: rooms/<hostUid> (the new rule), or the newest older room made with a random id. */
async function roomIdOf(hostUid: string): Promise<string | null> {
  const direct = await db.doc(`rooms/${hostUid}`).get();
  // rooms/<uid> is only mine while I am still its owner (the owner can hand the room to a partner, the id stays)
  if (direct.exists && direct.data()?.hostUid === hostUid) return hostUid;
  const old = await db.collection('rooms').where('hostUid', '==', hostUid).limit(20).get();
  if (old.empty) return null;
  return [...old.docs].sort((a, b) => Number(b.data().isLive === true) - Number(a.data().isLive === true) || (ms(b.data().createdAt) ?? 0) - (ms(a.data().createdAt) ?? 0))[0].id;
}

/** The room of a host and whether it is live right now. */
async function roomStateOf(hostUid: string): Promise<{ roomId: string | null; roomLive: boolean }> {
  const rid = await roomIdOf(hostUid);
  if (!rid) return { roomId: null, roomLive: false };
  const snap = await db.doc(`rooms/${rid}`).get();
  return { roomId: rid, roomLive: snap.data()?.isLive === true };
}

const person = (id: string, x: FirebaseFirestore.DocumentData | undefined) => ({
  uid: id, userId: String(x?.userId ?? ''), name: String(x?.name ?? 'User'), photoURL: (x?.photoURL as string | null) ?? null,
});

// ------------------------------------------------------------------ status of the person (host screens)

export async function getHostStatus(uid: string) {
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'This user does not exist.');
  const u = userSnap.data()!;

  const [agencySnap, appSnap, partnerSnap, partnerOfSnap] = await Promise.all([
    u.agencyId ? db.doc(`agencies/${u.agencyId}`).get() : Promise.resolve(null),
    db.doc(`host_applications/${uid}`).get(),
    u.partnerUid ? db.doc(`users/${u.partnerUid}`).get() : Promise.resolve(null),
    db.collection('users').where('partnerUid', '==', uid).limit(1).get(),
  ]);

  const app = appSnap.exists ? appSnap.data()! : null;
  const hostOf = partnerOfSnap.docs[0];
  return {
    hostStatus: String(u.hostStatus ?? 'none'),
    isHost: isActiveHost(u),
    agency: agencySnap?.exists ? { id: agencySnap.id, name: String(agencySnap.data()?.name ?? 'Agency'), status: String(agencySnap.data()?.status ?? 'active') } : null,
    application: app ? { agencyId: String(app.agencyId), agencyName: String(app.agencyName ?? 'Agency'), status: String(app.status), reason: app.reason ? String(app.reason) : null, createdAt: ms(app.createdAt) } : null,
    partner: partnerSnap?.exists ? person(partnerSnap.id, partnerSnap.data()) : null,
    partners: partnerSnap?.exists ? [person(partnerSnap.id, partnerSnap.data())] : [],
    roomLevel: 1,
    maxPartners: 1,
    // I am the partner of this host (so I may run their room when they are away)
    partnerOf: hostOf ? { ...person(hostOf.id, hostOf.data()), ...(await roomStateOf(hostOf.id)), isHostActive: isActiveHost(hostOf.data()) } : null,
  };
}

// ------------------------------------------------------------------ agencies a person can apply to

export async function listAgencies(q: string) {
  const snap = await db.collection('agencies').limit(300).get();
  const needle = q.trim().toLowerCase();
  return snap.docs
    .filter((d) => d.data().status !== 'suspended')
    .filter((d) => !needle || d.id === needle || String(d.data().name ?? '').toLowerCase().includes(needle))
    .map((d) => ({ id: d.id, name: String(d.data().name ?? 'Agency'), ownerName: String(d.data().ownerName ?? '') }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
}

// ------------------------------------------------------------------ applying

/** Any user asks an agency to make them a host. One open request at a time. */
export async function applyToAgency(uid: string, agencyId: string): Promise<void> {
  const userRef = db.doc(`users/${uid}`);
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const appRef = db.doc(`host_applications/${uid}`);
  await db.runTransaction(async (t) => {
    const [userSnap, agencySnap, appSnap] = await Promise.all([t.get(userRef), t.get(agencyRef), t.get(appRef)]);
    const u = userSnap.data();
    if (!userSnap.exists || !u) throw new AppError(404, 'user-not-found', 'This user does not exist.');
    if (u.status && u.status !== 'active') throw new AppError(403, 'account-blocked', 'This account cannot apply right now.');
    if (isActiveHost(u)) throw new AppError(409, 'already-host', 'You are already a host.');
    if (!agencySnap.exists || agencySnap.data()?.status === 'suspended') throw new AppError(404, 'agency-not-found', 'This agency is not available.');
    if (u.agencyRole === 'owner' && u.agencyId !== agencyId) throw new AppError(409, 'owner-other-agency', 'You own an agency, so you can only apply to your own agency.');
    if (appSnap.data()?.status === 'pending') throw new AppError(409, 'already-pending', 'You already have a request waiting. Cancel it first to apply to another agency.');

    t.set(appRef, {
      uid, userId: String(u.userId ?? ''), name: String(u.name ?? 'User'), photoURL: u.photoURL ?? null, country: String(u.country ?? ''),
      level: Number(u.level ?? 1), followers: Number(u.followers ?? 0),
      agencyId, agencyName: String(agencySnap.data()?.name ?? 'Agency'), status: 'pending', reason: null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    t.update(userRef, { hostStatus: 'pending' });
  });
}

export async function cancelApplication(uid: string): Promise<void> {
  const userRef = db.doc(`users/${uid}`);
  const appRef = db.doc(`host_applications/${uid}`);
  await db.runTransaction(async (t) => {
    const [userSnap, appSnap] = await Promise.all([t.get(userRef), t.get(appRef)]);
    if (appSnap.data()?.status !== 'pending') throw new AppError(409, 'not-pending', 'You have no waiting request.');
    t.update(appRef, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
    if (userSnap.data()?.hostStatus === 'pending') t.update(userRef, { hostStatus: 'none' });
  });
}

// ------------------------------------------------------------------ the agency owner

async function ownerAgencyId(uid: string): Promise<string> {
  const snap = await db.doc(`users/${uid}`).get();
  const u = snap.data();
  if (!snap.exists || u?.agencyRole !== 'owner' || !u?.agencyId) throw new AppError(403, 'not-agency-owner', 'Only an agency owner can do this.');
  return String(u.agencyId);
}

export async function listApplications(owner: AuthedUser) {
  const agencyId = await ownerAgencyId(owner.uid);
  const snap = await db.collection('host_applications').where('agencyId', '==', agencyId).where('status', '==', 'pending').limit(100).get();
  return snap.docs
    .map((d) => {
      const x = d.data();
      return { uid: d.id, userId: String(x.userId ?? ''), name: String(x.name ?? 'User'), photoURL: x.photoURL ?? null, country: String(x.country ?? ''), level: Number(x.level ?? 1), followers: Number(x.followers ?? 0), createdAt: ms(x.createdAt) };
    })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/**
 * The agency owner (or, for an emergency, a Super admin) approves or rejects a request.
 * An owner can decide only the requests made to HIS agency.
 */
export async function decideApplication(actor: AuthedUser, targetUid: string, decision: 'approve' | 'reject', reason: string, asAdmin = false): Promise<void> {
  const myAgency = asAdmin ? null : await ownerAgencyId(actor.uid);
  const appRef = db.doc(`host_applications/${targetUid}`);
  const userRef = db.doc(`users/${targetUid}`);
  await db.runTransaction(async (t) => {
    const [appSnap, userSnap] = await Promise.all([t.get(appRef), t.get(userRef)]);
    const app = appSnap.data();
    if (!appSnap.exists || !app || app.status !== 'pending') throw new AppError(409, 'not-pending', 'This request is not waiting any more.');
    if (!asAdmin && app.agencyId !== myAgency) throw new AppError(403, 'not-your-agency', 'This request was made to another agency.');
    const agencySnap = await t.get(db.doc(`agencies/${app.agencyId}`));
    if (!agencySnap.exists) throw new AppError(404, 'agency-not-found', 'This agency does not exist.');
    if (agencySnap.data()?.status === 'suspended' && decision === 'approve') throw new AppError(409, 'agency-suspended', 'This agency is suspended.');
    const u = userSnap.data();
    if (!userSnap.exists || !u) throw new AppError(404, 'user-not-found', 'This user does not exist.');

    if (decision === 'approve') {
      if (u.status && u.status !== 'active') throw new AppError(403, 'account-blocked', 'This account cannot become a host.');
      t.update(userRef, {
        hostStatus: 'approved', agencyId: app.agencyId, agencyRole: u.agencyRole === 'owner' ? 'owner' : 'none', // 'none' like before: the app only checks for 'owner'
        hostApprovedAt: FieldValue.serverTimestamp(),
      });
    } else if (u.hostStatus === 'pending') {
      t.update(userRef, { hostStatus: 'rejected' });
    }
    t.update(appRef, { status: decision === 'approve' ? 'approved' : 'rejected', reason: reason || null, decidedBy: actor.uid, decidedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    t.create(logRef(), {
      actorUid: actor.uid, actorName: actor.name, action: decision === 'approve' ? 'approve_host' : 'reject_host', collection: 'users', targetId: targetUid,
      details: { agencyId: app.agencyId, reason, viaAdmin: asAdmin }, at: FieldValue.serverTimestamp(),
    });
  });
}

/** The owner takes a host out of his agency. Their room is closed and every partner link of theirs is removed. */
export async function removeHost(owner: AuthedUser, targetUid: string, reason: string): Promise<void> {
  const agencyId = await ownerAgencyId(owner.uid);
  if (targetUid === owner.uid) throw new AppError(400, 'cannot-remove-self', 'You cannot remove yourself.');
  const userRef = db.doc(`users/${targetUid}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    const u = snap.data();
    if (!snap.exists || !u || u.agencyId !== agencyId) throw new AppError(404, 'not-in-agency', 'This person is not in your agency.');
    if (u.agencyRole === 'owner') throw new AppError(403, 'cannot-remove-owner', 'The owner cannot be removed.');
    t.update(userRef, { hostStatus: 'none', agencyId: null, agencyRole: 'none', partnerUid: FieldValue.delete() });
    t.create(logRef(), { actorUid: owner.uid, actorName: owner.name, action: 'remove_host', collection: 'users', targetId: targetUid, details: { agencyId, reason }, at: FieldValue.serverTimestamp() });
  });
  // after the person is out: close the room, and cut the partner links on both sides (best effort, the removal itself is already saved)
  try {
    await unlinkPartner(targetUid);
    const asPartner = await db.collection('users').where('partnerUid', '==', targetUid).get();
    for (const d of asPartner.docs) await unlinkPartner(d.id);
    const rid = await roomIdOf(targetUid);
    if (rid) await db.doc(`rooms/${rid}`).update({ isLive: false, lastActiveAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error('Cleanup after removing a host failed:', e);
  }
}

// ------------------------------------------------------------------ the partner

/** Takes the partner away from this host: the link, the room field and the admin role inside the room. */
async function unlinkPartner(hostUid: string): Promise<void> {
  const hostRef = db.doc(`users/${hostUid}`);
  const host = await hostRef.get();
  const old = host.data()?.partnerUid as string | undefined;
  const rid = await roomIdOf(hostUid);
  const batch = db.batch();
  if (old) batch.update(hostRef, { partnerUid: FieldValue.delete() });
  if (rid) {
    batch.update(db.doc(`rooms/${rid}`), { partnerUid: FieldValue.delete() });
    if (old) batch.delete(db.doc(`rooms/${rid}/staff/${old}`));
  }
  await batch.commit();
}

/** Makes the room of the host show his partner: the field on the room and an admin role in it. Safe to repeat. */
async function syncPartnerToRoom(hostUid: string): Promise<void> {
  const host = (await db.doc(`users/${hostUid}`).get()).data();
  const rid = await roomIdOf(hostUid);
  if (!rid) return;
  const roomRef = db.doc(`rooms/${rid}`);
  if (!host?.partnerUid) {
    await roomRef.update({ partnerUid: FieldValue.delete() });
    return;
  }
  const partner = (await db.doc(`users/${host.partnerUid}`).get()).data();
  const batch = db.batch();
  batch.update(roomRef, { partnerUid: host.partnerUid });
  batch.set(db.doc(`rooms/${rid}/staff/${host.partnerUid}`), { role: 'admin', name: String(partner?.name ?? 'Partner'), photoURL: partner?.photoURL ?? null, source: 'partner' });
  await batch.commit();
}

/** The agency hosts a host can pick as partner (same agency, active, not already somebody's partner). */
export async function listPartnerCandidates(uid: string) {
  const me = (await db.doc(`users/${uid}`).get()).data();
  if (!isActiveHost(me)) throw new AppError(403, 'not-host', 'Only an approved host can choose a partner.');
  const snap = await db.collection('users').where('agencyId', '==', me!.agencyId).where('hostStatus', '==', 'approved').limit(100).get();
  const taken = new Map<string, string>();
  const links = await db.collection('users').where('agencyId', '==', me!.agencyId).limit(200).get();
  links.docs.forEach((d) => d.data().partnerUid && taken.set(String(d.data().partnerUid), d.id));
  return snap.docs
    .filter((d) => d.id !== uid && (!taken.has(d.id) || taken.get(d.id) === uid))
    .map((d) => person(d.id, d.data()));
}

/** A host chooses his partner, or takes the partner away (partnerUid = null). */
export async function setPartner(uid: string, partnerUid: string | null): Promise<void> {
  const me = (await db.doc(`users/${uid}`).get()).data();
  if (!isActiveHost(me)) throw new AppError(403, 'not-host', 'Only an approved host can choose a partner.');

  if (partnerUid === null) {
    await unlinkPartner(uid);
    return;
  }
  if (partnerUid === uid) throw new AppError(400, 'bad-partner', 'You cannot be your own partner.');
  const p = (await db.doc(`users/${partnerUid}`).get()).data();
  if (!isActiveHost(p) || p?.status === 'banned' || (p?.status && p.status !== 'active')) throw new AppError(409, 'partner-not-host', 'The partner must be an approved host.');
  if (p?.agencyId !== me!.agencyId) throw new AppError(409, 'partner-other-agency', 'The partner must be in your agency.');
  const busy = await db.collection('users').where('partnerUid', '==', partnerUid).limit(3).get();
  if (busy.docs.some((d) => d.id !== uid)) throw new AppError(409, 'partner-busy', 'This host is already the partner of someone else.');

  if (me!.partnerUid && me!.partnerUid !== partnerUid) await unlinkPartner(uid); // a change: the old partner loses the role first
  await db.doc(`users/${uid}`).update({ partnerUid });
  await syncPartnerToRoom(uid);
}

/**
 * The owner makes his partner the owner of the room. The room stays the same (id, level, gifts, picture, bans),
 * only the owner changes, and the old owner becomes the partner (admin) of the room.
 */
export async function transferRoom(owner: AuthedUser, partnerUid: string): Promise<{ roomId: string }> {
  const ownerRef = db.doc(`users/${owner.uid}`);
  const me = (await ownerRef.get()).data();
  if (!isActiveHost(me)) throw new AppError(403, 'not-host', 'Only an approved host can do this.');
  if (partnerUid === owner.uid || me!.partnerUid !== partnerUid) throw new AppError(409, 'not-your-partner', 'Choose this person as your room partner first.');
  const partnerRef = db.doc(`users/${partnerUid}`);
  const p = (await partnerRef.get()).data();
  if (!isActiveHost(p) || p?.agencyId !== me!.agencyId) throw new AppError(409, 'partner-not-host', 'The new owner must be an approved host of your agency.');
  const rid = await roomIdOf(owner.uid);
  if (!rid) throw new AppError(404, 'no-room', 'You have not made your room yet.');
  if (await roomIdOf(partnerUid)) throw new AppError(409, 'partner-has-room', 'This host already has a room of their own. One host can own only one room.');

  const roomRef = db.doc(`rooms/${rid}`);
  const batch = db.batch();
  batch.update(roomRef, {
    hostUid: partnerUid, hostName: String(p?.name ?? 'Host'), hostPhotoURL: p?.photoURL ?? null,
    partnerUid: owner.uid, ownerChangedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(db.doc(`rooms/${rid}/staff/${partnerUid}`)); // the owner is not in the staff list
  batch.set(db.doc(`rooms/${rid}/staff/${owner.uid}`), { role: 'admin', name: String(me?.name ?? 'Host'), photoURL: me?.photoURL ?? null, source: 'partner' });
  batch.update(ownerRef, { partnerUid: FieldValue.delete() }); // I am not the one with a partner any more...
  batch.update(partnerRef, { partnerUid: owner.uid }); // ...the new owner's partner is me
  batch.set(logRef(), { type: 'room_transfer', roomId: rid, fromUid: owner.uid, toUid: partnerUid, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { roomId: rid };
}

/**
 * Room actions for the host or his partner. The partner is not the owner of the room document, so the server does the writes for him.
 *   start = open the room (empty and live), close = end it, beat = "still live" with the people count, sync = show the partner in the room.
 */
export async function roomAction(caller: AuthedUser, hostUid: string, action: 'start' | 'close' | 'beat' | 'sync', listeners = 0): Promise<{ roomId: string }> {
  const host = (await db.doc(`users/${hostUid}`).get()).data();
  const isOwner = caller.uid === hostUid;
  if (!isOwner && host?.partnerUid !== caller.uid) throw new AppError(403, 'not-allowed', 'Only the host or his partner can do this.');
  if (!isActiveHost(host)) throw new AppError(403, 'not-host', 'This host is not active.');
  const rid = await roomIdOf(hostUid);
  if (!rid) throw new AppError(404, 'no-room', 'The host has not made his room yet.');

  await syncPartnerToRoom(hostUid);
  const roomRef = db.doc(`rooms/${rid}`);
  if (action === 'start') {
    // already live (the host or the partner opened it): nothing to start, and nobody is thrown out
    if ((await roomRef.get()).data()?.isLive === true) return { roomId: rid };
    await roomRef.update({ isLive: true, listeners: 0, lastActiveAt: FieldValue.serverTimestamp() });
    // a new live starts clean: nobody inside, no seats, no old requests and chat
    for (const name of ['members', 'seats', 'requests', 'invites', 'messages']) {
      const docs = await db.collection(`rooms/${rid}/${name}`).limit(300).get();
      if (docs.empty) continue;
      const b = db.batch();
      docs.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  } else if (action === 'close') {
    await roomRef.update({ isLive: false, lastActiveAt: FieldValue.serverTimestamp() });
  } else if (action === 'beat') {
    await roomRef.update({ lastActiveAt: FieldValue.serverTimestamp(), listeners: Math.max(0, Math.min(5000, Math.round(listeners))) });
  }
  return { roomId: rid };
}

// ------------------------------------------------------------------ admin: agencies (Super admin)

export async function createAgency(actor: AuthedUser, input: { name: string; ownerUserId: string; commissionPercent: number }): Promise<{ id: string }> {
  const found = await db.collection('users').where('userId', '==', input.ownerUserId).limit(1).get();
  if (found.empty) throw new AppError(404, 'user-not-found', 'No user has this User ID.');
  const ownerRef = found.docs[0].ref;

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = String(randomInt(100000, 1000000)); // the Agency ID people type when they apply
    const ref = db.doc(`agencies/${id}`);
    try {
      await db.runTransaction(async (t) => {
        const [taken, ownerSnap] = await Promise.all([t.get(ref), t.get(ownerRef)]);
        if (taken.exists) throw new AppError(409, 'id-taken', 'retry');
        const o = ownerSnap.data()!;
        if (o.status && o.status !== 'active') throw new AppError(409, 'owner-blocked', 'This user account is not active.');
        if (o.agencyId) throw new AppError(409, 'owner-in-agency', 'This user is already in an agency.');
        t.create(ref, {
          name: input.name, ownerUid: ownerRef.id, ownerName: String(o.name ?? 'Owner'), ownerUserId: input.ownerUserId, status: 'active',
          commissionPercent: input.commissionPercent, createdAt: FieldValue.serverTimestamp(), createdBy: actor.uid,
        });
        t.update(ownerRef, { agencyId: id, agencyRole: 'owner' });
        t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'create_agency', collection: 'agencies', targetId: id, details: { name: input.name, ownerUserId: input.ownerUserId }, at: FieldValue.serverTimestamp() });
      });
      return { id };
    } catch (e) {
      if (e instanceof AppError && e.code === 'id-taken') continue;
      throw e;
    }
  }
  throw new AppError(500, 'id-failed', 'Could not make a free Agency ID. Please try again.');
}

export async function updateAgency(actor: AuthedUser, id: string, patch: { name?: string; status?: 'active' | 'suspended'; commissionPercent?: number; paypalEmail?: string }): Promise<void> {
  const ref = db.doc(`agencies/${id}`);
  await db.runTransaction(async (t) => {
    if (!(await t.get(ref)).exists) throw new AppError(404, 'not-found', 'This agency does not exist.');
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    t.update(ref, { ...clean, updatedAt: FieldValue.serverTimestamp() });
    t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'update_agency', collection: 'agencies', targetId: id, details: clean, at: FieldValue.serverTimestamp() });
  });
}

export async function listAgenciesAdmin() {
  const snap = await db.collection('agencies').limit(200).get();
  const count = async (q: FirebaseFirestore.Query) => {
    try {
      return (await q.count().get()).data().count;
    } catch {
      return 0;
    }
  };
  return Promise.all(
    snap.docs.map(async (d) => {
      const x = d.data();
      const [hosts, pending] = await Promise.all([
        count(db.collection('users').where('agencyId', '==', d.id).where('hostStatus', '==', 'approved')),
        count(db.collection('host_applications').where('agencyId', '==', d.id).where('status', '==', 'pending')),
      ]);
      return {
        id: d.id, name: String(x.name ?? ''), ownerName: String(x.ownerName ?? ''), ownerUserId: String(x.ownerUserId ?? ''),
        status: String(x.status ?? 'active'), commissionPercent: Number(x.commissionPercent ?? 0), createdAt: ms(x.createdAt), hosts, pending,
        paypalEmail: x.paypalEmail ? String(x.paypalEmail) : '', ownerEmail: x.ownerEmail ? String(x.ownerEmail) : '', ownerPhone: x.ownerPhone ? String(x.ownerPhone) : '',
        logo: x.logo ? String(x.logo) : null, hasOwnPlan: !!x.plan, planPeriod: x.plan?.period === 'monthly' ? 'monthly' : x.plan ? 'weekly' : null,
        commissionPaidCents: Number(x.commissionPaidCents ?? 0),
      };
    }),
  );
}

export async function listApplicationsAdmin() {
  const snap = await db.collection('host_applications').where('status', '==', 'pending').limit(200).get();
  return snap.docs
    .map((d) => {
      const x = d.data();
      return { uid: d.id, userId: String(x.userId ?? ''), name: String(x.name ?? 'User'), agencyId: String(x.agencyId ?? ''), agencyName: String(x.agencyName ?? ''), createdAt: ms(x.createdAt) };
    })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}