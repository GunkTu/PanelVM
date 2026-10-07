import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { SecretBox } from '../crypto/secrets.js';

export type Stage = 'pending_2fa' | 'pending_setup' | 'active';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  stage: Stage;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  fail_count: number;
}

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const PENDING_MS = 10 * 60 * 1000;
export const MAX_2FA_FAILS = 5;
const TOUCH_INTERVAL_MS = 60 * 1000;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly csrfKey: string,
  ) {}

  /** Buat sesi baru; token mentah hanya dikembalikan sekali (untuk cookie), DB menyimpan hash-nya. */
  create(userId: string, stage: Stage, ip: string | null, userAgent: string | null) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, token_hash, stage, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        userId,
        this.box.mac('session', token),
        stage,
        ip,
        userAgent?.slice(0, 300) ?? null,
        now,
        now,
        now + (stage === 'active' ? SESSION_ABSOLUTE_MS : PENDING_MS),
      );
    return { token, id };
  }

  /** Cari sesi dari token cookie; sesi kedaluwarsa (absolut atau idle) dihapus. */
  resolve(token: string): SessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(this.box.mac('session', token)) as SessionRow | undefined;
    if (!row) return null;
    const now = Date.now();
    const idleLimit = row.stage === 'active' ? SESSION_IDLE_MS : PENDING_MS;
    if (now > row.expires_at || now - row.last_seen_at > idleLimit) {
      this.destroy(row.id);
      return null;
    }
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return row;
  }

  /** Naikkan pending -> active dengan token baru (mencegah session fixation). */
  promote(sessionId: string, userId: string, ip: string | null, ua: string | null) {
    this.destroy(sessionId);
    return this.create(userId, 'active', ip, ua);
  }

  recordFail(sessionId: string): number {
    this.db.prepare('UPDATE sessions SET fail_count = fail_count + 1 WHERE id = ?').run(sessionId);
    return (
      (
        this.db.prepare('SELECT fail_count FROM sessions WHERE id = ?').get(sessionId) as
          { fail_count: number } | undefined
      )?.fail_count ?? MAX_2FA_FAILS
    );
  }

  touch(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  isLive(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT id, expires_at, last_seen_at, stage FROM sessions WHERE id = ?')
      .get(sessionId) as
      Pick<SessionRow, 'id' | 'expires_at' | 'last_seen_at' | 'stage'> | undefined;
    if (!row) return false;
    const now = Date.now();
    return now <= row.expires_at && now - row.last_seen_at <= SESSION_IDLE_MS;
  }

  destroy(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  destroyAllForUser(userId: string): string[] {
    const ids = (
      this.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as { id: string }[]
    ).map((r) => r.id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return ids;
  }

  csrfToken(sessionId: string): string {
    return createHmac('sha256', this.csrfKey).update(`csrf:${sessionId}`).digest('base64url');
  }

  verifyCsrf(sessionId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const a = Buffer.from(this.csrfToken(sessionId));
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  purgeExpired(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(now - SESSION_IDLE_MS);
  }
}
