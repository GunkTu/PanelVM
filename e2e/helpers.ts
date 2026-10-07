import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, nextClientIp } from './fixtures';
import { generateSync } from 'otplib';

export const adminOf = (name: 'auth' | 'iso' | 'real') => ({
  email: `admin-${name}@e2e.test`,
  password: 'admin-e2e-password-1',
});
const STEP_MS = 30_000;

/** Kode TOTP yang belum pernah dipakai akun ini (server menolak pemakaian ulang langkah waktu yang sama). */
export class Totp {
  private lastStep = -1;
  constructor(public secret: string) {}

  async next(): Promise<string> {
    for (;;) {
      const step = Math.floor(Date.now() / STEP_MS);
      if (step > this.lastStep) {
        this.lastStep = step;
        return generateSync({ secret: this.secret });
      }
      await new Promise((r) => setTimeout(r, STEP_MS - (Date.now() % STEP_MS) + 200)); // tunggu langkah berikutnya
    }
  }
}

/** Login password lalu langkah 2FA yang ditampilkan halaman. */
export async function loginPassword(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Lanjut' }).click();
}

/** Login penuh untuk akun yang 2FA-nya sudah aktif. */
export async function loginFull(
  page: Page,
  email: string,
  password: string,
  totp: Totp,
): Promise<void> {
  await loginPassword(page, email, password);
  await page.waitForURL('**/login/2fa');
  await page.getByLabel('Kode').fill(await totp.next());
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await page.waitForURL('**/vms');
}

/** Login pertama: aktifkan 2FA, simpan recovery code. Mengembalikan secret TOTP dan recovery code. */
export async function firstLogin(
  page: Page,
  email: string,
  password: string,
): Promise<{ totp: Totp; recovery: string[] }> {
  await loginPassword(page, email, password);
  await page.waitForURL('**/login/2fa-setup');
  const secret = (await page.locator('span.select-all').innerText()).trim();
  const totp = new Totp(secret);
  await page.getByLabel('Kode 6 digit').fill(await totp.next());
  await page.getByRole('button', { name: 'Aktifkan dan masuk' }).click();
  await page.getByText('Simpan recovery code').waitFor();
  const recovery = (await page.locator('ul.font-mono li').allInnerTexts()).map((t) => t.trim());
  await page.getByRole('button', { name: 'Sudah saya simpan, lanjut' }).click();
  await page.waitForURL('**/vms');
  return { totp, recovery };
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Keluar' }).click();
  await page.waitForURL('**/login');
}

export async function newContext(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    baseURL: 'http://localhost:5273',
    extraHTTPHeaders: { 'X-Forwarded-For': nextClientIp() },
  });
  return { ctx, page: await ctx.newPage() };
}

/** Admin: tambah VM, setujui host key, tes koneksi. Mengembalikan id VM dan public key panel. */
export async function adminAddVm(
  page: Page,
  name: string,
  port: number,
  user = 'root',
): Promise<{ vmId: string; publicKey: string }> {
  await page.goto('/admin/vms');
  await page.getByRole('button', { name: 'Tambah VM' }).first().click();
  await page.getByLabel('Nama VM').fill(name);
  await page.getByLabel('Host (IP atau nama)').fill('127.0.0.1');
  await page.getByLabel('Port SSH').fill(String(port));
  await page.getByLabel('User SSH').fill(user);
  await page.getByRole('dialog').getByRole('button', { name: 'Tambah' }).click();
  await page.getByRole('cell', { name, exact: true }).waitFor();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Kelola' })
    .click();
  const publicKey = await page.locator('textarea').first().inputValue();
  return { vmId: '', publicKey };
}

export async function approveAndTest(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Pindai host key' }).click();
  await page.getByRole('button', { name: 'Setujui fingerprint ini' }).click();
  await page.getByText('Host key disetujui').waitFor();
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await page.getByText('Koneksi SSH berhasil').waitFor();
}

export async function assignClient(page: Page, email: string): Promise<void> {
  await page.getByLabel('Client pemilik VM').selectOption({ label: email });
  await page.getByText('Akses client diperbarui').waitFor();
}

export async function adminCreateClient(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Tambah client' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password awal').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Buat akun' }).click();
  await expect(page.getByRole('cell', { name: email, exact: true })).toBeVisible();
}

/** Ambil id VM dari tautan di daftar "VM Saya". */
export async function vmIdByName(page: Page, name: string): Promise<string> {
  await page.goto('/vms');
  const href = await page
    .getByRole('link', { name: new RegExp(name) })
    .first()
    .getAttribute('href');
  const m = /\/vms\/([0-9a-f-]{36})\//.exec(href ?? '');
  if (!m) throw new Error(`VM ${name} tidak ditemukan di daftar`);
  return m[1]!;
}
