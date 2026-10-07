import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Clock, Cpu, Gauge as Gauge2, MemoryStick } from 'lucide-react';
import { Badge, PageHeader, ProgressBar, SectionTitle, Skeleton, Table } from '../../components';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useVmId } from '../layout/useVmId';

interface Monitoring {
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
  collectedAt: number;
}
type Sample = Monitoring & { history: number[] };

const HISTORY = 40;
const REFRESH_MS = 5000;

function uptimeText(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d} hari` : '', h ? `${h} jam` : '', `${m} menit`].filter(Boolean).join(' ');
}

/** Gauge melingkar: warna mengikuti beban (hijau, kuning >= 75%, merah >= 90%); angka selalu tertulis di tengah. */
function Gauge({ percent, label }: { percent: number; label: string }) {
  const p = Math.min(100, Math.max(0, percent));
  const r = 34;
  const c = 2 * Math.PI * r;
  const color = p >= 90 ? '#b91c1c' : p >= 75 ? '#f5b700' : '#15803d';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative h-24 w-24 shrink-0"
    >
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (p / 100) * c}
          className="transition-all duration-700"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-navy">
        {Math.round(p)}%
      </span>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="mt-3 text-xs text-slate-400">Mengumpulkan data...</p>;
  const w = 200;
  const h = 40;
  const pts = values.map(
    (v, i) => `${(i / (values.length - 1)) * w},${h - (Math.min(100, v) / 100) * (h - 4) - 2}`,
  );
  const last = pts[pts.length - 1]!.split(',')[0];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="mt-3 h-10 w-full"
      role="img"
      aria-label="Riwayat penggunaan CPU"
    >
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0B1F4B" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#0B1F4B" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(' ')} ${last},${h}`} fill="url(#spark)" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="#0B1F4B"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-medium text-slate-600">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-navy"
        >
          {icon}
        </span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function MonitoringPage() {
  const vmId = useVmId();
  const qc = useQueryClient();
  const key = ['monitoring', vmId];
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: key,
    refetchInterval: REFRESH_MS,
    retry: 1,
    queryFn: async (): Promise<Sample> => {
      const m = await api<Monitoring>(`/api/vms/${vmId}/monitoring`);
      const prev = qc.getQueryData<Sample>(key)?.history ?? [];
      return {
        ...m,
        history: m.cpuPercent === null ? prev : [...prev, m.cpuPercent].slice(-HISTORY),
      };
    },
  });

  const memPct =
    data && data.mem.totalBytes > 0 ? (data.mem.usedBytes / data.mem.totalBytes) * 100 : 0;
  const swapPct =
    data && data.mem.swapTotalBytes > 0
      ? (data.mem.swapUsedBytes / data.mem.swapTotalBytes) * 100
      : 0;

  return (
    <div>
      <PageHeader
        icon={<Activity className="h-5 w-5" />}
        title="Monitoring"
        description={
          data
            ? `${data.host} · ${data.os} · kernel ${data.kernel}`
            : 'Pemakaian CPU, memori, dan disk VM secara langsung.'
        }
        actions={
          <span
            className="inline-flex items-center gap-2 text-xs text-slate-500"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${isFetching ? 'animate-pulse bg-yellow' : 'bg-green-500'}`}
            />
            {isFetching ? 'Memperbarui...' : `Diperbarui otomatis tiap ${REFRESH_MS / 1000} detik`}
          </span>
        }
      />

      {error && !data && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          {error.message}
        </p>
      )}
      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 rounded-(--radius-card)" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard title={`CPU (${data.cpus} inti)`} icon={<Cpu className="h-4 w-4" />}>
              <div className="flex items-center gap-4">
                {data.cpuPercent === null ? (
                  <p className="text-2xl font-semibold text-navy">-</p>
                ) : (
                  <Gauge percent={data.cpuPercent} label="Penggunaan CPU" />
                )}
                <div className="min-w-0 text-xs text-slate-500">
                  <p>Beban 1 menit</p>
                  <p className="text-lg font-semibold text-navy">{data.load[0].toFixed(2)}</p>
                </div>
              </div>
              <Sparkline values={data.history} />
            </StatCard>

            <StatCard title="Memori" icon={<MemoryStick className="h-4 w-4" />}>
              <div className="flex items-center gap-4">
                <Gauge percent={memPct} label="Penggunaan memori" />
                <div className="min-w-0 text-xs text-slate-500">
                  <p className="text-sm font-semibold text-navy">
                    {formatBytes(data.mem.usedBytes)}
                  </p>
                  <p>dari {formatBytes(data.mem.totalBytes)}</p>
                  {data.mem.swapTotalBytes > 0 && (
                    <p className="mt-1">
                      Swap {formatBytes(data.mem.swapUsedBytes)} /{' '}
                      {formatBytes(data.mem.swapTotalBytes)} ({Math.round(swapPct)}%)
                    </p>
                  )}
                </div>
              </div>
            </StatCard>

            <StatCard title="Beban rata-rata" icon={<Gauge2 className="h-4 w-4" />}>
              <p className="text-3xl font-semibold text-navy">{data.load[0].toFixed(2)}</p>
              <p className="mt-1 text-xs text-slate-500">
                1 / 5 / 15 menit: {data.load.map((l) => l.toFixed(2)).join(' / ')}
              </p>
              <ProgressBar
                className="mt-3"
                percent={(data.load[0] / data.cpus) * 100}
                label="Beban terhadap jumlah inti"
              />
              {data.load[0] > data.cpus && (
                <p className="mt-2">
                  <Badge tone="warning" dot>
                    Melebihi jumlah inti CPU
                  </Badge>
                </p>
              )}
            </StatCard>

            <StatCard title="Uptime" icon={<Clock className="h-4 w-4" />}>
              <p className="text-2xl font-semibold text-navy">{uptimeText(data.uptimeSeconds)}</p>
              <p className="mt-1 text-xs text-slate-500">sejak VM terakhir menyala</p>
            </StatCard>
          </div>

          <div className="mt-8">
            <SectionTitle>Disk</SectionTitle>
            <Table
              rows={data.disks}
              rowKey={(d) => d.mount}
              emptyMessage="Tidak ada data disk dari VM."
              columns={[
                {
                  header: 'Mount',
                  render: (d) => <span className="font-mono text-xs">{d.mount}</span>,
                },
                {
                  header: 'Penggunaan',
                  render: (d) => (
                    <div className="min-w-40">
                      <ProgressBar percent={d.percent} label={`Disk ${d.mount}`} />
                    </div>
                  ),
                },
                { header: '', render: (d) => `${d.percent}%` },
                {
                  header: 'Terpakai',
                  render: (d) => `${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)}`,
                },
              ]}
            />
          </div>

          <div className="mt-8">
            <SectionTitle>Proses teratas (CPU)</SectionTitle>
            <Table
              rows={data.top}
              rowKey={(t) => String(t.pid)}
              emptyMessage="Data proses tidak tersedia."
              columns={[
                { header: 'PID', render: (t) => t.pid },
                { header: 'User', render: (t) => t.user },
                { header: 'CPU %', render: (t) => t.cpu },
                { header: 'Mem %', render: (t) => t.mem },
                {
                  header: 'Perintah',
                  render: (t) => <span className="font-mono text-xs">{t.command}</span>,
                },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}
