import { randomInt } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';

/**
 * "Create my own agency": any user fills a form (name, agency name, email, phone, PayPal email, a picture of the agency and a few documents).
 * The Super admin looks at it in the admin panel and approves or rejects it. Only when it is approved the agency exists:
 * the server makes it (with a free 6-digit Agency ID) and the applicant becomes its owner.
 *
 *   agency_applications/<uid>             the form (no pictures), status pending | approved | rejected | cancelled
 *   agency_application_files/<uid>_logo   the agency picture (a small JPEG as a data URL)
 *   agency_application_files/<uid>_doc0.. the documents (JPEG data URLs); only the server reads them, the Super admin sees them in the panel
 */

const ms = (t: any): number | null => t?.toMillis?.() ?? null;
const logRef = () => db.collection('admin_logs').doc();
const fileRef = (uid: string, name: string) => db.doc(`agency_application_files/${uid}_${name}`);

export type ApplicationInput = {
  ownerName: string; agencyName: string; email: string; phone: string; paypalEmail: string; logo: string; documents: string[];
};

export async function submitApplication(user: AuthedUser, input: ApplicationInput): Promise<void> {
  const userRef = db.doc(`users/${user.uid}`);
  const appRef = db.doc(`agency_applications/${user.uid}`);
  await db.runTransaction(async (t) => {
    const [u, app] = await Promise.all([t.get(userRef), t.get(appRef)]);
    const x = u.data();
    if (!u.exists || !x) throw new AppError(404, 'user-not-found', 'This account does not exist.');
    if (x.agencyId) throw new AppError(409, 'already-in-agency', x.agencyRole === 'owner' ? 'You already own an agency.' : 'You are already in an agency. A host cannot create an agency.');
    if (x.hostStatus === 'approved' || x.hostStatus === 'pending') throw new AppError(409, 'host-request-open', 'You have a host request or you are a host. Cancel the request first to create your own agency.');
    if (app.data()?.status === 'pending') throw new AppError(409, 'already-pending', 'Your agency request is already waiting for approval.');
    const now = FieldValue.serverTimestamp();
    t.set(appRef, {
      uid: user.uid, userId: String(x.userId ?? ''), userName: String(x.name ?? 'User'), photoURL: x.photoURL ?? null,
      ownerName: input.ownerName, agencyName: input.agencyName, email: input.email, phone: input.phone, paypalEmail: input.paypalEmail,
      documentCount: input.documents.length, status: 'pending', reason: null, agencyId: null, createdAt: now, updatedAt: now,
    });
    t.set(fileRef(user.uid, 'logo'), { data: input.logo, createdAt: now });
    for (let i = 0; i < 3; i++) {
      if (input.documents[i]) t.set(fileRef(user.uid, `doc${i}`), { data: input.documents[i], createdAt: now });
      else t.delete(fileRef(user.uid, `doc${i}`)); // an older request may have had more documents
    }
  });
}

export async function getMyApplication(uid: string) {
  const snap = await db.doc(`agency_applications/${uid}`).get();
  const x = snap.data();
  if (!snap.exists || !x) return null;
  return {
    status: String(x.status), agencyName: String(x.agencyName ?? ''), reason: x.reason ? String(x.reason) : null,
    agencyId: x.agencyId ? String(x.agencyId) : null, createdAt: ms(x.createdAt), decidedAt: ms(x.decidedAt),
  };
}

