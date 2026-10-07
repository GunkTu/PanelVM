import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { notFound } from '../../errors.js';

interface Row {
  id: string;
  type: string;
  title: string;
  message: string;
  read_at: number | null;
  created_at: number;
}

export function notificationRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/notifications', { preHandler: requireActive }, async (req) => {
    const rows = ctx.db
      .prepare(
        'SELECT id, type, title, message, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      )
      .all(actor(req).id) as Row[];
    return {
      unread: rows.filter((r) => r.read_at === null).length,
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        message: r.message,
        read: r.read_at !== null,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/notifications/read-all', { preHandler: requireActive }, async (req) => {
    ctx.db
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(Date.now(), actor(req).id);
    return { ok: true };
  });

  app.post('/api/notifications/:id/read', { preHandler: requireActive }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Dibatasi ke user sendiri: notifikasi milik orang lain tidak bisa disentuh.
    const res = ctx.db
      .prepare(
        'UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?',
      )
      .run(Date.now(), id, actor(req).id);
    if (res.changes === 0) throw notFound('Notifikasi');
    return { ok: true };
  });
}
