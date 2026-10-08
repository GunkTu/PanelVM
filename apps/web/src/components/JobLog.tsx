import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { Job } from '../lib/types';
import { Badge } from './Badge';
import { Button } from './Button';
import { useToast } from './Toast';

const tone = {
  running: 'info',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'error',
} as const;
const label = {
  running: 'Berjalan',
  waiting: 'Menunggu Anda',
  succeeded: 'Selesai',
  failed: 'Gagal',
} as const;

/**
 * Log proses latar belakang (instalasi/deploy) yang diperbarui otomatis sampai selesai. Bila proses berhenti
 * menunggu tindakan (mis. .env belum benar), tampil petunjuk beserta tombol Lanjutkan dan Batalkan.
 */
export function JobLog({
  vmId,
  jobId,
  onDone,
  waitActions,
}: {
  vmId: string;
  jobId: string;
  onDone?: (job: Job) => void;
  /** Tautan bantu saat menunggu (mis. ke halaman Database atau editor .env). */
  waitActions?: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['job', vmId, jobId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<Job>(`/api/vms/${vmId}/jobs/${jobId}`),
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || q.state.data?.status === 'waiting' || !q.state.data
        ? 1500
        : false,
  });
  const respond = useMutation({
    mutationFn: (action: 'resume' | 'cancel') =>
      api(`/api/vms/${vmId}/jobs/${jobId}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: Error) => toast.show('error', e.message),
  });
  const box = useRef<HTMLPreElement>(null);
  const doneRef = useRef(onDone);
  const notified = useRef(false);

  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [data?.log]);
  useEffect(() => {
    if (data && data.status !== 'running' && data.status !== 'waiting' && !notified.current) {
      notified.current = true;
      doneRef.current?.(data);
    }
  }, [data]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-navy">{data?.title ?? 'Memuat...'}</span>
        {data && (
          <Badge tone={tone[data.status]} dot>
            {label[data.status]}
          </Badge>
        )}
      </div>

      {data?.status === 'waiting' && (
        <div
          role="status"
          className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="flex items-center gap-2 font-semibold">
            <Hourglass aria-hidden="true" className="h-4 w-4" />
            Proses berhenti dan menunggu Anda
          </p>
          <p className="mt-2 whitespace-pre-wrap">{data.waitMessage}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {waitActions}
            <Button
              size="sm"
              loading={respond.isPending && respond.variables === 'resume'}
              onClick={() => respond.mutate('resume')}
            >
              Lanjutkan
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={respond.isPending && respond.variables === 'cancel'}
              onClick={() => respond.mutate('cancel')}
            >
              Batalkan
            </Button>
          </div>
          <p className="mt-2 text-xs text-amber-800">
            Bila tidak ada tindakan dalam 30 menit, proses dibatalkan otomatis.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0a0f1e]">
        <div
          className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2"
          aria-hidden="true"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        </div>
        <pre
          ref={box}
          className="max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-200"
        >
          {data?.log || 'Menunggu keluaran...'}
        </pre>
      </div>
    </div>
  );
}
