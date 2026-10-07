import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  Modal,
  Table,
  useToast,
  type BadgeTone,
} from '../../components';
import { api } from '../../lib/api';
import { useVmId } from '../layout/useVmId';

interface Service {
  name: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  enabled: string;
  protected: boolean;
}
type Action = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable';

const activeTone = (a: string): BadgeTone =>
  a === 'active' ? 'success' : a === 'failed' ? 'error' : a === 'inactive' ? 'neutral' : 'warning';
const activeText = (a: string, sub: string) =>
  a === 'active'
    ? `Aktif (${sub})`
    : a === 'failed'
      ? 'Gagal'
      : a === 'inactive'
        ? 'Mati'
        : `${a} (${sub})`;
const FILTERS = [
  ['all', 'Semua'],
  ['active', 'Aktif'],
  ['failed', 'Gagal'],
  ['inactive', 'Mati'],
] as const;

export function ServicesPage() {
  const vmId = useVmId();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}/services`;
  const list = useQuery({
    queryKey: ['services', vmId],
    retry: false,
    queryFn: () => api<{ items: Service[] }>(base),
  });
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<{ unit: string; action: Action } | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [lines, setLines] = useState(100);

  const run = useMutation({
    mutationFn: (v: { unit: string; action: Action }) =>
      api(`${base}/action`, { method: 'POST', body: v }),
    onSuccess: async (_r, v) => {
      toast.show('success', `${v.action} ${v.unit} berhasil.`);
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ['services', vmId] });
    },
    onError: (e) => {
      toast.show('error', e.message);
      setConfirm(null);
    },
  });
  const logs = useQuery({
    queryKey: ['service-logs', vmId, logFor, lines],
    enabled: logFor !== null,
    gcTime: 0,
    retry: false,
    queryFn: () =>
      api<{ log: string }>(`${base}/logs?unit=${encodeURIComponent(logFor!)}&lines=${lines}`),
  });

  const ask = (unit: string, action: Action) =>
    action === 'stop' || action === 'disable' || action === 'restart'
      ? setConfirm({ unit, action })
      : run.mutate({ unit, action });
  const rows = (list.data?.items ?? []).filter(
    (s) =>
      (filter === 'all' || s.active === filter) &&
      s.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-navy">Service</h1>
        <Button variant="ghost" loading={list.isFetching} onClick={() => void list.refetch()}>
          Muat ulang
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Input label="Cari service" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter status">
          {FILTERS.map(([k, t]) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={`rounded-full border px-3 py-1 text-sm ${filter === k ? 'border-navy bg-navy text-white' : 'border-slate-300'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4">
        <Table
          rows={list.data ? rows : undefined}
          loading={list.isLoading}
          error={list.error?.message}
          rowKey={(s) => s.name}
          emptyMessage="Tidak ada service yang cocok dengan filter."
          columns={[
            {
              header: 'Service',
              render: (s) => (
                <div>
                  <span className="font-mono text-xs font-medium">{s.name}</span>
                  {s.protected && (
                    <span className="ml-2">
                      <Badge tone="info">Dilindungi</Badge>
                    </span>
                  )}
                  <p className="text-xs text-slate-500">{s.description}</p>
                </div>
              ),
            },
            {
              header: 'Status',
              render: (s) => (
                <Badge tone={activeTone(s.active)}>{activeText(s.active, s.sub)}</Badge>
              ),
            },
            { header: 'Saat boot', render: (s) => s.enabled || '-' },
            {
              header: 'Aksi',
              render: (s) => (
                <div className="flex flex-wrap gap-1">
                  {s.protected ? (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={() => ask(s.name, 'reload')}
                    >
                      Reload
                    </Button>
                  ) : (
                    <>
                      {s.active !== 'active' && (
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => ask(s.name, 'start')}
                        >
                          Start
                        </Button>
                      )}
                      {s.active === 'active' && (
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => ask(s.name, 'restart')}
                        >
                          Restart
                        </Button>
                      )}
                      {s.active === 'active' && (
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs !text-error"
                          onClick={() => ask(s.name, 'stop')}
                        >
                          Stop
                        </Button>
                      )}
                      {s.enabled === 'enabled' ? (
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => ask(s.name, 'disable')}
                        >
                          Nonaktifkan boot
                        </Button>
                      ) : s.enabled === 'disabled' ? (
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => ask(s.name, 'enable')}
                        >
                          Aktifkan boot
                        </Button>
                      ) : null}
                    </>
                  )}
                  <Button
                    variant="ghost"
                    className="!px-2 !py-1 text-xs"
                    onClick={() => setLogFor(s.name)}
                  >
                    Log
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={`${confirm?.action ?? ''} ${confirm?.unit ?? ''}`}
        message={
          confirm?.action === 'stop'
            ? 'Service dihentikan. Aplikasi yang bergantung padanya bisa berhenti bekerja.'
            : confirm?.action === 'disable'
              ? 'Service tidak lagi menyala otomatis saat VM boot.'
              : 'Service dimulai ulang; koneksi yang sedang berjalan bisa terputus sesaat.'
        }
        confirmLabel="Lanjutkan"
        loading={run.isPending}
        onConfirm={() => confirm && run.mutate(confirm)}
        onCancel={() => setConfirm(null)}
      />
      <Modal
        open={logFor !== null}
        wide
        title={`Log: ${logFor ?? ''}`}
        onClose={() => setLogFor(null)}
        footer={
          <Button variant="ghost" onClick={() => setLogFor(null)}>
            Tutup
          </Button>
        }
      >
        <label className="text-sm font-medium text-slate-700" htmlFor="lines">
          Jumlah baris
        </label>
        <select
          id="lines"
          className="ml-2 rounded-md border border-slate-300 px-2 py-1"
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
        >
          {[50, 100, 200, 500].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        {logs.isLoading && <p className="mt-3 text-slate-500">Memuat log...</p>}
        {logs.error && (
          <p role="alert" className="mt-3 text-error">
            {logs.error.message}
          </p>
        )}
        {logs.data && (
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-[#0a0f1e] p-3 font-mono text-xs text-slate-200">
            {logs.data.log || 'Log kosong.'}
          </pre>
        )}
      </Modal>
    </div>
  );
}
