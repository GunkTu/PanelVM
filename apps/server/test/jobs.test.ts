import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import { JobService, WAIT_TIMEOUT_MS, toPublicJob } from '../src/modules/jobs/service.js';
import { DB_CHECK_PHP } from '../src/modules/sites/deploy.js';
import { runSteps } from '../src/modules/software/install.js';
import { execRemote } from '../src/ssh/exec.js';
import { call, login, makeApp, seedUser } from './helpers.js';

// execRemote dipalsukan agar hasil pemeriksaan gerbang bisa diatur per test.
vi.mock('../src/ssh/exec.js', () => ({ execRemote: vi.fn() }));

const built = await makeApp();
const { ctx } = built;
let userId = '';
let vmId = '';
let otherVmId = '';

beforeAll(async () => {
  userId = (await seedUser(built, 'pemilik@contoh.com')).row.id;
  const mkVm = (id: string, name: string) =>
    ctx.db
      .prepare(
        "INSERT INTO vms (id, name, host, ssh_user, ssh_private_key_enc, ssh_public_key, created_at) VALUES (?, ?, '127.0.0.1', 'root', 'x', 'x', ?)",
      )
      .run(id, name, Date.now());
  vmId = crypto.randomUUID();
  otherVmId = crypto.randomUUID();
  mkVm(vmId, 'vm-job');
  mkVm(otherVmId, 'vm-lain');
});
afterAll(() => built.app.close());

const input = () => ({ vmId, userId, kind: 'deploy', title: 'Deploy contoh', vmName: 'vm-job' });
const tick = () => new Promise((r) => setTimeout(r, 30));
const status = (id: string) => ctx.jobs.get(vmId, id).status;
const finish = async (id: string) => {
  for (let i = 0; i < 100 && ['running', 'waiting'].includes(status(id)); i++) await tick();
  return ctx.jobs.get(vmId, id);
};

describe('job yang menunggu tindakan pengguna', () => {
  it('berhenti di status waiting, memblokir job lain, lalu lanjut setelah Lanjutkan', async () => {
    const order: string[] = [];
    const job = ctx.jobs.start(input(), async (log, ctl) => {
      order.push('sebelum');
      log('langkah 1\n');
      const outcome = await ctl.waitForUser('Perbaiki .env dulu.');
      order.push(`sesudah:${outcome}`);
      log('langkah 2\n');
    });
    await tick();
    expect(status(job.id)).toBe('waiting');
    const pub = toPublicJob(ctx.jobs.get(vmId, job.id), true);
    expect(pub.waitMessage).toBe('Perbaiki .env dulu.');
    expect(pub.log).toContain('[MENUNGGU TINDAKAN] Perbaiki .env dulu.');
    expect(ctx.jobs.hasRunning(vmId)).toBe(true);
    expect(() => ctx.jobs.start(input(), async () => {})).toThrow(/Masih ada proses lain/);
    expect(order).toEqual(['sebelum']);

    const note = ctx.db
      .prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'job_waiting'")
      .get(userId) as { title: string };
    expect(note.title).toMatch(/Butuh tindakan/);

    ctx.jobs.respond(vmId, job.id, 'resume');
    const done = await finish(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.wait_message).toBeNull();
    expect(order).toEqual(['sebelum', 'sesudah:resume']);
    expect(done.log).toContain('langkah 2');
    expect(ctx.jobs.hasRunning(vmId)).toBe(false);
  });

  it('Batalkan: runner menerima cancel dan job berakhir gagal dengan pesan jelas', async () => {
    const job = ctx.jobs.start(input(), async (_log, ctl) => {
      if ((await ctl.waitForUser('Tunggu.')) === 'cancel')
        throw new AppError(409, 'job_cancelled', 'Dibatalkan oleh pengguna.');
    });
    await tick();
    ctx.jobs.respond(vmId, job.id, 'cancel');
    const done = await finish(job.id);
    expect(done.status).toBe('failed');
    expect(done.log).toContain('[GAGAL] Dibatalkan oleh pengguna.');
  });

  it('respons ke job yang tidak menunggu ditolak (409), dan job VM lain tidak bisa disentuh (404)', async () => {
    const waiting = ctx.jobs.start(input(), async (_l, ctl) => {
      await ctl.waitForUser('x');
    });
    await tick();
    expect(() => ctx.jobs.respond(otherVmId, waiting.id, 'resume')).toThrow(/tidak ditemukan/);
    ctx.jobs.respond(vmId, waiting.id, 'resume');
    await finish(waiting.id);
    try {
      ctx.jobs.respond(vmId, waiting.id, 'resume');
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe('job_not_waiting');
    }
  });

  it('menunggu lebih dari 30 menit membatalkan otomatis', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome = '';
      const job = ctx.jobs.start(input(), async (_l, ctl) => {
        outcome = await ctl.waitForUser('lama');
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(status(job.id)).toBe('waiting');
      await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS + 1000);
      expect(outcome).toBe('cancel');
    } finally {
      vi.useRealTimers();
    }
    await tick();
  });

  it('job menunggu saat server mulai ulang ditandai gagal (tidak bisa dilanjutkan)', () => {
    const id = crypto.randomUUID();
    ctx.db
      .prepare(
        "INSERT INTO jobs (id, vm_id, user_id, kind, title, status, wait_message, created_at) VALUES (?, ?, ?, 'deploy', 'Lama', 'waiting', 'x', ?)",
      )
      .run(id, vmId, userId, Date.now());
    new JobService(ctx);
    const row = ctx.jobs.get(vmId, id);
    expect(row.status).toBe('failed');
    expect(row.wait_message).toBeNull();
    expect(row.log).toContain('server panel dimulai ulang');
  });
});

