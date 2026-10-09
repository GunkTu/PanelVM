import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
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
import { LaravelGuide } from './LaravelGuide';

interface Site {
  id: string;
  domain: string;
  kind: 'laravel' | 'php' | 'static';
  phpVersion: string | null;
  webServer: 'nginx' | 'apache';
  rootPath: string;
  docRoot: string;
  /** Folder dokumen relatif ("." = folder utama) dan apakah masih mengikuti bawaan jenis situs. */
  docRootRel: string;
  docRootAuto: boolean;
  /** Situs utama Nginx (default_server): melayani Host yang tidak cocok dengan domain mana pun. */
  isDefault: boolean;
  envPath: string | null;
}
interface Options {
  nginx: boolean;
  apache: boolean;
  /** Web server yang dipakai situs baru; "both" bila keduanya ada (pengguna harus memilih). */
  webServer: 'nginx' | 'apache' | 'both' | null;
  composer: boolean;
  phpVersions: string[];
}
interface DirEntry {
  path: string;
  hasIndex: boolean;
}
interface DirsResponse {
  current: string;
  auto: boolean;
  defaultPath: string;
  suggested: string | null;
  entries: DirEntry[];
}

const serverLabel = { nginx: 'Nginx', apache: 'Apache' } as const;

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

type Dialog = {
  kind: 'deploy' | 'artisan' | 'php' | 'delete' | 'docroot' | 'default';
  site: Site;
} | null;

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
  const [form, setForm] = useState({
    domain: '',
    kind: 'laravel',
    phpVersion: '',
    webServer: 'nginx',
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobSite, setJobSite] = useState<Site | null>(null);
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
          ...(options.data?.webServer === 'both' ? { webServer: form.webServer } : {}),
        },
      }),
    onSuccess: async (s) => {
      setCreating(false);
      setForm({ domain: '', kind: 'laravel', phpVersion: '', webServer: 'nginx' });
      toast.show(
        'success',
        `Situs ${s.domain} dibuat di ${serverLabel[s.webServer]}. Lanjut: Deploy kode, lalu arahkan domain ke IP VM port 80 (atau lihat dulu lewat menu Preview Web).`,
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
  const [mode, setMode] = useState<'upload' | 'url' | 'git'>('upload');
  const [dlUrl, setDlUrl] = useState('');
  const closeDialog = () => {
    setDialog(null);
    setFile(null);
    setProgress(null);
    setArtisanOut(null);
    setDelConfirm('');
    setDocChoice(null);
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
      setJobSite(site);
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
    onSuccess: (j, site) => {
      setJobSite(site);
      setJobId(j.id);
      closeDialog();
    },
    onError: onErr,
  });

  // VM mengunduh arsip langsung dari link (mis. Google Drive), tanpa lewat panel/Cloudflare.
  const deployUrl = useMutation({
    mutationFn: (site: Site) =>
      api<Job>(`${base}/sites/${site.id}/deploy-url`, {
        method: 'POST',
        body: { url: dlUrl.trim(), ...opts },
      }),
    onSuccess: (j, site) => {
      setJobSite(site);
      setJobId(j.id);
      setDlUrl('');
      closeDialog();
    },
    onError: onErr,
  });

  // --- situs utama (Nginx default_server) ---
  const setDefault = useMutation({
    mutationFn: ({ site, enabled }: { site: Site; enabled: boolean }) =>
      api<Site>(`${base}/sites/${site.id}/default`, { method: 'POST', body: { enabled } }),
    onSuccess: async (s) => {
      toast.show(
        'success',
        s.isDefault
          ? `${s.domain} kini menjadi situs utama. Dibuka lewat IP VM, yang tampil situs ini.`
          : `${s.domain} tidak lagi menjadi situs utama.`,
      );
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });

  // --- folder dokumen ---
  const [docChoice, setDocChoice] = useState<string | null>(null);
  const dirs = useQuery({
    queryKey: ['site-dirs', dialog?.site.id],
    enabled: dialog?.kind === 'docroot',
    retry: false,
    queryFn: () => api<DirsResponse>(`${base}/sites/${dialog!.site.id}/dirs`),
  });
  const saveDocRoot = useMutation({
    mutationFn: ({ site, path }: { site: Site; path: string | null }) =>
      api<Site>(`${base}/sites/${site.id}/docroot`, { method: 'POST', body: { path } }),
    onSuccess: async (s) => {
      toast.show('success', `Folder dokumen ${s.domain} diatur ke "${s.docRootRel}".`);
      closeDialog();
      await refresh();
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
        description="Web server di VM (Nginx atau Apache, salah satu) melayani tiap domain di port 80. Arahkan domain ke VM (host: IP VM, port 80), atau lihat dulu hasilnya lewat menu Preview Web."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setCreating(true)}
            disabled={options.data ? !options.data.webServer : false}
          >
            Tambah situs
          </Button>
        }
      />

      <LaravelGuide vmId={vmId} />

      {options.data &&
        (!options.data.webServer ||
          options.data.phpVersions.length === 0 ||
          !options.data.composer) && (
          <div
            role="status"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            Prasyarat belum lengkap:
            <ul className="ml-5 list-disc">
              {!options.data.webServer && (
                <li>Belum ada web server. Pasang Nginx atau Apache (pilih salah satu).</li>
              )}
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
            waitActions={
              <>
                <ButtonLink variant="secondary" size="sm" to={`/vms/${vmId}/databases`}>
                  Buka Database
                </ButtonLink>
                {jobSite?.envPath && (
                  <ButtonLink
                    variant="secondary"
                    size="sm"
                    to={`/vms/${vmId}/files?path=${encodeURIComponent(jobSite.rootPath)}&edit=${encodeURIComponent(jobSite.envPath)}`}
                  >
                    Edit .env
                  </ButtonLink>
                )}
              </>
            }
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
                <Badge tone="neutral">{serverLabel[s.webServer]}</Badge>
                {s.isDefault && <Badge tone="success">Situs utama</Badge>}
              </span>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">{s.rootPath}</p>
            <p className="mt-1 text-xs text-slate-500">
              Folder dokumen: <code>{s.docRootRel === '.' ? '(folder utama)' : s.docRootRel}</code>
              {s.docRootAuto ? ' · bawaan' : ' · dipilih'}
            </p>
            {s.webServer === 'nginx' && !s.isDefault && (
              <p className="mt-1 text-xs text-slate-500">
                Nginx memilih situs menurut nama domain. Dibuka lewat IP VM atau domain lain, yang
                tampil halaman bawaan "Welcome to nginx", kecuali situs ini dijadikan situs utama.
              </p>
            )}
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDocChoice(null);
                  setDialog({ kind: 'docroot', site: s });
                }}
              >
                Folder dokumen
              </Button>
              {s.webServer === 'nginx' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDialog({ kind: 'default', site: s })}
                >
                  {s.isDefault ? 'Lepas situs utama' : 'Jadikan situs utama'}
                </Button>
              )}
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
          {options.data?.webServer === 'both' && (
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="ws">
                Web server
              </label>
              <select
                id="ws"
                className="mt-1 w-full h-10 px-3"
                value={form.webServer}
                onChange={(e) => setForm((f) => ({ ...f, webServer: e.target.value }))}
              >
                <option value="nginx">Nginx</option>
                <option value="apache">Apache</option>
              </select>
              <p className="mt-1 text-sm text-warning">
                VM ini punya Nginx dan Apache sekaligus (dipasang di luar panel). Pilih yang
                melayani situs ini; hanya satu yang bisa memakai port 80.
              </p>
            </div>
          )}
          {options.data?.webServer && options.data.webServer !== 'both' && (
            <p className="text-sm text-slate-600">
              Web server: <strong>{serverLabel[options.data.webServer]}</strong> (yang terpasang di
              VM ini).
            </p>
          )}
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
              ) : mode === 'url' ? (
                <Button
                  disabled={!dlUrl.trim()}
                  loading={deployUrl.isPending}
                  onClick={() => deployUrl.mutate(site)}
                >
                  Unduh dan deploy
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
          {(['upload', 'url', 'git'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md border px-3 py-1.5 text-sm ${mode === m ? 'border-navy bg-navy text-white' : 'border-slate-300'}`}
            >
              {m === 'upload'
                ? 'Upload arsip'
                : m === 'url'
                  ? 'Dari URL / Google Drive'
                  : 'Dari Git (publik)'}
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
        ) : mode === 'url' ? (
          <div className="flex flex-col gap-3">
            <p className="text-slate-600">
              VM mengunduh arsip <strong>langsung dari link-nya</strong>, tidak lewat panel dan
              Cloudflare, jadi jauh lebih cepat untuk file besar. Cocok untuk Google Drive atau
              Dropbox.
            </p>
            <Input
              label="Link arsip (https)"
              value={dlUrl}
              onChange={(e) => setDlUrl(e.target.value)}
              hint="Google Drive: buka file, klik Bagikan, atur 'Siapa saja yang memiliki link', lalu salin link file (bukan folder). Format .zip, .tar.gz, atau .tar."
              autoFocus
            />
            <p className="text-xs text-slate-500">
              Kamu bisa melihat kemajuan unduhan di log. File yang diunduh dihapus dari VM setelah
              selesai. Link folder dan Google Docs tidak didukung.
            </p>
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

      <ConfirmDialog
        open={dialog?.kind === 'default'}
        title={dialog?.site.isDefault ? 'Lepas situs utama?' : 'Jadikan situs utama?'}
        message={
          dialog?.site.isDefault
            ? `Situs ${dialog.site.domain} tidak lagi melayani permintaan yang domainnya tidak cocok. Halaman bawaan Nginx ("Welcome to nginx") diaktifkan kembali.`
            : `Situs ${dialog?.site.domain ?? ''} akan melayani SEMUA permintaan yang domainnya tidak cocok dengan situs mana pun, misalnya dibuka lewat IP VM. Halaman bawaan Nginx ("Welcome to nginx") dinonaktifkan (berkasnya tidak dihapus). Hanya satu situs per VM yang bisa menjadi situs utama; yang lama dilepas otomatis.`
        }
        confirmLabel={dialog?.site.isDefault ? 'Lepas' : 'Jadikan situs utama'}
        loading={setDefault.isPending}
        onConfirm={() =>
          dialog && setDefault.mutate({ site: dialog.site, enabled: !dialog.site.isDefault })
        }
        onCancel={closeDialog}
      />

      <Modal
        open={dialog?.kind === 'docroot'}
        wide
        title={`Folder dokumen: ${site?.domain ?? ''}`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            {site && dirs.data && !dirs.data.auto && (
              <Button
                variant="secondary"
                loading={saveDocRoot.isPending && saveDocRoot.variables?.path === null}
                onClick={() => saveDocRoot.mutate({ site, path: null })}
              >
                Pakai bawaan (
                {dirs.data.defaultPath === '.' ? 'folder utama' : dirs.data.defaultPath})
              </Button>
            )}
            {site && (
              <Button
                disabled={docChoice === null || docChoice === dirs.data?.current}
                loading={saveDocRoot.isPending && saveDocRoot.variables?.path !== null}
                onClick={() => docChoice !== null && saveDocRoot.mutate({ site, path: docChoice })}
              >
                Simpan
              </Button>
            )}
          </>
        }
      >
        <p className="text-slate-600">
          Folder yang dilayani web server sebagai halaman utama. Laravel biasanya memakai{' '}
          <code>public</code>. Pilih dari daftar folder yang ada di situs ini; folder yang berisi
          file <code>index.php</code> atau <code>index.html</code> ditandai.
        </p>
        {dirs.isLoading && <Skeleton className="mt-3 h-24" />}
        {dirs.error && (
          <p
            role="alert"
            className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-red-900"
          >
            {dirs.error.message}
          </p>
        )}
        {dirs.data && (
          <fieldset className="mt-3 max-h-72 overflow-auto rounded-xl border border-slate-200 p-2">
            <legend className="sr-only">Daftar folder situs</legend>
            {dirs.data.entries.map((e) => {
              const selected = (docChoice ?? dirs.data.current) === e.path;
              return (
                <label
                  key={e.path}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${selected ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                >
                  <input
                    type="radio"
                    name="docroot"
                    checked={selected}
                    onChange={() => setDocChoice(e.path)}
                  />
                  <code className="flex-1 break-all">
                    {e.path === '.' ? '. (folder utama situs)' : e.path}
                  </code>
                  {e.hasIndex ? (
                    <Badge tone="success">ada index</Badge>
                  ) : (
                    <Badge tone="neutral">tanpa index</Badge>
                  )}
                  {dirs.data.suggested === e.path && <Badge tone="info">disarankan</Badge>}
                  {dirs.data.current === e.path && <Badge tone="warning">dipakai</Badge>}
                </label>
              );
            })}
          </fieldset>
        )}
        {dirs.data && dirs.data.entries.every((e) => !e.hasIndex) && (
          <p className="mt-3 text-sm text-warning">
            Belum ada file index di folder mana pun. Deploy kode dulu; setelah itu folder yang
            berisi index akan terdeteksi otomatis.
          </p>
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
          Konfigurasi web server situs ini dihapus. Secara bawaan file di{' '}
          <code>{site?.rootPath}</code> tetap disimpan.
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
