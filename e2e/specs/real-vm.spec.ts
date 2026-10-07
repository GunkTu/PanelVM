import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import {
  adminOf,
  adminAddVm,
  approveAndTest,
  firstLogin,
  loginFull,
  Totp,
  vmIdByName,
} from '../helpers';

/**
 * Alur UI terhadap VM nyata (sshd, MariaDB, PostgreSQL, Nginx, PHP-FPM di mesin yang sama).
 * Dilewati bila PANEL_TEST_SSH_PORT / PANEL_TEST_AUTHORIZED_KEYS tidak diset (lihat docs/DEPLOY.md).
 */
const SSH_PORT = Number(process.env.PANEL_TEST_SSH_PORT ?? 0);
const AUTH_KEYS = process.env.PANEL_TEST_AUTHORIZED_KEYS ?? '';
const enabled = SSH_PORT > 0 && AUTH_KEYS !== '';
const ADMIN = adminOf('real');
const sfx = Math.random().toString(36).slice(2, 7);
const work = mkdtempSync(join(tmpdir(), 'panel-e2e-'));

test.skip(
  !enabled,
  'VM nyata tidak tersedia (set PANEL_TEST_SSH_PORT dan PANEL_TEST_AUTHORIZED_KEYS)',
);
test.describe.configure({ mode: 'serial' });
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

let totp: Totp;
let vmId = '';

test('admin mendaftarkan VM nyata dan menghubungkannya (host key + tes koneksi)', async ({
  page,
}) => {
  ({ totp } = await firstLogin(page, ADMIN.email, ADMIN.password));
  const { publicKey } = await adminAddVm(page, 'vm-nyata', SSH_PORT);
  appendFileSync(AUTH_KEYS, `${publicKey}\n`);
  await approveAndTest(page);
  await page.getByRole('button', { name: 'Tutup', exact: true }).click();
  vmId = await vmIdByName(page, 'vm-nyata');
  await page.goto(`/vms/${vmId}/files`); // menu modul hanya tampil di dalam halaman VM
  for (const m of ['File Manager', 'Database', 'Aplikasi', 'Situs Web', 'Monitoring', 'Service']) {
    await expect(page.getByRole('link', { name: m })).toBeVisible();
  }
});

test('file manager: folder, unggah, edit, hapus', async ({ page }) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/files?path=/tmp`);
  const dir = `e2e-${sfx}`;
  await page.getByRole('button', { name: 'Folder baru' }).click();
  await page.getByLabel('Nama folder').fill(dir);
  await page.getByRole('dialog').getByRole('button', { name: 'Buat' }).click();
  await page.getByRole('button', { name: new RegExp(dir) }).click();
  await page.getByText('Folder ini kosong').waitFor();
  await page.setInputFiles('input[type=file]', {
    name: 'catatan.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('halo dari browser'),
  });
  const row = page.getByRole('row', { name: /catatan.txt/ });
  await row.waitFor();
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Isi file').fill('diedit lewat panel');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await page.getByText('disimpan').first().waitFor();
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Isi file')).toHaveValue('diedit lewat panel');
  await page.getByRole('button', { name: 'Tutup', exact: true }).click();
  await row.getByRole('button', { name: 'Hapus' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus' }).click();
  await page.getByText('Folder ini kosong').waitFor();
});

test('database MySQL/MariaDB: buat (kredensial benar-benar bisa login), query, hapus butuh ketik nama', async ({
  page,
}) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/databases`);
  await expect(page.getByText('Siap dikelola').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: /MariaDB|MySQL/ }).click();
  const name = `e2e_${sfx}`;
  await page.getByRole('button', { name: 'Buat database' }).first().click();
  await page.getByLabel('Nama database').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Buat', exact: true }).click();
  await page.getByText('Simpan kredensial database').waitFor();
  const pw = (await page.locator('dd.select-all').innerText()).trim();
  expect(
    execFileSync('mariadb', ['-h127.0.0.1', `-u${name}`, `-p${pw}`, name, '-N', '-e', 'SELECT 42'])
      .toString()
      .trim(),
  ).toBe('42');
  await page.getByRole('button', { name: 'Sudah saya simpan' }).click();

  await page
    .getByRole('row', { name: new RegExp(name) })
    .first()
    .getByRole('button', { name: 'Query' })
    .click();
  await page.getByLabel('Perintah SQL').fill("SELECT 'halo' AS sapaan");
  await page.getByRole('button', { name: 'Jalankan' }).click();
  await expect(page.getByRole('cell', { name: 'halo' })).toBeVisible();
  await page.getByRole('button', { name: 'Tutup', exact: true }).click();

  await page
    .getByRole('row', { name: new RegExp(name) })
    .first()
    .getByRole('button', { name: 'Hapus' })
    .click();
  const del = page.getByRole('dialog').getByRole('button', { name: 'Hapus database' });
  await expect(del).toBeDisabled();
  await page.getByLabel(/Ketik/).fill(name);
  await del.click();
  await page.getByText(`${name} dihapus`).waitFor();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Hapus' })
    .last()
    .click();
  await page.getByLabel(/Ketik/).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus user' }).click();
  await page.getByText(`${name} dihapus`).first().waitFor();
});

