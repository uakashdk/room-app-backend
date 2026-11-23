import type { RequestHandler } from 'express';
import { adminAuth, db } from '../config/firebase';
import { AppError } from './error-handler';

export type AuthedUser = { uid: string; role: string; name: string; photoURL: string | null };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Every protected route starts here: checks the Firebase ID token ("Authorization: Bearer ...") and that the account is
 * active (not banned or suspended). The user's name and photo come from the database, never from the request.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AppError(401, 'unauthenticated', 'Please log in.');

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch {
      throw new AppError(401, 'unauthenticated', 'Your session is not valid. Please log in again.');
    }

    const snap = await db.doc(`users/${decoded.uid}`).get();
    const data = snap.data();
    if (!snap.exists || !data) throw new AppError(403, 'no-profile', 'Your profile was not found.');
    if (data.status !== 'active') throw new AppError(403, 'account-blocked', 'Your account cannot do this.');

    req.user = { uid: decoded.uid, role: String(decoded.role ?? 'none'), name: String(data.name ?? 'User'), photoURL: data.photoURL ?? null };
    next();
  } catch (e) {
    next(e);
  }
};
