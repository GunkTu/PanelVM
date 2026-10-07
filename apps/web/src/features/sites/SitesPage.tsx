import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Input,
  JobLog,
  Modal,
  PageHeader,
  Skeleton,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import type { Job } from '../../lib/types';
import { uploadRaw } from '../../lib/upload';
import { useVmId } from '../layout/useVmId';

interface Site {
  id: string;
  domain: string;
  kind: 'laravel' | 'php' | 'static';
  phpVersion: string | null;
  rootPath: string;
  docRoot: string;
  envPath: string | null;
}
interface Options {
  nginx: boolean;
  composer: boolean;
  phpVersions: string[];
}

const kindLabel = { laravel: 'Laravel', php: 'PHP', static: 'Statis (HTML)' } as const;
const ARTISAN = [
  'migrate',
  'migrate:status',
  'db:seed',
  'optimize',
  'optimize:clear',
  'cache:clear',
  'config:clear',
  'storage:link',
  'queue:restart',
  'key:generate',
] as const;
const RISKY_ARTISAN = new Set(['migrate', 'db:seed', 'key:generate']);

type Dialog = { kind: 'deploy' | 'artisan' | 'php' | 'delete'; site: Site } | null;

export function SitesPage() {
  const vmId = useVmId();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}`;
  const sites = useQuery({
    queryKey: ['sites', vmId],
    retry: false,
    queryFn: () => api<{ items: Site[] }>(`${base}/sites`),
  });
  const options = useQuery({
    queryKey: ['site-options', vmId],
    retry: false,
    queryFn: () => api<Options>(`${base}/sites/options`),
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ domain: '', kind: 'laravel', phpVersion: '' });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['sites', vmId] });
  const onErr = (e: Error) => toast.show('error', e.message);
  const phpChoice = form.phpVersion || options.data?.phpVersions[0] || '';

  const create = useMutation({
    mutationFn: () =>
      api<Site>(`${base}/sites`, {
        method: 'POST',
        body: {
          domain: form.domain.trim(),
          kind: form.kind,
          ...(form.kind === 'static' ? {} : { phpVersion: phpChoice }),
        },
      }),
    onSuccess: async (s) => {
      setCreating(false);
      setForm({ domain: '', kind: 'laravel', phpVersion: '' });
      toast.show(
        'success',
        `Situs ${s.domain} dibuat. Lanjut: Deploy kode, lalu arahkan domain di Nginx Proxy Manager ke IP VM port 80.`,
      );
      await refresh();
    },
    onError: onErr,
  });

  // --- deploy ---
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState({ composer: true, migrate: false, optimize: false });
  const [progress, setProgress] = useState<number | null>(null);
  const [git, setGit] = useState({ url: '', branch: 'main' });
  const [mode, setMode] = useState<'upload' | 'git'>('upload');
  const closeDialog = () => {
    setDialog(null);
    setFile(null);
    setProgress(null);
    setArtisanOut(null);
    setDelConfirm('');
  };

  const deployUpload = async (site: Site) => {
    if (!file) return;
    setProgress(0);
    try {
      const q = new URLSearchParams({
        filename: file.name,
        composer: String(opts.composer),
        migrate: String(opts.migrate),
        optimize: String(opts.optimize),
      });
      const job = await uploadRaw<Job>(
        'POST',
        `${base}/sites/${site.id}/deploy?${q}`,
        file,
        setProgress,
      );
      setJobId(job.id);
      closeDialog();
    } catch (e) {
      toast.show('error', (e as Error).message);
      setProgress(null);
    }
  };
  const deployGit = useMutation({
    mutationFn: (site: Site) =>
      api<Job>(`${base}/sites/${site.id}/deploy-git`, {
        method: 'POST',
        body: { ...git, ...opts },
      }),
    onSuccess: (j) => {
      setJobId(j.id);
      closeDialog();
    },
    onError: onErr,
  });

  // --- artisan ---
  const [artisan, setArtisan] = useState<(typeof ARTISAN)[number]>('migrate:status');
  const [artisanOut, setArtisanOut] = useState<{ code: number; output: string } | null>(null);
  const runArtisan = useMutation({
    mutationFn: (site: Site) =>
      api<{ code: number; output: string }>(`${base}/sites/${site.id}/artisan`, {
        method: 'POST',
        body: { command: artisan },
      }),
    onSuccess: setArtisanOut,
    onError: onErr,
  });

  // --- php & delete ---
  const [newPhp, setNewPhp] = useState('');
  const changePhp = useMutation({
    mutationFn: (site: Site) =>
      api(`${base}/sites/${site.id}/php`, { method: 'POST', body: { phpVersion: newPhp } }),
    onSuccess: async () => {
      toast.show('success', 'Versi PHP diganti.');
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });
  const [delConfirm, setDelConfirm] = useState('');
  const [delFiles, setDelFiles] = useState(false);
  const del = useMutation({
    mutationFn: (site: Site) =>
      api(`${base}/sites/${site.id}/delete`, {
        method: 'POST',
        body: { confirm: delConfirm, deleteFiles: delFiles },
      }),
    onSuccess: async () => {
      toast.show('success', 'Situs dihapus.');
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });

  const site = dialog?.site;
  const laravel = site?.kind === 'laravel';

  return (
    <div>
      <PageHeader
        icon={<Globe className="h-5 w-5" />}
        title="Situs Web"
        description="Nginx di VM melayani tiap domain di port 80. Arahkan domain ke VM lewat Nginx Proxy Manager (host: IP VM, port 80)."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setCreating(true)}
            disabled={options.data ? !options.data.nginx : false}
          >
            Tambah situs
          </Button>
        }
      />

      {options.data &&
        (!options.data.nginx ||
          options.data.phpVersions.length === 0 ||
          !options.data.composer) && (
          <div
            role="status"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            Prasyarat belum lengkap:
            <ul className="ml-5 list-disc">
              {!options.data.nginx && <li>Nginx belum terpasang.</li>}
              {options.data.phpVersions.length === 0 && (
                <li>PHP belum terpasang (diperlukan untuk Laravel/PHP).</li>
              )}
              {!options.data.composer && (
                <li>Composer belum terpasang (diperlukan untuk Laravel).</li>
              )}
            </ul>
            <Link className="mt-1 inline-block text-info underline" to={`/vms/${vmId}/software`}>
              Pasang dari menu Aplikasi
            </Link>
          </div>
        )}

      {jobId && (
        <div className="mt-4 card p-5">
          <JobLog
            vmId={vmId}
            jobId={jobId}
            onDone={(j) =>
              toast.show(
                j.status === 'succeeded' ? 'success' : 'error',
                j.status === 'succeeded'
                  ? `${j.title} selesai.`
                  : `${j.title} gagal. Baca log untuk penyebabnya.`,
              )
            }
          />
          <Button variant="ghost" className="mt-2" onClick={() => setJobId(null)}>
            Tutup log
          </Button>
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {sites.isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-36" />)}
        {sites.error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 lg:col-span-2"
          >
            {sites.error.message}
          </p>
        )}
        {sites.data?.items.map((s) => (
          <div key={s.id} className="card p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-navy">{s.domain}</span>
              <span className="flex gap-1">
                <Badge tone="info">{kindLabel[s.kind]}</Badge>
                {s.phpVersion && <Badge tone="neutral">PHP {s.phpVersion}</Badge>}
              </span>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">{s.rootPath}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setDialog({ kind: 'deploy', site: s })}>
                Deploy kode
              </Button>
              <ButtonLink
                variant="secondary"
                size="sm"
                to={`/vms/${vmId}/files?path=${encodeURIComponent(s.rootPath)}`}
              >
                File
              </ButtonLink>
              {s.envPath && (
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  to={`/vms/${vmId}/files?path=${encodeURIComponent(s.rootPath)}&edit=${encodeURIComponent(s.envPath)}`}
                >
                  Edit .env
                </ButtonLink>
              )}
              {s.kind === 'laravel' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setArtisanOut(null);
                    setDialog({ kind: 'artisan', site: s });
                  }}
                >
                  Artisan
                </Button>
              )}
              {s.kind !== 'static' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNewPhp(s.phpVersion ?? '');
                    setDialog({ kind: 'php', site: s });
                  }}
                >
                  Versi PHP
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="!text-error"
                onClick={() => {
                  setDelFiles(false);
                  setDialog({ kind: 'delete', site: s });
                }}
              >
                Hapus
              </Button>
            </div>
          </div>
        ))}
        {sites.data && sites.data.items.length === 0 && (
          <EmptyState
            className="lg:col-span-2"
            icon={<Globe className="h-6 w-6" />}
            title="Belum ada situs"
            description='Klik "Tambah situs", isi domain, lalu deploy kode Laravel atau PHP Anda.'
          />
        )}
      </div>

      <Modal
        open={creating}
        title="Tambah situs"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button
              loading={create.isPending}
              disabled={form.kind !== 'static' && !phpChoice}
              onClick={() => create.mutate()}
            >
              Buat situs
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Domain"
            value={form.domain}
            onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
            hint="Contoh: blog.contoh.com (huruf kecil, tanpa http://)."
            autoFocus
          />
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="kind">
              Jenis
            </label>
            <select
              id="kind"
              className="mt-1 w-full h-10 px-3"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="laravel">Laravel</option>
              <option value="php">PHP biasa / framework lain (CodeIgniter, WordPress, dll)</option>
              <option value="static">Statis (HTML/JS hasil build)</option>
            </select>
          </div>
          {form.kind !== 'static' && (
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="phpv">
                Versi PHP
              </label>
              <select
                id="phpv"
                className="mt-1 w-full h-10 px-3"
                value={phpChoice}
                onChange={(e) => setForm((f) => ({ ...f, phpVersion: e.target.value }))}
              >
                {options.data?.phpVersions.map((v) => (
                  <option key={v} value={v}>
                    PHP {v}
                  </option>
                ))}
              </select>
              {options.data?.phpVersions.length === 0 && (
                <p className="mt-1 text-sm text-warning">
                  Belum ada PHP terpasang. Pasang dulu lewat menu Aplikasi.
                </p>
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={dialog?.kind === 'deploy'}
        wide
        title={`Deploy: ${site?.domain ?? ''}`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            {site &&
              (mode === 'upload' ? (
                <Button
                  disabled={!file}
                  loading={progress !== null}
                  onClick={() => void deployUpload(site)}
                >
                  Unggah dan deploy
                </Button>
              ) : (
                <Button
                  disabled={!git.url}
                  loading={deployGit.isPending}
                  onClick={() => deployGit.mutate(site)}
                >
                  Clone dan deploy
                </Button>
              ))}
          </>
        }
      >
        <div className="mb-3 flex gap-2" role="tablist">
          {(['upload', 'git'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md border px-3 py-1.5 text-sm ${mode === m ? 'border-navy bg-navy text-white' : 'border-slate-300'}`}
            >
              {m === 'upload' ? 'Upload arsip' : 'Dari Git (publik)'}
            </button>
          ))}
        </div>
        {mode === 'upload' ? (
          <div>
            <p className="text-slate-600">
              Unggah source code sebagai <code>.zip</code>, <code>.tar.gz</code>, atau{' '}
              <code>.tar</code>.{' '}
              {laravel &&
                'Untuk Laravel, folder vendor dan node_modules tidak perlu disertakan (composer akan memasangnya).'}
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.tar,.tgz,.gz"
              className="mt-3 block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {progress !== null && (
              <div className="mt-2" role="progressbar" aria-valuenow={progress}>
                <div className="h-2 rounded bg-slate-200">
                  <div className="h-2 rounded bg-yellow" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1 text-xs">Mengunggah {progress}%</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              label="URL repositori (https)"
              value={git.url}
              onChange={(e) => setGit((g) => ({ ...g, url: e.target.value }))}
              hint="Hanya repositori publik, tanpa kredensial. Repositori privat: unggah arsip."
            />
            <Input
              label="Branch"
              value={git.branch}
              onChange={(e) => setGit((g) => ({ ...g, branch: e.target.value }))}
            />
          </div>
        )}
        {laravel && (
          <fieldset className="mt-4 rounded-xl bg-slate-50 p-4">
            <legend className="px-1 text-xs font-medium text-slate-600">
              Setelah kode terpasang
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={opts.composer}
                onChange={(e) => setOpts((o) => ({ ...o, composer: e.target.checked }))}
              />{' '}
              Jalankan composer install
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={opts.migrate}
                onChange={(e) => setOpts((o) => ({ ...o, migrate: e.target.checked }))}
              />{' '}
              Jalankan migrasi database (pastikan .env sudah benar)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={opts.optimize}
                onChange={(e) => setOpts((o) => ({ ...o, optimize: e.target.checked }))}
              />{' '}
              Cache konfigurasi, route, dan view
            </label>
            <p className="mt-2 text-xs text-slate-500">
              File .env dan isi storage/app tidak ditimpa saat update. Pertama kali, .env dibuat
              dari .env.example dan APP_KEY dibuat otomatis.
            </p>
          </fieldset>
        )}
      </Modal>

      <Modal
        open={dialog?.kind === 'artisan'}
        wide
        title={`Artisan: ${site?.domain ?? ''}`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Tutup
            </Button>
            {site && (
              <Button loading={runArtisan.isPending} onClick={() => runArtisan.mutate(site)}>
                Jalankan
              </Button>
            )}
          </>
        }
      >
        <label className="text-sm font-medium text-slate-700" htmlFor="art">
          Perintah
        </label>
        <select
          id="art"
          className="mt-1 w-full h-10 px-3 font-mono"
          value={artisan}
          onChange={(e) => setArtisan(e.target.value as (typeof ARTISAN)[number])}
        >
          {ARTISAN.map((c) => (
            <option key={c} value={c}>
              php artisan {c}
            </option>
          ))}
        </select>
        {RISKY_ARTISAN.has(artisan) && (
          <p className="mt-2 text-sm text-warning">
            Perintah ini mengubah data atau kunci aplikasi. Pastikan Anda paham dampaknya.
          </p>
        )}
        {artisanOut && (
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-[#0a0f1e] p-4 font-mono text-xs text-slate-200">{`[kode keluar ${artisanOut.code}]\n${artisanOut.output}`}</pre>
        )}
      </Modal>

      <Modal
        open={dialog?.kind === 'php'}
        title={`Versi PHP: ${site?.domain ?? ''}`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            {site && (
              <Button loading={changePhp.isPending} onClick={() => changePhp.mutate(site)}>
                Ganti
              </Button>
            )}
          </>
        }
      >
        <select
          aria-label="Versi PHP"
          className="w-full h-10 px-3"
          value={newPhp}
          onChange={(e) => setNewPhp(e.target.value)}
        >
          {options.data?.phpVersions.map((v) => (
            <option key={v} value={v}>
              PHP {v}
            </option>
          ))}
        </select>
        <p className="mt-2 text-sm text-slate-600">
          Hanya versi PHP yang sudah terpasang yang bisa dipilih. Pastikan aplikasi Anda kompatibel
          dengan versi baru.
        </p>
      </Modal>

      <Modal
        open={dialog?.kind === 'delete'}
        title={`Hapus situs ${site?.domain ?? ''}`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            {site && (
              <Button
                variant="danger"
                disabled={delConfirm !== site.domain}
                loading={del.isPending}
                onClick={() => del.mutate(site)}
              >
                Hapus situs
              </Button>
            )}
          </>
        }
      >
        <p>
          Konfigurasi nginx situs ini dihapus. Secara bawaan file di <code>{site?.rootPath}</code>{' '}
          tetap disimpan.
        </p>
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={delFiles}
            onChange={(e) => setDelFiles(e.target.checked)}
          />{' '}
          Hapus juga semua file situs (permanen)
        </label>
        <div className="mt-3">
          <Input
            label={`Ketik "${site?.domain ?? ''}" untuk melanjutkan`}
            value={delConfirm}
            onChange={(e) => setDelConfirm(e.target.value)}
            autoComplete="off"
          />
        </div>
      </Modal>
    </div>
  );
}
