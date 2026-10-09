import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireAdmin } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { FINGERPRINT_RE, ProxmoxClient, scanCertificate, type Endpoint } from './api.js';
import { toPublicJob } from '../jobs/service.js';
import { checkPermissions, collectInventory } from './inventory.js';
import {
  availableTemplates,
  createVmBody,
  insertVmRow,
  planCreate,
  provisionVm,
} from './provision.js';
import { clientFor, parseEndpoints, toPublicConn, tokenContext, type ConnRow } from './service.js';

const idParams = z.object({ id: z.string().uuid() });

/** Hanya origin https (host[:port]) tanpa path/kredensial; port bawaan Proxmox 8006. */
const urlField = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/,
    'Alamat harus berbentuk https://host:8006 (tanpa path, tanpa kredensial).',
  );
const endpointField = z.object({
  url: urlField,
  fingerprint: z.string().regex(FINGERPRINT_RE, 'Fingerprint harus format SHA-256 (AA:BB:...).'),
});
const endpointsField = z.array(endpointField).min(1).max(5);

const createBody = z.object({
  name: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/,
      'Nama 2-40 karakter: huruf, angka, spasi, titik, garis.',
    ),
  endpoints: endpointsField,
  tokenId: z
    .string()
    .trim()
    .max(100)
    .regex(
      /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/,
      'Token ID harus berbentuk user@realm!namatoken, mis. panel@pve!panel.',
    ),
  tokenSecret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{8,100}$/, 'Secret token tidak valid (biasanya berupa UUID).'),
  pool: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, 'Nama pool tidak valid.')
    .default('panel'),
});

/** Koneksi yang sedang membuat VM: satu per koneksi agar nomor VM dan clone tidak berebut. */
const provisioning = new Set<string>();