test('database PostgreSQL: pilih engine, buat database + user, login nyata, hapus', async ({
  page,
}) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/databases`);
  await page.getByRole('tab', { name: /PostgreSQL/ }).click();
  await expect(page.getByText('Siap dikelola').first()).toBeVisible({ timeout: 20_000 });
  const name = `pgx_${sfx}`; // awalan pg_ dicadangkan PostgreSQL untuk nama user
  await page.getByRole('button', { name: 'Buat database' }).first().click();
  await page.getByLabel('Nama database').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Buat', exact: true }).click();
  await page.getByText('Simpan kredensial database').waitFor();
  const pw = (await page.locator('dd.select-all').innerText()).trim();
  await expect(page.locator('pre').first()).toContainText('DB_CONNECTION=pgsql');
  const out = execFileSync(
    'psql',
    ['-h', '127.0.0.1', '-U', name, '-d', name, '-Atc', 'SELECT 7'],
    { env: { ...process.env, PGPASSWORD: pw } },
  )
    .toString()
    .trim();
  expect(out).toBe('7');
  await page.getByRole('button', { name: 'Sudah saya simpan' }).click();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .first()
    .getByRole('button', { name: 'Hapus' })
    .click();
  await page.getByLabel(/Ketik/).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus database' }).click();
  await page.getByText(`${name} dihapus`).waitFor();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Hapus' })
    .last()
    .click();
  await page.getByLabel(/Ketik/).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus user' }).click();
  await page.getByText(`${name} dihapus`).first().waitFor();
});

test('aplikasi: status paket dan job apt update dengan log langsung', async ({ page }) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/software`);
  await expect(page.getByText('Terpasang', { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Segarkan daftar paket' }).click();
  await expect(page.getByText('[SELESAI] Daftar paket diperbarui')).toBeVisible({
    timeout: 90_000,
  });
});

test('situs web: buat situs statis, deploy zip dari browser, dilayani Nginx, lalu hapus', async ({
  page,
}) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/sites`);
  const domain = `e2e-${sfx}.contoh.test`;
  await page.getByRole('button', { name: 'Tambah situs' }).first().click();
  await page.getByLabel('Domain').fill(domain);
  await page.getByLabel('Jenis').selectOption('static');
  await page.getByRole('dialog').getByRole('button', { name: 'Buat situs' }).click();
  await page.getByText(domain).first().waitFor();

  writeFileSync(join(work, 'index.html'), '<h1>E2E SITUS</h1>');
  execFileSync('zip', ['-q', 'site.zip', 'index.html'], { cwd: work });
  await page.getByRole('button', { name: 'Deploy kode' }).click();
  await page.setInputFiles('.fixed input[type=file]', join(work, 'site.zip'));
  await page.getByRole('button', { name: 'Unggah dan deploy' }).click();
  await expect(page.getByText('[SELESAI] Deploy berhasil')).toBeVisible({ timeout: 90_000 });
  expect(
    execFileSync('curl', ['-s', '-H', `Host: ${domain}`, 'http://127.0.0.1/']).toString(),
  ).toContain('E2E SITUS');

  await page.getByRole('button', { name: 'Hapus', exact: true }).last().click();
  await page.getByLabel(/Ketik/).fill(domain);
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus situs' }).click();
  await page.getByText('Situs dihapus').waitFor();
});

test('monitoring: kartu CPU, memori, dan disk tampil dengan data nyata', async ({ page }) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await page.goto(`/vms/${vmId}/monitoring`);
  await expect(page.getByText(/inti\)/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('progressbar', { name: 'Penggunaan memori' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Disk' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '/', exact: true })).toBeVisible();
});
