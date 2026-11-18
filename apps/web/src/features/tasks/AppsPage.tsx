import { useMutation } from '@tanstack/react-query';
import { Plus, Rocket } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  JobLog,
  Modal,
  PageHeader,
  Table,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import type { Job } from '../../lib/types';
import { useVmId } from '../layout/useVmId';
import { LogModal } from './TasksPage';
import {
  stateLabel,
  stateTone,
  useTaskActions,
  useTaskOptions,
  useTasks,
  type Task,
} from './tasksApi';

type Runtime = 'node' | 'python' | 'other';

const PRESETS: Record<Runtime, { label: string; command: string; install: string; hint: string }> =
  {
    node: {
      label: 'Node.js (Express, Next.js, dll.)',
      command: 'npm start',
      install: 'npm ci',
      hint: 'Aplikasi harus mendengarkan di port dari variabel PORT (process.env.PORT). Untuk Next.js: install "npm ci" lalu jalankan build sebelum start, mis. atur "build" di script start.',
    },
    python: {
      label: 'Python (Flask, Django, FastAPI)',
      command: './venv/bin/gunicorn -b 127.0.0.1:{PORT} app:app',
      install: '',
      hint: 'Gunakan {PORT} pada perintah agar diganti dengan port aplikasi. Siapkan virtualenv ("python3 -m venv venv" dan pip install) lewat terminal atau skrip, lalu klik Pasang ulang.',
    },
    other: {
      label: 'Lainnya (binary/skrip sendiri)',
      command: './server --port {PORT}',
      install: '',
      hint: 'Aplikasi dijalankan sebagai www-data dari folder aplikasinya. Gunakan {PORT} atau variabel PORT.',
    },
  };

