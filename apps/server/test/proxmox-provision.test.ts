import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMainDisk } from '../src/modules/proxmox/inventory.js';
import {
  templateSetupHints,
  templatesOnNode,
  ipv4ToNumber,
  isHostIn,
  parseCidr,
  resolveNetwork,
  type CreateVmInput,
} from '../src/modules/proxmox/provision.js';
import type { Inventory } from '../src/modules/proxmox/inventory.js';
import { startFakeSsh } from './fakeSsh.js';
import {
  hasOpenssl,
  makeCert,
  PVE_SECRET,
  PVE_TOKEN_ID,
  startFakePve,
  type FakePve,
} from './fakePve.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';
import { normalizeFingerprint } from '../src/modules/proxmox/api.js';

describe('jaringan IPv4', () => {
  it('parseCidr dan ipv4ToNumber', () => {
    expect(parseCidr('192.168.10.50/24')).toMatchObject({ ip: '192.168.10.50', prefix: 24 });
    for (const bad of [
      '192.168.10.50',
      '192.168.10.50/33',
      '192.168.10.50/7',
      '192.168.10.50/31',
      '192.168.10.256/24',
      '192.168.10/24',
      '192.168.10.50/24/1',
      'a.b.c.d/24',
      '',
      '192.168.10.50/ 24',
    ]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
    expect(ipv4ToNumber('0.0.0.0')).toBe(0);
    expect(ipv4ToNumber('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToNumber('1.2.3')).toBeNull();
    expect(ipv4ToNumber('1.2.3.999')).toBeNull();
  });

  it('isHostIn: subnet sama, bukan alamat jaringan atau broadcast', () => {
    const c = parseCidr('192.168.10.50/24')!;
    expect(isHostIn(c, ipv4ToNumber('192.168.10.1')!)).toBe(true);
    expect(isHostIn(c, ipv4ToNumber('192.168.10.0')!)).toBe(false);
    expect(isHostIn(c, ipv4ToNumber('192.168.10.255')!)).toBe(false);
    expect(isHostIn(c, ipv4ToNumber('192.168.11.1')!)).toBe(false);
    const wide = parseCidr('10.1.2.3/16')!;
    expect(isHostIn(wide, ipv4ToNumber('10.1.200.9')!)).toBe(true);
    expect(isHostIn(wide, ipv4ToNumber('10.2.0.1')!)).toBe(false);
  });

  const input = (over: Partial<CreateVmInput> = {}): CreateVmInput => ({
    node: 'pve1',
    osId: 'debian12',
    name: 'web-uji',
    cores: 2,
    memoryMb: 2048,
    diskGb: 20,
    storage: 'local-lvm',
    bridge: 'vmbr0',
    ip: '192.168.10.50/24',
    gateway: '192.168.10.1',
    sshPort: 22,
    ...over,
  });

  it('resolveNetwork: hasil benar dan penolakan yang jelas', () => {
    expect(resolveNetwork(input({ dns: '1.1.1.1, 8.8.8.8' }))).toEqual({
      host: '192.168.10.50',
      ipconfig0: 'ip=192.168.10.50/24,gw=192.168.10.1',
      nameserver: '1.1.1.1 8.8.8.8',
    });
    expect(resolveNetwork(input()).nameserver).toBeNull();
    expect(() => resolveNetwork(input({ ip: '192.168.10.0/24' }))).toThrow(/alamat jaringan/);
    expect(() => resolveNetwork(input({ ip: '192.168.10.255/24' }))).toThrow(/broadcast/);
    expect(() => resolveNetwork(input({ gateway: '192.168.11.1' }))).toThrow(/subnet yang sama/);
    expect(() => resolveNetwork(input({ gateway: '192.168.10.50' }))).toThrow(
      /tidak sama dengan IP VM/,
    );
    expect(() => resolveNetwork(input({ gateway: '999.1.1.1' }))).toThrow(/bukan alamat IPv4/);
    expect(() => resolveNetwork(input({ dns: '1.1.1.1 8.8.8.8 9.9.9.9' }))).toThrow(/1 sampai 2/);
    expect(() => resolveNetwork(input({ dns: 'dns.google' }))).toThrow(/IPv4/);
  });
});

describe('parseMainDisk', () => {
  it('membaca storage, kunci, dan ukuran; abaikan cdrom', () => {
    expect(
      parseMainDisk({
        ide2: 'local-lvm:vm-9000-cloudinit,media=cdrom',
        scsi0: 'tpl-smb:9000/base-9000-disk-0.qcow2,size=3G',
      }),
    ).toEqual({ key: 'scsi0', storage: 'tpl-smb', sizeBytes: 3 * 1024 ** 3 });
    expect(parseMainDisk({ scsi0: 'local-lvm:base-1-disk-0,size=3584M' })?.sizeBytes).toBe(
      3584 * 1024 ** 2,
    );
    expect(parseMainDisk({ virtio0: 'ceph:vm-1-disk-0,size=1.5G' })).toMatchObject({
      key: 'virtio0',
      sizeBytes: Math.round(1.5 * 1024 ** 3),
    });
    expect(parseMainDisk({ ide2: 'local:iso/x.iso,media=cdrom' })).toBeNull();
    expect(parseMainDisk({ name: 'x' })).toBeNull();
  });
});

describe('templatesOnNode dan templateSetupHints', () => {
  const tpl = (
    vmid: number,
    osId: string,
    shared: boolean,
    cloudinit: { key: string; storage: string } | null = null,
    cloneable = shared,
  ) => ({
    vmid,
    name: `tpl-${osId}`,
    os: { id: osId, label: osId, sshUser: 'debian' as const },
    diskKey: 'scsi0',
    diskStorage: 's',
    diskSizeBytes: 1,
    shared,
    cloudinit,
    freeIdeKey: cloudinit ? null : 'ide2',
    cloneableAcrossNodes: cloneable,
  });
  const node = (name: string, online: boolean, templates: ReturnType<typeof tpl>[]) => ({
    node: name,
    online,
    cpuPercent: null,
    cpuCores: null,
    memFreeBytes: null,
    memTotalBytes: null,
    templates,
    vmids: templates.map((t) => t.vmid),
    ignoredTemplates: 0,
    storages: [],
    bridges: [],
  });
  const inv: Inventory = {
    version: '8',
    nodes: [
      node('a', true, [tpl(1, 'debian12', true), tpl(2, 'ubuntu2404', false)]),
      node('b', true, [tpl(3, 'debian12', false)]),
      node('c', true, []),
      node('d', false, [tpl(4, 'debian12', true)]),
    ],
  };

  it('hanya template di node tujuan yang dipakai (clone lintas node ke storage lokal tidak didukung Proxmox)', () => {
    expect(templatesOnNode(inv, 'a').map((t) => t.vmid)).toEqual([1, 2]);
    expect(templatesOnNode(inv, 'b').map((t) => t.vmid)).toEqual([3]);
    expect(templatesOnNode(inv, 'c')).toEqual([]);
    expect(templatesOnNode(inv, 'd')).toEqual([]); // node offline
    expect(templatesOnNode(inv, 'tidak-ada')).toEqual([]);
  });

  it('petunjuk: perintah untuk node yang belum punya template bersama, nomor VM yang kosong', () => {
    const hints = templateSetupHints(inv, 'panel');
    // hanya template di storage bersama yang bisa disalin; b sudah punya debian12; ubuntu lokal tidak ikut
    expect(hints.map((h) => [h.node, h.osId, h.fromNode, h.newVmid, h.name])).toEqual([
      ['c', 'debian12', 'a', 5, 'tpl-debian12-c'],
    ]);
    expect(hints[0]!.commands).toEqual([
      'qm clone 1 5 --name tpl-debian12-c --full 1 --storage s --target c --pool panel',
      'pvesh create /nodes/c/qemu/5/template',
    ]);
  });

  it('disk cloud-init di storage lokal menghalangi clone antar node: perintah hapus disambung sekali per OS', () => {
    const withLocalCi: Inventory = {
      version: '8',
      nodes: [
        node('a', true, [tpl(1, 'debian12', true, { key: 'ide2', storage: 'local-lvm' }, false)]),
        node('b', true, []),
        node('c', true, []),
      ],
    };
    const hints = templateSetupHints(withLocalCi, 'panel');
    expect(hints.map((h) => h.node)).toEqual(['b', 'c']);
    expect(hints[0]!.commands).toEqual([
      'qm set 1 --delete ide2',
      'qm clone 1 2 --name tpl-debian12-b --full 1 --storage s --target b --pool panel',
      'pvesh create /nodes/b/qemu/2/template',
    ]);
    // hanya hint pertama membawa langkah persiapan; yang kedua tidak mengulanginya
    expect(hints[1]!.commands[0]).toMatch(/^qm clone 1 3 /);
  });

  it('template dengan disk lain di storage lokal tidak bisa disalin otomatis: ditandai blocked', () => {
    const blocked: Inventory = {
      version: '8',
      nodes: [node('a', true, [tpl(1, 'debian12', true, null, false)]), node('b', true, [])],
    };
    const [h] = templateSetupHints(blocked, 'panel');
    expect(h!.commands).toEqual([]);
    expect(h!.blocked).toMatch(/disk lain di storage lokal/);
  });

  it('petunjuk tidak pernah memakai nomor yang sudah dipakai atau nama tidak aman', () => {
    const crowded: Inventory = {
      version: '8',
      nodes: [
        { ...node('a', true, [tpl(10, 'debian12', true)]), vmids: [10, 11, 12] },
        node('Aneh Node', true, []),
        node('n2', true, []),
        node('n3', true, []),
      ],
    };
    const hints = templateSetupHints(crowded, 'panel');
    expect(hints.map((h) => [h.node, h.newVmid])).toEqual([
      ['n2', 13],
      ['n3', 14],
    ]);
    expect(templateSetupHints(crowded, 'pool; rm -rf /')).toEqual([]);
  });
});

describe.skipIf(!hasOpenssl)('membuat VM dari panel (Proxmox dan SSH tiruan)', () => {
  const tls = makeCert();
  let fake: FakePve;
  let ssh: Awaited<ReturnType<typeof startFakeSsh>>;
  let app: FastifyInstance;
  let ctx: Awaited<ReturnType<typeof makeApp>>['ctx'];
  let admin: Client;
  let client: Client;
  let connId = '';

  const base = () => ({
    node: 'pve1',
    osId: 'debian12',
    name: 'web-teman1',
    cores: 2,
    memoryMb: 2048,
    diskGb: 20,
    storage: 'local-lvm',
    bridge: 'vmbr0',
    vlan: 20,
    // 127.0.0.1 agar menunggu SSH mengenai SSH tiruan; port SSH diatur ke port tiruan
    ip: '127.0.0.1/8',
    gateway: '127.0.0.2',
    dns: '1.1.1.1 8.8.8.8',
    sshPort: ssh.port,
  });

  const create = (over: Record<string, unknown> = {}, c: Client | null = admin) =>
    call(app, c, 'POST', `/api/admin/proxmox/${connId}/vms`, { ...base(), ...over });

  /** Tunggu job selesai, kembalikan job (dengan log). */
  async function finish(res: { json: () => { vmId: string; job: { id: string } } }) {
    const { vmId, job } = res.json();
    for (let i = 0; i < 200; i++) {
      const j = (await call(app, admin, 'GET', `/api/vms/${vmId}/jobs/${job.id}`)).json();
      if (j.status !== 'running') return { vmId, job: j };
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job tidak selesai');
  }
  const reset = () => {
    ctx.db.prepare('DELETE FROM vms').run(); // cascade: jobs dan vm_proxmox
    fake.requests.length = 0;
    fake.created.clear();
  };

  beforeAll(async () => {
    ssh = await startFakeSsh();
    fake = await startFakePve(tls);
    const built = await makeApp();
    app = built.app;
    ctx = built.ctx;
    admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
    client = await login(app, await seedUser(built, 'klien@contoh.com'));
    const r = await call(app, admin, 'POST', '/api/admin/proxmox', {
      name: 'Cluster uji',
      endpoints: [{ url: fake.url, fingerprint: tls.fingerprint }],
      tokenId: PVE_TOKEN_ID,
      tokenSecret: PVE_SECRET,
    });
    expect(r.statusCode).toBe(201);
    connId = r.json().id;
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
    await ssh.close();
    tls.cleanup();
  });

  it('opsi wizard: hanya OS dengan template di node itu, plus petunjuk membuat template di node lain', async () => {
    const res = await call(app, admin, 'GET', `/api/admin/proxmox/${connId}/options`);
    expect(res.statusCode).toBe(200);
    const nodes = res.json().nodes as {
      node: string;
      online: boolean;
      osOptions: { id: string; ownerNode: string; shared: boolean; minDiskGb: number | null }[];
      storages: { name: string }[];
      bridges: string[];
    }[];
    const by = Object.fromEntries(nodes.map((n) => [n.node, n]));
    expect(by.pve1!.osOptions.map((o) => o.id)).toEqual(['debian12']);
    expect(by.pve2!.osOptions.map((o) => [o.id, o.ownerNode, o.shared])).toEqual([
      ['ubuntu2404', 'pve2', false],
    ]);
    expect(by.pve1!.osOptions[0]!.minDiskGb).toBe(3);
    const hints = res.json().hints as { node: string; osId: string; commands: string[] }[];
    expect(hints).toEqual([
      expect.objectContaining({
        node: 'pve2',
        osId: 'debian12',
        commands: [
          'qm set 9000 --delete ide2', // disk cloud-init template ada di local-lvm sehingga menghalangi clone antar node
          'qm clone 9000 9001 --name tpl-debian12-pve2 --full 1 --storage tpl-smb --target pve2 --pool panel',
          'pvesh create /nodes/pve2/qemu/9001/template',
        ],
      }),
    ]);
    expect(by.pve3!.online).toBe(false);
    expect(by.pve3!.osOptions).toEqual([]);
    expect(by.pve1!.bridges).toEqual(['vmbr0', 'vmbr1']);
    expect(res.body).not.toContain(PVE_SECRET);
  });

  it('hanya admin', async () => {
    expect((await create({}, client)).statusCode).toBe(403);
    expect((await create({}, null)).statusCode).toBe(401);
    expect(
      (await call(app, client, 'GET', `/api/admin/proxmox/${connId}/options`)).statusCode,
    ).toBe(403);
    expect(
      (await call(app, admin, 'POST', `/api/admin/proxmox/${crypto.randomUUID()}/vms`, base()))
        .statusCode,
    ).toBe(404);
  });

  it('jalur utama: urutan dan isi panggilan ke Proxmox, VM terdaftar di panel', async () => {
    reset();
    const res = await create();
    expect(res.statusCode).toBe(202);
    const { vmId, job } = await finish(res);
    expect(job.status, job.log).toBe('succeeded');
    expect(job.log).toContain('Host key VM: SHA256:');
    expect(job.log).toContain('Admin > Kelola VM');

    const reqs = fake.requests;
    const writes = reqs.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /nodes/pve1/qemu/9000/clone', // clone lokal di node yang punya template
      'PUT /nodes/pve1/qemu/200/config',
      'PUT /nodes/pve1/qemu/200/resize',
      'POST /nodes/pve1/qemu/200/status/start',
    ]);
    const [clone, config, resize] = writes;
    expect(clone!.form).toMatchObject({
      newid: '200',
      name: 'web-teman1',
      full: '1',
      storage: 'local-lvm',
      pool: 'panel',
    });
    expect(clone!.form.target).toBeUndefined(); // tidak pernah lintas node
    expect(config!.form.ide2).toBeUndefined(); // template Debian sudah punya disk cloud-init
    expect(config!.form).toMatchObject({
      cores: '2',
      memory: '2048',
      ciuser: 'debian',
      ipconfig0: 'ip=127.0.0.1/8,gw=127.0.0.2',
      net0: 'virtio,bridge=vmbr0,tag=20',
      nameserver: '1.1.1.1 8.8.8.8',
    });
    expect(resize!.form).toEqual({ disk: 'scsi0', size: '20G' });

    // kunci SSH publik panel dikirim ter-URL-encode sekali (Proxmox meng-decode-nya), tanpa kunci privat
    const vm = ctx.db.prepare('SELECT * FROM vms WHERE id = ?').get(vmId) as Record<
      string,
      string | number | null
    >;
    expect(decodeURIComponent(config!.form.sshkeys!)).toBe(String(vm.ssh_public_key).trim());
    expect(config!.form.sshkeys).not.toContain(' ');
    expect(JSON.stringify(writes)).not.toMatch(/PRIVATE KEY/);

    // catatan di panel
    expect(vm).toMatchObject({
      name: 'web-teman1',
      host: '127.0.0.1',
      ssh_port: ssh.port,
      ssh_user: 'debian',
      status: 'unknown',
      host_key_fingerprint: null,
    });
    expect(String(vm.ssh_private_key_enc)).not.toMatch(/PRIVATE KEY/);
    expect(
      ctx.db.prepare('SELECT node, vmid, template_vmid FROM vm_proxmox WHERE vm_id = ?').get(vmId),
    ).toEqual({
      node: 'pve1',
      vmid: 200,
      template_vmid: 9000,
    });
    const audit = JSON.stringify(
      ctx.db
        .prepare("SELECT action, target, meta FROM audit_logs WHERE action LIKE 'proxmox.vm_%'")
        .all(),
    );
    expect(audit).toContain('proxmox.vm_create');
    expect(audit).toContain('proxmox.vm_cloned');
    expect(audit).not.toContain(PVE_SECRET);

    // TIDAK PERNAH menghapus/menghentikan apa pun di Proxmox
    expect(reqs.every((r) => ['GET', 'POST', 'PUT'].includes(r.method))).toBe(true);
    expect(
      reqs.some((r) => /status\/(stop|shutdown|reboot|reset)|\/migrate|destroy/.test(r.path)),
    ).toBe(false);
  });

  it('clone lokal di node pemilik template tidak memakai target', async () => {
    reset();
    const res = await create({
      node: 'pve2',
      osId: 'ubuntu2404',
      name: 'ubuntu-uji',
      vlan: undefined,
      dns: undefined,
    });
    const { job, vmId } = await finish(res);
    expect(job.status, job.log).toBe('succeeded');
    const clone = fake.requests.find((r) => r.path.endsWith('/clone'))!;
    expect(clone.path).toBe('/nodes/pve2/qemu/9011/clone');
    expect(clone.form.target).toBeUndefined();
    const config = fake.requests.find((r) => r.path.endsWith('/config') && r.method === 'PUT')!;
    expect(config.form.ciuser).toBe('ubuntu');
    expect(config.form.net0).toBe('virtio,bridge=vmbr0'); // tanpa VLAN
    // template Ubuntu tanpa disk cloud-init: panel menambahkannya di storage VM
    expect(config.form.ide2).toBe('local-lvm:cloudinit');
    expect(config.form.nameserver).toBeUndefined();
    expect(ctx.db.prepare('SELECT ssh_user FROM vms WHERE id = ?').get(vmId)).toEqual({
      ssh_user: 'ubuntu',
    });
  });

  it('masukan tidak valid ditolak sebelum menyentuh Proxmox (tanpa menulis apa pun)', async () => {
    reset();
    const cases: [Record<string, unknown>, number, string | RegExp][] = [
      [{ ip: '10.0.0.5' }, 400, 'invalid_input'],
      [{ ip: '127.0.0.0/8' }, 400, 'bad_ip'],
      [{ gateway: '10.9.9.9' }, 400, 'bad_gateway'],
      [{ dns: '1.1.1.1 2.2.2.2 3.3.3.3' }, 400, 'bad_dns'],
      [{ name: 'Nama Salah' }, 400, 'invalid_input'],
      [{ name: '-x' }, 400, 'invalid_input'],
      [{ cores: 0 }, 400, 'invalid_input'],
      [{ memoryMb: 100 }, 400, 'invalid_input'],
      [{ diskGb: 1 }, 400, 'invalid_input'],
      [{ vlan: 0 }, 400, 'invalid_input'],
      [{ vlan: 5000 }, 400, 'invalid_input'],
      [{ node: 'bukan-node' }, 400, 'bad_node'],
      [{ node: 'pve3' }, 409, 'node_offline'],
      [{ storage: 'tidak-ada' }, 400, 'bad_storage'],
      [{ bridge: 'vmbr9' }, 400, 'bad_bridge'],
      [{ osId: 'ubuntu2404', node: 'pve1' }, 409, 'template_not_on_node'],
      [{ osId: 'debian12', node: 'pve2' }, 409, 'template_not_on_node'],
      [{ osId: 'debian99' }, 409, 'no_template'],
      [{ osId: 'centos9' }, 400, 'invalid_input'],
      [{ diskGb: 2 }, 400, 'disk_too_small'],
      [{ diskGb: 100 }, 409, 'storage_full'],
      [{ sshPort: 70000 }, 400, 'invalid_input'],
    ];
    for (const [over, status, code] of cases) {
      const r = await create(over);
      expect(r.statusCode, JSON.stringify(over)).toBe(status);
      expect(r.json().error, JSON.stringify(over)).toBe(code);
    }
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM vms').get()).toEqual({ c: 0 });
    const noTpl = await create({ osId: 'ubuntu2404', node: 'pve1' });
    expect(noTpl.json().message).toMatch(/ada di node pve2 tetapi belum di pve1/);
    expect(noTpl.json().message).toMatch(/clone lintas node ke storage bersama/);
  });

  it('nama dan IP yang sudah dipakai VM lain ditolak (409)', async () => {
    reset();
    const first = await finish(await create());
    expect(first.job.status, first.job.log).toBe('succeeded');
    const dupName = await create({ ip: '127.0.0.3/8' });
    expect(dupName.statusCode).toBe(409);
    expect(dupName.json().error).toBe('vm_name_taken');
    const dupIp = await create({ name: 'lain-lagi' });
    expect(dupIp.statusCode).toBe(409);
    expect(dupIp.json().error).toBe('ip_taken');
  });

  it('gagal di tengah (start): panel tidak menghapus apa pun, tautan tersimpan, kunci dilepas', async () => {
    reset();
    const failing = await startFakePve(tls, { failTasks: ['qmstart'] });
    try {
      const upd = await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: failing.url, fingerprint: tls.fingerprint }],
      });
      expect(upd.statusCode).toBe(200);
      const { job, vmId } = await finish(await create());
      expect(job.status).toBe('failed');
      expect(job.log).toMatch(/Tugas di Proxmox gagal: ERROR: simulasi gagal/);
      expect(job.log).toMatch(/VM sudah dibuat di Proxmox \(node pve1, nomor 200\)/);
      expect(job.log).toMatch(/Panel TIDAK menghapusnya/);
      expect(ctx.db.prepare('SELECT COUNT(*) c FROM vm_proxmox WHERE vm_id = ?').get(vmId)).toEqual(
        { c: 1 },
      );
      expect(
        failing.requests.some((r) => r.method === 'DELETE' || /stop|destroy/.test(r.path)),
      ).toBe(false);

      // kunci pembuatan dilepas: pembuatan berikutnya diterima lagi (nama lain)
      const again = await create({ name: 'web-lagi', ip: '127.0.0.9/8' });
      expect(again.statusCode).toBe(202);
      await finish(again);
    } finally {
      await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: fake.url, fingerprint: tls.fingerprint }],
      });
      await failing.close();
    }
  });

  it('hak token kurang di tengah jalan (403): log menyebut hak yang diminta Proxmox, VM tidak dihapus', async () => {
    reset();
    const denying = await startFakePve(tls, { forbidConfig: 'VM.Config.CDROM' });
    try {
      await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: denying.url, fingerprint: tls.fingerprint }],
      });
      const { job, vmId } = await finish(await create({ osId: 'ubuntu2404', node: 'pve2' }));
      expect(job.status).toBe('failed');
      expect(job.log).toMatch(/Proxmox: Permission check failed \(\/vms\/200, VM\.Config\.CDROM\)/);
      expect(job.log).toMatch(/Tambahkan hak yang kurang ke peran PanelVM/);
      expect(job.log).toMatch(/VM sudah dibuat di Proxmox \(node pve2, nomor 200\)/);
      expect(job.log).toMatch(/Panel TIDAK menghapusnya/);
      expect(ctx.db.prepare('SELECT COUNT(*) c FROM vm_proxmox WHERE vm_id = ?').get(vmId)).toEqual(
        {
          c: 1,
        },
      );
      expect(denying.requests.some((r) => r.method === 'DELETE')).toBe(false);
    } finally {
      await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: fake.url, fingerprint: tls.fingerprint }],
      });
      await denying.close();
    }
  });

  it('gagal saat clone: tidak ada tautan, pesan menyebut belum ada VM di Proxmox', async () => {
    reset();
    const failing = await startFakePve(tls, { failTasks: ['qmclone'] });
    try {
      await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: failing.url, fingerprint: tls.fingerprint }],
      });
      const { job, vmId } = await finish(await create());
      expect(job.status).toBe('failed');
      expect(job.log).toMatch(/Belum ada VM yang jadi di Proxmox/);
      expect(ctx.db.prepare('SELECT COUNT(*) c FROM vm_proxmox WHERE vm_id = ?').get(vmId)).toEqual(
        { c: 0 },
      );
      expect(failing.requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual([
        '/nodes/pve1/qemu/9000/clone',
      ]);
    } finally {
      await call(app, admin, 'PUT', `/api/admin/proxmox/${connId}/endpoints`, {
        endpoints: [{ url: fake.url, fingerprint: tls.fingerprint }],
      });
      await failing.close();
    }
  });

  it('dua permintaan bersamaan pada satu koneksi: hanya satu yang berjalan (409 provision_busy)', async () => {
    reset();
    const [a, b] = await Promise.all([
      create({ name: 'paralel-a' }),
      create({ name: 'paralel-b', ip: '127.0.0.4/8' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    const busy = a.statusCode === 409 ? a : b;
    expect(busy.json().error).toBe('provision_busy');
    const ok = a.statusCode === 202 ? a : b;
    expect((await finish(ok)).job.status).toBe('succeeded');
  });

  it('koneksi yang masih dipakai VM tidak bisa dihapus catatannya (409); setelah VM dihapus bisa', async () => {
    reset();
    const { vmId, job } = await finish(await create());
    expect(job.status, job.log).toBe('succeeded');
    const blocked = await call(app, admin, 'DELETE', `/api/admin/proxmox/${connId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('connection_in_use');
    expect(blocked.json().message).toMatch(/Proxmox tidak ikut terhapus/);
    expect((await call(app, admin, 'DELETE', `/api/vms/${vmId}`)).statusCode).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM vm_proxmox').get()).toEqual({ c: 0 });
    // tidak ada panggilan penghapusan ke Proxmox dari menghapus VM di panel
    expect(fake.requests.every((r) => r.method !== 'DELETE')).toBe(true);
    expect((await call(app, admin, 'DELETE', `/api/admin/proxmox/${connId}`)).statusCode).toBe(200);
  });

  it('sertifikat fingerprint dinormalkan konsisten', () => {
    expect(normalizeFingerprint(tls.fingerprint)).toHaveLength(64);
  });
});
