import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { AppError } from '../errors.js';
import { hashPassword, passwordSchema } from './passwords.js';

export type Role = 'admin' | 'client';
export type UserStatus = 'active' | 'suspended';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  failed_attempts: number;
  locked_until: number | null;
  created_at: number;
  last_login_at: number | null;
  max_sites: number;
}

/** Bentuk user yang aman dikirim ke browser (tanpa hash, secret, dan counter internal). */
export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  maxSites: number;
}

export const toPublicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  status: u.status,
  totpEnabled: u.totp_enabled === 1,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
  maxSites: u.max_sites,
});

export const getUserById = (db: Db, id: string): UserRow | undefined =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

export const getUserByEmail = (db: Db, email: string): UserRow | undefined =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

export async function createUser(
  db: Db,
  input: { email: string; password: string; role: Role },
): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const pw = passwordSchema.safeParse(input.password);
  if (!pw.success)
    throw new AppError(
      400,
      'weak_password',
      pw.error.issues[0]?.message ?? 'Password tidak valid.',
    );
  if (getUserByEmail(db, email)) {
    throw new AppError(
      409,
      'email_taken',
      'Email ini sudah terdaftar. Gunakan email lain atau kelola akun yang ada.',
    );
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, email, await hashPassword(input.password), input.role, 'active', Date.now());
  return getUserById(db, id)!;
}