export async function cancelMyApplication(uid: string): Promise<void> {
  const ref = db.doc(`agency_applications/${uid}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.data()?.status !== 'pending') throw new AppError(409, 'not-pending', 'You have no waiting agency request.');
    t.update(ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
  });
}

// ------------------------------------------------------------------ Super admin

export async function listApplicationsForAdmin(status: string) {
  const snap = await db.collection('agency_applications').where('status', '==', status).limit(200).get();
  return snap.docs
    .map((d) => {
      const x = d.data();
      return {
        uid: d.id, userId: String(x.userId ?? ''), userName: String(x.userName ?? ''), ownerName: String(x.ownerName ?? ''), agencyName: String(x.agencyName ?? ''),
        email: String(x.email ?? ''), phone: String(x.phone ?? ''), paypalEmail: String(x.paypalEmail ?? ''), documentCount: Number(x.documentCount ?? 0),
        status: String(x.status), reason: x.reason ? String(x.reason) : null, agencyId: x.agencyId ? String(x.agencyId) : null, createdAt: ms(x.createdAt), decidedAt: ms(x.decidedAt),
      };
    })
    .sort((a, b) => (status === 'pending' ? (a.createdAt ?? 0) - (b.createdAt ?? 0) : (b.decidedAt ?? 0) - (a.decidedAt ?? 0)));
}

/** One request with its pictures (the logo and the documents), for the detail window of the admin panel. */
export async function getApplicationForAdmin(uid: string) {
  const [app, logo, d0, d1, d2] = await Promise.all([db.doc(`agency_applications/${uid}`).get(), fileRef(uid, 'logo').get(), fileRef(uid, 'doc0').get(), fileRef(uid, 'doc1').get(), fileRef(uid, 'doc2').get()]);
  if (!app.exists) throw new AppError(404, 'not-found', 'This request does not exist.');
  return { logo: logo.data()?.data ?? null, documents: [d0, d1, d2].filter((d) => d.exists).map((d) => String(d.data()?.data)) };
}

export async function decideApplicationForAdmin(actor: AuthedUser, uid: string, decision: 'approve' | 'reject', reason: string, commissionPercent: number): Promise<{ agencyId: string | null }> {
  const appRef = db.doc(`agency_applications/${uid}`);
  const userRef = db.doc(`users/${uid}`);

  if (decision === 'reject') {
    await db.runTransaction(async (t) => {
      const snap = await t.get(appRef);
      if (snap.data()?.status !== 'pending') throw new AppError(409, 'not-pending', 'This request is not waiting any more.');
      t.update(appRef, { status: 'rejected', reason: reason || null, decidedBy: actor.uid, decidedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'reject_agency_request', collection: 'agency_applications', targetId: uid, details: { reason }, at: FieldValue.serverTimestamp() });
    });
    return { agencyId: null };
  }

  const logo = (await fileRef(uid, 'logo').get()).data()?.data ?? null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = String(randomInt(100000, 1000000)); // the Agency ID people type when they want to join
    const agencyRef = db.doc(`agencies/${id}`);
    try {
      await db.runTransaction(async (t) => {
        const [app, u, taken] = await Promise.all([t.get(appRef), t.get(userRef), t.get(agencyRef)]);
        const a = app.data();
        const x = u.data();
        if (taken.exists) throw new AppError(409, 'id-taken', 'retry');
        if (!app.exists || !a || a.status !== 'pending') throw new AppError(409, 'not-pending', 'This request is not waiting any more.');
        if (!u.exists || !x) throw new AppError(404, 'user-not-found', 'The applicant account does not exist.');
        if (x.status && x.status !== 'active') throw new AppError(409, 'owner-blocked', 'The applicant account is not active.');
        if (x.agencyId) throw new AppError(409, 'owner-in-agency', 'The applicant is already in an agency.');
        const now = FieldValue.serverTimestamp();
        t.create(agencyRef, {
          name: a.agencyName, ownerUid: uid, ownerName: a.ownerName || String(x.name ?? 'Owner'), ownerUserId: String(x.userId ?? ''), ownerEmail: a.email, ownerPhone: a.phone,
          paypalEmail: a.paypalEmail, logo, status: 'active', commissionPercent, source: 'application', createdAt: now, createdBy: actor.uid,
        });
        t.update(userRef, { agencyId: id, agencyRole: 'owner' });
        t.update(appRef, { status: 'approved', agencyId: id, reason: null, decidedBy: actor.uid, decidedAt: now, updatedAt: now });
        t.create(logRef(), { actorUid: actor.uid, actorName: actor.name, action: 'approve_agency_request', collection: 'agencies', targetId: id, details: { applicant: uid, name: a.agencyName, commissionPercent }, at: now });
      });
      return { agencyId: id };
    } catch (e) {
      if (e instanceof AppError && e.code === 'id-taken') continue;
      throw e;
    }
  }
  throw new AppError(500, 'id-failed', 'Could not make a free Agency ID. Please try again.');
}
