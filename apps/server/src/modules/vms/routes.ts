import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireActive, requireAdmin } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { assertVmAccess, VM_MODULES, type VmRow } from '../../rbac/index.js';
import { generateKeyPair, scanHostKey } from '../../ssh/connect.js';
import { notify } from '../notifications/service.js';
import { toPublicVm, testVm, vmKeyContext } from './service.js';

const hostSchema = z
  .string()
  .trim()
  .max(253)
  .regex(
    /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/,
    'Host harus berupa IP atau nama host yang valid.',
  );

const modulesSchema = z.object(
  Object.fromEntries(VM_MODULES.map((m) => [m, z.boolean()])) as Record<
    (typeof VM_MODULES)[number],
    z.ZodBoolean
  >,
);

const createBody = z.object({
  name: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/,
      'Nama VM 2-40 karakter: huruf, angka, spasi, titik, garis.',
    ),
  host: hostSchema,
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshUser: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'User SSH tidak valid (huruf kecil, angka, _ atau -).'),
  modules: modulesSchema.optional(),
});

const patchBody = createBody.partial();
const idParams = z.object({ id: z.string().uuid() });
const fingerprintBody = z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) });

export function vmRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;
  const getVm = (id: string) =>
    db.prepare('SELECT * FROM vms WHERE id = ?').get(id) as VmRow | undefined;
  const logSsh = (req: { log: { warn: (o: unknown, m: string) => void } }) => (e: Error) =>
    req.log.warn({ err: e.message }, 'ssh error');

  app.get('/api/vms', { preHandler: requireActive }, async (req) => {
    const user = actor(req);
    const rows =
      user.role === 'admin'
        ? (db.prepare('SELECT * FROM vms ORDER BY name').all() as VmRow[])
        : (db
            .prepare(
              'SELECT v.* FROM vms v JOIN vm_access a ON a.vm_id = v.id WHERE a.user_id = ? ORDER BY v.name',
            )
            .all(user.id) as VmRow[]);
    return { items: rows.map((v) => toPublicVm(ctx, v, user.role === 'admin')) };
  });

  app.get('/api/vms/:id', { preHandler: requireActive }, async (req) => {
    const { id } = idParams.parse(req.params);
    const user = actor(req);
    const vm = assertVmAccess(db, user, id);
    return toPublicVm(ctx, vm, user.role === 'admin');
  });

  app.post('/api/vms', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (db.prepare('SELECT 1 AS ok FROM vms WHERE name = ?').get(body.name)) {
      throw new AppError(409, 'vm_name_taken', 'Nama VM sudah dipakai. Pilih nama lain.');
    }
    const id = randomUUID();
    const pair = generateKeyPair(`panel-${id.slice(0, 8)}`);
    const modules = body.modules ?? Object.fromEntries(VM_MODULES.map((m) => [m, true]));
    db.prepare(
      'INSERT INTO vms (id, name, host, ssh_port, ssh_user, ssh_private_key_enc, ssh_public_key, modules_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      body.name,
      body.host,
      body.sshPort,
      body.sshUser,
      ctx.box.encrypt(pair.privateKey, vmKeyContext(id)),
      pair.publicKey,
      JSON.stringify(modules),
      Date.now(),
    );
    audit.record({
      userId: actor(req).id,
      vmId: id,
      ip: req.ip,
      action: 'vm.create',
      target: body.name,
      result: 'ok',
    });
    reply.code(201);
    return toPublicVm(ctx, getVm(id)!, true);
  });

  app.patch('/api/vms/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const vm = getVm(id);
    if (!vm) throw notFound('VM');
    const next = {
      name: body.name ?? vm.name,
      host: body.host ?? vm.host,
      ssh_port: body.sshPort ?? vm.ssh_port,
      ssh_user: body.sshUser ?? vm.ssh_user,
      modules_enabled: body.modules ? JSON.stringify(body.modules) : vm.modules_enabled,
    };
    const endpointChanged = next.host !== vm.host || next.ssh_port !== vm.ssh_port;
    try {
      db.prepare(
        'UPDATE vms SET name = ?, host = ?, ssh_port = ?, ssh_user = ?, modules_enabled = ?, host_key_fingerprint = ?, status = ? WHERE id = ?',
      ).run(
        next.name,
        next.host,
        next.ssh_port,
        next.ssh_user,
        next.modules_enabled,
        endpointChanged ? null : vm.host_key_fingerprint,
        endpointChanged ? 'unknown' : vm.status,
        id,
      );
    } catch (e) {
      if (String(e).includes('UNIQUE'))
        throw new AppError(409, 'vm_name_taken', 'Nama VM sudah dipakai. Pilih nama lain.');
      throw e;
    }
    // Alamat baru berarti host key harus disetujui ulang; modul dimatikan berarti sesi terkait ditutup.
    if (endpointChanged || body.modules?.terminal === false)
      ctx.terminals.closeByVm(id, 'Konfigurasi VM diubah admin');
    audit.record({
      userId: actor(req).id,
      vmId: id,
      ip: req.ip,
      action: 'vm.update',
      target: next.name,
      result: 'ok',
      meta: { endpointChanged, fields: Object.keys(body) },
    });
    return toPublicVm(ctx, getVm(id)!, true);
  });

  app.delete('/api/vms/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const vm = getVm(id);
    if (!vm) throw notFound('VM');
    ctx.terminals.closeByVm(id, 'VM dihapus dari panel');
    ctx.pool.invalidate(id);
    db.prepare('DELETE FROM vms WHERE id = ?').run(id);
    audit.record({
      userId: actor(req).id,
      vmId: id,
      ip: req.ip,
      action: 'vm.delete',
      target: vm.name,
      result: 'ok',
    });
    return { ok: true };
  });

  app.post(
    '/api/vms/:id/host-key/scan',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, preHandler: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const vm = getVm(id);
      if (!vm) throw notFound('VM');
      const fingerprint = await scanHostKey(vm.host, vm.ssh_port, logSsh(req));
      return {
        fingerprint,
        approved: vm.host_key_fingerprint,
        changed: vm.host_key_fingerprint !== null && vm.host_key_fingerprint !== fingerprint,
      };
    },
  );

  app.post(
    '/api/vms/:id/host-key/approve',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, preHandler: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { fingerprint } = fingerprintBody.parse(req.body);
      const vm = getVm(id);
      if (!vm) throw notFound('VM');
      // Pindai ulang: yang disetujui harus sama dengan yang sedang disajikan VM saat ini.
      const live = await scanHostKey(vm.host, vm.ssh_port, logSsh(req));
      if (live !== fingerprint) {
        throw new AppError(
          409,
          'fingerprint_mismatch',
          'Fingerprint yang Anda setujui berbeda dengan yang disajikan VM sekarang. Pindai ulang lalu cocokkan lagi.',
        );
      }
      db.prepare('UPDATE vms SET host_key_fingerprint = ? WHERE id = ?').run(fingerprint, id);
      ctx.terminals.closeByVm(id, 'Host key disetujui ulang');
      ctx.pool.invalidate(id);
      audit.record({
        userId: actor(req).id,
        vmId: id,
        ip: req.ip,
        action: 'vm.host_key_approve',
        target: vm.name,
        result: 'ok',
        meta: { fingerprint, previous: vm.host_key_fingerprint },
      });
      return toPublicVm(ctx, getVm(id)!, true);
    },
  );

  app.post(
    '/api/vms/:id/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, preHandler: requireAdmin },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const vm = getVm(id);
      if (!vm) throw notFound('VM');
      try {
        await testVm(ctx, vm, logSsh(req));
      } catch (e) {
        audit.record({
          userId: actor(req).id,
          vmId: id,
          ip: req.ip,
          action: 'vm.test',
          target: vm.name,
          result: 'fail',
        });
        throw e;
      }
      audit.record({
        userId: actor(req).id,
        vmId: id,
        ip: req.ip,
        action: 'vm.test',
        target: vm.name,
        result: 'ok',
      });
      return toPublicVm(ctx, getVm(id)!, true);
    },
  );

  app.put('/api/vms/:id/assignment', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { userId } = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
    const vm = getVm(id);
    if (!vm) throw notFound('VM');
    let email: string | null = null;
    if (userId) {
      const u = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId) as
        { id: string; email: string; role: string } | undefined;
      if (!u || u.role !== 'client') throw notFound('Akun client');
      const existing = db
        .prepare('SELECT vm_id FROM vm_access WHERE user_id = ? AND vm_id != ?')
        .get(userId, id);
      if (existing) {
        throw new AppError(
          409,
          'user_has_vm',
          'Akun ini sudah terhubung ke VM lain. Setiap client hanya boleh punya satu VM; lepaskan dulu VM sebelumnya.',
        );
      }
      email = u.email;
    }
    db.transaction(() => {
      db.prepare('DELETE FROM vm_access WHERE vm_id = ?').run(id);
      if (userId)
        db.prepare('INSERT INTO vm_access (id, user_id, vm_id, role) VALUES (?, ?, ?, ?)').run(
          randomUUID(),
          userId,
          id,
          'client',
        );
    })();
    ctx.terminals.closeByVm(id, 'Akses VM diubah admin');
    ctx.pool.invalidate(id);
    if (userId)
      notify(
        db,
        userId,
        'vm_assigned',
        'VM baru terhubung',
        `VM "${vm.name}" kini bisa Anda akses dari panel.`,
      );
    audit.record({
      userId: actor(req).id,
      vmId: id,
      ip: req.ip,
      action: 'vm.assign',
      target: email ?? '(dilepas)',
      result: 'ok',
    });
    return toPublicVm(ctx, getVm(id)!, true);
  });
}
