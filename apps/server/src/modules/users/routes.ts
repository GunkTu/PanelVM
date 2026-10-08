import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireAdmin } from '../../auth/plugin.js';
import { hashPassword, passwordSchema } from '../../auth/passwords.js';
import { createUser, getUserById, toPublicUser, type UserRow } from '../../auth/users.js';
import type { Ctx } from '../../context.js';
import { notFound } from '../../errors.js';
import { notify } from '../notifications/service.js';

const idParams = z.object({ id: z.string().uuid() });

export function userRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  /** Admin hanya mengelola akun client; admin lain dikelola lewat CLI. */
  function loadClient(id: string): UserRow {
    const u = getUserById(db, id);
    if (!u || u.role !== 'client') throw notFound('Akun client');
    return u;
  }

  function revokeAccess(userId: string, reason: string): void {
    ctx.sessions.destroyAllForUser(userId);
    ctx.terminals.closeByUser(userId, reason);
    ctx.previews.removeByUser(userId);
  }

  app.get('/api/users', { onRequest: requireAdmin }, async () => {
    const rows = db
      .prepare("SELECT * FROM users WHERE role = 'client' ORDER BY email")
      .all() as UserRow[];
    return {
      items: rows.map((u) => {
        const vm = db
          .prepare(
            'SELECT v.id, v.name FROM vm_access a JOIN vms v ON v.id = a.vm_id WHERE a.user_id = ?',
          )
          .get(u.id) as { id: string; name: string } | undefined;
        return { ...toPublicUser(u), vm: vm ?? null };
      }),
    };
  });

  app.post('/api/users', { onRequest: requireAdmin }, async (req, reply) => {
    const body = z
      .object({ email: z.string().trim().email().max(254), password: passwordSchema })
      .parse(req.body);
    const user = await createUser(db, {
      email: body.email,
      password: body.password,
      role: 'client',
    });
    notify(
      db,
      user.id,
      'welcome',
      'Selamat datang',
      'Akun Anda dibuat admin. Aktifkan 2FA saat login pertama.',
    );
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: 'user.create',
      target: user.email,
      result: 'ok',
    });
    reply.code(201);
    return toPublicUser(user);
  });

  app.patch('/api/users/:id', { onRequest: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    const user = loadClient(id);
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    if (status === 'suspended') revokeAccess(id, 'Akun ditangguhkan admin');
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: `user.${status === 'suspended' ? 'suspend' : 'activate'}`,
      target: user.email,
      result: 'ok',
    });
    return toPublicUser(getUserById(db, id)!);
  });

  app.post('/api/users/:id/reset-2fa', { onRequest: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const user = loadClient(id);
    db.transaction(() => {
      db.prepare(
        'UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
      ).run(id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    })();
    revokeAccess(id, '2FA direset admin');
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: 'user.reset_2fa',
      target: user.email,
      result: 'ok',
    });
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', { onRequest: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    const user = loadClient(id);
    db.prepare(
      'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    ).run(await hashPassword(password), id);
    revokeAccess(id, 'Password direset admin');
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: 'user.reset_password',
      target: user.email,
      result: 'ok',
    });
    return { ok: true };
  });

  app.get('/api/audit', { onRequest: requireAdmin }, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().optional(),
      })
      .parse(req.query);
    const rows = db
      .prepare(
        'SELECT id, ts, user_id AS userId, vm_id AS vmId, ip, action, target, result, meta FROM audit_logs WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      )
      .all(q.before ?? null, q.before ?? null, q.limit);
    return { items: rows };
  });
}
