import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { execRemote } from '../../ssh/exec.js';
import { MysqlDriver } from '../databases/mysql.js';
import { PostgresDriver } from '../databases/postgres.js';
import type { DbDriver, Engine } from '../databases/types.js';
import {
  assertRoleName,
  dbIdentifier,
  generateDbPassword,
  RESERVED_NAMES,
} from '../databases/validate.js';
import { privOpts, withVm } from '../vms/service.js';
import { dbNameFromDomain, setEnvVars } from './envfile.js';

const params = z.object({ vmId: z.string().uuid(), siteId: z.string().uuid() });

interface SiteLite {
  id: string;
  domain: string;
  kind: 'laravel' | 'php' | 'static';
  root_path: string;
}

/**
 * "Siapkan database" untuk sebuah situs: buat database + user khusus (password acak, hanya ditampilkan sekali),
 * lalu bila situs punya berkas .env (Laravel), isi variabel DB_* di dalamnya. Tanpa .env, kredensial hanya
 * ditampilkan agar pengguna memasukkannya ke konfigurasi aplikasinya.
 */
export function siteDbRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const access = (req: FastifyRequest): { vm: VmRow; userId: string; site: SiteLite } => {
    const { vmId, siteId } = params.parse(req.params);
    const user = actor(req);
    // Butuh kedua modul: situs (milik situs ini) dan database (membuat database/user).
    assertVmAccess(db, user, vmId, 'database');
    const vm = assertVmAccess(db, user, vmId, 'sites');
    const site = db
      .prepare('SELECT id, domain, kind, root_path FROM sites WHERE id = ? AND vm_id = ?')
      .get(siteId, vm.id) as SiteLite | undefined;
    if (!site) throw notFound('Situs');
    return { vm, userId: user.id, site };
  };

  app.post(
    '/api/vms/:vmId/sites/:siteId/database',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId, site } = access(req);
      const body = z
        .object({
          name: dbIdentifier.optional(),
          engine: z.enum(['mysql', 'postgres']).default('mysql'),
        })
        .parse(req.body ?? {});
      const engine: Engine = body.engine;

      let name = body.name ?? dbNameFromDomain(site.domain);
      if (RESERVED_NAMES.has(name)) name = `${name}_db`.slice(0, 32);
      const user = `${name.slice(0, 29)}_u`;
      dbIdentifier.parse(name);
      dbIdentifier.parse(user);
      assertRoleName(engine, user);

      const result = await withVm(ctx, vm, async (lease) => {
        const d: DbDriver =
          engine === 'postgres'
            ? new PostgresDriver(lease.client, privOpts(vm))
            : new MysqlDriver(lease.client, privOpts(vm));
        const info = await d.info();
        if (!info.managed)
          throw new AppError(
            409,
            'engine_unavailable',
            info.problem ??
              'Database belum terpasang atau belum bisa dikelola panel. Pasang lewat menu Aplikasi, lalu coba lagi.',
          );
        if ((await d.listDatabases()).some((x) => x.name === name))
          throw new AppError(
            409,
            'db_exists',
            `Database "${name}" sudah ada. Isi nama lain pada kolom Nama database, atau pakai database yang sudah ada.`,
          );
        if ((await d.listUsers()).some((x) => x.name === user))
          throw new AppError(
            409,
            'db_user_exists',
            `User database "${user}" sudah ada. Isi nama database lain agar nama user-nya berbeda.`,
          );

        const password = generateDbPassword();
        await d.createDatabase(name);
        try {
          await d.createUser(user, password);
          await d.grant(user, name, 'all');
        } catch (e) {
          await d.dropDatabase(name).catch(() => {}); // jangan tinggalkan setengah jadi
          await d.dropUser(user).catch(() => {});
          throw e;
        }

        const vars = {
          DB_CONNECTION: engine === 'postgres' ? 'pgsql' : 'mysql',
          DB_HOST: '127.0.0.1',
          DB_PORT: engine === 'postgres' ? '5432' : '3306',
          DB_DATABASE: name,
          DB_USERNAME: user,
          DB_PASSWORD: password,
        };

        let envWritten = false;
        const envPath = `${site.root_path}/.env`;
        if (site.kind !== 'static') {
          try {
            const run = (argv: string[], stdin?: string) =>
              execRemote(lease.client, argv, { ...privOpts(vm), ...(stdin ? { stdin } : {}) });
            const has = (await run(['test', '-f', envPath])).code === 0;
            let current = '';
            if (has) current = (await run(['cat', '--', envPath])).stdout;
            else if (site.kind === 'laravel') {
              const ex = await run(['cat', '--', `${site.root_path}/.env.example`]);
              if (ex.code === 0) current = ex.stdout;
            }
            // Situs PHP biasa hanya disentuh bila sudah punya .env; Laravel boleh dibuat baru.
            if (has || site.kind === 'laravel') {
              const next = setEnvVars(current, vars);
              const w = await run(['tee', '--', envPath], next);
              if (w.code === 0) {
                if (!has) {
                  await run(['chown', 'www-data:www-data', '--', envPath]);
                  await run(['chmod', '640', '--', envPath]);
                }
                envWritten = true;
              }
            }
          } catch {
            envWritten = false; // database tetap jadi; kredensial ditampilkan agar bisa dipasang manual
          }
        }
        return { password, envWritten, envPath };
      });

      audit.record({
        userId,
        vmId: vm.id,
        ip: req.ip,
        action: 'site.db_setup',
        target: site.domain,
        result: 'ok',
        meta: { database: name, user, envWritten: result.envWritten, engine },
      });
      return {
        ok: true,
        database: name,
        user,
        password: result.password,
        envWritten: result.envWritten,
        envPath: result.envWritten ? result.envPath : null,
      };
    },
  );
}
