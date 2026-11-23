// Writes the default host policy and withdrawal rules (only when they do not exist yet):   npm run salary:seed
// The numbers are PLACEHOLDERS. Change them in the admin panel (Host policy page) with the client's real policy.
import 'dotenv/config';
import { db } from '../src/config/firebase';
import { DEFAULT_SALARY_POLICY, DEFAULT_WITHDRAWAL, SALARY_POLICY_DOC, WITHDRAWAL_DOC } from '../src/config/salary';

async function main() {
  for (const [path, value] of [[SALARY_POLICY_DOC, DEFAULT_SALARY_POLICY], [WITHDRAWAL_DOC, DEFAULT_WITHDRAWAL]] as const) {
    const ref = db.doc(path);
    if ((await ref.get()).exists) console.log(`${path} already exists, left as it is.`);
    else {
      await ref.set(value);
      console.log(`Created ${path} with the default values.`);
    }
  }
  process.exit(0);
}
main();
