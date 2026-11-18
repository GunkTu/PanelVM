import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, ConfirmDialog, JobLog, useToast } from '../../components';
import { api } from '../../lib/api';
import type { Job } from '../../lib/types';

interface Status {
  installed: boolean;
  version: string | null;
  phpVersion: string | null;
  phpVersions: string[];
  canOpen: boolean;
  cantOpenReason: string | null;
}

/**
 * phpMyAdmin per VM. Dipasang panel, hanya mendengarkan di 127.0.0.1 VM, dan dibuka lewat tombol di sini
 * (tiket sekali pakai). Login memakai user database biasa; root tidak diizinkan.
 */
export function PhpMyAdminCard({ vmId }: { vmId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}/phpmyadmin`;
  const status = useQuery({
    queryKey: ['phpmyadmin', vmId],
    retry: false,
    queryFn: () => api<Status>(base),
  });
  const [php, setPhp] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['phpmyadmin', vmId] });

  const s = status.data;
  const phpChoice = php || s?.phpVersions[0] || '';

  const install = useMutation({
    mutationFn: () =>
      api<Job>(`${base}/install`, { method: 'POST', body: { phpVersion: phpChoice } }),
    onSuccess: (j) => setJobId(j.id),
    onError: (e: Error) => toast.show('error', e.message),
  });
  const remove = useMutation({
    mutationFn: () => api(`${base}/uninstall`, { method: 'POST', body: { confirm: 'phpmyadmin' } }),
    onSuccess: async () => {
      setRemoving(false);
      toast.show('success', 'phpMyAdmin dihapus dari VM. Database Anda tidak ikut terhapus.');
      await refresh();
    },
    onError: (e: Error) => {
      setRemoving(false);
      toast.show('error', e.message);
    },
  });
  const open = useMutation({
    mutationFn: async () => {
      // Buka tab kosong dulu (saat klik) agar tidak diblokir pop-up, lalu arahkan setelah tiket siap.
      const w = window.open('', '_blank');
      try {
        const r = await api<{ url: string }>(`${base}/open`, { method: 'POST', body: {} });
        if (w) {
          w.opener = null;
          w.location.href = r.url;
        } else window.location.href = r.url;
      } catch (e) {
        w?.close();
        throw e;
      }
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  return (
    <div className="card mt-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-semibold text-navy">phpMyAdmin</span>
          {s?.installed && (
            <span className="ml-2 text-sm text-slate-500">
              {s.version ? `v${s.version} · ` : ''}PHP {s.phpVersion}
            </span>
          )}
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Kelola tabel dan isi database lewat antarmuka phpMyAdmin. Hanya bisa dibuka lewat tombol
            di sini (tidak terbuka ke internet), dan masuk dengan user database Anda, bukan root.
          </p>
        </div>
        {status.isLoading ? null : s?.installed ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">Terpasang</Badge>
            <Button
              icon={<ExternalLink className="h-4 w-4" />}
              loading={open.isPending}
              disabled={!s.canOpen}
              onClick={() => open.mutate()}
            >
              Buka phpMyAdmin
            </Button>
            <Button
              variant="ghost"
              loading={install.isPending}
              onClick={() => {
                setPhp(s.phpVersion ?? '');
                install.mutate();
              }}
            >
              Perbarui
            </Button>
            <Button variant="ghost" className="!text-error" onClick={() => setRemoving(true)}>
              Hapus
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {s && s.phpVersions.length > 0 && (
              <select
                aria-label="Versi PHP untuk phpMyAdmin"
                className="h-10 px-3"
                value={phpChoice}
                onChange={(e) => setPhp(e.target.value)}
              >
                {s.phpVersions.map((v) => (
                  <option key={v} value={v}>
                    PHP {v}
                  </option>
                ))}
              </select>
            )}
            <Button
              loading={install.isPending}
              disabled={!phpChoice}
              onClick={() => install.mutate()}
            >
              Pasang phpMyAdmin
            </Button>
          </div>
        )}
      </div>
      {s && !s.installed && s.phpVersions.length === 0 && (
        <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          PHP-FPM belum terpasang di VM ini. Pasang PHP lewat menu Aplikasi, lalu kembali ke sini.
          phpMyAdmin juga membutuhkan Nginx dan curl.
        </p>
      )}
      {s?.installed && !s.canOpen && (
        <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{s.cantOpenReason}</p>
      )}
      {jobId && (
        <div className="mt-4">
          <JobLog vmId={vmId} jobId={jobId} onDone={() => void refresh()} />
        </div>
      )}
      <ConfirmDialog
        open={removing}
        title="Hapus phpMyAdmin?"
        message="phpMyAdmin dihapus dari VM ini. Database dan user Anda tidak tersentuh. Anda bisa memasangnya lagi kapan saja."
        confirmLabel="Hapus phpMyAdmin"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setRemoving(false)}
      />
    </div>
  );
}
