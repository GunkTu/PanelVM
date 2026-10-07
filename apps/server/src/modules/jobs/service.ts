import { randomUUID } from 'node:crypto';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { notify } from '../notifications/service.js';

export interface JobRow {
  id: string;
  vm_id: string;
  user_id: string;
  kind: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  log: string;
  created_at: number;
  finished_at: number | null;
}

export interface PublicJob {
  id: string;
  kind: string;
  title: string;
  status: JobRow['status'];
  log?: string;
  createdAt: number;
  finishedAt: number | null;
}

const LOG_CAP = 512 * 1024;
const FLUSH_MS = 400;

export const toPublicJob = (j: JobRow, withLog: boolean): PublicJob => ({
  id: j.id,
  kind: j.kind,
  title: j.title,
  status: j.status,
  ...(withLog ? { log: j.log } : {}),
  createdAt: j.created_at,
  finishedAt: j.finished_at,
});

export type JobRunner = (log: (text: string) => void) => Promise<void>;

/** Job latar belakang per VM (maksimal satu yang berjalan per VM, karena apt memakai lock). */
export class JobService {
  constructor(private readonly ctx: Ctx) {
    // Job yang sedang berjalan saat server mati tidak bisa dilanjutkan.
    ctx.db
      .prepare(
        "UPDATE jobs SET status = 'failed', finished_at = ?, log = log || ? WHERE status = 'running'",
      )
      .run(Date.now(), '\n[Dihentikan karena server panel dimulai ulang]\n');
  }

  hasRunning(vmId: string): boolean {
    return !!this.ctx.db
      .prepare("SELECT 1 AS ok FROM jobs WHERE vm_id = ? AND status = 'running'")
      .get(vmId);
  }

  start(
    input: {
      vmId: string;
      userId: string;
      ip?: string;
      kind: string;
      title: string;
      vmName: string;
    },
    runner: JobRunner,
  ): JobRow {
    const { db, audit } = this.ctx;
    if (this.hasRunning(input.vmId)) {
      throw new AppError(
        409,
        'job_running',
        'Masih ada proses lain yang berjalan di VM ini. Tunggu sampai selesai, lalu coba lagi.',
      );
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO jobs (id, vm_id, user_id, kind, title, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
    ).run(id, input.vmId, input.userId, input.kind, input.title, Date.now());
    audit.record({
      userId: input.userId,
      vmId: input.vmId,
      ip: input.ip,
      action: `job.${input.kind}`,
      target: input.title,
      result: 'ok',
      meta: { phase: 'start' },
    });

    let buffer = '';
    const flush = () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = '';
      db.prepare('UPDATE jobs SET log = substr(log || ?, -?) WHERE id = ?').run(chunk, LOG_CAP, id);
    };
    const timer = setInterval(flush, FLUSH_MS);
    const log = (text: string) => {
      buffer += text;
    };

    void (async () => {
      let ok = true;
      try {
        await runner(log);
      } catch (e) {
        ok = false;
        log(
          `\n[GAGAL] ${e instanceof AppError ? e.message : 'Proses berhenti karena kesalahan di panel. Detail ada di log server.'}\n`,
        );
        if (!(e instanceof AppError)) this.ctx.log?.error({ err: e }, 'job error');
      } finally {
        clearInterval(timer);
        flush();
        db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
          ok ? 'succeeded' : 'failed',
          Date.now(),
          id,
        );
        notify(
          db,
          input.userId,
          'job',
          ok ? `Selesai: ${input.title}` : `Gagal: ${input.title}`,
          `${input.title} di VM "${input.vmName}" ${ok ? 'selesai.' : 'gagal. Buka halaman terkait untuk melihat log.'}`,
        );
        audit.record({
          userId: input.userId,
          vmId: input.vmId,
          ip: input.ip,
          action: `job.${input.kind}`,
          target: input.title,
          result: ok ? 'ok' : 'fail',
          meta: { phase: 'end' },
        });
      }
    })();

    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
  }

  get(vmId: string, jobId: string): JobRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM jobs WHERE id = ? AND vm_id = ?')
      .get(jobId, vmId) as JobRow | undefined;
    if (!row) throw notFound('Proses');
    return row;
  }

  list(vmId: string, limit = 20): JobRow[] {
    return this.ctx.db
      .prepare('SELECT * FROM jobs WHERE vm_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(vmId, limit) as JobRow[];
  }
}
