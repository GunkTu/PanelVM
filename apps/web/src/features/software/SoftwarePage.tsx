import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, JobLog, Modal, Skeleton, useToast } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { Job } from '../../lib/types';
import { useVmId } from '../layout/useVmId';

interface Item {
  id: string;
  title: string;
  description: string;
  installed: boolean;
  version: string | null;
  candidate: string | null;
  available: boolean;
  conflict?: string;
}
interface Versioned {
  version: string;
  installed: boolean;
  candidate: string | null;
}
interface Status {
  os: { id: string; pretty: string; supported: boolean };
  items: Item[];
  php: { repoInstalled: boolean; versions: Versioned[] };
  postgres: { versions: Versioned[] };
}

const OPTIONAL_EXT = [
  ['redis', 'Redis'],
  ['imagick', 'ImageMagick'],
  ['soap', 'SOAP'],
  ['gmp', 'GMP'],
  ['ldap', 'LDAP'],
] as const;

export function SoftwarePage() {
  const vmId = useVmId();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}`;
  const status = useQuery({
    queryKey: ['software', vmId],
    retry: false,
    queryFn: () => api<Status>(`${base}/software`),
  });
  const jobs = useQuery({
    queryKey: ['jobs', vmId],
    refetchInterval: 8000,
    queryFn: () => api<{ items: Job[] }>(`${base}/jobs`),
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [exts, setExts] = useState<string[]>([]);
  const [repoModal, setRepoModal] = useState(false);
  const [accept, setAccept] = useState(false);
  const [pgVersion, setPgVersion] = useState('');

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['software', vmId] }),
      qc.invalidateQueries({ queryKey: ['jobs', vmId] }),
    ]);
  };
  const install = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Job>(`${base}/software/install`, { method: 'POST', body }),
    onSuccess: (j) => {
      setJobId(j.id);
      setRepoModal(false);
      setAccept(false);
      void refresh();
    },
    onError: (e) => toast.show('error', e.message),
  });
  const aptUpdate = useMutation({
    mutationFn: () => api<Job>(`${base}/software/apt-update`, { method: 'POST', body: {} }),
    onSuccess: (j) => setJobId(j.id),
    onError: (e) => toast.show('error', e.message),
  });

  const running = jobs.data?.items.some((j) => j.status === 'running') ?? false;
  const busy = install.isPending || aptUpdate.isPending || running;
  const s = status.data;
  const pgChoice = pgVersion || s?.postgres.versions.find((v) => !v.installed)?.version || '';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-navy">Aplikasi</h1>
        <Button variant="ghost" disabled={busy} onClick={() => aptUpdate.mutate()}>
          Segarkan daftar paket
        </Button>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Pasang database, PHP, composer, dan web server di VM ini dengan satu klik. Versi yang muncul
        mengikuti repositori OS di VM.
      </p>

      {status.isLoading && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {status.error && (
        <p role="alert" className="mt-4 rounded-md border border-error bg-red-50 p-3 text-red-900">
          {status.error.message}
        </p>
      )}
      {s && !s.os.supported && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-warning bg-yellow-50 p-3 text-yellow-900"
        >
          OS VM ({s.os.pretty || 'tidak dikenal'}) belum didukung installer. Yang didukung: Debian
          dan Ubuntu.
        </p>
      )}
      {s && (
        <p className="mt-3 text-sm text-slate-600">
          OS VM: <strong>{s.os.pretty}</strong>
        </p>
      )}

      {jobId && (
        <div className="mt-4 rounded-lg border border-slate-200 p-4">
          <JobLog vmId={vmId} jobId={jobId} onDone={() => void refresh()} />
          <Button variant="ghost" className="mt-2" onClick={() => setJobId(null)}>
            Tutup log
          </Button>
        </div>
      )}

      {s && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {s.items.map((it) => (
            <div
              key={it.id}
              className="flex flex-col justify-between rounded-lg border border-slate-200 p-4"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-navy">{it.title}</span>
                  {it.installed ? (
                    <Badge tone="success">Terpasang {it.version ?? ''}</Badge>
                  ) : it.available ? (
                    <Badge tone="neutral">Belum terpasang</Badge>
                  ) : (
                    <Badge tone="warning">Tidak tersedia</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-600">{it.description}</p>
                {!it.installed && it.candidate && (
                  <p className="mt-1 text-xs text-slate-500">
                    Versi yang akan dipasang: {it.candidate}
                  </p>
                )}
                {it.conflict && !it.installed && (
                  <p className="mt-1 text-xs text-warning">{it.conflict}</p>
                )}
              </div>
              {!it.installed && (
                <Button
                  className="mt-3 self-start"
                  disabled={busy || !s.os.supported || !!it.conflict || !it.available}
                  loading={install.isPending && install.variables?.item === it.id}
                  onClick={() => install.mutate({ item: it.id })}
                >
                  Pasang
                </Button>
              )}
            </div>
          ))}

          <div className="rounded-lg border border-slate-200 p-4 md:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-navy">PHP (FPM)</span>
              {s.php.repoInstalled ? (
                <Badge tone="info">Repositori tambahan aktif</Badge>
              ) : (
                <Badge tone="neutral">Versi bawaan OS</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Beberapa versi PHP bisa dipasang berdampingan; tiap situs memilih versinya sendiri.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {s.php.versions.map((v) => (
                <div
                  key={v.version}
                  className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
                >
                  <span className="font-medium">PHP {v.version}</span>
                  {v.installed ? (
                    <Badge tone="success">Terpasang</Badge>
                  ) : (
                    <Button
                      className="!px-2 !py-1 text-xs"
                      disabled={busy || !s.os.supported}
                      loading={
                        install.isPending &&
                        install.variables?.version === v.version &&
                        install.variables?.item === 'php'
                      }
                      onClick={() =>
                        install.mutate({ item: 'php', version: v.version, extensions: exts })
                      }
                    >
                      Pasang
                    </Button>
                  )}
                </div>
              ))}
              {s.php.versions.length === 0 && (
                <p className="text-sm text-slate-600">
                  Tidak ada versi PHP di repositori. Coba "Segarkan daftar paket".
                </p>
              )}
            </div>
            <fieldset className="mt-3">
              <legend className="text-xs font-medium text-slate-600">
                Ekstensi tambahan saat memasang (opsional; hanya dipasang bila tersedia)
              </legend>
              <div className="mt-1 flex flex-wrap gap-3 text-sm">
                {OPTIONAL_EXT.map(([k, t]) => (
                  <label key={k} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={exts.includes(k)}
                      onChange={(e) =>
                        setExts((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))
                      }
                    />
                    {t}
                  </label>
                ))}
              </div>
            </fieldset>
            {!s.php.repoInstalled && (
              <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
                <p>Butuh versi PHP selain bawaan OS? Aktifkan repositori tambahan (Ondřej Surý).</p>
                <Button
                  variant="secondary"
                  className="mt-2"
                  disabled={busy || !s.os.supported}
                  onClick={() => setRepoModal(true)}
                >
                  Aktifkan repositori PHP tambahan
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-4 md:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-navy">PostgreSQL</span>
              {s.postgres.versions.some((v) => v.installed) ? (
                <Badge tone="success">
                  Terpasang{' '}
                  {s.postgres.versions
                    .filter((v) => v.installed)
                    .map((v) => v.version)
                    .join(', ')}
                </Badge>
              ) : (
                <Badge tone="neutral">Belum terpasang</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Pengelolaan database PostgreSQL dari panel menyusul; sementara ini bisa dipasang dan
              dipakai dari aplikasi Anda.
            </p>
            {s.postgres.versions.filter((v) => !v.installed).length > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <select
                  aria-label="Versi PostgreSQL"
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={pgChoice}
                  onChange={(e) => setPgVersion(e.target.value)}
                >
                  {s.postgres.versions
                    .filter((v) => !v.installed)
                    .map((v) => (
                      <option key={v.version} value={v.version}>
                        PostgreSQL {v.version}
                      </option>
                    ))}
                </select>
                <Button
                  disabled={busy || !s.os.supported || !pgChoice}
                  onClick={() => install.mutate({ item: 'postgresql', version: pgChoice })}
                >
                  Pasang
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold text-navy">Riwayat proses</h2>
      <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        {jobs.data?.items.length ? (
          jobs.data.items.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span>
                {j.title} <span className="text-xs text-slate-500">{formatTime(j.createdAt)}</span>
              </span>
              <span className="flex items-center gap-2">
                <Badge
                  tone={
                    j.status === 'running' ? 'info' : j.status === 'succeeded' ? 'success' : 'error'
                  }
                >
                  {j.status === 'running'
                    ? 'Berjalan'
                    : j.status === 'succeeded'
                      ? 'Selesai'
                      : 'Gagal'}
                </Badge>
                <Button
                  variant="ghost"
                  className="!px-2 !py-1 text-xs"
                  onClick={() => setJobId(j.id)}
                >
                  Lihat log
                </Button>
              </span>
            </li>
          ))
        ) : (
          <li className="px-3 py-6 text-center text-slate-500">
            Belum ada proses. Pasang aplikasi pertama dari daftar di atas.
          </li>
        )}
      </ul>

      <Modal
        open={repoModal}
        title="Aktifkan repositori PHP tambahan"
        onClose={() => setRepoModal(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRepoModal(false)}>
              Batal
            </Button>
            <Button
              disabled={!accept}
              loading={install.isPending}
              onClick={() => install.mutate({ item: 'php-repo', acceptThirdParty: true })}
            >
              Aktifkan
            </Button>
          </>
        }
      >
        <p>
          Ini menambahkan sumber paket <strong>pihak ketiga</strong> (Ondřej Surý, pemelihara paket
          PHP Debian) ke VM ini agar banyak versi PHP bisa dipasang. Paket dari sumber ini berjalan
          dengan hak root saat dipasang.
        </p>
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
          Saya mengerti dan percaya pada sumber paket ini.
        </label>
      </Modal>
    </div>
  );
}
