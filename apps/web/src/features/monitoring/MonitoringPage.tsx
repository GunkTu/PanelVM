import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Skeleton, Table } from '../../components';
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

/** Warna bar mengikuti beban: hijau, kuning, merah (disertai angka agar tidak bergantung warna saja). */
function Bar({ percent, label }: { percent: number; label: string }) {
  const tone = percent >= 90 ? 'bg-error' : percent >= 75 ? 'bg-yellow' : 'bg-success';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-2.5 overflow-hidden rounded bg-slate-200">
        <div
          className={`h-2.5 rounded ${tone} transition-all`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2)
    return <div className="h-12 text-xs text-slate-400">Mengumpulkan data...</div>;
  const w = 200;
  const h = 48;
  const pts = values
    .map((v, i) => `${(i / (HISTORY - 1)) * w},${h - (Math.min(100, v) / 100) * h}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-12 w-full"
      role="img"
      aria-label="Riwayat penggunaan CPU"
    >
      <polyline points={pts} fill="none" stroke="#0B1F4B" strokeWidth="2" />
    </svg>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h2 className="text-sm font-medium text-slate-600">{title}</h2>
      <div className="mt-2">{children}</div>
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-navy">Monitoring</h1>
        <span className="text-xs text-slate-500" aria-live="polite">
          {isFetching ? 'Memperbarui...' : `Diperbarui otomatis tiap ${REFRESH_MS / 1000} detik`}
        </span>
      </div>

      {error && !data && (
        <p role="alert" className="mt-4 rounded-md border border-error bg-red-50 p-3 text-red-900">
          {error.message}
        </p>
      )}
      {isLoading && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}

      {data && (
        <>
          <p className="mt-2 text-sm text-slate-600">
            {data.host} · {data.os} · kernel {data.kernel}
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Card title={`CPU (${data.cpus} inti)`}>
              <p className="text-2xl font-semibold text-navy">
                {data.cpuPercent === null ? '-' : `${data.cpuPercent}%`}
              </p>
              {data.cpuPercent !== null && <Bar percent={data.cpuPercent} label="Penggunaan CPU" />}
              <Sparkline values={data.history} />
            </Card>
            <Card title="Memori">
              <p className="text-2xl font-semibold text-navy">{Math.round(memPct)}%</p>
              <Bar percent={memPct} label="Penggunaan memori" />
              <p className="mt-1 text-xs text-slate-600">
                {formatBytes(data.mem.usedBytes)} dari {formatBytes(data.mem.totalBytes)}
              </p>
              {data.mem.swapTotalBytes > 0 && (
                <p className="mt-1 text-xs text-slate-600">
                  Swap {formatBytes(data.mem.swapUsedBytes)} /{' '}
                  {formatBytes(data.mem.swapTotalBytes)} ({Math.round(swapPct)}%)
                </p>
              )}
            </Card>
            <Card title="Beban rata-rata">
              <p className="text-2xl font-semibold text-navy">{data.load[0].toFixed(2)}</p>
              <p className="text-xs text-slate-600">
                1 / 5 / 15 menit: {data.load.map((l) => l.toFixed(2)).join(' / ')}
              </p>
              {data.load[0] > data.cpus && (
                <p className="mt-1">
                  <Badge tone="warning">Beban melebihi jumlah inti CPU</Badge>
                </p>
              )}
            </Card>
            <Card title="Uptime">
              <p className="text-lg font-semibold text-navy">{uptimeText(data.uptimeSeconds)}</p>
            </Card>
          </div>

          <h2 className="mt-8 text-lg font-semibold text-navy">Disk</h2>
          <div className="mt-2">
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
                      <Bar percent={d.percent} label={`Disk ${d.mount}`} />
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

          <h2 className="mt-8 text-lg font-semibold text-navy">Proses teratas (CPU)</h2>
          <div className="mt-2">
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
