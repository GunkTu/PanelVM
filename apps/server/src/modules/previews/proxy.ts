import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import type { ClientChannel } from 'ssh2';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { classifyForwardError } from '../../ssh/pool.js';
import { sshTargetFor } from '../vms/service.js';
import { previewLabel } from './service.js';

const HEADER_TIMEOUT_MS = 60_000;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Header yang diisi panel sendiri; nilai kiriman pengunjung dibuang agar tidak bisa dipalsukan. */
const OWN_HEADERS = new Set([
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

interface Failure {
  status: number;
  title: string;
  message: string;
}

const NOT_FOUND: Failure = {
  status: 404,
  title: 'Preview tidak ditemukan',
  message:
    'Alamat preview ini tidak aktif. Mungkin sudah kedaluwarsa atau dicabut oleh pemiliknya. Minta link baru kepada pemilik.',
};

/** Terjemahkan error pembukaan tunnel ke halaman yang jelas. Tanpa detail internal. */
function describeFailure(err: unknown): Failure {
  const kind = classifyForwardError(err);
  if (kind === 'refused') {
    return {
      status: 502,
      title: 'Aplikasi belum berjalan',
      message:
        'Tidak ada aplikasi yang mendengarkan di port preview ini. Pemilik perlu menjalankan aplikasinya di VM, lalu muat ulang halaman ini.',
    };
  }
  if (kind === 'prohibited') {
    return {
      status: 502,
      title: 'Penerusan port dilarang',
      message:
        'Layanan SSH di VM melarang penerusan port. Pemilik VM perlu mengaktifkan AllowTcpForwarding di sshd_config lalu me-reload sshd.',
    };
  }
  if (err instanceof AppError && err.status === 503) {
    return { status: 503, title: 'Terlalu sibuk', message: err.message };
  }
  return {
    status: 502,
    title: 'VM tidak dapat dijangkau',
    message:
      'Panel gagal terhubung ke VM. Pastikan VM menyala, lalu muat ulang halaman ini beberapa saat lagi.',
  };
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
};

function pageHtml(f: Failure): string {
  // Semua teks statis dari kode ini (tanpa input pengunjung), jadi aman tanpa escaping.
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${f.title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:2rem}h1{color:#0b1f4b;font-size:1.4rem;margin:0 0 .5rem}p{margin:0;color:#475569}small{display:block;margin-top:1.5rem;color:#94a3b8}</style></head><body><main><h1>${f.title}</h1><p>${f.message}</p><small>Panel VM · preview</small></main></body></html>`;
}

function sendPage(res: http.ServerResponse, f: Failure): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(f.status, PAGE_HEADERS);
  res.end(pageHtml(f));
}

function sendUpgradeFailure(socket: Duplex, f: Failure): void {
  socket.end(
    `HTTP/1.1 ${f.status} ${f.status === 404 ? 'Not Found' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\nX-Robots-Tag: noindex\r\n\r\n`,
  );
}

/** Channel ssh2 bukan net.Socket; node:http memanggil beberapa method socket sehingga perlu stub. */
function asSocket(ch: ClientChannel): Duplex {
  const s = ch as unknown as Record<string, unknown>;
  for (const m of ['setNoDelay', 'setKeepAlive', 'setTimeout', 'ref', 'unref']) {
    if (typeof s[m] !== 'function') s[m] = () => ch;
  }
  return ch as unknown as Duplex;
}

function upstreamHeaders(
  req: FastifyRequest,
  port: number,
  host: string,
): http.OutgoingHttpHeaders {
  const upgrade = typeof req.headers.upgrade === 'string';
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || OWN_HEADERS.has(k)) continue;
    if (HOP_BY_HOP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue;
    out[k] = v;
  }
  out.host = `localhost:${port}`;
  out['x-forwarded-for'] = req.ip;
  out['x-forwarded-host'] = host;
  out['x-forwarded-proto'] = 'https';
  return out;
}

async function handle(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  label: string,
): Promise<void> {
  const res = reply.raw;
  const socket = req.raw.socket;
  const isUpgrade = typeof req.headers.upgrade === 'string';
  const fail = (f: Failure) => (isUpgrade ? sendUpgradeFailure(socket, f) : sendPage(res, f));

  // Hook global lain (helmet, dll.) sudah menulis header panel ke respons; preview bukan bagian dari panel.
  for (const h of res.getHeaderNames()) res.removeHeader(h);

  const found = ctx.previews.resolve(label);
  if (!found) return fail(NOT_FOUND);
  const { preview, vm } = found;

  const maxBody = ctx.env.MAX_UPLOAD_MB * 1024 * 1024;
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBody) {
    return fail({
      status: 413,
      title: 'Permintaan terlalu besar',
      message: `Ukuran data yang dikirim melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB.`,
    });
  }

  let closed = false;
  let channel: ClientChannel | null = null;
  let upstream: http.ClientRequest | null = null;
  let upstreamSocket: Duplex | null = null;
  let release: (() => void) | null = null;
  let headerTimer: NodeJS.Timeout | undefined = undefined;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    release?.();
    clearTimeout(headerTimer);
    upstream?.destroy();
    upstreamSocket?.destroy();
    channel?.destroy();
    if (isUpgrade) socket.destroy();
    else res.destroy();
  };

  const untrack = ctx.previews.track(preview.id, closeAll);
  if (!untrack) {
    return fail({
      status: 503,
      title: 'Terlalu sibuk',
      message: 'Terlalu banyak koneksi ke preview ini. Tunggu sebentar lalu muat ulang.',
    });
  }
  release = untrack;
  ctx.previews.touch(preview.id);

  try {
    channel = await ctx.pool.forward(vm.id, sshTargetFor(ctx, vm), preview.port, (e) =>
      ctx.log?.warn({ err: e.message }, 'ssh preview error'),
    );
  } catch (e) {
    untrack();
    release = null;
    closed = true;
    return fail(describeFailure(e));
  }
  if (closed) {
    channel.destroy();
    return;
  }

  const sock = asSocket(channel);
  const host = String(req.headers.host ?? '');
  const preq = http.request({
    createConnection: () => sock,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, preview.port, host),
    setHost: false,
  });
  upstream = preq;

  headerTimer = setTimeout(() => {
    if (closed) return;
    fail({
      status: 504,
      title: 'Aplikasi tidak merespons',
      message:
        'Aplikasi di VM tidak menjawab dalam 60 detik. Periksa aplikasinya, lalu muat ulang.',
    });
    closeAll();
  }, HEADER_TIMEOUT_MS);

  preq.on('error', () => {
    if (closed) return;
    fail(describeFailure(null));
    closeAll();
  });

  if (isUpgrade) {
    preq.on('upgrade', (pres, psock, head) => {
      clearTimeout(headerTimer);
      if (closed) return psock.destroy();
      upstreamSocket = psock;
      let h = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (let i = 0; i < pres.rawHeaders.length; i += 2)
        h += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
      socket.write(`${h}\r\n`);
      if (head.length) socket.write(head);
      psock.pipe(socket);
      socket.pipe(psock);
      psock.on('error', closeAll);
      psock.on('close', closeAll);
      socket.on('error', closeAll);
      socket.on('close', closeAll);
    });
  }

  preq.on('response', (pres) => {
    clearTimeout(headerTimer);
    if (closed) return;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(pres.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    headers['x-robots-tag'] = 'noindex, nofollow';
    // Hindari cache CDN/browser menyajikan versi lama saat pengembangan, kecuali aplikasi menentukannya sendiri.
    if (!headers['cache-control'] && !headers['etag'] && !headers['last-modified'])
      headers['cache-control'] = 'no-cache';
    if (isUpgrade) {
      // Aplikasi menolak upgrade dan menjawab biasa: teruskan sebagai respons HTTP mentah lalu tutup.
      let h = `HTTP/1.1 ${pres.statusCode} ${pres.statusMessage ?? ''}\r\nConnection: close\r\n`;
      for (const [k, v] of Object.entries(headers))
        for (const one of Array.isArray(v) ? v : [String(v)]) h += `${k}: ${one}\r\n`;
      socket.write(`${h}\r\n`);
      pres.pipe(socket);
      return;
    }
    res.writeHead(pres.statusCode ?? 502, pres.statusMessage, headers);
    pres.pipe(res);
    pres.on('error', closeAll);
  });

  res.on('close', closeAll);
  if (isUpgrade) socket.once('close', closeAll);

  let received = 0;
  req.raw.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxBody && !closed) {
      fail({
        status: 413,
        title: 'Permintaan terlalu besar',
        message: `Ukuran data yang dikirim melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB.`,
      });
      closeAll();
    }
  });
  if (isUpgrade) preq.end();
  else req.raw.pipe(preq);
}

/**
 * Hook onRequest untuk host preview (pv-<acak>.<PREVIEW_BASE_DOMAIN>). WAJIB didaftarkan SEBELUM hook auth:
 * request di host preview diambil alih sepenuhnya dan diteruskan ke aplikasi di VM, tidak pernah ke rute panel
 * (termasuk /api). Host lain lewat ke panel seperti biasa.
 */
export function previewHook(ctx: Ctx) {
  const base = ctx.env.PREVIEW_BASE_DOMAIN;
  return (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const label = base ? previewLabel(req.headers.host, base) : null;
    if (!label) return done();
    reply.hijack();
    handle(ctx, req, reply, label).catch((err: unknown) => {
      req.log.error({ err }, 'preview proxy error');
      const f = describeFailure(null);
      if (typeof req.headers.upgrade === 'string') sendUpgradeFailure(req.raw.socket, f);
      else sendPage(reply.raw, f);
    });
  };
}

/** Host yang termasuk alamat preview (untuk mengecualikan dari rate limit panel). */
export function isPreviewHost(ctx: Ctx, req: FastifyRequest): boolean {
  const base = ctx.env.PREVIEW_BASE_DOMAIN;
  return !!base && previewLabel(req.headers.host, base) !== null;
}
