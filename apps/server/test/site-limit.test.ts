import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

const fake = await startFakeSsh({});
const built = await makeApp();
const { app, ctx } = built;
let admin: Client, owner: Client, other: Client;
let ownerId = '';
let vmId = '';

beforeAll(async () => {
  admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
  const ownerU = await seedUser(built, 'pemilik@contoh.com');
  ownerId = ownerU.row.id;
  owner = await login(app, ownerU);
  other = await login(app, await seedUser(built, 'lain@contoh.com'));
  const r = await call(app, admin, 'POST', '/api/vms', {
    name: 'vm-batas',
    host: '127.0.0.1',
    sshPort: fake.port,
    sshUser: 'root',
  });
  vmId = r.json().id as string;
  await call(app, admin, 'PUT', `/api/vms/${vmId}/assignment`, { userId: ownerId });
  const fp = (await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/scan`)).json().fingerprint;
  await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/approve`, { fingerprint: fp });
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

const addSite = (domain: string) =>
  ctx.db
    .prepare(
      'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, web_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      crypto.randomUUID(),
      vmId,
      domain,
      'static',
      null,
      `/var/www/${domain}`,
      'nginx',
      Date.now(),
    );
const create = (c: Client, domain: string) =>
  call(app, c, 'POST', `/api/vms/${vmId}/sites`, { domain, kind: 'static' });

describe('batas situs web per client', () => {
  it('bawaan 5 dan terlihat di daftar pengguna beserta jumlah terpakai', async () => {
    const list = (await call(app, admin, 'GET', '/api/users')).json().items as {
      id: string;
      maxSites: number;
      siteCount: number;
    }[];
    expect(list.find((u) => u.id === ownerId)).toMatchObject({ maxSites: 5, siteCount: 0 });
  });

  it('hanya admin yang boleh mengubah; nilai tidak valid ditolak', async () => {
    const url = `/api/users/${ownerId}`;
    expect((await call(app, owner, 'PATCH', url, { maxSites: 99 })).statusCode).toBe(403);
    expect((await call(app, other, 'PATCH', url, { maxSites: 99 })).statusCode).toBe(403);
    for (const body of [
      {},
      { maxSites: -1 },
      { maxSites: 1001 },
      { maxSites: 1.5 },
      { maxSites: '3' },
    ]) {
      expect((await call(app, admin, 'PATCH', url, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
    expect((await call(app, admin, 'PATCH', url, { maxSites: 2 })).json().maxSites).toBe(2);
    const row = ctx.db
      .prepare("SELECT meta FROM audit_logs WHERE action = 'user.set_max_sites'")
      .get() as { meta: string };
    expect(JSON.parse(row.meta)).toEqual({ from: 5, to: 2 });
  });

  it('client yang sudah mencapai batas ditolak dengan pesan jelas; setelah dinaikkan bisa lagi', async () => {
    addSite('a.contoh.com');
    addSite('b.contoh.com');
    const r = await create(owner, 'c.contoh.com');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('site_limit');
    expect(r.json().message).toMatch(/2 dari 2/);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM sites').get()).toEqual({ c: 2 });

    await call(app, admin, 'PATCH', `/api/users/${ownerId}`, { maxSites: 3 });
    expect((await create(owner, 'c.contoh.com')).json().error).not.toBe('site_limit');
  });

  it('batas 0 melarang membuat situs; admin tidak dibatasi', async () => {
    await call(app, admin, 'PATCH', `/api/users/${ownerId}`, { maxSites: 0 });
    expect((await create(owner, 'd.contoh.com')).json().error).toBe('site_limit');
    expect((await create(admin, 'd.contoh.com')).json().error).not.toBe('site_limit');
  });
});
