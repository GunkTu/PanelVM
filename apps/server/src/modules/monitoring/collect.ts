/**
 * Monitoring VM: satu skrip shell STATIS yang hanya membaca (/proc, df, ps). Tidak ada input pengguna
 * yang masuk ke skrip. Dikirim lewat stdin ke `sh -s`.
 */
export const MONITOR_SCRIPT = `echo "host=$(hostname)"
echo "kernel=$(uname -r)"
echo "os=$( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" )"
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "cpus=$(grep -c '^processor' /proc/cpuinfo)"
echo "##stat1"
head -n1 /proc/stat
sleep 1
echo "##stat2"
head -n1 /proc/stat
echo "##mem"
grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo "##disk"
df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x efivarfs -x overlay 2>/dev/null
echo "##top"
ps -eo pid,user:20,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 6
`;

export interface Monitoring {
  host: string;
  kernel: string;
  os: string;
  uptimeSeconds: number;
  load: [number, number, number];
  cpus: number;
  cpuPercent: number | null;
  mem: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disks: {
    filesystem: string;
    mount: string;
    totalBytes: number;
    usedBytes: number;
    percent: number;
  }[];
  top: { pid: number; user: string; cpu: number; mem: number; command: string }[];
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function cpuPercent(a: string | undefined, b: string | undefined): number | null {
  const parse = (l?: string) => (l ? l.trim().split(/\s+/).slice(1, 9).map(Number) : []);
  const x = parse(a);
  const y = parse(b);
  if (x.length < 5 || y.length < 5 || [...x, ...y].some((n) => !Number.isFinite(n))) return null;
  const total = (v: number[]) => v.reduce((s, n) => s + n, 0);
  const idle = (v: number[]) => (v[3] ?? 0) + (v[4] ?? 0);
  const dt = total(y) - total(x);
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle(y) - idle(x)) / dt) * 1000) / 10));
}

export function parseMonitoring(text: string): Monitoring {
  const kv: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const sec = /^##(\w+)$/.exec(line);
    if (sec) {
      current = sec[1]!;
      sections[current] = [];
      continue;
    }
    if (current) {
      if (line.trim()) sections[current]!.push(line);
      continue;
    }
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) kv[m[1]!] = m[2]!.trim();
  }

  const meminfo: Record<string, number> = {};
  for (const l of sections.mem ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) meminfo[m[1]!] = Number(m[2]) * 1024;
  }
  const total = meminfo.MemTotal ?? 0;
  // MemAvailable ada di kernel >= 3.14; cadangan untuk kernel lama.
  const available =
    meminfo.MemAvailable ?? (meminfo.MemFree ?? 0) + (meminfo.Buffers ?? 0) + (meminfo.Cached ?? 0);
  const swapTotal = meminfo.SwapTotal ?? 0;

  const disks = (sections.disk ?? [])
    .slice(1) // header df
    .map((l) => {
      const p = l.trim().split(/\s+/);
      if (p.length < 6) return null;
      const totalBytes = num(p[1]);
      const usedBytes = num(p[2]);
      return {
        filesystem: p[0]!,
        mount: p.slice(5).join(' '),
        totalBytes,
        usedBytes,
        percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null && d.totalBytes > 0);

  const top = (sections.top ?? [])
    .slice(1)
    .map((l) => {
      const p = l.trim().split(/\s+/);
      return p.length >= 5
        ? {
            pid: num(p[0]),
            user: p[1]!,
            cpu: num(p[2]),
            mem: num(p[3]),
            command: p.slice(4).join(' '),
          }
        : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const load = (kv.load ?? '').split(' ').map(num);
  return {
    host: kv.host ?? '',
    kernel: kv.kernel ?? '',
    os: kv.os ?? '',
    uptimeSeconds: Math.floor(num(kv.uptime)),
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpus: Math.max(1, Math.round(num(kv.cpus))),
    cpuPercent: cpuPercent(sections.stat1?.[0], sections.stat2?.[0]),
    mem: {
      totalBytes: total,
      availableBytes: available,
      usedBytes: Math.max(0, total - available),
      swapTotalBytes: swapTotal,
      swapUsedBytes: Math.max(0, swapTotal - (meminfo.SwapFree ?? 0)),
    },
    disks,
    top,
  };
}