/** Susun tiruan: urutan kode keluar pemeriksa gerbang dan urutan jawaban pengguna (Lanjutkan/Batalkan). */
function harness(gateCodes: number[], answers: ('resume' | 'cancel')[]) {
  const calls: string[] = [];
  const waits: string[] = [];
  let g = 0;
  vi.mocked(execRemote).mockImplementation(async (_ssh, argv) => {
    if (argv[0] === 'php' && argv[1] === '-r') {
      calls.push('gate');
      const code = gateCodes[g++] ?? 0;
      return { code, stdout: code ? '' : 'ok', stderr: code ? 'Gagal: db' : '', truncated: false };
    }
    calls.push('step');
    return { code: 0, stdout: '', stderr: '', truncated: false };
  });
  const queue = [...answers];
  const ctl = {
    waitForUser: async (m: string) => {
      waits.push(m);
      return queue.shift() ?? 'cancel';
    },
  };
  const ssh = {} as never;
  return {
    calls,
    waits,
    run: (steps: Parameters<typeof runSteps>[2]) =>
      runSteps(ssh, { sudo: false }, steps, () => {}, ctl),
    runWithoutControl: (steps: Parameters<typeof runSteps>[2]) =>
      runSteps(ssh, { sudo: false }, steps, () => {}),
  };
}

describe('runSteps dengan gerbang prasyarat', () => {
  const step = {
    title: 'Migrasi',
    argv: ['php', 'artisan', 'migrate'],
    gate: {
      title: 'Database',
      argv: ['php', '-r', 'cek'],
      message: (d: string) => `Perbaiki .env. Detail: ${d}`,
      cancelMessage: 'Dibatalkan sebelum migrasi.',
    },
  };

  it('menunggu pengguna tiap pemeriksaan gagal, lalu menjalankan langkah setelah lolos', async () => {
    const { run, calls, waits } = harness([1, 1, 0], ['resume', 'resume']);
    await run([step]);
    expect(calls).toEqual(['gate', 'gate', 'gate', 'step']);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toContain('Perbaiki .env');
  });

  it('batal -> galat job_cancelled dan langkah tidak dijalankan', async () => {
    const { run, calls } = harness([1], ['cancel']);
    await expect(run([step])).rejects.toMatchObject({ code: 'job_cancelled' });
    expect(calls).toEqual(['gate']);
  });

  it('tanpa kendali job (bukan job latar belakang), kegagalan gerbang langsung galat', async () => {
    const { runWithoutControl } = harness([1], []);
    await expect(runWithoutControl([step])).rejects.toMatchObject({ code: 'gate_failed' });
  });
});

