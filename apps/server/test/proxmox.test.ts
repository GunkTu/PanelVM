import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { RequestListener } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto/secrets.js';
import { rotateMasterKey } from '../src/crypto/rotate.js';
import { openDb, migrate } from '../src/db/index.js';
import {
  ALLOWED_CALLS,
  ProxmoxClient,
  isAllowedCall,
  normalizeFingerprint,
  scanCertificate,
} from '../src/modules/proxmox/api.js';
import { collectInventory, parseTemplateOs } from '../src/modules/proxmox/inventory.js';
import { call, login, makeApp, seedUser } from './helpers.js';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TOKEN_ID = 'panel@pve!panel';
const SECRET = '11111111-2222-3333-4444-555555555555';

describe('parseTemplateOs', () => {
  it('mengenali Debian dan Ubuntu dari nama template', () => {
    expect(parseTemplateOs('tpl-debian12-pve1')).toEqual({
      id: 'debian12',
      label: 'Debian 12',
      sshUser: 'debian',
    });
    expect(parseTemplateOs('tpl-ubuntu2404-pve2')).toEqual({
      id: 'ubuntu2404',
      label: 'Ubuntu 24.04',
      sshUser: 'ubuntu',
    });
    expect(parseTemplateOs('tpl-debian13')?.label).toBe('Debian 13');
    expect(parseTemplateOs('tpl-ubuntu2204-node-3')?.label).toBe('Ubuntu 22.04');
  });

  it('mengabaikan nama lain (tidak menebak user SSH)', () => {
    for (const n of [
      '',
      'web-server',
      'tpl-centos9',
      'tpl-debian',
      'tpl-debian1',
      'tpl-debian12345',
      'tpl-ubuntu24',
      'tpl-ubuntu2404 x',
      'TPL-debian12',
      'tpl-debian12-;rm',
      'template-debian12',
    ]) {
      expect(parseTemplateOs(n), JSON.stringify(n)).toBeNull();
    }
  });
});

