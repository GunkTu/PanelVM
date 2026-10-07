import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { execRemote } from '../../ssh/exec.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import type { Lease } from '../../ssh/pool.js';
import { notifyAdmins } from '../notifications/service.js';
import { privOpts, sshTargetFor, withVm } from '../vms/service.js';
import { MysqlDriver } from './mysql.js';
import type { DbDriver } from './types.js';
import { dbIdentifier, generateDbPassword } from './validate.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const MAX_SQL_CHARS = 200_000;

export function databaseRoutes(app: FastifyInstance, ctx: Ctx): void {
  const maxBytes = ctx.env.MAX_UPLOAD_MB * 1024 * 1024;

  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(ctx.db, user, vmId, 'database'), userId: user.id };
  };
  const driver = (vm: VmRow, lease: Lease): DbDriver => new MysqlDriver(lease.client, privOpts(vm));
  const withDriver = <T>(vm: VmRow, fn: (d: DbDriver) => Promise<T>) =>
    withVm(ctx, vm, (lease) => fn(driver(vm, lease)));
  const rec = (
    req: FastifyRequest,
    vm: VmRow,
    userId: string,
    action: string,
    target: string,
    result: 'ok' | 'fail' = 'ok',
    meta?: Record<string, unknown>,
  ) =>
    ctx.audit.record({
      userId,
      vmId: vm.id,
      ip: req.ip,
      action: `db.${action}`,
      target,
      result,
      meta,
    });
  const risky = (vm: VmRow, who: string, what: string) =>
    notifyAdmins(
      ctx.db,
      'risky_action',
      'Aksi berisiko di database',
      `${who} ${what} di VM "${vm.name}".`,
    );
  const emailOf = (id: string) =>
    (
      ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(id) as
        { email: string } | undefined
    )?.email ?? 'Pengguna';

  /** Kredensial dikembalikan SEKALI; password tidak disimpan di panel maupun audit. */
  const credentialsFor = (user: string, password: string, database?: string) => ({
    user,
    password,
    database: database ?? null,
    envSnippet: [
      'DB_CONNECTION=mysql',
      'DB_HOST=127.0.0.1',
      'DB_PORT=3306',
      ...(database ? [`DB_DATABASE=${database}`] : []),
      `DB_USERNAME=${user}`,
      `DB_PASSWORD=${password}`,
    ].join('\n'),
  });

  app.get('/api/vms/:vmId/databases/engines', { preHandler: requireActive }, async (req) => {
    const { vm } = access(req);
    const mysql = await withDriver(vm, (d) => d.info());
    // Deteksi PostgreSQL hanya informatif; manajemennya menyusul (Fase 3).
    const pg = await withVm(ctx, vm, async (lease) => {
      const r = await execRemote(
        lease.client,
        ['sh', '-c', 'command -v psql >/dev/null 2>&1 && psql --version'],
        privOpts(vm),
      );
      return r.code === 0 ? r.stdout.trim() : null;
    });
    return {
      engines: [
        mysql,
        ...(pg
          ? [
              {
                engine: 'postgres',
                flavor: 'postgres',
                version: pg.replace(/^psql \(PostgreSQL\) /, ''),
                running: true,
                managed: false,
                problem: 'Pengelolaan PostgreSQL dari panel belum tersedia.',
              },
            ]
          : []),
      ],
    };
  });

  app.get('/api/vms/:vmId/databases', { preHandler: requireActive }, async (req) => {
    const { vm } = access(req);
    return withDriver(vm, async (d) => ({
      databases: await d.listDatabases(),
      users: await d.listUsers(),
    }));
  });

  app.post('/api/vms/:vmId/databases', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ name: dbIdentifier, user: dbIdentifier.optional() }).parse(req.body);
    const result = await withDriver(vm, async (d) => {
      await d.createDatabase(b.name);
      if (!b.user) return null;
      const password = generateDbPassword();
      try {
        await d.createUser(b.user, password);
        await d.grant(b.user, b.name, 'all');
      } catch (e) {
        await d.dropDatabase(b.name).catch(() => {}); // rollback agar tidak setengah jadi
        await d.dropUser(b.user).catch(() => {});
        throw e;
      }
      return credentialsFor(b.user, password, b.name);
    });
    rec(req, vm, userId, 'create_database', b.name, 'ok', { withUser: !!b.user });
    return { ok: true, credentials: result };
  });

  app.post('/api/vms/:vmId/databases/drop', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ name: dbIdentifier, confirm: z.string() }).parse(req.body);
    if (b.confirm !== b.name)
      throw new AppError(
        400,
        'confirm_mismatch',
        'Konfirmasi tidak cocok. Ketik nama database persis untuk menghapus.',
      );
    await withDriver(vm, (d) => d.dropDatabase(b.name));
    rec(req, vm, userId, 'drop_database', b.name);
    risky(vm, emailOf(userId), `menghapus database "${b.name}"`);
    return { ok: true };
  });

  app.post('/api/vms/:vmId/databases/users', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ name: dbIdentifier, database: dbIdentifier.optional() }).parse(req.body);
    const password = generateDbPassword();
    await withDriver(vm, async (d) => {
      await d.createUser(b.name, password);
      if (b.database)
        await d.grant(b.name, b.database, 'all').catch(async (e) => {
          await d.dropUser(b.name).catch(() => {});
          throw e;
        });
    });
    rec(req, vm, userId, 'create_user', b.name, 'ok', { database: b.database });
    return { ok: true, credentials: credentialsFor(b.name, password, b.database) };
  });

  app.post(
    '/api/vms/:vmId/databases/users/password',
    { preHandler: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const b = z.object({ name: dbIdentifier }).parse(req.body);
      const password = generateDbPassword();
      await withDriver(vm, async (d) => {
        if (!(await d.listUsers()).some((u) => u.name === b.name))
          throw new AppError(
            404,
            'db_user_missing',
            'User database tidak ditemukan. Muat ulang daftar.',
          );
        await d.setPassword(b.name, password);
      });
      rec(req, vm, userId, 'reset_user_password', b.name);
      return { ok: true, credentials: credentialsFor(b.name, password) };
    },
  );

  app.post('/api/vms/:vmId/databases/users/drop', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ name: dbIdentifier, confirm: z.string() }).parse(req.body);
    if (b.confirm !== b.name)
      throw new AppError(
        400,
        'confirm_mismatch',
        'Konfirmasi tidak cocok. Ketik nama user persis untuk menghapus.',
      );
    await withDriver(vm, (d) => d.dropUser(b.name));
    rec(req, vm, userId, 'drop_user', b.name);
    risky(vm, emailOf(userId), `menghapus user database "${b.name}"`);
    return { ok: true };
  });

  app.post('/api/vms/:vmId/databases/grant', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z
      .object({ user: dbIdentifier, database: dbIdentifier, level: z.enum(['all', 'readonly']) })
      .parse(req.body);
    await withDriver(vm, async (d) => {
      const dbs = await d.listDatabases();
      if (!dbs.some((x) => x.name === b.database))
        throw new AppError(404, 'db_unknown', 'Database tidak ditemukan. Muat ulang daftar.');
      if (!(await d.listUsers()).some((u) => u.name === b.user))
        throw new AppError(
          404,
          'db_user_missing',
          'User database tidak ditemukan. Muat ulang daftar.',
        );
      await d.grant(b.user, b.database, b.level);
    });
    rec(req, vm, userId, 'grant', `${b.user}@${b.database}`, 'ok', { level: b.level });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/databases/revoke', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ user: dbIdentifier, database: dbIdentifier }).parse(req.body);
    await withDriver(vm, (d) => d.revoke(b.user, b.database));
    rec(req, vm, userId, 'revoke', `${b.user}@${b.database}`);
    return { ok: true };
  });

  app.post(
    '/api/vms/:vmId/databases/query',
    { preHandler: requireActive, bodyLimit: MAX_SQL_CHARS * 4 },
    async (req) => {
      const { vm, userId } = access(req);
      const b = z
        .object({
          database: dbIdentifier.nullable(),
          sql: z
            .string()
            .min(1)
            .max(MAX_SQL_CHARS, 'Query terlalu panjang. Gunakan Import untuk file SQL besar.'),
        })
        .parse(req.body);
      let result;
      try {
        result = await withDriver(vm, (d) => d.query(b.database, b.sql));
      } catch (e) {
        rec(req, vm, userId, 'query', b.database ?? '-', 'fail', { chars: b.sql.length });
        throw e;
      }
      // Isi query tidak dicatat (bisa memuat data); hanya kata pertama dan panjang.
      rec(req, vm, userId, 'query', b.database ?? '-', 'ok', {
        verb: b.sql.trim().split(/\s+/)[0]?.slice(0, 12)?.toUpperCase(),
        chars: b.sql.length,
        rows: result.rows.length,
      });
      return result;
    },
  );

  // Import: body mentah (stream) langsung ke stdin klien mysql di VM, tanpa file sementara.
  app.post(
    '/api/vms/:vmId/databases/import',
    { preHandler: requireActive, bodyLimit: maxBytes },
    async (req) => {
      const { vm, userId } = access(req);
      const { database } = z.object({ database: dbIdentifier }).parse(req.query);
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (!Number.isFinite(declared))
        throw new AppError(
          411,
          'length_required',
          'Ukuran file tidak diketahui. Unggah lewat halaman Database.',
        );
      if (declared > maxBytes)
        throw new AppError(
          413,
          'too_large',
          `File SQL melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB. Gunakan terminal untuk file yang lebih besar.`,
        );
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          received += chunk.length;
          if (received > maxBytes)
            return cb(
              new AppError(
                413,
                'too_large',
                `File SQL melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB.`,
              ),
            );
          cb(null, chunk);
        },
      });
      (req.body as Readable).pipe(limiter);
      try {
        await withDriver(vm, async (d) => {
          if (!(await d.listDatabases()).some((x) => x.name === database))
            throw new AppError(
              404,
              'db_unknown',
              'Database tujuan tidak ditemukan. Buat dulu, lalu import.',
            );
          await d.importSql(database, limiter);
        });
      } catch (e) {
        rec(req, vm, userId, 'import', database, 'fail', { bytes: received });
        throw e;
      }
      rec(req, vm, userId, 'import', database, 'ok', { bytes: received });
      return { ok: true, bytes: received };
    },
  );

  app.get('/api/vms/:vmId/databases/export', { preHandler: requireActive }, async (req, reply) => {
    const { vm, userId } = access(req);
    const { database } = z.object({ database: dbIdentifier }).parse(req.query);
    const { vmId } = vmParams.parse(req.params);
    const lease = await ctx.pool.acquire(vmId, sshTargetFor(ctx, vm));
    try {
      const d = driver(vm, lease);
      if (!(await d.listDatabases()).some((x) => x.name === database))
        throw new AppError(404, 'db_unknown', 'Database tidak ditemukan. Muat ulang daftar.');
      const { stream, done } = await d.exportSql(database);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      reply
        .header('Content-Type', 'application/sql; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${database}-${stamp}.sql"`)
        .header('X-Content-Type-Options', 'nosniff');
      rec(req, vm, userId, 'export', database);
      done.catch((e) => {
        ctx.log?.warn({ err: (e as Error).message }, 'dump gagal');
        reply.raw.destroy(); // putuskan koneksi agar unduhan tidak terlihat "sukses" padahal terpotong
      });
      reply.raw.on('close', () => {
        stream.destroy();
        lease.release();
      });
      return reply.send(stream);
    } catch (e) {
      lease.release();
      throw e;
    }
  });
}