const hasPhp = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPhp)('pemeriksa database Laravel (PHP sungguhan)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbcheck-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const check = (env: string | null, files: Record<string, string> = {}) => {
    const cwd = mkdtempSync(join(dir, 'app-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), body);
    }
    if (env !== null) writeFileSync(join(cwd, '.env'), env);
    try {
      const out = execFileSync('php', ['-r', DB_CHECK_PHP], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  it('.env tidak ada -> kode 2 dengan pesan jelas', () => {
    const r = check(null);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/file \.env tidak ditemukan/);
  });

  it('SQLite (path bawaan database/database.sqlite): file ada lolos, tidak ada gagal', () => {
    const present = check('DB_CONNECTION=sqlite', { 'database/database.sqlite': '' });
    expect(present.code).toBe(0);
    expect(present.out).toMatch(/DB_CONNECTION=sqlite file=/);
    const missing = check('DB_CONNECTION=sqlite');
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/File SQLite tidak ada/);
  });

  it('MySQL: DB_DATABASE kosong dan server tidak terjangkau gagal; password tidak pernah dicetak', () => {
    const empty = check('DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=\n');
    expect(empty.code).toBe(1);
    expect(empty.out).toMatch(/DB_DATABASE masih kosong/);

    const unreachable = check(
      'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=1\nDB_DATABASE=app\nDB_USERNAME=root\nDB_PASSWORD="rahasia-banget-123"\n',
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toMatch(/Gagal:/);
    expect(unreachable.out).toMatch(/database=app user=root/);
    expect(unreachable.out).not.toContain('rahasia-banget-123');
  });

  it('nilai ber-kutip, komentar, dan awalan export dibaca benar', () => {
    const r = check(
      'export DB_CONNECTION=\'mysql\' # komentar\nDB_HOST="127.0.0.1"\nDB_PORT=1 # port ditolak\nDB_DATABASE="nama app"\n',
    );
    expect(r.out).toMatch(/host=127\.0\.0\.1 port=1 database=nama app/);
  });
});

describe('endpoint Lanjutkan/Batalkan: otorisasi', () => {
  it('hanya pemilik VM yang bisa; user lain 404, tanpa login 401', async () => {
    const owner = await seedUser(built, 'pemilik-vm@contoh.com');
    const stranger = await seedUser(built, 'orang-lain@contoh.com');
    ctx.db
      .prepare('INSERT INTO vm_access (id, user_id, vm_id, role) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.row.id, vmId, 'client');
    const ownerC = await login(built.app, owner);
    const strangerC = await login(built.app, stranger);

    const job = ctx.jobs.start(input(), async (_l, ctl) => {
      await ctl.waitForUser('Perbaiki .env.');
    });
    await tick();
    const url = (action: string) => `/api/vms/${vmId}/jobs/${job.id}/${action}`;

    for (const action of ['resume', 'cancel']) {
      expect((await call(built.app, null, 'POST', url(action), {})).statusCode).toBe(401);
      expect((await call(built.app, strangerC, 'POST', url(action), {})).statusCode).toBe(404);
    }
    expect(status(job.id)).toBe('waiting');

    const detail = await call(built.app, ownerC, 'GET', `/api/vms/${vmId}/jobs/${job.id}`);
    expect(detail.json().status).toBe('waiting');
    expect(detail.json().waitMessage).toBe('Perbaiki .env.');

    const ok = await call(built.app, ownerC, 'POST', url('resume'), {});
    expect(ok.statusCode).toBe(200);
    await finish(job.id);
    expect(status(job.id)).toBe('succeeded');

    const again = await call(built.app, ownerC, 'POST', url('resume'), {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('job_not_waiting');
  });
});