describe('daftar panggilan yang diizinkan', () => {
  it('hanya membaca (GET); tidak ada DELETE dan tidak ada penghapusan', () => {
    for (const c of ALLOWED_CALLS) expect(c.method).not.toBe('DELETE');
    expect(isAllowedCall('GET', '/nodes')).toBe(true);
    expect(isAllowedCall('GET', '/nodes/pve1/qemu')).toBe(true);
    expect(isAllowedCall('GET', '/nodes/pve1/qemu/100/config')).toBe(true);
    // Tahap B: hanya yang dibutuhkan untuk membuat VM
    expect(isAllowedCall('POST', '/nodes/pve1/qemu/9000/clone')).toBe(true);
    expect(isAllowedCall('PUT', '/nodes/pve1/qemu/200/config')).toBe(true);
    expect(isAllowedCall('PUT', '/nodes/pve1/qemu/200/resize')).toBe(true);
    expect(isAllowedCall('POST', '/nodes/pve1/qemu/200/status/start')).toBe(true);
    for (const [m, p] of [
      ['DELETE', '/nodes/pve1/qemu/100'],
      ['DELETE', '/nodes/pve1/lxc/100'],
      ['GET', '/nodes/pve1/qemu/100'],
      ['POST', '/nodes/pve1/qemu/100/status/stop'],
      ['POST', '/nodes/pve1/qemu/100/status/stop'],
      ['POST', '/nodes/pve1/qemu/100/status/shutdown'],
      ['POST', '/nodes/pve1/qemu/100/status/reboot'],
      ['POST', '/nodes/pve1/qemu'],
      ['POST', '/nodes/pve1/qemu/100/migrate'],
      ['PUT', '/nodes/pve1/qemu/100/status/start'],
      ['DELETE', '/nodes/pve1/qemu/100/config'],
      ['GET', '/nodes/pve1/qemu/100/status/start'],
      ['GET', '/nodes/../version'],
      ['GET', '/nodes/pve1/qemu/abc/config'],
      ['GET', '/access/users'],
      ['GET', '/nodes/pve1/qemu/100/config/extra'],
    ] as const) {
      expect(isAllowedCall(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it('klien menolak panggilan di luar daftar tanpa membuka koneksi', async () => {
    const client = new ProxmoxClient(
      [{ url: 'https://127.0.0.1:1', fingerprint: 'AA:'.repeat(31) + 'AA' }],
      { tokenId: TOKEN_ID, secret: SECRET },
    );
    const anyClient = client as unknown as { call: (m: string, p: string) => Promise<unknown> };
    await expect(anyClient.call('DELETE', '/nodes/pve1/qemu/100')).rejects.toMatchObject({
      code: 'proxmox_call_blocked',
    });
    await expect(anyClient.call('POST', '/nodes/pve1/qemu/100/status/stop')).rejects.toMatchObject({
      code: 'proxmox_call_blocked',
    });
  });
});

describe.skipIf(!hasOpenssl)('klien dan rute dengan server Proxmox tiruan (HTTPS + pin)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pve-'));
  interface Fake {
    url: string;
    fingerprint: string;
    requests: { method: string; url: string; auth: string | undefined }[];
    close: () => Promise<void>;
  }
  let key = '';
  let cert = '';
  let fingerprint = '';

  const handlers = (requests: Fake['requests']): RequestListener => {
    const perms: Record<string, Record<string, number>> = {
      '/pool/panel': Object.fromEntries(
        [
          'VM.Allocate',
          'VM.Config.CPU',
          'VM.Config.Memory',
          'VM.Config.Disk',
          'VM.Config.Network',
          'VM.Config.Cloudinit',
          'VM.Config.CDROM',
          'VM.Config.Options',
          'VM.PowerMgmt',
          'VM.Audit',
        ].map((p) => [p, 1]),
      ),
      '/storage/local-lvm': { 'Datastore.AllocateSpace': 1 },
      '/nodes': { 'Sys.Audit': 1 },
      '/vms/9000': {}, // sengaja kurang: tidak ada VM.Clone
      '/vms/9010': { 'VM.Clone': 1 },
    };
    return (req, res) => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
      });
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { data } : { errors: 'x' }));
      };
      if (req.headers.authorization !== `PVEAPIToken=${TOKEN_ID}=${SECRET}`) return send(401);
      const u = new URL(req.url ?? '/', 'https://x');
      const p = u.pathname.replace('/api2/json', '');
      if (p === '/version') return send(200, { version: '8.4.14' });
      if (p === '/nodes')
        return send(200, [
          { node: 'pve1', status: 'online', cpu: 0.25, maxcpu: 8, mem: 4e9, maxmem: 16e9 },
          { node: 'pve2', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1e9, maxmem: 8e9 },
          { node: 'pve3', status: 'offline' },
        ]);
      if (p === '/nodes/pve1/qemu')
        return send(200, [
          { vmid: 9000, name: 'tpl-debian12-pve1', template: 1 },
          { vmid: 9010, name: 'tpl-ubuntu2404-pve1', template: 1 },
          { vmid: 9999, name: 'tpl-centos9', template: 1 },
          { vmid: 100, name: 'web', status: 'running' },
        ]);
      if (p === '/nodes/pve2/qemu') return send(200, []);
      if (p === '/nodes/pve1/storage' || p === '/nodes/pve2/storage')
        return send(200, [
          {
            storage: 'local-lvm',
            type: 'lvmthin',
            avail: 50e9,
            total: 100e9,
            active: 1,
            enabled: 1,
          },
          { storage: 'mati', type: 'dir', active: 0, enabled: 1 },
        ]);
      if (p === '/nodes/pve1/network' || p === '/nodes/pve2/network')
        return send(200, [{ iface: 'vmbr0' }, { iface: 'vmbr1' }]);
      if (p === '/access/permissions') {
        const path = u.searchParams.get('path') ?? '';
        return send(200, path in perms ? { [path]: perms[path] } : {});
      }
      return send(404);
    };
  };

  const start = async (): Promise<Fake> => {
    const requests: Fake['requests'] = [];
    const server = https.createServer({ key, cert }, handlers(requests));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fingerprint,
      requests,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };

  let fake: Fake;
  beforeAll(async () => {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(join(dir, 'k.pem'), 'utf8');
    cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    fingerprint = new X509Certificate(cert).fingerprint256;
    fake = await start();
  });
  afterAll(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const clientFor = (eps: { url: string; fingerprint: string }[], secret = SECRET) =>
    new ProxmoxClient(eps, { tokenId: TOKEN_ID, secret });

  describe('klien API', () => {
    it('memindai sertifikat dan memakai pin yang benar; token lewat header Authorization', async () => {
      const scan = await scanCertificate(fake.url);
      expect(normalizeFingerprint(scan.fingerprint)).toBe(normalizeFingerprint(fingerprint));
      const before = fake.requests.length;
      const v = await clientFor([{ url: fake.url, fingerprint }]).get<{ version: string }>(
        '/version',
      );
      expect(v.version).toBe('8.4.14');
      const last = fake.requests[fake.requests.length - 1]!;
      expect(fake.requests.length).toBe(before + 1);
      expect(last.auth).toBe(`PVEAPIToken=${TOKEN_ID}=${SECRET}`);
      expect(last.url).not.toContain(SECRET); // token tidak pernah di URL
    });

    it('fingerprint salah: ditolak SEBELUM data apa pun (termasuk token) dikirim', async () => {
      const before = fake.requests.length;
      const wrong = 'AA:'.repeat(31) + 'AA';
      await expect(
        clientFor([{ url: fake.url, fingerprint: wrong }]).get('/version'),
      ).rejects.toMatchObject({
        code: 'proxmox_cert_changed',
      });
      expect(fake.requests.length).toBe(before); // server tidak menerima request sama sekali
    });

    it('beralih ke endpoint cadangan bila yang pertama mati atau pin-nya tidak cocok', async () => {
      const dead = { url: 'https://127.0.0.1:1', fingerprint };
      const good = { url: fake.url, fingerprint };
      expect((await clientFor([dead, good]).get<{ version: string }>('/version')).version).toBe(
        '8.4.14',
      );
      const wrongPin = { url: fake.url, fingerprint: 'BB:'.repeat(31) + 'BB' };
      const before = fake.requests.length;
      await clientFor([wrongPin, good]).get('/version');
      expect(fake.requests.length).toBe(before + 1); // hanya endpoint dengan pin benar yang menerima request
    });

    it('semua endpoint mati: pesan jelas dengan langkah berikutnya', async () => {
      await expect(
        clientFor([{ url: 'https://127.0.0.1:1', fingerprint }]).get('/version'),
      ).rejects.toMatchObject({ code: 'proxmox_unreachable' });
    });

    it('token salah -> 401 yang jelas, tanpa beralih endpoint', async () => {
      const ep = { url: fake.url, fingerprint };
      await expect(clientFor([ep, ep], 'salah-salah-salah').get('/version')).rejects.toMatchObject({
        code: 'proxmox_auth',
        status: 401,
      });
    });
  });

  describe('inventaris', () => {
    it('node online diperiksa, node offline dilewati; template dikenali; storage tidak aktif disaring', async () => {
      const inv = await collectInventory(clientFor([{ url: fake.url, fingerprint }]));
      expect(inv.version).toBe('8.4.14');
      expect(inv.nodes.map((n) => [n.node, n.online])).toEqual([
        ['pve1', true],
        ['pve2', true],
        ['pve3', false],
      ]);
      const pve1 = inv.nodes[0]!;
      expect(pve1.templates.map((t) => [t.vmid, t.os.id, t.os.sshUser])).toEqual([
        [9000, 'debian12', 'debian'],
        [9010, 'ubuntu2404', 'ubuntu'],
      ]);
      expect(pve1.ignoredTemplates).toBe(1); // tpl-centos9
      expect(pve1.storages).toEqual([
        { name: 'local-lvm', type: 'lvmthin', availBytes: 50e9, totalBytes: 100e9, shared: false },
      ]);
      expect(pve1.bridges).toEqual(['vmbr0', 'vmbr1']);
      expect(pve1.cpuPercent).toBe(25);
      expect(pve1.memFreeBytes).toBe(12e9);
      expect(inv.nodes[2]!.templates).toEqual([]);
    });
  });

  describe('rute admin', () => {
    const body = (over: Record<string, unknown> = {}) => ({
      name: 'Cluster rumah',
      endpoints: [{ url: fake.url, fingerprint }],
      tokenId: TOKEN_ID,
      tokenSecret: SECRET,
      ...over,
    });

    it('hanya admin: client 403, tanpa login 401', async () => {
      const built = await makeApp();
      try {
        const client = await login(built.app, await seedUser(built, 'klien@contoh.com'));
        for (const [m, u] of [
          ['GET', '/api/admin/proxmox'],
          ['POST', '/api/admin/proxmox'],
          ['POST', '/api/admin/proxmox/scan-cert'],
          ['POST', `/api/admin/proxmox/${crypto.randomUUID()}/test`],
          ['DELETE', `/api/admin/proxmox/${crypto.randomUUID()}`],
        ] as const) {
          expect((await call(built.app, client, m, u, {})).statusCode, `${m} ${u}`).toBe(403);
          expect((await call(built.app, null, m, u, {})).statusCode, `${m} ${u} tanpa login`).toBe(
            401,
          );
        }
      } finally {
        await built.app.close();
      }
    });

    it('alur penuh: scan sertifikat, tambah, tes, perbarui pin, hapus catatan', async () => {
      const built = await makeApp();
      const { app, ctx } = built;
      try {
        const admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));

        const scan = await call(app, admin, 'POST', '/api/admin/proxmox/scan-cert', {
          url: fake.url,
        });
        expect(scan.statusCode).toBe(200);
        expect(normalizeFingerprint(scan.json().fingerprint)).toBe(
          normalizeFingerprint(fingerprint),
        );
        expect(
          (await call(app, admin, 'POST', '/api/admin/proxmox/scan-cert', { url: 'http://x:8006' }))
            .statusCode,
        ).toBe(400);
        expect(
          (
            await call(app, admin, 'POST', '/api/admin/proxmox/scan-cert', {
              url: 'https://u:p@x:8006',
            })
          ).statusCode,
        ).toBe(400);

        // token salah: ditolak dan tidak ada yang tersimpan
        const bad = await call(
          app,
          admin,
          'POST',
          '/api/admin/proxmox',
          body({ tokenSecret: 'salah-salah-salah' }),
        );
        expect(bad.statusCode).toBe(401);
        expect(bad.json().error).toBe('proxmox_auth');
        expect(ctx.db.prepare('SELECT COUNT(*) c FROM proxmox_connections').get()).toEqual({
          c: 0,
        });

        const created = await call(app, admin, 'POST', '/api/admin/proxmox', body());
        expect(created.statusCode).toBe(201);
        const conn = created.json();
        expect(JSON.stringify(conn)).not.toContain(SECRET);
        expect(conn).toMatchObject({ name: 'Cluster rumah', tokenId: TOKEN_ID, pool: 'panel' });

        // secret tersimpan terenkripsi (AAD terikat id), bukan teks biasa
        const row = ctx.db.prepare('SELECT token_secret_enc e FROM proxmox_connections').get() as {
          e: string;
        };
        expect(row.e).not.toContain(SECRET);
        expect(ctx.box.decrypt(row.e, `proxmox.token:${conn.id}`)).toBe(SECRET);
        expect(() => ctx.box.decrypt(row.e, 'proxmox.token:lain')).toThrow();

        const dupe = await call(app, admin, 'POST', '/api/admin/proxmox', body());
        expect(dupe.statusCode).toBe(409);

        const list = await call(app, admin, 'GET', '/api/admin/proxmox');
        expect(list.body).not.toContain(SECRET);
        expect(list.json().items).toHaveLength(1);

        const t = await call(app, admin, 'POST', `/api/admin/proxmox/${conn.id}/test`, {});
        expect(t.statusCode).toBe(200);
        expect(t.body).not.toContain(SECRET);
        const tj = t.json();
        expect(tj.inventory.nodes).toHaveLength(3);
        const perms = tj.permissions as { path: string; missing: string[]; unknown?: boolean }[];
        expect(perms.find((p) => p.path === '/pool/panel')!.missing).toEqual([]);
        expect(perms.find((p) => p.path === '/storage/local-lvm')!.missing).toEqual([]);
        expect(perms.find((p) => p.path === '/vms/9000')!.missing).toEqual(['VM.Clone']);
        expect(perms.find((p) => p.path === '/vms/9010')!.missing).toEqual([]);

        // pin yang salah ditolak dan data lama tidak berubah
        const badPin = await call(app, admin, 'PUT', `/api/admin/proxmox/${conn.id}/endpoints`, {
          endpoints: [{ url: fake.url, fingerprint: 'CC:'.repeat(31) + 'CC' }],
        });
        expect(badPin.statusCode).toBe(502);
        expect(badPin.json().error).toBe('proxmox_cert_changed');
        const same = await call(app, admin, 'GET', '/api/admin/proxmox');
        expect(same.json().items[0].endpoints[0].fingerprint).toBe(fingerprint);

        const ok = await call(app, admin, 'PUT', `/api/admin/proxmox/${conn.id}/endpoints`, {
          endpoints: [{ url: fake.url, fingerprint }],
        });
        expect(ok.statusCode).toBe(200);

        // audit memuat aksi tetapi tidak pernah secret
        const audit = JSON.stringify(
          ctx.db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'proxmox.%'").all(),
        );
        for (const a of ['proxmox.add', 'proxmox.test', 'proxmox.update_pins', 'proxmox.scan_cert'])
          expect(audit).toContain(a);
        expect(audit).not.toContain(SECRET);

        // semua panggilan ke Proxmox hanya GET (tidak pernah mengubah apa pun)
        expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);

        expect((await call(app, admin, 'DELETE', `/api/admin/proxmox/${conn.id}`)).statusCode).toBe(
          200,
        );
        expect(ctx.db.prepare('SELECT COUNT(*) c FROM proxmox_connections').get()).toEqual({
          c: 0,
        });
        expect(
          (await call(app, admin, 'POST', `/api/admin/proxmox/${conn.id}/test`, {})).statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('validasi input: alamat, fingerprint, token, nama', async () => {
      const built = await makeApp();
      try {
        const admin = await login(built.app, await seedUser(built, 'admin2@contoh.com', 'admin'));
        for (const over of [
          { endpoints: [] },
          { endpoints: [{ url: 'http://x:8006', fingerprint }] },
          { endpoints: [{ url: 'https://x:8006/api', fingerprint }] },
          { endpoints: [{ url: fake.url, fingerprint: 'bukan-fingerprint' }] },
          { tokenId: 'tanpa-format' },
          { tokenSecret: 'x' },
          { name: '' },
          { pool: 'a b' },
        ]) {
          const r = await call(built.app, admin, 'POST', '/api/admin/proxmox', body(over));
          expect(r.statusCode, JSON.stringify(over)).toBe(400);
        }
      } finally {
        await built.app.close();
      }
    });
  });
});

describe('rotasi master key mencakup token Proxmox', () => {
  it('token dienkripsi ulang dengan AAD yang sama dan bisa dibaca dengan kunci baru', () => {
    const db = openDb(':memory:');
    migrate(db);
    const oldBox = new SecretBox(Buffer.alloc(32, 1));
    const newBox = new SecretBox(Buffer.alloc(32, 2));
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO proxmox_connections (id, name, endpoints, token_id, token_secret_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, 'x', '[]', TOKEN_ID, oldBox.encrypt(SECRET, `proxmox.token:${id}`), Date.now());
    expect(rotateMasterKey(db, oldBox, newBox).proxmoxTokens).toBe(1);
    const row = db.prepare('SELECT token_secret_enc e FROM proxmox_connections').get() as {
      e: string;
    };
    expect(newBox.decrypt(row.e, `proxmox.token:${id}`)).toBe(SECRET);
    expect(() => oldBox.decrypt(row.e, `proxmox.token:${id}`)).toThrow();
  });
});
