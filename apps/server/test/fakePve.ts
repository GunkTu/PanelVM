import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PVE_TOKEN_ID = 'panel@pve!panel';
export const PVE_SECRET = '11111111-2222-3333-4444-555555555555';

export const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Buat sertifikat self-signed sementara (tidak ada kunci yang disimpan di repositori). */
export function makeCert(): {
  key: string;
  cert: string;
  fingerprint: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'pve-'));
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
  const key = readFileSync(join(dir, 'k.pem'), 'utf8');
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  return {
    key,
    cert,
    fingerprint: new X509Certificate(cert).fingerprint256,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
}

export interface FakePveOptions {
  /** Jenis tugas yang berakhir gagal, mis. 'qmclone' atau 'qmstart'. */
  failTasks?: string[];
  /** Ruang kosong local-lvm di semua node (byte). */
  localLvmAvail?: number;
}

export interface FakePve {
  url: string;
  requests: Recorded[];
  /** VM yang dibuat lewat clone: vmid -> {node, name}. */
  created: Map<number, { node: string; name: string }>;
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c: Buffer) => (b += c.toString('utf8')));
    req.on('end', () => resolve(b));
  });

/**
 * Proxmox tiruan: tiga node (pve1, pve2 online; pve3 offline), dua template.
 * - tpl-debian12 (#9000) di pve1 dengan disk di storage BERSAMA tpl-smb (bisa di-clone ke node mana pun).
 * - tpl-ubuntu2404-pve2 (#9011) di pve2 dengan disk LOKAL local-lvm (hanya untuk pve2).
 */
export async function startFakePve(
  tls: { key: string; cert: string },
  opts: FakePveOptions = {},
): Promise<FakePve> {
  const requests: Recorded[] = [];
  const created = new Map<number, { node: string; name: string }>();
  const avail = opts.localLvmAvail ?? 50e9;
  const server = https.createServer(tls, (req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'https://x');
      const path = u.pathname.replace('/api2/json', '');
      const body = await readBody(req);
      requests.push({
        method: req.method ?? '',
        path,
        query: Object.fromEntries(u.searchParams),
        form: Object.fromEntries(new URLSearchParams(body)),
      });
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { data } : { errors: 'x' }));
      };
      if (req.headers.authorization !== `PVEAPIToken=${PVE_TOKEN_ID}=${PVE_SECRET}`)
        return send(401);
      const upid = (node: string, type: string, id: number) =>
        `UPID:${node}:0000A1B2:0000C3D4:65000000:${type}:${id}:${PVE_TOKEN_ID}:`;
      let m: RegExpExecArray | null;

      if (path === '/version') return send(200, { version: '8.4.14' });
      if (path === '/nodes')
        return send(200, [
          { node: 'pve1', status: 'online', cpu: 0.25, maxcpu: 8, mem: 4e9, maxmem: 16e9 },
          { node: 'pve2', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1e9, maxmem: 8e9 },
          { node: 'pve3', status: 'offline' },
        ]);
      if (path === '/cluster/nextid') return send(200, String(200 + created.size));
      if ((m = /^\/nodes\/(pve[12])\/qemu$/.exec(path))) {
        const node = m[1]!;
        const list: unknown[] = [{ vmid: 100, name: 'web-lama', status: 'running' }];
        if (node === 'pve1') list.push({ vmid: 9000, name: 'tpl-debian12', template: 1 });
        if (node === 'pve2') list.push({ vmid: 9011, name: 'tpl-ubuntu2404-pve2', template: 1 });
        for (const [vmid, v] of created) if (v.node === node) list.push({ vmid, name: v.name });
        return send(200, list);
      }
      if (req.method === 'GET' && (m = /^\/nodes\/(pve[12])\/qemu\/(\d+)\/config$/.exec(path))) {
        if (m[2] === '9000')
          return send(200, {
            scsi0: 'tpl-smb:9000/base-9000-disk-0.qcow2,size=3G',
            ide2: 'local-lvm:vm-9000-cloudinit,media=cdrom',
          });
        if (m[2] === '9011')
          // sengaja tanpa disk cloud-init: panel yang menambahkannya saat membuat VM
          return send(200, { scsi0: 'local-lvm:base-9011-disk-0,size=3584M' });
        return send(404);
      }
      if (/^\/nodes\/pve[12]\/storage$/.test(path))
        return send(200, [
          {
            storage: 'local-lvm',
            type: 'lvmthin',
            avail,
            total: 100e9,
            active: 1,
            enabled: 1,
            shared: 0,
          },
          {
            storage: 'tpl-smb',
            type: 'cifs',
            avail: 500e9,
            total: 900e9,
            active: 1,
            enabled: 1,
            shared: 1,
          },
        ]);
      if (/^\/nodes\/pve[12]\/network$/.test(path))
        return send(200, [{ iface: 'vmbr0' }, { iface: 'vmbr1' }]);
      if (path === '/access/permissions') return send(200, {});

      if (req.method === 'POST' && (m = /^\/nodes\/(pve[12])\/qemu\/(\d+)\/clone$/.exec(path))) {
        const f = Object.fromEntries(new URLSearchParams(body));
        const target = f.target ?? m[1]!;
        created.set(Number(f.newid), { node: target, name: f.name ?? '' });
        return send(200, upid(m[1]!, 'qmclone', Number(m[2])));
      }
      if (req.method === 'PUT' && /^\/nodes\/pve[12]\/qemu\/\d+\/(config|resize)$/.test(path))
        return send(200, null);
      if (
        req.method === 'POST' &&
        (m = /^\/nodes\/(pve[12])\/qemu\/(\d+)\/status\/start$/.exec(path))
      )
        return send(200, upid(m[1]!, 'qmstart', Number(m[2])));
      if ((m = /^\/nodes\/(pve[12])\/tasks\/(UPID:[^/]+)\/status$/.exec(path))) {
        const type = m[2]!.split(':')[5] ?? '';
        return opts.failTasks?.includes(type)
          ? send(200, { status: 'stopped', exitstatus: 'ERROR: simulasi gagal' })
          : send(200, { status: 'stopped', exitstatus: 'OK' });
      }
      return send(404);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    created,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
