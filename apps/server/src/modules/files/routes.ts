import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { execRemote } from '../../ssh/exec.js';
import { inDir } from '../../ssh/shell.js';
import type { Lease } from '../../ssh/pool.js';
import { privOpts, sshTargetFor, withVm } from '../vms/service.js';
import { assertNotProtected, baseName, dirName, entryName, remotePath } from './paths.js';
import { modeString, Sftp, sftpError, typeOfMode } from './sftp.js';

const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_LIST = 5000;
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

const vmParams = z.object({ vmId: z.string().uuid() });
const pathQuery = z.object({ path: remotePath });
const modeSchema = z
  .string()
  .regex(/^[0-7]{3,4}$/, 'Izin harus berupa angka oktal 3-4 digit, contoh 755 atau 0644.');
const accountName = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'Nama user/grup tidak valid.');

export function fileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { audit } = ctx;
  const maxBytes = ctx.env.MAX_UPLOAD_MB * 1024 * 1024;

  // Upload dikirim sebagai body mentah (stream), bukan multipart, agar tidak ditampung di memori.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(ctx.db, user, vmId, 'files'), userId: user.id };
  };

  const rec = (
    req: FastifyRequest,
    vm: VmRow,
    userId: string,
    action: string,
    target: string,
    meta?: Record<string, unknown>,
  ) =>
    audit.record({
      userId,
      vmId: vm.id,
      ip: req.ip,
      action: `files.${action}`,
      target,
      result: 'ok',
      meta,
    });

  /** Jalankan operasi SFTP dengan koneksi bersama. */
  const withSftp = <T>(vm: VmRow, fn: (s: Sftp, lease: Lease) => Promise<T>): Promise<T> =>
    withVm(ctx, vm, async (lease) => fn(new Sftp(await lease.sftp()), lease));

  const runOk = async (vm: VmRow, lease: Lease, argv: string[], timeoutMs = 60_000) => {
    const r = await execRemote(lease.client, argv, { ...privOpts(vm), timeoutMs });
    if (r.code !== 0) {
      const detail = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      const missing =
        r.code === 127
          ? ` Perintah "${argv[0]}" belum terpasang di VM; pasang lewat menu Aplikasi (Alat dasar).`
          : '';
      throw new AppError(
        422,
        'command_failed',
        `VM menolak perintah (${argv[0]}): ${detail || 'tanpa pesan'}.${missing}`,
      );
    }
    return r;
  };

  app.get('/api/vms/:vmId/files/list', { preHandler: requireActive }, async (req) => {
    const { vm } = access(req);
    const { path } = pathQuery.parse(req.query);
    return withSftp(vm, async (s) => {
      const st = await s.stat(path);
      if (typeOfMode(st.mode) !== 'dir')
        throw new AppError(400, 'not_a_directory', `"${path}" bukan folder.`);
      const list = await s.readdir(path);
      const items = await Promise.all(
        list.slice(0, MAX_LIST).map(async (e) => {
          let type = typeOfMode(e.attrs.mode);
          let linkTarget: 'dir' | 'file' | undefined;
          if (type === 'link') {
            try {
              linkTarget =
                typeOfMode((await s.stat(`${path === '/' ? '' : path}/${e.filename}`)).mode) ===
                'dir'
                  ? 'dir'
                  : 'file';
            } catch {
              linkTarget = undefined; // symlink putus
            }
          }
          if (type === 'link' && linkTarget === 'dir') type = 'dir';
          return {
            name: e.filename,
            type,
            isLink: typeOfMode(e.attrs.mode) === 'link',
            size: e.attrs.size,
            mode: modeString(e.attrs.mode),
            mtime: e.attrs.mtime * 1000,
            uid: e.attrs.uid,
            gid: e.attrs.gid,
          };
        }),
      );
      items.sort(
        (a, b) =>
          Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
      );
      return { path, truncated: list.length > MAX_LIST, items };
    });
  });

  app.get('/api/vms/:vmId/files/content', { preHandler: requireActive }, async (req) => {
    const { vm } = access(req);
    const { path } = pathQuery.parse(req.query);
    return withSftp(vm, async (s) => {
      const st = await s.stat(path);
      if (typeOfMode(st.mode) !== 'file')
        throw new AppError(400, 'not_a_file', `"${path}" bukan file biasa.`);
      if (st.size > MAX_EDIT_BYTES) {
        throw new AppError(
          413,
          'too_large',
          `File ${Math.round(st.size / 1024)} KB terlalu besar untuk diedit di browser (maksimal ${MAX_EDIT_BYTES / 1024} KB). Unduh file ini, atau edit lewat terminal.`,
        );
      }
      const chunks: Buffer[] = [];
      for await (const c of s.raw.createReadStream(path) as Readable) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      if (buf.subarray(0, 8192).includes(0)) {
        throw new AppError(
          415,
          'binary_file',
          'File ini berisi data biner, bukan teks, jadi tidak bisa diedit di browser. Unduh file untuk melihat isinya.',
        );
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        throw new AppError(
          415,
          'not_utf8',
          'File ini bukan teks UTF-8, jadi tidak bisa diedit di browser tanpa merusak isinya. Unduh atau edit lewat terminal.',
        );
      }
      return { path, content, size: st.size, mode: modeString(st.mode) };
    });
  });

  app.put(
    '/api/vms/:vmId/files/content',
    { preHandler: requireActive, bodyLimit: MAX_EDIT_BYTES + 4096 },
    async (req) => {
      const { vm, userId } = access(req);
      const body = z
        .object({ path: remotePath, content: z.string(), create: z.boolean().default(false) })
        .parse(req.body);
      const bytes = Buffer.from(body.content, 'utf8');
      if (bytes.length > MAX_EDIT_BYTES)
        throw new AppError(
          413,
          'too_large',
          'Isi file melebihi batas editor (1 MB). Gunakan upload untuk file besar.',
        );
      await withSftp(vm, async (s) => {
        const exists = await s.exists(body.path);
        if (!exists && !body.create)
          throw new AppError(
            404,
            'no_such_file',
            `"${body.path}" tidak ditemukan. Muat ulang daftar file.`,
          );
        const prior = exists ? await s.stat(body.path) : null;
        if (prior && typeOfMode(prior.mode) !== 'file')
          throw new AppError(400, 'not_a_file', `"${body.path}" bukan file biasa.`);
        // Tulis di tempat agar pemilik tetap sama. ssh2 selalu menerapkan mode (default 0666)
        // lewat fchmod, jadi izin lama dipulihkan eksplisit setelah menulis.
        await new Promise<void>((resolve, reject) => {
          const w = s.raw.createWriteStream(body.path, {
            flags: 'w',
            mode: prior ? prior.mode & 0o7777 : 0o644,
          });
          w.on('error', (e: Error) => reject(sftpError(e, body.path)));
          w.on('close', () => resolve());
          w.end(bytes);
        });
      });
      rec(req, vm, userId, 'edit', body.path, { bytes: bytes.length, created: body.create });
      return { ok: true, size: bytes.length };
    },
  );

  app.get('/api/vms/:vmId/files/download', { preHandler: requireActive }, async (req, reply) => {
    const { vm, userId } = access(req);
    const { path } = pathQuery.parse(req.query);
    const { vmId } = vmParams.parse(req.params);
    const lease = await ctx.pool.acquire(vmId, sshTargetFor(ctx, vm));
    try {
      const s = new Sftp(await lease.sftp());
      const st = await s.stat(path);
      if (typeOfMode(st.mode) === 'dir')
        throw new AppError(
          400,
          'is_directory',
          'Folder tidak bisa diunduh langsung. Kompres dulu lewat menu Arsip, lalu unduh file arsipnya.',
        );
      const stream = s.raw.createReadStream(path);
      const name = baseName(path);
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', st.size)
        .header(
          'Content-Disposition',
          `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .header('X-Content-Type-Options', 'nosniff');
      rec(req, vm, userId, 'download', path, { bytes: st.size });
      stream.on('error', () => reply.raw.destroy());
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

  app.put(
    '/api/vms/:vmId/files/upload',
    { preHandler: requireActive, bodyLimit: maxBytes },
    async (req) => {
      const { vm, userId } = access(req);
      const q = z
        .object({ path: remotePath, overwrite: z.enum(['true', 'false']).default('false') })
        .parse(req.query);
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (!Number.isFinite(declared))
        throw new AppError(
          411,
          'length_required',
          'Ukuran file tidak diketahui. Unggah lewat halaman File Manager.',
        );
      if (declared > maxBytes)
        throw new AppError(
          413,
          'too_large',
          `File melebihi batas upload ${ctx.env.MAX_UPLOAD_MB} MB. Pecah file, atau unggah lewat SFTP/terminal.`,
        );
      const body = req.body as Readable;
      const name = entryName.parse(baseName(q.path));
      const dir = dirName(q.path);
      const overwrite = q.overwrite === 'true';

      const size = await withSftp(vm, async (s) => {
        if (typeOfMode((await s.stat(dir)).mode) !== 'dir')
          throw new AppError(400, 'not_a_directory', `"${dir}" bukan folder tujuan yang valid.`);
        const prior = (await s.exists(q.path)) ? await s.stat(q.path) : null;
        if (prior && !overwrite)
          throw new AppError(
            409,
            'exists',
            `"${name}" sudah ada di folder ini. Ganti nama file atau pilih timpa.`,
          );
        if (prior && typeOfMode(prior.mode) === 'dir')
          throw new AppError(
            409,
            'is_directory',
            `"${name}" adalah folder, tidak bisa ditimpa file.`,
          );

        const tmp = `${dir === '/' ? '' : dir}/.${name}.panel-${randomBytes(6).toString('hex')}`;
        let received = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            if (received > maxBytes)
              return cb(
                new AppError(
                  413,
                  'too_large',
                  `File melebihi batas upload ${ctx.env.MAX_UPLOAD_MB} MB.`,
                ),
              );
            cb(null, chunk);
          },
        });
        try {
          await pipeline(
            body,
            limiter,
            s.raw.createWriteStream(tmp, {
              flags: 'wx',
              mode: prior ? prior.mode & 0o7777 : 0o644,
            }),
          );
          if (prior) await s.unlink(q.path);
          await s.rename(tmp, q.path);
          if (prior) {
            await s.chmod(q.path, prior.mode & 0o7777).catch(() => {});
            await s.chown(q.path, prior.uid, prior.gid).catch(() => {});
          }
        } catch (e) {
          await s.unlink(tmp).catch(() => {});
          throw e instanceof AppError ? e : sftpError(e, q.path);
        }
        return received;
      });
      rec(req, vm, userId, 'upload', q.path, { bytes: size, overwrite });
      return { ok: true, size };
    },
  );

  app.post('/api/vms/:vmId/files/mkdir', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const { path } = pathQuery.parse(req.body);
    await withSftp(vm, async (s) => {
      if (await s.exists(path))
        throw new AppError(409, 'exists', `"${baseName(path)}" sudah ada. Pilih nama lain.`);
      await s.mkdir(path);
    });
    rec(req, vm, userId, 'mkdir', path);
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/rename', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const { from, to } = z.object({ from: remotePath, to: remotePath }).parse(req.body);
    assertNotProtected(from);
    await withSftp(vm, async (s) => {
      if (await s.exists(to))
        throw new AppError(
          409,
          'exists',
          `"${baseName(to)}" sudah ada di tujuan. Pilih nama lain.`,
        );
      await s.rename(from, to);
    });
    rec(req, vm, userId, 'rename', from, { to });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/delete', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const { path } = pathQuery.parse(req.body);
    assertNotProtected(path);
    const kind = await withVm(ctx, vm, async (lease) => {
      const s = new Sftp(await lease.sftp());
      const st = await s.lstat(path);
      if (typeOfMode(st.mode) === 'dir') {
        await runOk(vm, lease, ['rm', '-rf', '--', path], 5 * 60_000);
        return 'dir';
      }
      await s.unlink(path);
      return 'file';
    });
    rec(req, vm, userId, 'delete', path, { kind });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/chmod', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z
      .object({ path: remotePath, mode: modeSchema, recursive: z.boolean().default(false) })
      .parse(req.body);
    if (b.recursive) assertNotProtected(b.path);
    await withVm(ctx, vm, async (lease) => {
      if (b.recursive) await runOk(vm, lease, ['chmod', '-R', b.mode, '--', b.path], 5 * 60_000);
      else await new Sftp(await lease.sftp()).chmod(b.path, parseInt(b.mode, 8));
    });
    rec(req, vm, userId, 'chmod', b.path, { mode: b.mode, recursive: b.recursive });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/chown', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z
      .object({
        path: remotePath,
        owner: accountName,
        group: accountName.optional(),
        recursive: z.boolean().default(false),
      })
      .parse(req.body);
    if (b.recursive) assertNotProtected(b.path);
    await withVm(ctx, vm, (lease) =>
      runOk(
        vm,
        lease,
        [
          'chown',
          ...(b.recursive ? ['-R'] : []),
          b.group ? `${b.owner}:${b.group}` : b.owner,
          '--',
          b.path,
        ],
        5 * 60_000,
      ),
    );
    rec(req, vm, userId, 'chown', b.path, {
      owner: b.owner,
      group: b.group,
      recursive: b.recursive,
    });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/archive', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z
      .object({ paths: z.array(remotePath).min(1).max(200), dest: remotePath })
      .parse(req.body);
    const parent = dirName(b.paths[0]!);
    if (b.paths.some((p) => dirName(p) !== parent))
      throw new AppError(
        400,
        'mixed_parents',
        'Semua item yang diarsipkan harus berada di folder yang sama.',
      );
    const names = b.paths.map((p) => entryName.parse(baseName(p)));
    const isZip = b.dest.endsWith('.zip');
    if (!isZip && !b.dest.endsWith('.tar.gz') && !b.dest.endsWith('.tgz'))
      throw new AppError(
        400,
        'bad_archive_name',
        'Nama arsip harus berakhiran .zip, .tar.gz, atau .tgz.',
      );
    await withVm(ctx, vm, async (lease) => {
      if (await new Sftp(await lease.sftp()).exists(b.dest))
        throw new AppError(
          409,
          'exists',
          `"${baseName(b.dest)}" sudah ada. Pilih nama arsip lain.`,
        );
      const cmd = isZip
        ? ['zip', '-r', '-q', b.dest, '--', ...names]
        : ['tar', '-czf', b.dest, '-C', parent, '--', ...names];
      const r = await execRemote(lease.client, isZip ? inDir(parent, cmd) : cmd, {
        ...privOpts(vm),
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      });
      if (r.code !== 0) {
        const missing =
          r.code === 127
            ? ` Perintah "${cmd[0]}" belum terpasang di VM; pasang lewat menu Aplikasi (Alat dasar).`
            : '';
        throw new AppError(
          422,
          'archive_failed',
          `Pembuatan arsip gagal: ${r.stderr.trim().slice(0, 200) || 'tanpa pesan'}.${missing}`,
        );
      }
    });
    rec(req, vm, userId, 'archive', b.dest, { items: names.length });
    return { ok: true };
  });

  app.post('/api/vms/:vmId/files/extract', { preHandler: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const b = z.object({ path: remotePath, destDir: remotePath }).parse(req.body);
    const zip = b.path.endsWith('.zip');
    if (!zip && !/\.(tar\.gz|tgz|tar)$/.test(b.path))
      throw new AppError(400, 'bad_archive', 'Format arsip didukung: .zip, .tar.gz, .tgz, .tar.');
    await withVm(ctx, vm, async (lease) => {
      const s = new Sftp(await lease.sftp());
      if (typeOfMode((await s.stat(b.path)).mode) !== 'file')
        throw new AppError(400, 'not_a_file', `"${b.path}" bukan file arsip.`);
      await runOk(vm, lease, ['mkdir', '-p', '--', b.destDir]);
      const cmd = zip
        ? ['unzip', '-o', '-q', b.path, '-d', b.destDir]
        : ['tar', '-xf', b.path, '-C', b.destDir];
      await runOk(vm, lease, cmd, ARCHIVE_TIMEOUT_MS);
    });
    rec(req, vm, userId, 'extract', b.path, { destDir: b.destDir });
    return { ok: true };
  });
}
