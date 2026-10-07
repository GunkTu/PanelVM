import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const defaultMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(path: string): Db {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (!inMemory) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // izin file tidak bisa diubah di beberapa filesystem; dicatat di docs/DEPLOY.md
    }
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Jalankan migrasi SQL berurutan (nama file diurutkan). Tiap file berjalan dalam satu transaksi. */
export function migrate(db: Db, dir = defaultMigrationsDir): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const done = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );
  if (!existsSync(dir)) throw new Error(`Folder migrasi tidak ditemukan: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
    })();
    applied.push(file);
  }
  return applied;
}