export function proxmoxRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;
  const load = (id: string): ConnRow => {
    const row = db.prepare('SELECT * FROM proxmox_connections WHERE id = ?').get(id) as
      ConnRow | undefined;
    if (!row) throw notFound('Koneksi Proxmox');
    return row;
  };
  /** Ambil fingerprint sertifikat sebuah node untuk dikonfirmasi admin (seperti persetujuan host key SSH). */
  app.post(
    '/api/admin/proxmox/scan-cert',
    { config: rateLimit(10), onRequest: requireAdmin },
    async (req) => {
      const { url } = z.object({ url: urlField }).parse(req.body);
      const r = await scanCertificate(url);
      audit.record({
        userId: actor(req).id,
        ip: req.ip,
        action: 'proxmox.scan_cert',
        target: url,
        result: 'ok',
      });
      return { url, fingerprint: r.fingerprint, subject: r.subject };
    },
  );

  app.get('/api/admin/proxmox', { onRequest: requireAdmin }, async () => ({
    items: (db.prepare('SELECT * FROM proxmox_connections ORDER BY name').all() as ConnRow[]).map(
      toPublicConn,
    ),
  }));

  /** Tambah koneksi. Disimpan hanya bila token terbukti bisa membaca daftar node (diuji dulu). */
  app.post(
    '/api/admin/proxmox',
    { config: rateLimit(10), onRequest: requireAdmin },
    async (req, reply) => {
      const b = createBody.parse(req.body);
      if (db.prepare('SELECT 1 AS ok FROM proxmox_connections WHERE name = ?').get(b.name)) {
        throw new AppError(
          409,
          'proxmox_name_taken',
          'Nama koneksi sudah dipakai. Pilih nama lain.',
        );
      }
      const client = new ProxmoxClient(b.endpoints, { tokenId: b.tokenId, secret: b.tokenSecret });
      try {
        await client.get('/version');
        await client.get('/nodes');
      } catch (e) {
        audit.record({
          userId: actor(req).id,
          ip: req.ip,
          action: 'proxmox.add',
          target: b.name,
          result: 'fail',
        });
        throw e;
      }
      const id = randomUUID();
      db.prepare(
        'INSERT INTO proxmox_connections (id, name, endpoints, token_id, token_secret_enc, pool, created_at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        b.name,
        JSON.stringify(b.endpoints),
        b.tokenId,
        ctx.box.encrypt(b.tokenSecret, tokenContext(id)),
        b.pool,
        Date.now(),
        Date.now(),
      );
      audit.record({
        userId: actor(req).id,
        ip: req.ip,
        action: 'proxmox.add',
        target: b.name,
        result: 'ok',
        meta: { endpoints: b.endpoints.length, pool: b.pool },
      });
      reply.code(201);
      return toPublicConn(load(id));
    },
  );

  /** Tes: baca node, template, storage, bridge, dan periksa hak token. Tidak mengubah apa pun di Proxmox. */
  app.post(
    '/api/admin/proxmox/:id/test',
    { config: rateLimit(20), onRequest: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const row = load(id);
      const client = clientFor(ctx, row);
      try {
        const inventory = await collectInventory(client);
        const permissions = await checkPermissions(client, row.pool, inventory);
        db.prepare('UPDATE proxmox_connections SET last_ok_at = ? WHERE id = ?').run(
          Date.now(),
          id,
        );
        audit.record({
          userId: actor(req).id,
          ip: req.ip,
          action: 'proxmox.test',
          target: row.name,
          result: 'ok',
        });
        return { connection: toPublicConn(load(id)), inventory, permissions };
      } catch (e) {
        audit.record({
          userId: actor(req).id,
          ip: req.ip,
          action: 'proxmox.test',
          target: row.name,
          result: 'fail',
        });
        throw e;
      }
    },
  );

  /** Perbarui alamat/pin (mis. sertifikat node diganti). Diuji dulu dengan token yang sudah tersimpan. */
  app.put(
    '/api/admin/proxmox/:id/endpoints',
    { config: rateLimit(10), onRequest: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { endpoints } = z.object({ endpoints: endpointsField }).parse(req.body);
      const row = load(id);
      const secret = ctx.box.decrypt(row.token_secret_enc, tokenContext(id));
      await new ProxmoxClient(endpoints as Endpoint[], { tokenId: row.token_id, secret }).get(
        '/nodes',
      );
      db.prepare('UPDATE proxmox_connections SET endpoints = ?, last_ok_at = ? WHERE id = ?').run(
        JSON.stringify(endpoints),
        Date.now(),
        id,
      );
      audit.record({
        userId: actor(req).id,
        ip: req.ip,
        action: 'proxmox.update_pins',
        target: row.name,
        result: 'ok',
        meta: { before: parseEndpoints(row.endpoints).length, after: endpoints.length },
      });
      return toPublicConn(load(id));
    },
  );

  /** Pilihan untuk wizard Buat VM: per node (online) beserta OS, storage, dan bridge yang benar-benar tersedia. */
  app.get(
    '/api/admin/proxmox/:id/options',
    { config: rateLimit(30), onRequest: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const row = load(id);
      const inv = await collectInventory(clientFor(ctx, row));
      return {
        pool: row.pool,
        nodes: inv.nodes.map((n) => {
          const seen = new Set<string>();
          const osOptions = (n.online ? availableTemplates(inv, n.node) : [])
            .filter((t) => !seen.has(t.os.id) && !!seen.add(t.os.id))
            .map((t) => ({
              id: t.os.id,
              label: t.os.label,
              templateName: t.name,
              ownerNode: t.ownerNode,
              shared: t.shared,
              minDiskGb: t.diskSizeBytes ? Math.ceil(t.diskSizeBytes / 1024 ** 3) : null,
            }));
          return {
            node: n.node,
            online: n.online,
            cpuPercent: n.cpuPercent,
            cpuCores: n.cpuCores,
            memFreeBytes: n.memFreeBytes,
            storages: n.storages,
            bridges: n.bridges,
            osOptions,
          };
        }),
      };
    },
  );

  /**
   * Buat VM dari template. Seluruh masukan diperiksa ulang terhadap keadaan nyata Proxmox dan data panel; VM
   * dicatat di panel lebih dulu (kunci SSH khusus), lalu job latar belakang menjalankan clone dan seterusnya.
   * Panel tidak pernah menghapus apa pun di Proxmox, termasuk bila langkah di tengah gagal.
   */
  app.post(
    '/api/admin/proxmox/:id/vms',
    { config: rateLimit(5), onRequest: requireAdmin },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const row = load(id);
      const input = createVmBody.parse(req.body);
      if (provisioning.has(id)) {
        throw new AppError(
          409,
          'provision_busy',
          'Masih ada pembuatan VM yang berjalan di koneksi ini. Tunggu sampai selesai, lalu coba lagi.',
        );
      }
      provisioning.add(id);
      let started = false;
      try {
        const client = clientFor(ctx, row);
        const plan = planCreate(ctx, await collectInventory(client), input);
        const vmId = randomUUID();
        let vm;
        try {
          vm = insertVmRow(ctx, vmId, input, plan);
        } catch (e) {
          if (String(e).includes('UNIQUE'))
            throw new AppError(
              409,
              'vm_name_taken',
              'Nama VM sudah dipakai di panel. Pilih nama lain.',
            );
          throw e;
        }
        const admin = actor(req);
        audit.record({
          userId: admin.id,
          vmId,
          ip: req.ip,
          action: 'proxmox.vm_create',
          target: input.name,
          result: 'ok',
          meta: {
            node: plan.node.node,
            os: input.osId,
            cores: input.cores,
            memoryMb: input.memoryMb,
            diskGb: input.diskGb,
          },
        });
        const job = ctx.jobs.start(
          {
            vmId,
            userId: admin.id,
            ip: req.ip,
            kind: 'proxmox-create',
            title: `Buat VM ${input.name} di ${plan.node.node}`,
            vmName: input.name,
          },
          async (log, ctl) => {
            try {
              await provisionVm({
                ctx,
                client,
                connectionId: id,
                pool: row.pool,
                vm,
                input,
                plan,
                log,
                ctl,
              });
            } finally {
              provisioning.delete(id);
            }
          },
        );
        started = true;
        reply.code(202);
        return { vmId, name: input.name, job: toPublicJob(job, false) };
      } finally {
        if (!started) provisioning.delete(id);
      }
    },
  );

  /** Hapus catatan koneksi di panel. Tidak menyentuh Proxmox sama sekali. */
  app.delete('/api/admin/proxmox/:id', { onRequest: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = load(id);
    const used = db
      .prepare('SELECT COUNT(*) AS c FROM vm_proxmox WHERE connection_id = ?')
      .get(id) as { c: number };
    if (used.c > 0) {
      throw new AppError(
        409,
        'connection_in_use',
        `Koneksi ini masih dipakai ${used.c} VM yang dibuat lewat panel. Hapus dulu VM itu dari Kelola VM (VM di Proxmox tidak ikut terhapus), lalu hapus koneksinya.`,
      );
    }
    db.prepare('DELETE FROM proxmox_connections WHERE id = ?').run(id);
    audit.record({
      userId: actor(req).id,
      ip: req.ip,
      action: 'proxmox.remove',
      target: row.name,
      result: 'ok',
    });
    return { ok: true };
  });
}
