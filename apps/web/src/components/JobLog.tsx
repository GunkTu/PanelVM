import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { Job } from '../lib/types';
import { Badge } from './Badge';

const tone = { running: 'info', succeeded: 'success', failed: 'error' } as const;
const label = { running: 'Berjalan', succeeded: 'Selesai', failed: 'Gagal' } as const;

/** Log proses latar belakang (instalasi/deploy) yang diperbarui otomatis sampai selesai. */
export function JobLog({
  vmId,
  jobId,
  onDone,
}: {
  vmId: string;
  jobId: string;
  onDone?: (job: Job) => void;
}) {
  const { data } = useQuery({
    queryKey: ['job', vmId, jobId],
    queryFn: () => api<Job>(`/api/vms/${vmId}/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' || !q.state.data ? 1500 : false),
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
    if (data && data.status !== 'running' && !notified.current) {
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
