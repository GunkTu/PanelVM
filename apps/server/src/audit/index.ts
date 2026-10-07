import type { Db } from '../db/index.js';

export interface AuditEntry {
  userId?: string | null;
  vmId?: string | null;
  ip?: string | null;
  action: string;
  target?: string | null;
  result: 'ok' | 'fail' | 'denied';
  meta?: Record<string, unknown>;
}

const FORBIDDEN_KEY = /pass|secret|token|key|code|content|keystroke|authorization|cookie/i;

/** Hapus kunci yang berpotensi memuat data sensitif sebelum disimpan ke audit log. */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEY.test(k)) continue;
    clean[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export class Audit {
  private readonly insert;
  constructor(db: Db) {
    this.insert = db.prepare(
      'INSERT INTO audit_logs (ts, user_id, vm_id, ip, action, target, result, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  record(e: AuditEntry): void {
    this.insert.run(
      Date.now(),
      e.userId ?? null,
      e.vmId ?? null,
      e.ip ?? null,
      e.action,
      e.target ?? null,
      e.result,
      sanitizeMeta(e.meta),
    );
  }
}
