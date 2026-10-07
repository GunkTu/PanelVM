import type { Audit } from './audit/index.js';
import type { SessionService } from './auth/sessions.js';
import type { Env } from './config/env.js';
import type { SecretBox } from './crypto/secrets.js';
import type { Db } from './db/index.js';
import type { TerminalRegistry } from './modules/terminal/registry.js';

/** Dependensi bersama yang diteruskan ke semua modul route. */
export interface Ctx {
  env: Env;
  db: Db;
  box: SecretBox;
  audit: Audit;
  sessions: SessionService;
  terminals: TerminalRegistry;
}
