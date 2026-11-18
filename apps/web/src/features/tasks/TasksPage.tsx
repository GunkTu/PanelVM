import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  Modal,
  PageHeader,
  Table,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import { useVmId } from '../layout/useVmId';
import {
  stateLabel,
  stateTone,
  useTaskActions,
  useTaskOptions,
  useTasks,
  type Task,
} from './tasksApi';

type Mode = 'scheduler' | 'queue' | 'cron' | 'worker';

const MODE_LABEL: Record<Mode, string> = {
  scheduler: 'Laravel Scheduler (tiap menit)',
  queue: 'Laravel Queue Worker',
  cron: 'Jadwal cron khusus',
  worker: 'Worker / proses khusus',
};

const CRON_PRESETS = [
  ['Tiap menit', '* * * * *'],
  ['Tiap 5 menit', '*/5 * * * *'],
  ['Tiap jam', '@hourly'],
  ['Tiap hari', '@daily'],
  ['Tiap minggu', '@weekly'],
] as const;

/** Jadwal cron dan worker (queue/proses latar belakang) yang dikelola panel di VM. */
export function TasksPage() {
  const vmId = useVmId();
  const toast = useToast();
  const tasks = useTasks(vmId);
  const options = useTaskOptions(vmId);
  const { act, del, refresh } = useTaskActions(vmId);

  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<Mode>('scheduler');
  const [siteId, setSiteId] = useState('');
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('* * * * *');
  const [command, setCommand] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [delTask, setDelTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);

  const laravelSites = (options.data?.sites ?? []).filter(
    (s) => s.kind === 'laravel' && s.phpVersion,
  );
  const site = laravelSites.find((s) => s.id === siteId);
  const isPreset = mode === 'scheduler' || mode === 'queue';
  const slug = (d: string) =>
    d
      .replace(/\.[a-z]{2,63}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const body = (() => {
    if (isPreset) {
      if (!site) return null;
      const php = `php${site.phpVersion}`;
      return mode === 'scheduler'
        ? {
            kind: 'cron',
            name: `${slug(site.domain)}-scheduler`.slice(0, 31),
            siteId: site.id,
            schedule: '* * * * *',
            command: `${php} artisan schedule:run`,
          }
        : {
            kind: 'worker',
            name: `${slug(site.domain)}-queue`.slice(0, 31),
            siteId: site.id,
            command: `${php} artisan queue:work --sleep=3 --tries=3 --max-time=3600`,
          };
    }
    return {
      kind: mode,
      name,
      command,
      workdir,
      ...(mode === 'cron' ? { schedule } : {}),
    };
  })();

  const create = useMutation({
    mutationFn: () => api(`/api/vms/${vmId}/tasks`, { method: 'POST', body }),
    onSuccess: async () => {
      toast.show('success', 'Tersimpan dan aktif di VM.');
      setCreating(false);
      setName('');
      setCommand('');
      await refresh();
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  const rows = (tasks.data?.items ?? []).filter((t) => t.kind !== 'app');

  return (
    <div>
      <PageHeader
        icon={<CalendarClock className="h-5 w-5" />}
        title="Jadwal & Worker"
        description="Jalankan tugas terjadwal (cron) dan proses latar belakang seperti queue worker Laravel. Dikelola lewat systemd dan /etc/cron.d, berjalan sebagai www-data."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Tambah
          </Button>
        }
      />
      <Table
        rows={rows}
        loading={tasks.isLoading}
        error={tasks.error?.message}
        rowKey={(t) => t.id}
        emptyMessage='Belum ada jadwal atau worker. Klik "Tambah" lalu pilih "Laravel Scheduler" atau "Queue Worker".'
        columns={[
          {
            header: 'Nama',
            render: (t) => (
              <div>
                <span className="font-medium">{t.name}</span>
                <p className="font-mono text-xs text-slate-500">{t.workdir}</p>
              </div>
            ),
          },
          {
            header: 'Jenis',
            render: (t) => <Badge tone="info">{t.kind === 'cron' ? 'Cron' : 'Worker'}</Badge>,
          },
          {
            header: 'Jadwal / perintah',
            render: (t) => (
              <span className="font-mono text-xs break-all">
                {t.schedule ? `${t.schedule}  ` : ''}
                {t.command}
              </span>
            ),
          },
          {
            header: 'Status',
            render: (t) => <Badge tone={stateTone(t.state)}>{stateLabel(t.state)}</Badge>,
          },
          {
            header: 'Aksi',
            render: (t) => (
              <div className="flex flex-wrap gap-1">
                {t.kind === 'worker' && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={act.isPending}
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
                    <Button variant="ghost" size="sm" onClick={() => setLogTask(t)}>
                      Log
                    </Button>
                  </>
                )}
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
        title="Tambah jadwal atau worker"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button disabled={!body} loading={create.isPending} onClick={() => create.mutate()}>
              Simpan dan aktifkan
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-slate-700" htmlFor="task-mode">
            Jenis
          </label>
          <select
            id="task-mode"
            className="h-10 w-full px-3"
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>

          {isPreset ? (
            <>
              <label className="text-sm font-medium text-slate-700" htmlFor="task-site">
                Situs Laravel
              </label>
              <select
                id="task-site"
                className="h-10 w-full px-3"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              >
                <option value="">Pilih situs...</option>
                {laravelSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.domain} (PHP {s.phpVersion})
                  </option>
                ))}
              </select>
              {laravelSites.length === 0 && (
                <p className="text-sm text-slate-600">
                  Belum ada situs Laravel di VM ini. Buat dulu di halaman Situs Web.
                </p>
              )}
              <p className="text-sm text-slate-600">
                {mode === 'scheduler'
                  ? 'Menjalankan "php artisan schedule:run" tiap menit, sesuai kebutuhan Laravel Task Scheduling.'
                  : 'Menjalankan "php artisan queue:work" terus-menerus; otomatis hidup lagi bila berhenti. Setelah deploy kode baru, klik Restart agar memakai kode terbaru.'}
              </p>
            </>
          ) : (
            <>
              <Input
                label="Nama"
                hint="Huruf kecil, angka, dan -. Contoh: laporan-harian"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
              <Input
                label="Folder kerja"
                hint="Harus di /var/www/... atau /srv/...."
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                placeholder="/var/www/situs-anda.com"
              />
              {mode === 'cron' && (
                <div>
                  <Input
                    label="Jadwal (5 kolom cron)"
                    hint="menit jam tanggal bulan hari-minggu. Contoh: */10 * * * *"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {CRON_PRESETS.map(([l, v]) => (
                      <Button key={v} variant="ghost" size="sm" onClick={() => setSchedule(v)}>
                        {l}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <Input
                label="Perintah"
                hint="Tanpa tanda kutip, $, ;, |, &, < atau >. Untuk perintah rumit, simpan sebagai skrip lalu panggil skripnya."
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="php8.3 artisan laporan:kirim"
              />
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!delTask}
        title={`Hapus ${delTask?.name ?? ''}?`}
        message={
          delTask?.kind === 'cron'
            ? 'Jadwal ini dihapus dari VM dan tidak berjalan lagi.'
            : 'Worker dihentikan dan unit systemd-nya dihapus dari VM.'
        }
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

export function LogModal({
  vmId,
  task,
  onClose,
}: {
  vmId: string;
  task: Task | null;
  onClose: () => void;
}) {
  const logs = useQuery({
    queryKey: ['task-log', vmId, task?.id],
    enabled: !!task,
    refetchInterval: 5000,
    queryFn: () => api<{ log: string }>(`/api/vms/${vmId}/tasks/${task!.id}/logs?lines=200`),
  });
  return (
    <Modal open={!!task} wide title={`Log: ${task?.name ?? ''}`} onClose={onClose}>
      <pre className="max-h-96 overflow-auto rounded-xl bg-slate-900 p-3 text-xs whitespace-pre-wrap text-slate-100">
        {logs.error ? logs.error.message : logs.data?.log || 'Belum ada log.'}
      </pre>
    </Modal>
  );
}
