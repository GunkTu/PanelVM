import { dirname, join } from 'node:path';
import { backupDb } from '../db/backup.js';
import { loadEnv } from '../config/env.js';
import { openDb } from '../db/index.js';

const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
try {
  const dir = process.env.BACKUP_DIR ?? join(dirname(env.DATABASE_PATH), 'backups');
  const keep = Number(process.env.BACKUP_KEEP ?? 14);
  const file = await backupDb(db, dir, Number.isInteger(keep) && keep > 0 ? keep : 14);
  console.log(`Cadangan dibuat: ${file}`);
  console.log(
    'Catatan: cadangan DB tidak berisi master key. Simpan SECRETS_MASTER_KEY secara terpisah; tanpa itu kunci SSH VM tidak bisa dibuka.',
  );
} finally {
  db.close();
}
