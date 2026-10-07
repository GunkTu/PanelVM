import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, seedUser } from '../helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './vmFixture.js';

const built = await makeApp();
const { app, ctx } = built;
let f: VmFixture;

beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built, 'vm-sw', 'admin-sw@contoh.com');
});
afterAll(() => app.close());

const base = () => `/api/vms/${f.vmId}`;
async function waitJob(id: string, ms = 240_000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = (await call(app, f.admin, 'GET', `${base()}/jobs/${id}`)).json();
    if (r.status !== 'running') return r as { status: string; log: string; title: string };
    if (Date.now() > end) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!vmAvailable)('installer (VM nyata)', () => {
  it('mendeteksi OS, versi PHP, dan status paket', async () => {
    const r = await call(app, f.admin, 'GET', `${base()}/software`);
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.os).toMatchObject({ id: 'ubuntu', supported: true });
    expect(
      s.php.versions.some(
        (v: { version: string; installed: boolean }) => v.version === '8.3' && v.installed,
      ),
    ).toBe(true);
    const byId = Object.fromEntries(s.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.nginx.installed).toBe(true);
    expect(byId.mariadb.installed).toBe(true);
    expect(byId.mysql.conflict).toMatch(/MariaDB sudah terpasang/);
    expect(byId.composer.installed).toBe(true);
  });

  it('menolak input berbahaya/tidak valid dan konflik database', { timeout: 60_000 }, async () => {
    const inst = (b: unknown) => call(app, f.admin, 'POST', `${base()}/software/install`, b);
    expect((await inst({ item: 'rm -rf /' })).statusCode).toBe(400);
    expect((await inst({ item: 'php', version: '8.3; id' })).statusCode).toBe(400);
    expect((await inst({ item: 'php', version: '5.6' })).statusCode).toBe(400);
    expect((await inst({ item: 'php', version: '8.3', extensions: ['x; id'] })).statusCode).toBe(
      400,
    );
    expect((await inst({ item: 'mysql' })).statusCode).toBe(409);
    expect((await inst({ item: 'php-repo' })).statusCode).toBe(400); // wajib persetujuan pihak ketiga
    expect((await inst({ item: 'postgresql', version: '1' })).statusCode).toBe(400);
  });

  it(
    'menjalankan job apt-update dengan log live, satu job per VM, dan notifikasi selesai',
    { timeout: 120_000 },
    async () => {
      const start = await call(app, f.admin, 'POST', `${base()}/software/apt-update`, {});
      expect(start.statusCode).toBe(200);
      const id = start.json().id as string;
      const second = await call(app, f.admin, 'POST', `${base()}/software/apt-update`, {});
      expect(second.statusCode).toBe(409);
      const done = await waitJob(id);
      expect(done.status).toBe('succeeded');
      expect(done.log).toContain('$ apt-get update');
      expect(done.log).toContain('[SELESAI]');
      const n = ctx.db.prepare("SELECT title FROM notifications WHERE type = 'job'").all() as {
        title: string;
      }[];
      expect(n.some((x) => x.title.startsWith('Selesai:'))).toBe(true);
    },
  );

  it(
    'memasang paket sungguhan (redis) lewat apt dan memverifikasinya',
    { timeout: 300_000 },
    async () => {
      const r = await call(app, f.admin, 'POST', `${base()}/software/install`, { item: 'redis' });
      expect(r.statusCode).toBe(200);
      const done = await waitJob(r.json().id);
      expect(done.log).toContain('apt-get install');
      expect(done.status, done.log.slice(-800)).toBe('succeeded');
      const s = (await call(app, f.admin, 'GET', `${base()}/software`)).json();
      expect(s.items.find((i: { id: string }) => i.id === 'redis').installed).toBe(true);
    },
  );

  it(
    'memasang ekstensi PHP opsional hanya bila tersedia di repositori',
    { timeout: 300_000 },
    async () => {
      const r = await call(app, f.admin, 'POST', `${base()}/software/install`, {
        item: 'php',
        version: '8.3',
        extensions: ['soap'],
      });
      expect(r.statusCode).toBe(200);
      const done = await waitJob(r.json().id);
      expect(done.status, done.log.slice(-800)).toBe('succeeded');
      expect(done.log).toContain('php8.3-soap');
    },
  );

  it('client lain tidak bisa melihat atau memicu proses di VM ini (404) dan job tak bisa dibaca silang', async () => {
    const other = await seedUser(built, 'luar-sw@contoh.com');
    const c = await login(app, other);
    expect((await call(app, c, 'GET', `${base()}/software`)).statusCode).toBe(404);
    expect(
      (await call(app, c, 'POST', `${base()}/software/install`, { item: 'nginx' })).statusCode,
    ).toBe(404);
    expect((await call(app, c, 'POST', `${base()}/software/apt-update`, {})).statusCode).toBe(404);
    expect((await call(app, c, 'GET', `${base()}/jobs`)).statusCode).toBe(404);
    const anyJob = ctx.db.prepare('SELECT id FROM jobs LIMIT 1').get() as { id: string };
    expect((await call(app, c, 'GET', `${base()}/jobs/${anyJob.id}`)).statusCode).toBe(404);
  });
});