/** Aplikasi non-PHP (Node/Python/lainnya): service systemd + reverse proxy Nginx ke domain. */
export function AppsPage() {
  const vmId = useVmId();
  const toast = useToast();
  const tasks = useTasks(vmId);
  const options = useTaskOptions(vmId);
  const { act, del, redeploy, refresh } = useTaskActions(vmId);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    domain: '',
    runtime: 'node' as Runtime,
    command: PRESETS.node.command,
    installCommand: PRESETS.node.install,
    gitUrl: '',
    gitBranch: 'main',
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [delTask, setDelTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);

  const setRuntime = (r: Runtime) =>
    setForm((f) => ({
      ...f,
      runtime: r,
      command: PRESETS[r].command,
      installCommand: PRESETS[r].install,
    }));

  const create = useMutation({
    mutationFn: () =>
      api<{ job: Job }>(`/api/vms/${vmId}/tasks`, {
        method: 'POST',
        body: {
          kind: 'app',
          name: form.name,
          domain: form.domain,
          runtime: form.runtime,
          command: form.command,
          ...(form.installCommand ? { installCommand: form.installCommand } : {}),
          ...(form.gitUrl ? { gitUrl: form.gitUrl, gitBranch: form.gitBranch } : {}),
        },
      }),
    onSuccess: async (r) => {
      setCreating(false);
      setJobId(r.job.id);
      await refresh();
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  const apps = (tasks.data?.items ?? []).filter((t) => t.kind === 'app');
  const preset = PRESETS[form.runtime];

  return (
    <div>
      <PageHeader
        icon={<Rocket className="h-5 w-5" />}
        title="App Node/Python"
        description="Jalankan aplikasi non-PHP sebagai service systemd dan sambungkan ke domain lewat Nginx (reverse proxy, WebSocket didukung)."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Buat aplikasi
          </Button>
        }
      />

      {jobId && (
        <div className="mb-6">
          <JobLog vmId={vmId} jobId={jobId} onDone={() => void refresh()} />
        </div>
      )}

      <Table
        rows={apps}
        loading={tasks.isLoading}
        error={tasks.error?.message}
        rowKey={(t) => t.id}
        emptyMessage='Belum ada aplikasi. Klik "Buat aplikasi" untuk memasang Node.js atau Python dengan domainnya.'
        columns={[
          {
            header: 'Aplikasi',
            render: (t) => (
              <div>
                <span className="font-medium">{t.name}</span>
                <p className="text-xs text-slate-500">
                  {t.domain} · port {t.port}
                </p>
              </div>
            ),
          },
          { header: 'Runtime', render: (t) => <Badge tone="info">{t.runtime}</Badge> },
          {
            header: 'Perintah',
            render: (t) => <span className="font-mono text-xs break-all">{t.command}</span>,
          },
          {
            header: 'Status',
            render: (t) => <Badge tone={stateTone(t.state)}>{stateLabel(t.state)}</Badge>,
          },
          {
            header: 'Aksi',
            render: (t) => (
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => act.mutate({ task: t, action: 'restart' })}
                >
                  Restart
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    act.mutate({ task: t, action: t.state === 'active' ? 'stop' : 'start' })
                  }
                >
                  {t.state === 'active' ? 'Stop' : 'Start'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={redeploy.isPending}
                  onClick={() =>
                    redeploy.mutate(t, {
                      onSuccess: (j) => {
                        setJobId(j.id);
                        toast.show('info', 'Pemasangan ulang berjalan; pantau lognya di atas.');
                      },
                    })
                  }
                >
                  Pasang ulang
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setLogTask(t)}>
                  Log
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="!text-error"
                  onClick={() => setDelTask(t)}
                >
                  Hapus
                </Button>
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={creating}
        wide
        title="Buat aplikasi"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button
              disabled={!form.name || !form.domain || !form.command}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Buat dan jalankan
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-slate-700" htmlFor="app-runtime">
            Jenis aplikasi
          </label>
          <select
            id="app-runtime"
            className="h-10 w-full px-3"
            value={form.runtime}
            onChange={(e) => setRuntime(e.target.value as Runtime)}
          >
            {(Object.keys(PRESETS) as Runtime[]).map((r) => (
              <option key={r} value={r}>
                {PRESETS[r].label}
              </option>
            ))}
          </select>
          <p className="text-sm text-slate-600">{preset.hint}</p>
          <Input
            label="Nama"
            hint="Huruf kecil, angka, dan -. Contoh: toko-online"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toLowerCase() }))}
          />
          <Input
            label="Domain"
            hint="Domain yang diarahkan ke VM ini (belum dipakai situs lain)."
            value={form.domain}
            onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value.toLowerCase() }))}
            placeholder="app.contoh.com"
          />
          <Input
            label="Git URL (opsional)"
            hint="https://github.com/user/repo.git (repositori publik). Kosongkan bila akan mengunggah file lewat File Manager."
            value={form.gitUrl}
            onChange={(e) => setForm((f) => ({ ...f, gitUrl: e.target.value }))}
          />
          {form.gitUrl && (
            <Input
              label="Branch"
              value={form.gitBranch}
              onChange={(e) => setForm((f) => ({ ...f, gitBranch: e.target.value }))}
            />
          )}
          <Input
            label="Perintah pasang dependensi (opsional)"
            hint="Dijalankan sebagai www-data di folder aplikasi, mis. npm ci"
            value={form.installCommand}
            onChange={(e) => setForm((f) => ({ ...f, installCommand: e.target.value }))}
          />
          <Input
            label="Perintah menjalankan aplikasi"
            hint="Tanpa tanda kutip, $, ;, |, &. Pakai {PORT} untuk nomor port."
            value={form.command}
            onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
          />
          <p className="text-xs text-slate-500">
            Port otomatis: {options.data?.nextPort ?? '-'} (diteruskan lewat variabel PORT).
            Variabel lain bisa ditaruh di file <code>.env</code> di folder aplikasi
            (/var/www/&lt;domain&gt;/.env, format KEY=nilai), lalu klik Restart.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!delTask}
        title={`Hapus aplikasi ${delTask?.name ?? ''}?`}
        message={`Service dihentikan, unit systemd dan konfigurasi Nginx untuk ${delTask?.domain ?? ''} dihapus.File aplikasi di VM tetap ada; hapus lewat File Manager bila tidak diperlukan.`}
        confirmLabel="Hapus"
        requireText={delTask?.name}
        loading={del.isPending}
        onConfirm={() =>
          delTask &&
          del.mutate({ task: delTask, deleteFiles: false }, { onSuccess: () => setDelTask(null) })
        }
        onCancel={() => setDelTask(null)}
      />
      <LogModal vmId={vmId} task={logTask} onClose={() => setLogTask(null)} />
    </div>
  );
}
