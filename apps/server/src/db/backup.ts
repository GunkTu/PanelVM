import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index.js';

/** Cadangan SQLite yang konsisten (API backup, aman saat panel berjalan). Menyisakan `keep` file terbaru. */
export async function backupDb(db: Db, dir: string, keep = 14, now = new Date()): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `panel-${stamp}.db`);
  await db.backup(file);
  chmodSync(file, 0o600);
  const old = readdirSync(dir)
    .filter((f) => /^panel-.*\.db$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  return file;
}
