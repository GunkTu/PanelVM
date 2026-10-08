import type { Db } from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hapus data lama sesuai retensi. Audit log hanya dihapus lewat jalur ini, tidak pernah diubah. */
export function purgeOld(
  db: Db,
  auditDays: number,
  now = Date.now(),
): { audit: number; jobs: number } {
  const audit = db
    .prepare('DELETE FROM audit_logs WHERE ts < ?')
    .run(now - auditDays * DAY_MS).changes;
  const jobs = db
    .prepare("DELETE FROM jobs WHERE status NOT IN ('running', 'waiting') AND created_at < ?")
    .run(now - 30 * DAY_MS).changes;
  db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?').run(
    now - 90 * DAY_MS,
  );
  return { audit, jobs };
}
