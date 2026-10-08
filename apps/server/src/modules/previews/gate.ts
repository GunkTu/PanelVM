import type http from 'node:http';
import type { FastifyRequest } from 'fastify';
import { verifyPassword } from '../../auth/passwords.js';
import { secureCookies } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import {
  ACCESS_COOKIE,
  MAX_PREVIEW_PASSWORD,
  readCookie,
  signAccess,
  verifyAccess,
} from './access.js';
import type { PreviewRow } from './service.js';

/** Path milik panel di host preview (form kata sandi). Aplikasi pengguna tidak boleh memakai path ini. */
export const GATE_LOGIN_PATH = '/__pv/login';
const ACCESS_COOKIE_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_BODY = 4096;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Hanya path relatif di host yang sama; selain itu kembali ke "/". Mencegah open redirect. */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 2000 || !next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\') || next.startsWith(GATE_LOGIN_PATH))
    return '/';
  if (/[\r\n]/.test(next)) return '/';
  return next;
}

function loginHtml(next: string, error?: string): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Preview dilindungi</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font:16px/1.5 system-ui,sans-serif}main{width:100%;max-width:24rem;padding:1.5rem}form{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:1.5rem;box-shadow:0 1px 3px rgb(0 0 0/.08)}h1{color:#0b1f4b;font-size:1.25rem;margin:0 0 .25rem}p{margin:0 0 1rem;color:#475569;font-size:.9rem}label{display:block;font-size:.85rem;font-weight:600;margin-bottom:.25rem}input[type=password]{box-sizing:border-box;width:100%;height:2.5rem;padding:0 .75rem;border:1px solid #cbd5e1;border-radius:.5rem;font:inherit}button{margin-top:1rem;width:100%;height:2.5rem;border:0;border-radius:.5rem;background:#f5b700;color:#0b1f4b;font:inherit;font-weight:600;cursor:pointer}.err{margin:0 0 1rem;padding:.6rem .75rem;background:#fef2f2;border:1px solid #fecaca;border-radius:.5rem;color:#991b1b;font-size:.9rem}small{display:block;margin-top:1rem;text-align:center;color:#94a3b8}</style></head><body><main><form method="post" action="${GATE_LOGIN_PATH}"><h1>Preview dilindungi</h1><p>Masukkan kata sandi yang diberikan pemilik untuk melihat halaman ini.</p>${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}<label for="p">Kata sandi</label><input id="p" name="password" type="password" autocomplete="current-password" maxlength="${MAX_PREVIEW_PASSWORD}" required autofocus><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Buka</button><small>Panel VM · preview</small></form></main></body></html>`;
}

function send(
  res: http.ServerResponse,
  status: number,
  html: string,
  extra: http.OutgoingHttpHeaders = {},
): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(html);
}

const message = (title: string, text: string): string =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px system-ui;padding:2rem"><h1>${title}</h1><p>${text}</p></body></html>`;

async function readBody(req: FastifyRequest): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.raw as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_LOGIN_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameHostOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleLogin(
  ctx: Ctx,
  req: FastifyRequest,
  res: http.ServerResponse,
  preview: PreviewRow,
): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const url = new URL(req.url ?? '/', 'http://x');
    return send(res, 200, loginHtml(safeNext(url.searchParams.get('next'))));
  }
  if (req.method !== 'POST')
    return send(res, 405, message('Metode tidak didukung', 'Gunakan form kata sandi.'));

  // Form hanya boleh dikirim dari halaman preview itu sendiri.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    if (!sameHostOrigin(origin, req.headers.host)) {
      return send(
        res,
        403,
        message('Permintaan ditolak', 'Kirim kata sandi dari halaman preview ini.'),
      );
    }
  }
  if (!ctx.previews.allowLogin(preview.id, req.ip)) {
    return send(
      res,
      429,
      loginHtml('/', 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.'),
      { 'retry-after': '600' },
    );
  }
  const body = await readBody(req);
  if (body === null)
    return send(res, 413, message('Terlalu besar', 'Data yang dikirim terlalu besar.'));
  const form = new URLSearchParams(body);
  const next = safeNext(form.get('next'));
  const password = form.get('password') ?? '';
  const ok =
    password.length > 0 &&
    password.length <= MAX_PREVIEW_PASSWORD &&
    !!preview.password_hash &&
    (await verifyPassword(preview.password_hash, password));
  if (!ok) return send(res, 401, loginHtml(next, 'Kata sandi salah. Periksa lalu coba lagi.'));

  const exp = Math.min(preview.expires_at, Date.now() + ACCESS_COOKIE_MAX_MS);
  const token = signAccess(ctx.previews.accessKey, preview.id, preview.access_version, exp);
  const maxAge = Math.max(1, Math.floor((exp - Date.now()) / 1000));
  const cookie = `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies(ctx) ? '; Secure' : ''}`;
  send(res, 303, '', { location: next, 'set-cookie': cookie });
}

/**
 * Gerbang kata sandi preview. Mengembalikan true bila request boleh diteruskan ke aplikasi; false bila gerbang
 * sudah menjawab sendiri (form login, penolakan, atau hasil login). Preview publik selalu lolos.
 */
export async function passwordGate(
  ctx: Ctx,
  req: FastifyRequest,
  res: http.ServerResponse,
  preview: PreviewRow,
): Promise<boolean> {
  if (preview.access !== 'password') return true;
  const path = (req.url ?? '/').split('?')[0];
  if (path === GATE_LOGIN_PATH) {
    await handleLogin(ctx, req, res, preview);
    return false;
  }
  const token = readCookie(req.headers.cookie, ACCESS_COOKIE);
  if (
    preview.password_hash &&
    verifyAccess(ctx.previews.accessKey, token, preview.id, preview.access_version, Date.now())
  ) {
    return true;
  }
  const upgrade = typeof req.headers.upgrade === 'string';
  if (upgrade) {
    req.raw.socket.end(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\nX-Robots-Tag: noindex\r\n\r\n',
    );
  } else if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    String(req.headers.accept ?? '').includes('text/html')
  ) {
    send(res, 401, loginHtml(safeNext(req.url)));
  } else {
    send(
      res,
      401,
      message('Perlu kata sandi', 'Buka alamat preview ini di browser dan masukkan kata sandi.'),
    );
  }
  return false;
}
