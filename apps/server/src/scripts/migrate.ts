import { loadEnv } from '../config/env.js';
import { migrate, openDb } from '../db/index.js';

const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
const applied = migrate(db);
console.log(
  applied.length ? `Migrasi diterapkan: ${applied.join(', ')}` : 'Database sudah terbaru.',
);
db.close();
