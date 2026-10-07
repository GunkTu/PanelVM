import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Audit } from './audit/index.js';
import { purgeOld } from './audit/retention.js';
import { authHook } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { SessionService } from './auth/sessions.js';
import type { Env } from './config/env.js';
import type { Ctx } from './context.js';
import { SecretBox } from './crypto/secrets.js';
import { migrate, openDb, type Db } from './db/index.js';
import { AppError } from './errors.js';
import { JobService } from './modules/jobs/service.js';
import { SshPool } from './ssh/pool.js';
import { siteRoutes } from './modules/sites/routes.js';
import { softwareRoutes } from './modules/software/routes.js';
import { databaseRoutes } from './modules/databases/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { MAX_WS_MESSAGE_BYTES, terminalRoutes } from './modules/terminal/routes.js';
import { TerminalRegistry } from './modules/terminal/registry.js';
import { userRoutes } from './modules/users/routes.js';
import { vmRoutes } from './modules/vms/routes.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Ctx;
}

export interface BuildOptions {
  /** Hanya untuk test: nonaktifkan rate limit agar test tidak saling mengganggu. */
  rateLimit?: boolean;
  db?: Db;
}

export async function buildApp(env: Env, opts: BuildOptions = {}): Promise<BuiltApp> {
  const existingDb = opts.db;
  const db = existingDb ?? openDb(env.DATABASE_PATH);
  migrate(db);
  const box = SecretBox.fromBase64(env.SECRETS_MASTER_KEY);
  const ctx: Ctx = {
    env,
    db,
    box,
    audit: new Audit(db),
    sessions: new SessionService(db, box, env.SESSION_SECRET),
    terminals: new TerminalRegistry(),
    pool: new SshPool((vmId, online) =>
      db.prepare('UPDATE vms SET status = ? WHERE id = ?').run(online ? 'online' : 'offline', vmId),
    ),
    jobs: undefined as unknown as JobService,
  };
  ctx.jobs = new JobService(ctx);

  const app = Fastify({
    // IP klien hanya dipercaya dari header proxy bila TRUST_PROXY aktif (di belakang NPM).
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // dibutuhkan xterm.js untuk style dinamis
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // HSTS diatur di NPM sampai HTTPS stabil (lihat CLAUDE.md 5.6).
    strictTransportSecurity: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    ...(opts.rateLimit === false ? { allowList: () => true } : {}),
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) =>
      new AppError(
        429,
        'rate_limited',
        `Terlalu banyak permintaan. Tunggu ${Math.ceil(context.ttl / 1000)} detik lalu coba lagi.`,
      ),
  });
  await app.register(websocket, { options: { maxPayload: MAX_WS_MESSAGE_BYTES + 1024 } });

  ctx.log = app.log;
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook(ctx));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? ` (${first.path.join('.')})` : '';
      return reply.code(400).send({
        error: 'invalid_input',
        message: `Input tidak valid${where}: ${first?.message ?? 'periksa isian Anda'}. Perbaiki lalu kirim ulang.`,
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
      });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: 'bad_request',
        message: 'Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.',
      });
    }
    // Detail teknis hanya ke log server, tidak ke pengguna.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal',
      message:
        'Server gagal memproses permintaan Anda. Coba lagi beberapa saat; bila terus terjadi, hubungi admin.',
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  authRoutes(app, ctx);
  userRoutes(app, ctx);
  vmRoutes(app, ctx);
  notificationRoutes(app, ctx);
  terminalRoutes(app, ctx);
  fileRoutes(app, ctx);
  databaseRoutes(app, ctx);
  softwareRoutes(app, ctx);
  siteRoutes(app, ctx);

  // Produksi: sajikan SPA dari origin yang sama dengan API (tanpa CORS).
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (env.NODE_ENV === 'production' && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({
        error: 'not_found',
        message: 'Alamat tidak ditemukan. Periksa URL atau kembali ke beranda.',
      });
    });
  }

  const purge = setInterval(() => ctx.sessions.purgeExpired(), 10 * 60 * 1000);
  purge.unref();
  const retention = () => purgeOld(db, env.AUDIT_RETENTION_DAYS);
  retention();
  const retentionTimer = setInterval(retention, 24 * 60 * 60 * 1000);
  retentionTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(purge);
    clearInterval(retentionTimer);
    ctx.pool.closeAll();
    ctx.terminals.closeAll('Server dimatikan');
    if (!existingDb) db.close();
  });

  return { app, ctx };
}
