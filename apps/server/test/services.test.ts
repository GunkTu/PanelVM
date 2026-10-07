import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isProtectedUnit,
  mergeServices,
  parseListUnits,
  parseShow,
  parseUnitFiles,
  unitName,
} from '../src/modules/services/systemd.js';
import { call, login, makeApp, seedUser } from './helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './integration/vmFixture.js';

// Format keluaran systemctl (list-units --plain --no-legend) sesuai dokumentasi systemd.
const LIST = `  accounts-daemon.service  loaded    active   running Accounts Service
  nginx.service            loaded    active   running A high performance web server
  redis-server.service     loaded    inactive dead    Advanced key-value store
  ghost.service            not-found inactive dead    ghost.service
  apt-daily.service        loaded    failed   failed  Daily apt download activities
`;
const FILES = `accounts-daemon.service enabled enabled
nginx.service           enabled enabled
redis-server.service    disabled enabled
apt-daily.service       static   -
`;

describe('parser systemd', () => {
  it('menggabungkan list-units dan list-unit-files, membuang not-found', () => {
    const items = mergeServices(parseListUnits(LIST), parseUnitFiles(FILES));
    expect(items.map((i) => i.name)).toEqual([
      'accounts-daemon.service',
      'apt-daily.service',
      'nginx.service',
      'redis-server.service',
    ]);
    expect(items.find((i) => i.name === 'nginx.service')).toMatchObject({
      active: 'active',
      sub: 'running',
      enabled: 'enabled',
      description: 'A high performance web server',
    });
    expect(items.find((i) => i.name === 'apt-daily.service')).toMatchObject({
      active: 'failed',
      enabled: 'static',
    });
  });
  it('parseShow dan keluaran kosong', () => {
    expect(parseShow('ActiveState=active\nSubState=running\nDescription=a=b\n')).toEqual({
      ActiveState: 'active',
      SubState: 'running',
      Description: 'a=b',
    });
    expect(parseListUnits('')).toEqual([]);
  });
});

