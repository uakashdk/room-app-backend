import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { env } from './env';

if (!getApps().length) {
  initializeApp({
    credential: env.FIREBASE_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault(),
  });
}

export const db = getFirestore();
export const adminAuth = getAuth();
