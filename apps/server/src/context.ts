import type { Audit } from './audit/index.js';
import type { SessionService } from './auth/sessions.js';
import type { Env } from './config/env.js';
import type { SecretBox } from './crypto/secrets.js';
import type { Db } from './db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { VmWatcher } from './modules/vms/watcher.js';
import type { JobService } from './modules/jobs/service.js';
import type { PreviewManager } from './modules/previews/service.js';
import type { SshPool } from './ssh/pool.js';
import type { TerminalRegistry } from './modules/terminal/registry.js';

/** Dependensi bersama yang diteruskan ke semua modul route. */
export interface Ctx {
  env: Env;
  db: Db;
  box: SecretBox;
  audit: Audit;
  sessions: SessionService;
  terminals: TerminalRegistry;
  pool: SshPool;
  jobs: JobService;
  previews: PreviewManager;
  watcher: VmWatcher;
  /** Diisi setelah Fastify dibuat. */
  log?: FastifyBaseLogger;
}
