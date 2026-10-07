import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * E2E: menjalankan server panel (DB sementara, kunci acak) dan Vite, lalu mengendalikan browser sungguhan.
 * Spesifikasi yang butuh VM nyata dilewati bila PANEL_TEST_SSH_PORT/PANEL_TEST_AUTHORIZED_KEYS tidak diset.
 * Jalankan: npm run e2e   (opsional PLAYWRIGHT_CHROMIUM_PATH=/path/ke/chromium)
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tmp = join(here, '.tmp');
const API_PORT = 3100;
const WEB_PORT = 5273;
const origin = `http://localhost:${WEB_PORT}`;

const env: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  APP_ORIGIN: origin,
  DATABASE_PATH: join(tmp, 'panel.db'),
  SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(48).toString('base64'),
  TRUST_PROXY: 'true', // E2E memberi X-Forwarded-For unik per konteks (lihat fixtures.ts)
  VM_CHECK_INTERVAL_SEC: '0',
  MAX_UPLOAD_MB: '64',
};

export default defineConfig({
  testDir: join(here, 'specs'),
  outputDir: join(tmp, 'results'),
  workers: 1, // satu DB bersama; tiap spec memakai akun dan VM sendiri
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: origin,
    locale: 'id-ID',
    viewport: { width: 1280, height: 900 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] }
      : { args: ['--no-sandbox'] },
  },
  webServer: [
    {
      command: `rm -rf ${tmp}/panel.db* && mkdir -p ${tmp} && cd ${root}/apps/server && npx tsx ${join(here, 'seed.ts')} && npx tsx src/index.ts`,
      url: `http://localhost:${API_PORT}/api/health`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `cd ${root}/apps/web && npx vite --port ${WEB_PORT} --strictPort`,
      url: origin,
      env: { PANEL_API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
