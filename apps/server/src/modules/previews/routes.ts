import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive, requireAdmin } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { DOMAIN_RE } from '../sites/nginx.js';
import { classifyForwardError } from '../../ssh/pool.js';
import { sshTargetFor } from '../vms/service.js';
import {
  DEFAULT_TTL_HOURS,
  LIVE_WINDOW_MS,
  MAX_PREVIEWS_PER_VM,
  MAX_TTL_HOURS,
  newSubdomain,
  isPreviewPort,
  type PreviewRow,
} from './service.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const previewParams = z.object({ vmId: z.string().uuid(), previewId: z.string().uuid() });
const idParams = z.object({ previewId: z.string().uuid() });
const ttlHours = z.number().int().min(1).max(MAX_TTL_HOURS);

const createBody = z.object({
  port: z
    .number()
    .int()
    .refine(
      isPreviewPort,
      'Port harus 80 atau antara 1024 dan 65535 (port di bawah 1024 selain 80 dipakai layanan sistem).',
    ),
  /** Domain situs di Nginx VM; dikirim sebagai header Host agar Nginx memilih situs yang benar. */
  hostHeader: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      DOMAIN_RE,
      'Host situs tidak valid. Contoh: blog.contoh.com (tanpa http:// dan tanpa port).',
    )
    .optional(),
  label: z
    .string()
    .trim()
    .max(60)
    .regex(/^[\p{L}\p{N} _.:/()-]*$/u, 'Label hanya boleh huruf, angka, spasi, dan . _ : / ( ) -')
    .default(''),
  ttlHours: ttlHours.default(DEFAULT_TTL_HOURS),
});