describe('validasi nama unit dan proteksi', () => {
  it('menerima nama wajar, menolak injeksi dan bentuk lain', () => {
    for (const ok of [
      'nginx.service',
      'php8.3-fpm.service',
      'user@1000.service',
      'my_app-1.service',
    ])
      expect(unitName.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      'nginx',
      'a b.service',
      'x;id.service',
      '$(id).service',
      '../x.service',
      'a\nb.service',
      '-rf.service ',
      '--all.service',
      'x.service --now',
      '',
      'a'.repeat(120) + '.service',
      'nginx.timer',
    ]) {
      expect(unitName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('service sistem dilindungi', () => {
    for (const u of [
      'ssh.service',
      'sshd.service',
      'dbus.service',
      'systemd-logind.service',
      'systemd-networkd.service',
      'networking.service',
      'ssh@1.service',
    ])
      expect(isProtectedUnit(u), u).toBe(true);
    for (const u of ['nginx.service', 'mariadb.service', 'php8.3-fpm.service', 'sshfs.service'])
      expect(isProtectedUnit(u), u).toBe(false);
  });
});

// ---- integrasi dengan systemctl PALSU (VM uji tanpa systemd). Tidak menguji systemd nyata. ----
const FAKE_DIR = '/usr/local/bin';
const STATE = '/tmp/fake-systemd.log';
const FAKE_SYSTEMCTL = `#!/bin/bash
echo "systemctl $*" >> ${STATE}
case "$1" in
  list-units) printf '%s\\n' 'nginx.service loaded active running A high performance web server' 'redis-server.service loaded inactive dead Redis' 'ssh.service loaded active running OpenBSD Secure Shell server' 'ghost.service not-found inactive dead ghost.service';;
  list-unit-files) printf '%s\\n' 'nginx.service enabled enabled' 'redis-server.service disabled enabled' 'ssh.service enabled enabled';;
  show)
    unit="\${@: -1}"
    case "$unit" in
      nginx.service|redis-server.service|ssh.service) printf 'loaded\\n';;
      *) printf 'not-found\\n';;
    esac
    if [[ "$*" == *ActiveState* ]]; then printf 'ActiveState=active\\nSubState=running\\nUnitFileState=enabled\\n'; fi;;
  start|stop|restart|reload|enable|disable) if [[ "\${@: -1}" == "redis-server.service" && "$1" == "start" && -f /tmp/fake-systemd.fail ]]; then echo "Job for redis-server.service failed." >&2; exit 1; fi;;
esac
exit 0
`;
const FAKE_JOURNAL = `#!/bin/bash
echo "journalctl $*" >> ${STATE}
printf '2026-01-01T00:00:00+0000 vm nginx[1]: started\\n'
`;

const built = await makeApp();
const { app, ctx } = built;
let f: VmFixture;
const useFake = vmAvailable && !existsSync('/run/systemd/system');

beforeAll(async () => {
  if (!vmAvailable) return;
  f = await setupRealVm(built, 'vm-svc', 'admin-svc@contoh.com');
  if (useFake) {
    mkdirSync(FAKE_DIR, { recursive: true });
    writeFileSync(`${FAKE_DIR}/systemctl`, FAKE_SYSTEMCTL);
    writeFileSync(`${FAKE_DIR}/journalctl`, FAKE_JOURNAL);
    chmodSync(`${FAKE_DIR}/systemctl`, 0o755);
    chmodSync(`${FAKE_DIR}/journalctl`, 0o755);
    writeFileSync(STATE, '');
  }
});
afterAll(async () => {
  if (useFake)
    for (const p of [
      `${FAKE_DIR}/systemctl`,
      `${FAKE_DIR}/journalctl`,
      STATE,
      '/tmp/fake-systemd.fail',
    ])
      rmSync(p, { force: true });
  await app.close();
});

const base = () => `/api/vms/${f.vmId}/services`;
const calls = () => readFileSync(STATE, 'utf8').trim().split('\n').filter(Boolean);

describe.skipIf(!useFake)('service manager (systemctl palsu di VM nyata)', () => {
  it('daftar service dengan status dan proteksi', async () => {
    const r = await call(app, f.admin, 'GET', base());
    expect(r.statusCode, r.body).toBe(200);
    const items = r.json().items as {
      name: string;
      active: string;
      enabled: string;
      protected: boolean;
    }[];
    expect(items.map((i) => i.name)).toEqual([
      'nginx.service',
      'redis-server.service',
      'ssh.service',
    ]);
    expect(items.find((i) => i.name === 'ssh.service')!.protected).toBe(true);
    expect(items.find((i) => i.name === 'redis-server.service')).toMatchObject({
      active: 'inactive',
      enabled: 'disabled',
    });
  });

  it('aksi memanggil systemctl dengan argumen tetap dan tercatat di audit', async () => {
    writeFileSync(STATE, '');
    const r = await call(app, f.admin, 'POST', `${base()}/action`, {
      unit: 'nginx.service',
      action: 'restart',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, active: 'active' });
    expect(calls()).toContain('systemctl restart -- nginx.service');
    const a = ctx.db
      .prepare(
        "SELECT result FROM audit_logs WHERE action = 'service.restart' AND target = 'nginx.service'",
      )
      .get() as { result: string };
    expect(a.result).toBe('ok');
  });

  it('menolak input berbahaya, service tak dikenal, dan aksi pada service terlindungi', async () => {
    writeFileSync(STATE, '');
    const act = (b: unknown) => call(app, f.admin, 'POST', `${base()}/action`, b);
    for (const unit of [
      'nginx',
      'x;id.service',
      '--now.service',
      '$(id).service',
      'nginx.service --force',
    ])
      expect((await act({ unit, action: 'stop' })).statusCode, unit).toBe(400);
    expect((await act({ unit: 'nginx.service', action: 'poweroff' })).statusCode).toBe(400);
    expect((await act({ unit: 'tidak-ada.service', action: 'start' })).statusCode).toBe(404);
    for (const action of ['stop', 'disable', 'restart', 'start', 'enable'])
      expect((await act({ unit: 'ssh.service', action })).statusCode, action).toBe(403);
    expect((await act({ unit: 'systemd-logind.service', action: 'restart' })).statusCode).toBe(403);
    expect((await act({ unit: 'ssh.service', action: 'reload' })).statusCode).toBe(200);
    expect(calls().some((c) => /systemctl (stop|disable|restart|start|enable) /.test(c))).toBe(
      false,
    ); // tidak ada yang sampai ke systemctl
  });

  it('kegagalan systemctl dilaporkan dengan pesan jelas', async () => {
    writeFileSync('/tmp/fake-systemd.fail', '1');
    const r = await call(app, f.admin, 'POST', `${base()}/action`, {
      unit: 'redis-server.service',
      action: 'start',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain('gagal');
    expect(
      ctx.db
        .prepare("SELECT result FROM audit_logs WHERE action = 'service.start' ORDER BY id DESC")
        .get(),
    ).toEqual({ result: 'fail' });
  });

  it('log dibatasi jumlah barisnya dan unit divalidasi', async () => {
    writeFileSync(STATE, '');
    const ok = await call(app, f.admin, 'GET', `${base()}/logs?unit=nginx.service&lines=50`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().log).toContain('started');
    expect(calls()).toContain('journalctl --unit nginx.service -n 50 --no-pager -o short-iso');
    for (const q of [
      'unit=nginx.service&lines=100000',
      'unit=nginx.service&lines=0',
      'unit=x;id.service',
      'unit=tidak-ada.service',
    ]) {
      expect(
        (await call(app, f.admin, 'GET', `${base()}/logs?${q}`)).statusCode,
        q,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it('client lain mendapat 404', async () => {
    const other = await login(app, await seedUser(built, 'luar-svc@contoh.com'));
    expect((await call(app, other, 'GET', base())).statusCode).toBe(404);
    expect(
      (
        await call(app, other, 'POST', `${base()}/action`, {
          unit: 'nginx.service',
          action: 'stop',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(app, other, 'GET', `${base()}/logs?unit=nginx.service`)).statusCode).toBe(
      404,
    );
  });
});
