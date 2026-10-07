import { createUser } from '../apps/server/src/auth/users.ts';
import { loadEnv } from '../apps/server/src/config/env.ts';
import { migrate, openDb } from '../apps/server/src/db/index.ts';

// Admin awal untuk E2E (di produksi dibuat lewat `npm run create-admin`).
const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
migrate(db);
// Satu admin per spec agar tidak saling bergantung (2FA tiap akun diaktifkan lewat UI di spec masing-masing).
for (const name of ['auth', 'iso', 'real']) {
  await createUser(db, {
    email: `admin-${name}@e2e.test`,
    password: 'admin-e2e-password-1',
    role: 'admin',
  });
}
db.close();