export function previewRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit, previews } = ctx;

  const toPublic = (p: PreviewRow) => ({
    id: p.id,
    vmId: p.vm_id,
    port: p.port,
    label: p.label,
    hostHeader: p.host_header,
    url: previews.urlFor(p.subdomain),
    createdAt: p.created_at,
    expiresAt: p.expires_at,
    lastAccessAt: p.last_access_at,
    connections: previews.connectionCount(p.id),
  });

  const access = (req: FastifyRequest): VmRow => {
    const { vmId } = vmParams.parse(req.params);
    return assertVmAccess(db, actor(req), vmId, 'previews');
  };

  /** Preview harus milik VM di URL; kalau tidak, 404 (mencegah akses lintas VM lewat id preview). */
  const load = (vm: VmRow, previewId: string): PreviewRow => {
    const p = db
      .prepare('SELECT * FROM previews WHERE id = ? AND vm_id = ? AND expires_at > ?')
      .get(previewId, vm.id, Date.now()) as PreviewRow | undefined;
    if (!p) throw notFound('Preview');
    return p;
  };

  const requireEnabled = () => {
    if (!previews.enabled) {
      throw new AppError(
        503,
        'previews_disabled',
        'Fitur preview belum diaktifkan di server. Hubungi admin untuk mengisi PREVIEW_BASE_DOMAIN.',
      );
    }
  };

  app.get('/api/vms/:vmId/previews', { onRequest: requireActive }, async (req) => {
    const vm = access(req);
    if (!previews.enabled) return { enabled: false, maxPerVm: MAX_PREVIEWS_PER_VM, items: [] };
    const rows = db
      .prepare('SELECT * FROM previews WHERE vm_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(vm.id, Date.now()) as PreviewRow[];
    return {
      enabled: true,
      maxPerVm: MAX_PREVIEWS_PER_VM,
      maxTtlHours: MAX_TTL_HOURS,
      items: rows.map(toPublic),
    };
  });

  app.post(
    '/api/vms/:vmId/previews',
    { onRequest: requireActive, config: rateLimit(20) },
    async (req, reply) => {
      requireEnabled();
      const user = actor(req);
      const vm = access(req);
      // Hanya pemilik VM (client). Admin memantau dan mencabut, tidak membuat.
      if (user.role !== 'client') {
        throw forbidden(
          'Hanya pemilik VM yang bisa membuat preview. Admin dapat memantau dan mencabutnya.',
        );
      }
      const body = createBody.parse(req.body);
      if (body.port === vm.ssh_port) {
        throw new AppError(
          400,
          'port_reserved',
          'Port itu dipakai layanan SSH VM dan tidak bisa dibuka sebagai preview. Pilih port aplikasimu (mis. 3000 atau 5173).',
        );
      }
      const now = Date.now();
      const active = db
        .prepare('SELECT port FROM previews WHERE vm_id = ? AND expires_at > ?')
        .all(vm.id, now) as { port: number }[];
      if (active.some((a) => a.port === body.port)) {
        throw new AppError(
          409,
          'preview_exists',
          'Port itu sudah punya preview aktif. Gunakan link yang ada, atau cabut dulu bila ingin membuat yang baru.',
        );
      }
      if (active.length >= MAX_PREVIEWS_PER_VM) {
        throw new AppError(
          409,
          'preview_limit',
          `Batas ${MAX_PREVIEWS_PER_VM} preview aktif per VM sudah tercapai. Cabut salah satu lalu coba lagi.`,
        );
      }
      const id = randomUUID();
      db.prepare(
        'INSERT INTO previews (id, vm_id, user_id, subdomain, port, label, host_header, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        vm.id,
        user.id,
        newSubdomain(),
        body.port,
        body.label,
        body.hostHeader ?? null,
        now,
        now + body.ttlHours * 3_600_000,
      );
      // Subdomain adalah kunci akses: tidak dicatat di audit log.
      audit.record({
        userId: user.id,
        vmId: vm.id,
        ip: req.ip,
        action: 'preview.create',
        target: `port:${body.port}`,
        result: 'ok',
        meta: { hours: body.ttlHours },
      });
      reply.code(201);
      return toPublic(load(vm, id));
    },
  );

  app.post(
    '/api/vms/:vmId/previews/:previewId/extend',
    { onRequest: requireActive, config: rateLimit(30) },
    async (req) => {
      const vm = access(req);
      const { previewId } = previewParams.parse(req.params);
      const { ttlHours: hours } = z.object({ ttlHours }).parse(req.body);
      load(vm, previewId);
      const expires = Date.now() + hours * 3_600_000;
      db.prepare('UPDATE previews SET expires_at = ?, warned_at = NULL WHERE id = ?').run(
        expires,
        previewId,
      );
      audit.record({
        userId: actor(req).id,
        vmId: vm.id,
        ip: req.ip,
        action: 'preview.extend',
        target: previewId,
        result: 'ok',
        meta: { hours },
      });
      return toPublic(load(vm, previewId));
    },
  );

  app.delete(
    '/api/vms/:vmId/previews/:previewId',
    { onRequest: requireActive, config: rateLimit(30) },
    async (req) => {
      const vm = access(req);
      const { previewId } = previewParams.parse(req.params);
      const p = load(vm, previewId);
      previews.remove(p.id);
      audit.record({
        userId: actor(req).id,
        vmId: vm.id,
        ip: req.ip,
        action: 'preview.revoke',
        target: `port:${p.port}`,
        result: 'ok',
      });
      return { ok: true };
    },
  );

  /** Cek apakah ada aplikasi yang mendengarkan di port preview (pemilik atau admin). */
  app.post(
    '/api/vms/:vmId/previews/:previewId/check',
    { onRequest: requireActive, config: rateLimit(30) },
    async (req) => {
      const vm = access(req);
      const { previewId } = previewParams.parse(req.params);
      const p = load(vm, previewId);
      try {
        const ch = await ctx.pool.forward(vm.id, sshTargetFor(ctx, vm), p.port, (e) =>
          req.log.warn({ err: e.message }, 'ssh preview check error'),
        );
        ch.destroy();
        return { listening: true };
      } catch (e) {
        const kind = classifyForwardError(e);
        if (kind === 'refused') return { listening: false };
        if (kind === 'prohibited') {
          throw new AppError(
            502,
            'forwarding_prohibited',
            'Layanan SSH di VM melarang penerusan port. Aktifkan AllowTcpForwarding di sshd_config lalu reload sshd.',
          );
        }
        if (e instanceof AppError) throw e;
        throw new AppError(
          502,
          'ssh_failed',
          'Panel gagal terhubung ke VM. Periksa status VM lalu coba lagi.',
        );
      }
    },
  );

  /** Admin: semua preview lintas VM, dengan status koneksi langsung. */
  app.get('/api/admin/previews', { onRequest: requireAdmin }, async () => {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT p.*, v.name AS vm_name, v.status AS vm_status, u.email AS owner_email
         FROM previews p JOIN vms v ON v.id = p.vm_id JOIN users u ON u.id = p.user_id
         WHERE p.expires_at > ? ORDER BY p.created_at DESC`,
      )
      .all(now) as (PreviewRow & { vm_name: string; vm_status: string; owner_email: string })[];
    return {
      enabled: previews.enabled,
      items: rows.map((r) => {
        const connections = previews.connectionCount(r.id);
        return {
          ...toPublic(r),
          vmName: r.vm_name,
          vmStatus: r.vm_status,
          owner: r.owner_email,
          live:
            connections > 0 ||
            (r.last_access_at !== null && now - r.last_access_at < LIVE_WINDOW_MS),
        };
      }),
    };
  });

  /** Admin: cabut preview mana pun tanpa perlu tahu VM-nya. */
  app.delete('/api/admin/previews/:previewId', { onRequest: requireAdmin }, async (req) => {
    const { previewId } = idParams.parse(req.params);
    const p = db.prepare('SELECT * FROM previews WHERE id = ?').get(previewId) as
      PreviewRow | undefined;
    if (!p) throw notFound('Preview');
    previews.remove(p.id);
    audit.record({
      userId: actor(req).id,
      vmId: p.vm_id,
      ip: req.ip,
      action: 'preview.revoke',
      target: `port:${p.port}`,
      result: 'ok',
      meta: { byAdmin: true },
    });
    return { ok: true };
  });
}
