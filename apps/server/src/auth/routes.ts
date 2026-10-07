import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { AppError } from '../errors.js';
import { notify } from '../modules/notifications/service.js';
import {
  actor,
  clearSessionCookie,
  requireActive,
  requireAuthed,
  requireStage,
  setSessionCookie,
} from './plugin.js';
import { burnPasswordTime, hashPassword, passwordSchema, verifyPassword } from './passwords.js';
import {
  consumeRecoveryCode,
  normalizeRecovery,
  RECOVERY_PATTERN,
  regenerateRecoveryCodes,
} from './recovery.js';
import { MAX_2FA_FAILS, SESSION_ABSOLUTE_MS } from './sessions.js';
import { newTotpSecret, totpUri, verifyTotp } from './totp.js';
import { getUserByEmail, toPublicUser, type UserRow } from './users.js';

const MAX_PASSWORD_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const GENERIC_LOGIN_ERROR = new AppError(
  401,
  'invalid_credentials',
  'Email atau password salah, atau akun tidak dapat masuk saat ini. Periksa data Anda, tunggu beberapa menit, atau hubungi admin.',
);

const loginBody = z.object({ email: z.string().max(254), password: z.string().min(1).max(256) });
const codeBody = z.object({ code: z.string().trim().min(1).max(20) });

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
const ua = (req: FastifyRequest) => (req.headers['user-agent'] as string | undefined) ?? null;

