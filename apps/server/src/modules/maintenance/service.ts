import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireAdmin } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';

export interface MaintenanceState {
  enabled: boolean;
  message: string;
  since: number | null;
}

export const DEFAULT_MESSAGE =
  'Panel sedang dalam pemeliharaan untuk peningkatan layanan. Silakan kembali beberapa saat lagi.';

const KEY = 'maintenance';

/** Jalur API yang tetap terbuka saat maintenance: login admin, status, dan health check. */
const OPEN_PREFIXES = ['/api/auth/', '/api/maintenance'];

export function loadMaintenance(ctx: Ctx): MaintenanceState {
  const row = ctx.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as
    { value: string } | undefined;
  if (!row) return { enabled: false, message: DEFAULT_MESSAGE, since: null };
  try {
    const v = JSON.parse(row.value) as Partial<MaintenanceState>;
    return {
      enabled: v.enabled === true,
      message: typeof v.message === 'string' && v.message ? v.message : DEFAULT_MESSAGE,
      since: typeof v.since === 'number' ? v.since : null,
    };
  } catch {
    return { enabled: false, message: DEFAULT_MESSAGE, since: null };
  }
}

/**
 * Hook onRequest (dipasang SETELAH authHook): saat maintenance aktif, semua API untuk non-admin dijawab 503,
 * kecuali login/status. Admin tetap bisa bekerja penuh. Trafik preview diambil alih lebih awal oleh previewHook
 * sehingga situs milik pengguna tidak ikut terhenti.
 */
export function maintenanceHook(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || path === '/api/health') return;
    if (OPEN_PREFIXES.some((p) => path.startsWith(p))) return;
    const m = loadMaintenance(ctx);
    if (!m.enabled || req.auth?.user.role === 'admin') return;
    throw new AppError(503, 'maintenance', m.message);
  };
}

export function maintenanceRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  /** Publik: dipakai halaman login/SPA untuk menampilkan layar maintenance. */
  app.get('/api/maintenance', async () => {
    const m = loadMaintenance(ctx);
    return { enabled: m.enabled, message: m.message, since: m.since };
  });

  app.put('/api/admin/maintenance', { onRequest: requireAdmin }, async (req) => {
    const body = z
      .object({
        enabled: z.boolean(),
        message: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const prev = loadMaintenance(ctx);
    const next: MaintenanceState = {
      enabled: body.enabled,
      message: body.message || DEFAULT_MESSAGE,
      since: body.enabled ? (prev.enabled ? prev.since : Date.now()) : null,
    };
    db.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(KEY, JSON.stringify(next), Date.now());

    let closed = 0;
    if (next.enabled && !prev.enabled) {
      // Putus terminal milik client; terminal admin dibiarkan.
      const clients = db.prepare("SELECT id FROM users WHERE role = 'client'").all() as {
        id: string;
      }[];
      for (const c of clients) {
        closed += ctx.terminals.countForUser(c.id);
        ctx.terminals.closeByUser(c.id, 'Panel masuk mode maintenance');
      }
    }
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: next.enabled ? 'maintenance.on' : 'maintenance.off',
      target: 'panel',
      result: 'ok',
      meta: { terminalsClosed: closed },
    });
    return { ...next, terminalsClosed: closed };
  });
}
