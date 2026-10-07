import { afterAll, describe, expect, it } from 'vitest';
import { startFakeSsh, type FakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser } from './helpers.js';

const built = await makeApp();
const { app, ctx } = built;
let fake: FakeSsh;
afterAll(async () => {
  await fake?.close();
  await app.close();
});

const count = (type: string, userId?: string) =>
  (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE type = ?${userId ? ' AND user_id = ?' : ''}`,
      )
      .get(...(userId ? [type, userId] : [type])) as { n: number }
  ).n;
const status = (id: string) =>
  (ctx.db.prepare('SELECT status FROM vms WHERE id = ?').get(id) as { status: string }).status;

describe('pemeriksa status VM', () => {
  it('online -> offline -> online, notifikasi hanya saat status berubah', async () => {
    fake = await startFakeSsh();
    const adminU = await seedUser(built, 'admin-w@contoh.com', 'admin');
    const clientU = await seedUser(built, 'client-w@contoh.com');
    const admin = await login(app, adminU);
    const vm = (
      await call(app, admin, 'POST', '/api/vms', {
        name: 'vm-w',
        host: '127.0.0.1',
        sshPort: fake.port,
        sshUser: 'root',
      })
    ).json() as { id: string };
    const fp = (await call(app, admin, 'POST', `/api/vms/${vm.id}/host-key/scan`)).json()
      .fingerprint as string;
    await call(app, admin, 'POST', `/api/vms/${vm.id}/host-key/approve`, { fingerprint: fp });
    await call(app, admin, 'PUT', `/api/vms/${vm.id}/assignment`, { userId: clientU.row.id });
    expect((await call(app, admin, 'POST', `/api/vms/${vm.id}/test`)).statusCode).toBe(200);
    expect(status(vm.id)).toBe('online');

    await ctx.watcher.checkAll();
    expect(status(vm.id)).toBe('online');
    expect(count('vm_offline')).toBe(0);

    const { port, hostKey } = fake;
    await fake.close();
    await ctx.watcher.checkAll();
    expect(status(vm.id)).toBe('offline');
    expect(count('vm_offline', adminU.row.id)).toBe(1);
    expect(count('vm_offline', clientU.row.id)).toBe(1);

    await ctx.watcher.checkAll(); // masih offline: tidak boleh menambah notifikasi
    expect(count('vm_offline')).toBe(2);

    fake = await startFakeSsh({ port, hostKey });
    await ctx.watcher.checkAll();
    expect(status(vm.id)).toBe('online');
    expect(count('vm_online', adminU.row.id)).toBe(1);
    expect(count('vm_online', clientU.row.id)).toBe(1);
    const acts = (
      ctx.db
        .prepare(
          "SELECT action FROM audit_logs WHERE action LIKE 'vm.went%' OR action LIKE 'vm.came%' ORDER BY id",
        )
        .all() as { action: string }[]
    ).map((r) => r.action);
    expect(acts).toEqual(['vm.went_offline', 'vm.came_online']);
  });

  it('VM tanpa host key yang disetujui tidak diperiksa', async () => {
    const admin = await login(app, await seedUser(built, 'admin-w2@contoh.com', 'admin'));
    const vm = (
      await call(app, admin, 'POST', '/api/vms', {
        name: 'vm-w2',
        host: '127.0.0.1',
        sshPort: 1,
        sshUser: 'root',
      })
    ).json() as { id: string };
    await ctx.watcher.checkAll();
    expect(status(vm.id)).toBe('unknown');
  });
});