export function authRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, box, audit, sessions } = ctx;
  const secretContext = (userId: string) => `users.totp:${userId}`;

  function finishLogin(req: FastifyRequest, reply: FastifyReply, user: UserRow, pendingId: string) {
    const { token, id } = sessions.promote(pendingId, user.id, req.ip, ua(req));
    db.prepare(
      'UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    ).run(Date.now(), user.id);

    // Deteksi perangkat/IP baru. Login pertama kali tidak dianggap "baru".
    const fp = box.mac('device', `${req.ip}|${ua(req) ?? ''}`);
    const known = db
      .prepare('SELECT 1 AS ok FROM known_devices WHERE user_id = ? AND fingerprint = ?')
      .get(user.id, fp);
    const hadAny = db
      .prepare('SELECT 1 AS ok FROM known_devices WHERE user_id = ? LIMIT 1')
      .get(user.id);
    const now = Date.now();
    if (known) {
      db.prepare(
        'UPDATE known_devices SET last_seen_at = ? WHERE user_id = ? AND fingerprint = ?',
      ).run(now, user.id, fp);
    } else {
      db.prepare(
        'INSERT INTO known_devices (user_id, fingerprint, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)',
      ).run(user.id, fp, now, now);
      if (hadAny) {
        notify(
          db,
          user.id,
          'new_device',
          'Login dari perangkat atau IP baru',
          `Ada login berhasil dari IP ${req.ip}. Bila itu bukan Anda, segera ganti password dan hubungi admin.`,
        );
        audit.record({ userId: user.id, ip: req.ip, action: 'auth.new_device', result: 'ok' });
      }
    }

    audit.record({ userId: user.id, ip: req.ip, action: 'auth.login', result: 'ok' });
    setSessionCookie(ctx, reply, token, SESSION_ABSOLUTE_MS);
    return {
      stage: 'active' as const,
      user: toPublicUser(user),
      csrfToken: sessions.csrfToken(id),
    };
  }

  app.post('/api/auth/login', { config: limit(10) }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) throw GENERIC_LOGIN_ERROR;
    const { email, password } = body.data;

    const old = req.cookies[ctx.env.NODE_ENV === 'production' ? '__Host-sid' : 'sid'];
    if (old) {
      const s = sessions.resolve(old);
      if (s) sessions.destroy(s.id);
    }

    const user = getUserByEmail(db, email.trim());
    const locked = user?.locked_until != null && user.locked_until > Date.now();
    if (!user || user.status !== 'active' || locked) {
      await burnPasswordTime(password);
      audit.record({
        userId: user?.id,
        ip: req.ip,
        action: 'auth.password',
        result: 'fail',
        meta: { reason: locked ? 'locked' : 'rejected' },
      });
      throw GENERIC_LOGIN_ERROR;
    }

    if (!(await verifyPassword(user.password_hash, password))) {
      const fails = user.failed_attempts + 1;
      const lockUntil = fails >= MAX_PASSWORD_FAILS ? Date.now() + LOCK_MS : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
        lockUntil ? 0 : fails,
        lockUntil,
        user.id,
      );
      audit.record({
        userId: user.id,
        ip: req.ip,
        action: 'auth.password',
        result: 'fail',
        meta: { locked: lockUntil !== null },
      });
      throw GENERIC_LOGIN_ERROR;
    }

    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(
      user.id,
    );
    const stage = user.totp_enabled ? 'pending_2fa' : 'pending_setup';
    const { token, id } = sessions.create(user.id, stage, req.ip, ua(req));
    audit.record({ userId: user.id, ip: req.ip, action: 'auth.password', result: 'ok' });
    setSessionCookie(ctx, reply, token);
    return { stage, csrfToken: sessions.csrfToken(id) };
  });

  app.post(
    '/api/auth/2fa/verify',
    { config: limit(10), onRequest: requireStage('pending_2fa') },
    async (req, reply) => {
      const { user, session } = requireAuthed(req);
      const { code } = codeBody.parse(req.body);

      let ok = false;
      if (/^\d{6}$/.test(code) && user.totp_secret_enc) {
        const secret = box.decrypt(user.totp_secret_enc, secretContext(user.id));
        const step = verifyTotp(secret, code);
        if (step !== null && step > (user.totp_last_step ?? -1)) {
          db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
          ok = true;
        }
      } else if (RECOVERY_PATTERN.test(normalizeRecovery(code))) {
        ok = await consumeRecoveryCode(db, user.id, code);
        if (ok) {
          notify(
            db,
            user.id,
            'recovery_used',
            'Recovery code dipakai',
            'Satu recovery code dipakai untuk masuk. Buat ulang kode baru bila sisa kode menipis.',
          );
        }
      }

      if (!ok) {
        const n = sessions.recordFail(session.id);
        audit.record({ userId: user.id, ip: req.ip, action: 'auth.2fa', result: 'fail' });
        if (n >= MAX_2FA_FAILS) {
          sessions.destroy(session.id);
          clearSessionCookie(ctx, reply);
          throw new AppError(
            401,
            'too_many_2fa_failures',
            'Terlalu banyak kode salah. Masuk ulang dari awal dengan email dan password.',
          );
        }
        throw new AppError(
          401,
          'invalid_2fa',
          'Kode salah atau sudah dipakai. Masukkan kode 6 digit terbaru dari aplikasi autentikator, atau gunakan recovery code.',
        );
      }
      audit.record({ userId: user.id, ip: req.ip, action: 'auth.2fa', result: 'ok' });
      return finishLogin(req, reply, user, session.id);
    },
  );

  app.post(
    '/api/auth/2fa/setup',
    { config: limit(10), onRequest: requireStage('pending_setup') },
    async (req) => {
      const { user } = requireAuthed(req);
      const secret = newTotpSecret();
      db.prepare(
        'UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
      ).run(box.encrypt(secret, secretContext(user.id)), user.id);
      return { secret, uri: totpUri(user.email, secret) };
    },
  );

  app.post(
    '/api/auth/2fa/enable',
    { config: limit(10), onRequest: requireStage('pending_setup') },
    async (req, reply) => {
      const { user, session } = requireAuthed(req);
      const { code } = codeBody.parse(req.body);
      if (!user.totp_secret_enc) {
        throw new AppError(
          409,
          '2fa_not_started',
          'Pengaturan 2FA belum dimulai. Muat ulang halaman lalu mulai dari awal.',
        );
      }
      const step = verifyTotp(box.decrypt(user.totp_secret_enc, secretContext(user.id)), code);
      if (step === null) {
        const n = sessions.recordFail(session.id);
        audit.record({ userId: user.id, ip: req.ip, action: 'auth.2fa_enable', result: 'fail' });
        if (n >= MAX_2FA_FAILS) {
          sessions.destroy(session.id);
          clearSessionCookie(ctx, reply);
          throw new AppError(
            401,
            'too_many_2fa_failures',
            'Terlalu banyak kode salah. Masuk ulang dari awal.',
          );
        }
        throw new AppError(
          400,
          'invalid_2fa',
          'Kode tidak cocok. Pastikan jam ponsel Anda akurat lalu masukkan kode 6 digit terbaru.',
        );
      }
      db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(
        step,
        user.id,
      );
      const recoveryCodes = await regenerateRecoveryCodes(db, user.id);
      audit.record({ userId: user.id, ip: req.ip, action: 'auth.2fa_enable', result: 'ok' });
      const fresh = { ...user, totp_enabled: 1 };
      return { ...finishLogin(req, reply, fresh, session.id), recoveryCodes };
    },
  );

  app.get('/api/auth/me', async (req) => {
    const { user, session } = requireAuthed(req);
    return {
      stage: session.stage,
      user: toPublicUser(user),
      csrfToken: sessions.csrfToken(session.id),
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const { user, session } = requireAuthed(req);
    sessions.destroy(session.id);
    ctx.terminals.closeByAuthSession(session.id, 'Anda keluar dari panel');
    audit.record({ userId: user.id, ip: req.ip, action: 'auth.logout', result: 'ok' });
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.post('/api/auth/password', { config: limit(5), onRequest: requireActive }, async (req) => {
    const user = actor(req);
    const { session } = requireAuthed(req);
    const body = z
      .object({ currentPassword: z.string().max(256), newPassword: passwordSchema })
      .parse(req.body);
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
      audit.record({
        userId: user.id,
        ip: req.ip,
        action: 'account.password_change',
        result: 'fail',
      });
      throw new AppError(400, 'wrong_password', 'Password saat ini salah. Periksa lalu coba lagi.');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      await hashPassword(body.newPassword),
      user.id,
    );
    // Putuskan semua sesi lain (dan terminalnya); sesi ini tetap hidup.
    const others = db
      .prepare('SELECT id FROM sessions WHERE user_id = ? AND id != ?')
      .all(user.id, session.id) as { id: string }[];
    for (const o of others) {
      sessions.destroy(o.id);
      ctx.terminals.closeByAuthSession(o.id, 'Password diganti');
    }
    audit.record({ userId: user.id, ip: req.ip, action: 'account.password_change', result: 'ok' });
    return { ok: true };
  });
}
