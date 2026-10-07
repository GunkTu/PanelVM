import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/index.js';

/** Buat notifikasi in-app. Pengiriman email ditambahkan di Fase 2 (menunggu konfigurasi SMTP). */
export function notify(db: Db, userId: string, type: string, title: string, message: string): void {
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), userId, type, title, message, Date.now());
}

export function notifyAdmins(db: Db, type: string, title: string, message: string): void {
  const admins = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")
    .all() as {
    id: string;
  }[];
  for (const a of admins) notify(db, a.id, type, title, message);
}
