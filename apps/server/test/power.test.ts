import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hasOpenssl,
  makeCert,
  PVE_SECRET,
  PVE_TOKEN_ID,
  startFakePve,
  type FakePve,
} from './fakePve.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

describe.skipIf(!hasOpenssl)('tombol restart VM', () => {
  const tls = makeCert();
  let fake: FakePve;
  let app: FastifyInstance;
  let ctx: Awaited<ReturnType<typeof makeApp>>['ctx'];
  let admin: Client, owner: Client, other: Client;
  let linked = '';
  let manual = '';

  beforeAll(async () => {
    fake = await startFakePve(tls);
    const built = await makeApp();
    app = built.app;
    ctx = built.ctx;
    admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
    const ownerU = await seedUser(built, 'pemilik@contoh.com');
    owner = await login(app, ownerU);
    other = await login(app, await seedUser(built, 'lain@contoh.com'));
    const conn = await call(app, admin, 'POST', '/api/admin/proxmox', {
      name: 'Cluster uji',
      endpoints: [{ url: fake.url, fingerprint: tls.fingerprint }],
      tokenId: PVE_TOKEN_ID,
      tokenSecret: PVE_SECRET,
    });
    const mk = async (name: string) =>
      (
        await call(app, admin, 'POST', '/api/vms', { name, host: '127.0.0.1', sshUser: 'root' })
      ).json().id as string;
    linked = await mk('vm-tertaut');
    manual = await mk('vm-manual');
    await call(app, admin, 'PUT', `/api/vms/${linked}/assignment`, { userId: ownerU.row.id });
    ctx.db
      .prepare(
        'INSERT INTO vm_proxmox (vm_id, connection_id, node, vmid, template_vmid, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(linked, conn.json().id, 'pve1', 101, 9000, Date.now());
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
    tls.cleanup();
  });

  const reboots = () => fake.requests.filter((r) => /status\/reboot$/.test(r.path));

  it('otorisasi: tanpa login 401, client lain 404, tidak ada panggilan ke Proxmox', async () => {
    fake.requests.length = 0;
    expect((await call(app, null, 'POST', `/api/vms/${linked}/power/reboot`, {})).statusCode).toBe(
      401,
    );
    expect((await call(app, other, 'POST', `/api/vms/${linked}/power/reboot`, {})).statusCode).toBe(
      404,
    );
    expect((await call(app, other, 'GET', `/api/vms/${linked}/power`)).statusCode).toBe(404);
    expect(reboots()).toHaveLength(0);
  });

  it('status daya: tersedia untuk VM bertaut, tidak untuk VM manual', async () => {
    const a = await call(app, owner, 'GET', `/api/vms/${linked}/power`);
    expect(a.json()).toEqual({ available: true, status: 'running' });
    const b = await call(app, admin, 'GET', `/api/vms/${manual}/power`);
    expect(b.json()).toEqual({ available: false, status: null });
  });

  it('pemilik me-restart VM-nya: reboot dikirim ke node dan vmid yang benar, tercatat di audit', async () => {
    fake.requests.length = 0;
    const r = await call(app, owner, 'POST', `/api/vms/${linked}/power/reboot`, {});
    expect(r.statusCode).toBe(200);
    expect(reboots().map((x) => [x.method, x.path])).toEqual([
      ['POST', '/nodes/pve1/qemu/101/status/reboot'],
    ]);
    const rows = JSON.stringify(
      ctx.db
        .prepare("SELECT action, target, result FROM audit_logs WHERE action = 'vm.reboot'")
        .all(),
    );
    expect(rows).toContain('vm-tertaut');
    expect(rows).not.toContain(PVE_SECRET);
  });

  it('VM manual: ditolak dengan petunjuk, tanpa panggilan ke Proxmox', async () => {
    fake.requests.length = 0;
    const r = await call(app, admin, 'POST', `/api/vms/${manual}/power/reboot`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('power_unavailable');
    expect(fake.requests).toHaveLength(0);
  });
});
