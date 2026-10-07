import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { SessionRow, Stage } from './sessions.js';
import { getUserById, type UserRow } from './users.js';

export interface AuthState {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
  }
}

/** Cookie aman (Secure + prefiks __Host-) di produksi, kecuali mode uji HTTP lokal (INSECURE_HTTP). */
export const secureCookies = (ctx: Ctx): boolean =>
  ctx.env.NODE_ENV === 'production' && !ctx.env.INSECURE_HTTP;

export const cookieName = (ctx: Ctx): string => (secureCookies(ctx) ? '__Host-sid' : 'sid');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const LOGIN_PATH = '/api/auth/login';

export function setSessionCookie(
  ctx: Ctx,
  reply: FastifyReply,
  token: string,
  maxAgeMs?: number,
): void {
  reply.setCookie(cookieName(ctx), token, {
    httpOnly: true,
    secure: secureCookies(ctx),
    sameSite: 'strict',
    path: '/',
    ...(maxAgeMs ? { maxAge: Math.floor(maxAgeMs / 1000) } : {}),
  });
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply): void {
  reply.clearCookie(cookieName(ctx), { path: '/' });
}

/** Hook onRequest global: resolve sesi, tolak Origin asing, dan wajibkan token CSRF. */
export function authHook(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    req.auth = null;
    const unsafe = !SAFE_METHODS.has(req.method);
    // Hanya pembacaan aset statis yang dilewati. Pengecekan memakai includes('/api'), bukan startsWith('/api/'),
    // agar variasi URL (mis. '//api/...') tidak bisa menghindari Origin/CSRF seandainya routing kelak dilonggarkan.
    if (!unsafe && !req.url.includes('/api')) return;

    if (unsafe && req.headers.origin !== ctx.env.APP_ORIGIN) {
      throw new AppError(
        403,
        'bad_origin',
        'Permintaan ditolak karena berasal dari alamat yang tidak dikenal. Buka panel dari alamat resminya lalu coba lagi.',
      );
    }

    const token = req.cookies[cookieName(ctx)];
    if (token) {
      const session = ctx.sessions.resolve(token);
      const user = session ? getUserById(ctx.db, session.user_id) : undefined;
      if (session && user && user.status === 'active') {
        req.auth = { user, session };
      } else if (session) {
        ctx.sessions.destroy(session.id);
        ctx.terminals.closeByAuthSession(session.id, 'Sesi diakhiri');
      }
    }

    if (unsafe && req.auth && req.url.split('?')[0] !== LOGIN_PATH) {
      const header = req.headers['x-csrf-token'];
      if (
        !ctx.sessions.verifyCsrf(
          req.auth.session.id,
          typeof header === 'string' ? header : undefined,
        )
      ) {
        throw new AppError(
          403,
          'bad_csrf',
          'Token keamanan formulir tidak valid atau kedaluwarsa. Muat ulang halaman lalu ulangi aksi Anda.',
        );
      }
    }
  };
}

export function requireStage(stage: Stage) {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (req.auth.session.stage !== stage) {
      throw unauthorized('Langkah login tidak sesuai. Mulai ulang proses masuk.');
    }
  };
}

export const requireActive = requireStage('active');

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  await requireActive(req);
  if (req.auth?.user.role !== 'admin')
    throw forbidden('Hanya admin yang boleh melakukan aksi ini.');
}

export function actor(req: FastifyRequest): UserRow {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

export function requireAuthed(req: FastifyRequest): AuthState {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
