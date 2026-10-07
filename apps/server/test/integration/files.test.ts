import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, ORIGIN, seedUser, type Client } from '../helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './vmFixture.js';

const built = await makeApp(false, { MAX_UPLOAD_MB: '8' });
const { app, ctx } = built;
let f: VmFixture;
const root = `/tmp/panel-test-${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built);
});
afterAll(async () => {
  if (vmAvailable)
    await call(app, f.admin, 'POST', `/api/vms/${f.vmId}/files/delete`, { path: root });
  await app.close();
});

const url = (p: string, q: Record<string, string> = {}) =>
  `/api/vms/${f.vmId}/files/${p}?${new URLSearchParams(q)}`;
const post = (p: string, body: unknown) =>
  call(app, f.admin, 'POST', `/api/vms/${f.vmId}/files/${p}`, body);
const upload = (path: string, data: Buffer, overwrite = false, c: Client = f.admin) =>
  app.inject({
    method: 'PUT',
    url: url('upload', { path, ...(overwrite ? { overwrite: 'true' } : {}) }),
    headers: {
      origin: ORIGIN,
      cookie: c.cookie,
      'x-csrf-token': c.csrf,
      'content-type': 'application/octet-stream',
    },
    payload: data,
  });

describe.skipIf(!vmAvailable)('file manager (sshd nyata)', () => {
  it('mkdir, list, dan proteksi folder sistem', async () => {
    expect((await post('mkdir', { path: root })).statusCode).toBe(200);
    expect((await post('mkdir', { path: root })).statusCode).toBe(409);
    expect((await post('mkdir', { path: `${root}/sub` })).statusCode).toBe(200);
    const list = await call(app, f.admin, 'GET', url('list', { path: root }));
    expect(list.statusCode).toBe(200);
    expect(
      list.json().items.map((i: { name: string; type: string }) => `${i.name}:${i.type}`),
    ).toEqual(['sub:dir']);
    for (const p of ['/', '/etc', '/usr', '/var']) {
      expect((await post('delete', { path: p })).statusCode, p).toBe(400);
    }
    expect((await post('rename', { from: '/etc', to: '/etc2' })).statusCode).toBe(400);
    expect((await post('chmod', { path: '/', mode: '777', recursive: true })).statusCode).toBe(400);
  });

  it('upload 5 MB (streaming) lalu unduh identik; timpa butuh izin', async () => {
    const data = randomBytes(5 * 1024 * 1024);
    const up = await upload(`${root}/besar.bin`, data);
    expect(up.statusCode).toBe(200);
    expect(up.json().size).toBe(data.length);
    const dl = await call(app, f.admin, 'GET', url('download', { path: `${root}/besar.bin` }));
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('besar.bin');
    expect(Buffer.compare(dl.rawPayload, data)).toBe(0);

    expect((await upload(`${root}/besar.bin`, Buffer.from('baru'))).statusCode).toBe(409);
    expect((await upload(`${root}/besar.bin`, Buffer.from('baru'), true)).statusCode).toBe(200);
    const after = await call(app, f.admin, 'GET', url('content', { path: `${root}/besar.bin` }));
    expect(after.json().content).toBe('baru');
  });

  it('batas ukuran upload ditegakkan dan file sementara dibersihkan', async () => {
    const res = await upload(`${root}/terlalu.bin`, randomBytes(9 * 1024 * 1024));
    expect(res.statusCode).toBe(413);
    const list = await call(app, f.admin, 'GET', url('list', { path: root }));
    expect(
      list
        .json()
        .items.some(
          (i: { name: string }) => i.name.includes('terlalu') || i.name.includes('.panel-'),
        ),
    ).toBe(false);
  });

  it('edit teks, tolak biner, simpan mempertahankan izin', async () => {
    const path = `${root}/app.env`;
    expect((await post('chmod', { path: `${root}/besar.bin`, mode: '600' })).statusCode).toBe(200);
    expect(
      (
        await call(app, f.admin, 'PUT', `/api/vms/${f.vmId}/files/content`, {
          path,
          content: 'A=1\n',
          create: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await post('chmod', { path, mode: '640' })).statusCode).toBe(200);
    expect(
      (
        await call(app, f.admin, 'PUT', `/api/vms/${f.vmId}/files/content`, {
          path,
          content: 'A=2\nB=ü\n',
        })
      ).statusCode,
    ).toBe(200);
    const got = await call(app, f.admin, 'GET', url('content', { path }));
    expect(got.json()).toMatchObject({ content: 'A=2\nB=ü\n', mode: '0640' });
    expect(
      (
        await call(app, f.admin, 'PUT', `/api/vms/${f.vmId}/files/content`, {
          path: `${root}/tidakada.txt`,
          content: 'x',
        })
      ).statusCode,
    ).toBe(404);

    await upload(
      `${root}/biner.dat`,
      Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2, 0xff])]),
    );
    expect(
      (await call(app, f.admin, 'GET', url('content', { path: `${root}/biner.dat` }))).statusCode,
    ).toBe(415);
  });

  it('rename, arsip tar.gz & zip, ekstrak, hapus rekursif', async () => {
    expect(
      (await post('rename', { from: `${root}/app.env`, to: `${root}/sub/app.env` })).statusCode,
    ).toBe(200);
    expect(
      (await post('rename', { from: `${root}/sub/app.env`, to: `${root}/besar.bin` })).statusCode,
    ).toBe(409);

    expect(
      (await post('archive', { paths: [`${root}/sub`], dest: `${root}/a.tar.gz` })).statusCode,
    ).toBe(200);
    expect(
      (await post('archive', { paths: [`${root}/sub`], dest: `${root}/a.tar.gz` })).statusCode,
    ).toBe(409);
    expect(
      (await post('archive', { paths: [`${root}/sub`], dest: `${root}/a.zip` })).statusCode,
    ).toBe(200);
    expect(
      (await post('archive', { paths: [`${root}/sub`], dest: `${root}/a.rar` })).statusCode,
    ).toBe(400);

    for (const a of ['a.tar.gz', 'a.zip']) {
      const dest = `${root}/out-${a}`;
      expect((await post('extract', { path: `${root}/${a}`, destDir: dest })).statusCode, a).toBe(
        200,
      );
      const got = await call(app, f.admin, 'GET', url('content', { path: `${dest}/sub/app.env` }));
      expect(got.json().content, a).toBe('A=2\nB=ü\n');
    }
    expect((await post('delete', { path: `${root}/sub` })).statusCode).toBe(200);
    const list = await call(app, f.admin, 'GET', url('list', { path: root }));
    expect(list.json().items.some((i: { name: string }) => i.name === 'sub')).toBe(false);
  });

  it('nama dengan karakter berbahaya diperlakukan sebagai data (tidak ada injeksi shell)', async () => {
    const marker = `pwned_${randomBytes(4).toString('hex')}`;
    const evil = `${root}/a b'; touch ${marker}; echo '$(touch ${marker}2)\`touch ${marker}3\``;
    expect((await post('mkdir', { path: evil })).statusCode).toBe(200);
    expect((await post('chmod', { path: evil, mode: '755', recursive: true })).statusCode).toBe(
      200,
    );
    expect((await post('chown', { path: evil, owner: 'root', recursive: true })).statusCode).toBe(
      200,
    );
    expect((await post('delete', { path: evil })).statusCode).toBe(200);
    // Direktori kerja exec adalah home user SSH (/root); tidak boleh ada file penanda di sana.
    const home = await call(app, f.admin, 'GET', url('list', { path: '/root' }));
    expect(home.json().items.some((i: { name: string }) => i.name.startsWith(marker))).toBe(false);
  });

  it('input tidak valid ditolak', async () => {
    expect((await post('chmod', { path: root, mode: '9999' })).statusCode).toBe(400);
    expect((await post('chown', { path: root, owner: 'root; id' })).statusCode).toBe(400);
    expect(
      (await call(app, f.admin, 'GET', url('list', { path: 'relatif/path' }))).statusCode,
    ).toBe(400);
    expect(
      (await call(app, f.admin, 'GET', url('list', { path: '/tidak/ada/sama/sekali' }))).statusCode,
    ).toBe(404);
  });

  it('client lain tidak bisa mengakses file VM ini (404) dan audit tercatat', async () => {
    const other = await seedUser(built, 'luar@contoh.com');
    const c = await login(app, other);
    for (const [m, p] of [
      ['GET', 'list'],
      ['GET', 'content'],
      ['GET', 'download'],
    ] as const) {
      expect((await call(app, c, m, url(p, { path: root }))).statusCode, p).toBe(404);
    }
    for (const p of ['mkdir', 'delete', 'chmod', 'rename', 'archive', 'extract']) {
      expect(
        (await call(app, c, 'POST', `/api/vms/${f.vmId}/files/${p}`, { path: root })).statusCode,
        p,
      ).toBe(404);
    }
    expect((await upload(`${root}/x`, Buffer.from('x'), false, c)).statusCode).toBe(404);
    const actions = (
      ctx.db
        .prepare("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'files.%'")
        .all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'files.upload',
        'files.delete',
        'files.edit',
        'files.chmod',
        'files.archive',
      ]),
    );
    const meta = (
      ctx.db.prepare("SELECT meta FROM audit_logs WHERE action LIKE 'files.%'").all() as {
        meta: string | null;
      }[]
    )
      .map((r) => r.meta ?? '')
      .join('');
    expect(meta).not.toContain('A=2');
  });
});
