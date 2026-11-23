/*
 * Gives (or removes) a staff role for a Firebase user.  Roles: super_admin | admin | none
 *
 *   node scripts/set-role.cjs someone@gmail.com super_admin
 *   node scripts/set-role.cjs someone@gmail.com none
 *
 * Run it on the server, in the backend folder (it reads the same .env as the server).
 * The person must sign out and sign in again in the admin panel after the change.
 */
require('dotenv/config');
const { applicationDefault, cert, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const [email, role] = process.argv.slice(2);
if (!email || !['super_admin', 'admin', 'none'].includes(role)) {
  console.error('Usage: node scripts/set-role.cjs <email> <super_admin|admin|none>');
  process.exit(1);
}

initializeApp({
  credential: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault(),
});

(async () => {
  const auth = getAuth();
  const user = await auth.getUserByEmail(email); // the person must have signed in at least once
  const claims = { ...(user.customClaims || {}) };
  if (role === 'none') delete claims.role;
  else claims.role = role;
  await auth.setCustomUserClaims(user.uid, claims); // other claims are kept
  console.log(`Done: ${email} (${user.uid}) now has role "${role}". Ask them to sign out and in again.`);
  process.exit(0);
})().catch((e) => {
  console.error('Failed:', e.code || '', e.message);
  process.exit(1);
});
