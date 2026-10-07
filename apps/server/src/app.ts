import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import type { Env } from './config/env.js';

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    // IP klien hanya dipercaya dari header proxy bila TRUST_PROXY aktif (di belakang NPM).
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
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

  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}
