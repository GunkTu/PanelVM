import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONITOR_SCRIPT, parseMonitoring } from '../src/modules/monitoring/collect.js';
import { call, login, makeApp, seedUser } from './helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './integration/vmFixture.js';

// Keluaran nyata dari MONITOR_SCRIPT di Ubuntu 24.04 (dipotong).
const SAMPLE = `host=vm
kernel=6.18.44-fc-v77
os=Ubuntu 24.04.5 LTS
uptime=313.90
load=0.61 0.35 0.14
cpus=4
##stat1
cpu  10303 0 2625 109096 2500 0 302 477 0 0
##stat2
cpu  10304 0 2625 109495 2500 0 302 477 0 0
##mem
MemTotal:       16480968 kB
MemFree:        15457516 kB
MemAvailable:   15794936 kB
Buffers:           24304 kB
Cached:           543912 kB
SwapTotal:       2097148 kB
SwapFree:        2097000 kB
##disk
Filesystem         1-blocks        Used   Available Capacity Mounted on
/dev/vda       270553174016 11008933888 30814924800      27% /
/dev/vdc          279711744   249368576    24727552      91% /mnt/data disk
##top
  PID USER                 %CPU %MEM COMMAND
 5929 root                  100  0.0 ps
   94 www-data               5.6  1.9 php-fpm8.3
`;

describe('parseMonitoring', () => {
  it('mengurai keluaran nyata dengan benar', () => {
    const m = parseMonitoring(SAMPLE);
    expect(m).toMatchObject({
      host: 'vm',
      os: 'Ubuntu 24.04.5 LTS',
      uptimeSeconds: 313,
      cpus: 4,
      load: [0.61, 0.35, 0.14],
    });
    // delta total = 400 (1 user + 399 idle); idle delta = 399 -> 0.25% terpakai
    expect(m.cpuPercent).toBeGreaterThanOrEqual(0.2);
    expect(m.cpuPercent).toBeLessThanOrEqual(0.3);
    expect(m.mem.totalBytes).toBe(16480968 * 1024);
    expect(m.mem.usedBytes).toBe((16480968 - 15794936) * 1024);
    expect(m.mem.swapUsedBytes).toBe(148 * 1024);
    expect(m.disks).toHaveLength(2);
    expect(m.disks[1]).toMatchObject({ mount: '/mnt/data disk', percent: 89.2 }); // mount dengan spasi tetap utuh
    expect(m.top[1]).toMatchObject({ pid: 94, user: 'www-data', command: 'php-fpm8.3' });
  });

  it('tahan terhadap keluaran rusak/kosong tanpa melempar error', () => {
    const m = parseMonitoring('##stat1\nxx\n##stat2\nyy\n##mem\nMemTotal: abc kB\n##disk\n');
    expect(m.cpuPercent).toBeNull();
    expect(m.disks).toEqual([]);
    expect(m.cpus).toBe(1);
    expect(() => parseMonitoring('')).not.toThrow();
  });

  it('kernel lama tanpa MemAvailable memakai cadangan', () => {
    const m = parseMonitoring(
      '##mem\nMemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n',
    );
    expect(m.mem.availableBytes).toBe(300 * 1024);
  });

  it('skrip statis dan hanya membaca (tanpa perintah penulis/destruktif)', () => {
    expect(MONITOR_SCRIPT).not.toMatch(/\b(rm|mv|cp|chmod|chown|kill|tee|dd|mkfs|apt|systemctl)\b/);
    // satu-satunya pengalihan keluaran yang boleh adalah membuang stderr ke /dev/null
    expect(MONITOR_SCRIPT.replace(/2>\/dev\/null/g, '')).not.toMatch(/>/);
  });
});

const built = await makeApp();
const { app } = built;
let f: VmFixture;
beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built, 'vm-mon', 'admin-mon@contoh.com');
});
afterAll(() => app.close());

describe.skipIf(!vmAvailable)('monitoring (VM nyata)', () => {
  it('membaca metrik asli dan menolak client lain', async () => {
    const r = await call(app, f.admin, 'GET', `/api/vms/${f.vmId}/monitoring`);
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json();
    expect(m.cpus).toBeGreaterThan(0);
    expect(m.mem.totalBytes).toBeGreaterThan(0);
    expect(m.disks.length).toBeGreaterThan(0);
    expect(m.uptimeSeconds).toBeGreaterThan(0);
    expect(m.cpuPercent).toBeGreaterThanOrEqual(0);
    const other = await login(app, await seedUser(built, 'luar-mon@contoh.com'));
    expect((await call(app, other, 'GET', `/api/vms/${f.vmId}/monitoring`)).statusCode).toBe(404);
  });
});
