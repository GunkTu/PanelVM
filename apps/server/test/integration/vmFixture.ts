import { appendFileSync } from 'node:fs';
import { call, login, seedUser, type Client, type TestUser } from '../helpers.js';
import type { BuiltApp } from '../../src/app.js';

/**
 * Test integrasi memakai sshd sungguhan (lihat test/integration/setup-test-vm.sh).
 * Tanpa PANEL_TEST_SSH_PORT dan PANEL_TEST_AUTHORIZED_KEYS, suite integrasi dilewati.
 */
export const sshPort = Number(process.env.PANEL_TEST_SSH_PORT ?? 0);
export const authorizedKeys = process.env.PANEL_TEST_AUTHORIZED_KEYS ?? '';
export const vmAvailable = sshPort > 0 && authorizedKeys !== '';

export interface VmFixture {
  admin: Client;
  adminUser: TestUser;
  vmId: string;
}

export async function setupRealVm(
  built: BuiltApp,
  name = 'vm-nyata',
  adminEmail = 'admin-nyata@contoh.com',
): Promise<VmFixture> {
  const adminUser = await seedUser(built, adminEmail, 'admin');
  const admin = await login(built.app, adminUser);
  const created = await call(built.app, admin, 'POST', '/api/vms', {
    name,
    host: '127.0.0.1',
    sshPort,
    sshUser: 'root',
  });
  if (created.statusCode !== 201) throw new Error(`buat VM gagal: ${created.body}`);
  const vm = created.json() as { id: string; publicKey: string };
  appendFileSync(authorizedKeys, `${vm.publicKey}\n`);
  const scan = await call(built.app, admin, 'POST', `/api/vms/${vm.id}/host-key/scan`);
  const approve = await call(built.app, admin, 'POST', `/api/vms/${vm.id}/host-key/approve`, {
    fingerprint: scan.json().fingerprint,
  });
  if (approve.statusCode !== 200) throw new Error(`approve gagal: ${approve.body}`);
  const test = await call(built.app, admin, 'POST', `/api/vms/${vm.id}/test`);
  if (test.statusCode !== 200) throw new Error(`tes koneksi gagal: ${test.body}`);
  return { admin, adminUser, vmId: vm.id };
}
