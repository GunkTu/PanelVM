import { expect, test } from '../fixtures';
import { startFakeSsh, type FakeSsh } from '../../apps/server/test/fakeSsh';
import {
  adminOf,
  adminAddVm,
  adminCreateClient,
  approveAndTest,
  assignClient,
  firstLogin,
  loginFull,
  newContext,
  vmIdByName,
  Totp,
} from '../helpers';

const ADMIN = adminOf('iso');
test.describe.configure({ mode: 'serial' });

const A = { email: 'klien-a@e2e.test', password: 'klien-a-password-1' };
const B = { email: 'klien-b@e2e.test', password: 'klien-b-password-1' };
let fakeA: FakeSsh;
let fakeB: FakeSsh;
let adminTotp: Totp;
let aTotp: Totp;
let idA = '';
let idB = '';

test.beforeAll(async () => {
  fakeA = await startFakeSsh();
  fakeB = await startFakeSsh();
});
test.afterAll(async () => {
  await fakeA?.close();
  await fakeB?.close();
});

test('admin menyiapkan dua VM dan dua client (satu VM per client)', async ({ browser }) => {
  const { ctx, page } = await newContext(browser);
  ({ totp: adminTotp } = await firstLogin(page, ADMIN.email, ADMIN.password));
  await adminCreateClient(page, A.email, A.password);
  await adminCreateClient(page, B.email, B.password);
  for (const [name, fake, who] of [
    ['vm-a', fakeA, A.email],
    ['vm-b', fakeB, B.email],
  ] as const) {
    await adminAddVm(page, name, fake.port);
    await approveAndTest(page);
    await assignClient(page, who);
    await page.getByRole('button', { name: 'Tutup', exact: true }).click();
  }
  await expect(page.getByRole('row', { name: /vm-a/ })).toContainText(A.email);
  await expect(page.getByRole('row', { name: /vm-b/ })).toContainText(B.email);
  idA = await vmIdByName(page, 'vm-a');
  idB = await vmIdByName(page, 'vm-b');
  expect(idA).not.toBe(idB);
  await ctx.close();
});

test('client A hanya melihat VM-nya dan tidak bisa membuka VM B (UI maupun API)', async ({
  browser,
}) => {
  const { ctx, page } = await newContext(browser);
  ({ totp: aTotp } = await firstLogin(page, A.email, A.password));
  await expect(page.getByRole('link', { name: /vm-a/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /vm-b/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Kelola VM' })).toHaveCount(0); // menu admin tidak tampil

  for (const path of ['files', 'databases', 'software', 'sites', 'monitoring', 'services']) {
    await page.goto(`/vms/${idB}/${path}`);
    await expect(page.getByRole('alert').first()).toContainText(/tidak ditemukan/i);
  }
  const api = ctx.request;
  for (const url of [
    `/api/vms/${idB}`,
    `/api/vms/${idB}/files/list?path=/`,
    `/api/vms/${idB}/databases`,
    `/api/vms/${idB}/jobs`,
  ]) {
    expect((await api.get(url)).status(), url).toBe(404);
  }
  expect((await api.get('/api/users')).status()).toBe(403);
  expect((await api.get('/api/audit')).status()).toBe(403);
  await page.goto('/admin/users');
  await page.waitForURL('**/vms'); // rute admin dialihkan untuk client
  await ctx.close();
});

test('terminal client A berjalan, lalu terputus otomatis saat admin menangguhkan akun', async ({
  browser,
}) => {
  const clientCtx = await newContext(browser);
  const adminCtx = await newContext(browser);
  await loginFull(clientCtx.page, A.email, A.password, aTotp);
  await loginFull(adminCtx.page, ADMIN.email, ADMIN.password, adminTotp);

  await clientCtx.page.goto(`/vms/${idA}/terminal`);
  await expect(clientCtx.page.getByText('Terhubung', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await clientCtx.page.locator('.xterm').click();
  await clientCtx.page.keyboard.type('halo-e2e');
  await expect(clientCtx.page.locator('.xterm-rows')).toContainText('halo-e2e');

  await adminCtx.page.goto('/admin/users');
  await adminCtx.page
    .getByRole('row', { name: new RegExp(A.email) })
    .getByRole('button', { name: 'Tangguhkan' })
    .click();
  await adminCtx.page.getByRole('dialog').getByRole('button', { name: 'Tangguhkan' }).click();
  await adminCtx.page.getByText('ditangguhkan').first().waitFor();

  // Terminal harus ditutup server (tanpa menunggu timeout idle) dan sesi client tidak berlaku lagi.
  await expect(clientCtx.page.getByText('Ditutup', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await clientCtx.page.goto('/vms');
  await clientCtx.page.waitForURL('**/login');
  await clientCtx.ctx.close();
  await adminCtx.ctx.close();
});

test('audit log mencatat sesi terminal dan penangguhan', async ({ browser }) => {
  const { ctx, page } = await newContext(browser);
  await loginFull(page, ADMIN.email, ADMIN.password, adminTotp);
  await page.goto('/admin/audit');
  for (const action of ['terminal.open', 'terminal.close', 'user.suspend', 'vm.create']) {
    await expect(page.getByText(action).first()).toBeVisible();
  }
  await ctx.close();
});
