import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive, requireAdmin } from '../../auth/plugin.js';
import { hashPassword } from '../../auth/passwords.js';
import type { Ctx } from '../../context.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { DOMAIN_RE } from '../sites/nginx.js';
import { classifyForwardError } from '../../ssh/pool.js';
import { notify } from '../notifications/service.js';
import { sshTargetFor } from '../vms/service.js';
import { aliasError, MAX_PREVIEW_PASSWORD, MIN_PREVIEW_PASSWORD } from './access.js';
import {
  DEFAULT_TTL_HOURS,
  LIVE_WINDOW_MS,
  MAX_PREVIEWS_PER_VM,
  MAX_TTL_HOURS,
  newSubdomain,
  ADMIN_EXPIRY_DAYS,
  isPermanent,
  PERMANENT_EXPIRES_AT,
  isPreviewPort,
  type PreviewRow,
} from './service.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const previewParams = z.object({ vmId: z.string().uuid(), previewId: z.string().uuid() });
const idParams = z.object({ previewId: z.string().uuid() });
const ttlHours = z.number().int().min(1).max(MAX_TTL_HOURS);

const passwordField = z
  .string()
  .min(MIN_PREVIEW_PASSWORD, `Kata sandi preview minimal ${MIN_PREVIEW_PASSWORD} karakter.`)
  .max(MAX_PREVIEW_PASSWORD, `Kata sandi preview maksimal ${MAX_PREVIEW_PASSWORD} karakter.`);

/** Mode akses: publik, atau dilindungi kata sandi (wajib diisi bila mode password). */
const accessFields = {
  access: z.enum(['public', 'password']).default('public'),
  password: passwordField.optional(),
};
const needPassword = (v: { access: string; password?: string }, c: z.RefinementCtx) => {
  if (v.access === 'password' && !v.password) {
    c.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Isi kata sandi untuk preview yang dilindungi.',
    });
  }
};

const createBody = z
  .object({
    ...accessFields,
    /** Alias alamat: pv-<alias>.<domain>. Kosong = alamat acak panjang. */
    alias: z
      .string()
      .trim()
      .toLowerCase()
      .superRefine((v, c) => {
        const msg = aliasError(v);
        if (msg) c.addIssue({ code: 'custom', message: msg });
      })
      .optional(),
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
  })
  .superRefine(needPassword);

const accessBody = z.object(accessFields).superRefine(needPassword);

export function previewRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit, previews } = ctx;

  const toPublic = (p: PreviewRow) => ({
    id: p.id,
    vmId: p.vm_id,
    port: p.port,
    label: p.label,
    hostHeader: p.host_header,
    access: p.access,
    url: previews.urlFor(p.subdomain),
    createdAt: p.created_at,
    expiresAt: p.expires_at,
    permanent: isPermanent(p.expires_at),
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
      baseDomain: ctx.env.PREVIEW_BASE_DOMAIN ?? null,
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
      const subdomain = body.alias ? `pv-${body.alias}` : newSubdomain();
      if (db.prepare('SELECT 1 AS ok FROM previews WHERE subdomain = ?').get(subdomain)) {
        throw new AppError(
          409,
          'alias_taken',
          'Alias itu sudah dipakai preview lain. Pilih alias berbeda, atau kosongkan untuk alamat acak.',
        );
      }
      const passwordHash =
        body.access === 'password' ? await hashPassword(body.password as string) : null;
      const id = randomUUID();
      try {
        db.prepare(
          'INSERT INTO previews (id, vm_id, user_id, subdomain, port, label, host_header, access, password_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          vm.id,
          user.id,
          subdomain,
          body.port,
          body.label,
          body.hostHeader ?? null,
          body.access,
          passwordHash,
          now,
          now + body.ttlHours * 3_600_000,
        );
      } catch (e) {
        if (String(e).includes('UNIQUE'))
          throw new AppError(409, 'alias_taken', 'Alias itu baru saja dipakai. Pilih alias lain.');
        throw e;
      }
      // Subdomain adalah kunci akses: tidak dicatat di audit log.
      audit.record({
        userId: user.id,
        vmId: vm.id,
        ip: req.ip,
        action: 'preview.create',
        target: `port:${body.port}`,
        result: 'ok',
        meta: { hours: body.ttlHours, access: body.access, customAlias: !!body.alias },
      });
      reply.code(201);
      return toPublic(load(vm, id));
    },
  );

  /** Ubah mode akses atau ganti kata sandi. Cookie akses lama langsung tidak berlaku (versi dinaikkan). */
  app.post(
    '/api/vms/:vmId/previews/:previewId/access',
    { onRequest: requireActive, config: rateLimit(20) },
    async (req) => {
      const vm = access(req);
      const { previewId } = previewParams.parse(req.params);
      const body = accessBody.parse(req.body);
      load(vm, previewId);
      const hash = body.access === 'password' ? await hashPassword(body.password as string) : null;
      db.prepare(
        'UPDATE previews SET access = ?, password_hash = ?, access_version = access_version + 1 WHERE id = ?',
      ).run(body.access, hash, previewId);
      audit.record({
        userId: actor(req).id,
        vmId: vm.id,
        ip: req.ip,
        action: 'preview.access',
        target: previewId,
        result: 'ok',
        meta: { access: body.access },
      });
      return toPublic(load(vm, previewId));
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
      const current = load(vm, previewId);
      if (isPermanent(current.expires_at)) {
        throw new AppError(
          409,
          'preview_permanent',
          'Preview ini permanen (diatur admin), jadi tidak perlu diperpanjang.',
        );
      }
      // Memperpanjang tidak pernah memperpendek masa berlaku yang sudah lebih lama (mis. diatur admin).
      const expires = Math.max(current.expires_at, Date.now() + hours * 3_600_000);
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

  /** Admin: ubah masa berlaku preview mana pun, dari 30 hari sampai permanen (dihitung dari sekarang). */
  app.post('/api/admin/previews/:previewId/expiry', { onRequest: requireAdmin }, async (req) => {
    const { previewId } = idParams.parse(req.params);
    const { duration } = z
      .object({ duration: z.enum(['30d', '90d', '180d', '365d', 'permanent']) })
      .parse(req.body);
    const p = db
      .prepare('SELECT * FROM previews WHERE id = ? AND expires_at > ?')
      .get(previewId, Date.now()) as PreviewRow | undefined;
    if (!p) throw notFound('Preview');
    const expires =
      duration === 'permanent'
        ? PERMANENT_EXPIRES_AT
        : Date.now() + ADMIN_EXPIRY_DAYS[duration] * 86_400_000;
    db.prepare('UPDATE previews SET expires_at = ?, warned_at = NULL WHERE id = ?').run(
      expires,
      p.id,
    );
    audit.record({
      userId: actor(req).id,
      vmId: p.vm_id,
      ip: req.ip,
      action: 'preview.expiry',
      target: `port:${p.port}`,
      result: 'ok',
      meta: { duration, byAdmin: true },
    });
    notify(
      db,
      p.user_id,
      'preview_expiry',
      'Masa berlaku preview diubah admin',
      duration === 'permanent'
        ? `Preview untuk port ${p.port} kini permanen sampai dicabut.`
        : `Preview untuk port ${p.port} kini berlaku ${ADMIN_EXPIRY_DAYS[duration]} hari dari sekarang.`,
    );
    return toPublic(db.prepare('SELECT * FROM previews WHERE id = ?').get(p.id) as PreviewRow);
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
