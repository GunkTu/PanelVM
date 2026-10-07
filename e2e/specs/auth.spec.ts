import { expect, test } from '../fixtures';
import {
  adminOf,
  firstLogin,
  loginFull,
  loginPassword,
  logout,
  newContext,
  type Totp,
} from '../helpers';

const ADMIN = adminOf('auth');
test.describe.configure({ mode: 'serial' });

let totp: Totp;
let recovery: string[] = [];

test('pesan error login sama untuk email tidak ada dan password salah', async ({ page }) => {
  await loginPassword(page, 'tidak-ada@e2e.test', 'password-apa-saja-123');
  const a = await page.getByRole('alert').innerText();
  await loginPassword(page, ADMIN.email, 'password-salah-sekali-123');
  const b = await page.getByRole('alert').innerText();
  expect(a).toBe(b);
  expect(a).toMatch(/Email atau password salah/);
});

test('halaman terlindungi mengalihkan ke login; sesi sebelum 2FA tidak cukup', async ({ page }) => {
  await page.goto('/admin/users');
  await page.waitForURL('**/login');
  await page.goto('/vms');
  await page.waitForURL('**/login');
  // lolos password tetapi belum 2FA: tetap tidak boleh melihat halaman
  await loginPassword(page, ADMIN.email, ADMIN.password);
  await page.waitForURL('**/login/2fa-setup');
  await page.goto('/vms');
  await page.waitForURL('**/login/2fa-setup');
  await page.goto('/admin/audit');
  await page.waitForURL('**/login/2fa-setup');
});

test('login pertama memaksa pengaktifan 2FA dan menampilkan 10 recovery code', async ({ page }) => {
  ({ totp, recovery } = await firstLogin(page, ADMIN.email, ADMIN.password));
  expect(recovery).toHaveLength(10);
  expect(recovery.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c))).toBe(true);
  await expect(page.getByRole('link', { name: 'Kelola VM' })).toBeVisible();
});

test('logout lalu login ulang dengan kode TOTP', async ({ page }) => {
  await loginFull(page, ADMIN.email, ADMIN.password, totp);
  await logout(page);
  await page.goto('/vms');
  await page.waitForURL('**/login');
});

test('kode 2FA salah ditolak dengan pesan yang jelas', async ({ page }) => {
  await loginPassword(page, ADMIN.email, ADMIN.password);
  await page.waitForURL('**/login/2fa');
  await page.getByLabel('Kode').fill('000000');
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await expect(page.getByRole('alert')).toContainText('Kode salah');
});

test('recovery code bisa dipakai sekali saja', async ({ page, browser }) => {
  const code = recovery[0]!;
  await loginPassword(page, ADMIN.email, ADMIN.password);
  await page.waitForURL('**/login/2fa');
  await page.getByLabel('Kode').fill(code);
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await page.waitForURL('**/vms');
  await logout(page);

  const ctx2 = await newContext(browser).then((c) => c.ctx);
  const p2 = await ctx2.newPage();
  await loginPassword(p2, ADMIN.email, ADMIN.password);
  await p2.waitForURL('**/login/2fa');
  await p2.getByLabel('Kode').fill(code);
  await p2.getByRole('button', { name: 'Verifikasi' }).click();
  await expect(p2.getByRole('alert')).toContainText('Kode salah atau sudah dipakai');
  await ctx2.close();
});

test('tidak ada halaman atau endpoint registrasi publik', async ({ page, request }) => {
  await page.goto('/register');
  await page.waitForURL('**/login');
  const r = await request.post('/api/auth/register', {
    data: {},
    headers: { origin: 'http://localhost:5273' },
  });
  expect(r.status()).toBe(404);
});
