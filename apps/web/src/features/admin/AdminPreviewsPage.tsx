import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Radio } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, ConfirmDialog, PageHeader, Table, useToast } from '../../components';
import { api } from '../../lib/api';
import { formatRemaining, formatTime } from '../../lib/format';
import type { AdminPreview } from '../../lib/types';

export function AdminPreviewsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin-previews'],
    refetchInterval: 5_000,
    queryFn: () => api<{ enabled: boolean; items: AdminPreview[] }>('/api/admin/previews'),
  });
  const [target, setTarget] = useState<AdminPreview | null>(null);
  const onErr = (e: Error) => toast.show('error', e.message);

  const revoke = useMutation({
    mutationFn: (p: AdminPreview) => api(`/api/admin/previews/${p.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.show('success', 'Preview dicabut dan semua koneksinya diputus.');
      setTarget(null);
      await qc.invalidateQueries({ queryKey: ['admin-previews'] });
    },
    onError: onErr,
  });
  const check = useMutation({
    mutationFn: (p: AdminPreview) =>
      api<{ listening: boolean }>(`/api/vms/${p.vmId}/previews/${p.id}/check`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (r, p) =>
      toast.show(
        r.listening ? 'success' : 'warning',
        r.listening
          ? `Port ${p.port} di VM "${p.vmName}" sedang dipakai aplikasi.`
          : `Tidak ada aplikasi di port ${p.port} VM "${p.vmName}". Pemilik belum menjalankannya atau sudah berhenti.`,
      ),
    onError: onErr,
  });

  const items = list.data?.items ?? [];
  const liveCount = items.filter((p) => p.live).length;

  return (
    <div>
      <PageHeader
        icon={<Radio className="h-5 w-5" />}
        title="Preview Live"
        description="Semua preview web yang aktif di VM client. Daftar diperbarui otomatis tiap beberapa detik. Kamu bisa mengecek port dan mencabut preview mana pun."
      />
      {list.data && !list.data.enabled && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Fitur preview belum aktif. Isi PREVIEW_BASE_DOMAIN di env server dan siapkan DNS wildcard
          (lihat docs/DEPLOY.md).
        </p>
      )}
      <p className="mt-4 text-sm text-slate-600">
        {items.length} preview aktif, {liveCount} sedang dipakai.
      </p>
      <div className="mt-3">
        <Table
          rows={list.data?.items}
          loading={list.isLoading}
          error={list.error?.message}
          rowKey={(p) => p.id}
          emptyMessage="Belum ada preview aktif. Preview muncul di sini saat client membuatnya dari menu Preview Web."
          columns={[
            {
              header: 'VM / Pemilik',
              render: (p) => (
                <div>
                  <p className="font-medium text-navy">{p.vmName}</p>
                  <p className="text-xs text-slate-500">{p.owner}</p>
                </div>
              ),
            },
            {
              header: 'Preview',
              render: (p) => (
                <div>
                  <p>{p.label || `Port ${p.port}`}</p>
                  <p className="text-xs text-slate-500">Port {p.port}</p>
                </div>
              ),
            },
            {
              header: 'Status',
              render: (p) =>
                p.live ? (
                  <Badge tone="success" dot>
                    Live{p.connections > 0 ? ` · ${p.connections} koneksi` : ''}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Siaga</Badge>
                ),
            },
            {
              header: 'Akses terakhir',
              render: (p) => (p.lastAccessAt ? formatTime(p.lastAccessAt) : 'Belum ada'),
            },
            { header: 'Berakhir', render: (p) => formatRemaining(p.expiresAt) },
            {
              header: 'Aksi',
              render: (p) => (
                <div className="flex flex-wrap gap-2">
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-navy hover:bg-slate-50"
                  >
                    <ExternalLink aria-hidden="true" className="h-4 w-4" />
                    Buka
                  </a>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={check.isPending && check.variables?.id === p.id}
                    onClick={() => check.mutate(p)}
                  >
                    Cek port
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="!text-error"
                    onClick={() => setTarget(p)}
                  >
                    Cabut
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </div>

      <ConfirmDialog
        open={!!target}
        title="Cabut preview ini?"
        message={
          target
            ? `Preview port ${target.port} milik ${target.owner} di VM "${target.vmName}" akan dihapus dan semua koneksinya diputus. Pemilik bisa membuat yang baru.`
            : ''
        }
        confirmLabel="Cabut preview"
        loading={revoke.isPending}
        onConfirm={() => target && revoke.mutate(target)}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
