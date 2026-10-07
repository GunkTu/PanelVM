import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArrowUp,
  ChevronRight,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Upload,
} from 'lucide-react';
import {
  Badge,
  Button,
  ButtonAnchor,
  ConfirmDialog,
  Input,
  Modal,
  PageHeader,
  ProgressBar,
  Skeleton,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import { formatBytes, formatTime, joinPath, parentPath } from '../../lib/format';
import type { FileEntry } from '../../lib/types';
import { uploadRaw } from '../../lib/upload';
import { useVmId } from '../layout/useVmId';

interface Listing {
  path: string;
  truncated: boolean;
  items: FileEntry[];
}

const QUICK = [
  ['/', 'Root'],
  ['/root', 'Home root'],
  ['/var/www', 'Situs web'],
  ['/etc/nginx', 'Nginx'],
  ['/tmp', 'Sementara'],
] as const;
const isArchive = (n: string) => /\.(zip|tar|tar\.gz|tgz)$/i.test(n);

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'chmod'; entry: FileEntry }
  | { kind: 'delete'; entry: FileEntry }
  | { kind: 'archive' }
  | null;

function Editor({ vmId, path, onClose }: { vmId: string; path: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const file = useQuery({
    queryKey: ['file-content', vmId, path],
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const r = await api<{ content: string; mode: string }>(
        `/api/vms/${vmId}/files/content?path=${encodeURIComponent(path)}`,
      );
      setText(r.content);
      return r;
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/vms/${vmId}/files/content`, { method: 'PUT', body: { path, content: text ?? '' } }),
    onSuccess: async () => {
      toast.show('success', `${path} disimpan.`);
      await qc.invalidateQueries({ queryKey: ['files', vmId] });
      onClose();
    },
    onError: (e) => toast.show('error', e.message),
  });
  return (
    <Modal
      open
      wide
      title={`Edit: ${path}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Tutup
          </Button>
          <Button loading={save.isPending} disabled={text === null} onClick={() => save.mutate()}>
            Simpan
          </Button>
        </>
      }
    >
      {file.isLoading && <Skeleton className="h-64" />}
      {file.error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">
          {file.error.message}
        </p>
      )}
      {text !== null && (
        <textarea
          aria-label="Isi file"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-96 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
        />
      )}
    </Modal>
  );
}

export function FilesPage() {
  const vmId = useVmId();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const path = sp.get('path') ?? '/var/www';
  const [editing, setEditing] = useState<string | null>(sp.get('edit'));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [mode, setMode] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ['files', vmId, path],
    retry: false,
    queryFn: () => api<Listing>(`/api/vms/${vmId}/files/list?path=${encodeURIComponent(path)}`),
  });
  const go = (p: string) => {
    setSelected(new Set());
    setSp({ path: p });
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['files', vmId] });
  const close = () => {
    setDialog(null);
    setName('');
  };
  const act = useMutation({
    mutationFn: (v: { endpoint: string; body: unknown; ok: string }) =>
      api(`/api/vms/${vmId}/files/${v.endpoint}`, { method: 'POST', body: v.body }),
    onSuccess: async (_r, v) => {
      toast.show('success', v.ok);
      setSelected(new Set());
      close();
      await refresh();
    },
    onError: (e) => toast.show('error', e.message),
  });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setProgress(0);
      try {
        await uploadRaw(
          'PUT',
          `/api/vms/${vmId}/files/upload?path=${encodeURIComponent(joinPath(path, f.name))}&overwrite=false`,
          f,
          setProgress,
        );
        toast.show('success', `${f.name} terunggah.`);
      } catch (e) {
        toast.show('error', (e as Error).message);
      }
    }
    setProgress(null);
    if (fileInput.current) fileInput.current.value = '';
    await refresh();
  };

  const crumbs = path.split('/').filter(Boolean);
  const items = list.data?.items ?? [];
  const toggle = (n: string) =>
    setSelected((s) => {
      const x = new Set(s);
      if (x.has(n)) x.delete(n);
      else x.add(n);
      return x;
    });

  return (
    <div>
      <PageHeader
        icon={<FolderOpen className="h-5 w-5" />}
        title="File Manager"
        description="Jelajahi, unggah, edit, dan kelola file di VM ini."
      />
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {QUICK.map(([p, t]) => (
            <button
              key={p}
              type="button"
              onClick={() => go(p)}
              className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm text-slate-700 transition-colors hover:border-navy hover:bg-white hover:text-navy"
            >
              {t}
            </button>
          ))}
        </div>
        <nav
          aria-label="Lokasi"
          className="mt-3 flex flex-wrap items-center gap-0.5 rounded-lg bg-slate-50 px-4 py-2.5 font-mono text-sm"
        >
          <button
            type="button"
            className="rounded px-1 text-info hover:bg-blue-50 hover:underline"
            onClick={() => go('/')}
          >
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded px-1 text-info hover:bg-blue-50 hover:underline"
                onClick={() => go(`/${crumbs.slice(0, i + 1).join('/')}`)}
              >
                {c}
              </button>
              {i < crumbs.length - 1 && (
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
              )}
            </span>
          ))}
        </nav>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            icon={<ArrowUp className="h-4 w-4" />}
            disabled={path === '/'}
            onClick={() => go(parentPath(path))}
          >
            Naik
          </Button>
          <Button
            variant="secondary"
            icon={<FolderPlus className="h-4 w-4" />}
            onClick={() => setDialog({ kind: 'mkdir' })}
          >
            Folder baru
          </Button>
          <Button
            icon={<Upload className="h-4 w-4" />}
            onClick={() => fileInput.current?.click()}
            loading={progress !== null}
          >
            Unggah file
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <Button
            variant="ghost"
            icon={<Archive className="h-4 w-4" />}
            disabled={selected.size === 0}
            onClick={() => {
              setName(`arsip-${Date.now().toString(36)}.tar.gz`);
              setDialog({ kind: 'archive' });
            }}
          >
            Arsipkan ({selected.size})
          </Button>
        </div>
        {progress !== null && (
          <div className="mt-3">
            <ProgressBar percent={progress} label="Progres unggah" />
            <p className="mt-1 text-xs text-slate-600">Mengunggah {progress}%</p>
          </div>
        )}
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="w-10 px-4 py-3" />
              <th className="px-4 py-3 font-semibold">Nama</th>
              <th className="px-4 py-3 font-semibold">Ukuran</th>
              <th className="px-4 py-3 font-semibold">Izin</th>
              <th className="px-4 py-3 font-semibold">Diubah</th>
              <th className="px-4 py-3 font-semibold">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.isLoading &&
              [0, 1, 2].map((i) => (
                <tr key={i}>
                  <td colSpan={6} className="px-4 py-3">
                    <Skeleton />
                  </td>
                </tr>
              ))}
            {list.error && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-error" role="alert">
                  {list.error.message}
                </td>
              </tr>
            )}
            {list.data && items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                  Folder ini kosong. Unggah file atau buat folder baru.
                </td>
              </tr>
            )}
            {items.map((e) => (
              <tr key={e.name} className="transition-colors hover:bg-slate-50/70">
                <td className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Pilih ${e.name}`}
                    checked={selected.has(e.name)}
                    onChange={() => toggle(e.name)}
                  />
                </td>
                <td className="px-4 py-2.5">
                  {e.type === 'dir' ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 font-medium text-navy hover:underline"
                      onClick={() => go(joinPath(path, e.name))}
                    >
                      <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-500" />
                      {e.name}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      {e.isLink ? (
                        <Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
                      ) : isArchive(e.name) ? (
                        <FileArchive
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0 text-violet-500"
                        />
                      ) : (
                        <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      {e.name}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  {e.type === 'dir' ? '-' : formatBytes(e.size)}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">{e.mode}</td>
                <td className="px-4 py-2.5 text-slate-600">{formatTime(e.mtime)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {e.type === 'file' && (
                      <ButtonAnchor
                        size="sm"
                        href={`/api/vms/${vmId}/files/download?path=${encodeURIComponent(joinPath(path, e.name))}`}
                      >
                        Unduh
                      </ButtonAnchor>
                    )}
                    {e.type === 'file' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(joinPath(path, e.name))}
                      >
                        Edit
                      </Button>
                    )}
                    {e.type === 'file' && isArchive(e.name) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          act.mutate({
                            endpoint: 'extract',
                            body: { path: joinPath(path, e.name), destDir: path },
                            ok: `${e.name} diekstrak.`,
                          })
                        }
                      >
                        Ekstrak
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setName(e.name);
                        setDialog({ kind: 'rename', entry: e });
                      }}
                    >
                      Ganti nama
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMode(e.mode);
                        setRecursive(false);
                        setDialog({ kind: 'chmod', entry: e });
                      }}
                    >
                      Izin
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!text-error"
                      onClick={() => setDialog({ kind: 'delete', entry: e })}
                    >
                      Hapus
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data?.truncated && (
        <p className="mt-2">
          <Badge tone="warning">Hanya 5000 item pertama yang ditampilkan.</Badge>
        </p>
      )}

      <Modal
        open={dialog?.kind === 'mkdir'}
        title="Folder baru"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
            <Button
              loading={act.isPending}
              onClick={() =>
                act.mutate({
                  endpoint: 'mkdir',
                  body: { path: joinPath(path, name) },
                  ok: `Folder ${name} dibuat.`,
                })
              }
            >
              Buat
            </Button>
          </>
        }
      >
        <Input
          label="Nama folder"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </Modal>
      <Modal
        open={dialog?.kind === 'rename'}
        title="Ganti nama"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
            <Button
              loading={act.isPending}
              onClick={() =>
                dialog?.kind === 'rename' &&
                act.mutate({
                  endpoint: 'rename',
                  body: { from: joinPath(path, dialog.entry.name), to: joinPath(path, name) },
                  ok: 'Nama diganti.',
                })
              }
            >
              Simpan
            </Button>
          </>
        }
      >
        <Input label="Nama baru" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Modal>
      <Modal
        open={dialog?.kind === 'chmod'}
        title="Ubah izin"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
            <Button
              loading={act.isPending}
              onClick={() =>
                dialog?.kind === 'chmod' &&
                act.mutate({
                  endpoint: 'chmod',
                  body: { path: joinPath(path, dialog.entry.name), mode, recursive },
                  ok: 'Izin diubah.',
                })
              }
            >
              Terapkan
            </Button>
          </>
        }
      >
        <Input
          label="Izin (oktal)"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          hint="Contoh: 755 untuk folder, 644 untuk file, 600 untuk rahasia."
        />
        {dialog?.kind === 'chmod' && dialog.entry.type === 'dir' && (
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />{' '}
            Terapkan ke semua isi folder (rekursif)
          </label>
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'archive'}
        title="Buat arsip"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
            <Button
              loading={act.isPending}
              onClick={() =>
                act.mutate({
                  endpoint: 'archive',
                  body: {
                    paths: [...selected].map((n) => joinPath(path, n)),
                    dest: joinPath(path, name),
                  },
                  ok: `Arsip ${name} dibuat.`,
                })
              }
            >
              Buat arsip
            </Button>
          </>
        }
      >
        <Input
          label="Nama arsip"
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Akhiri dengan .zip, .tar.gz, atau .tgz."
        />
      </Modal>
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={`Hapus ${dialog?.kind === 'delete' ? dialog.entry.name : ''}`}
        message={
          dialog?.kind === 'delete' && dialog.entry.type === 'dir'
            ? 'Folder beserta seluruh isinya akan dihapus permanen dari VM.'
            : 'File akan dihapus permanen dari VM.'
        }
        requireText={
          dialog?.kind === 'delete' && dialog.entry.type === 'dir' ? dialog.entry.name : undefined
        }
        confirmLabel="Hapus"
        loading={act.isPending}
        onConfirm={() =>
          dialog?.kind === 'delete' &&
          act.mutate({
            endpoint: 'delete',
            body: { path: joinPath(path, dialog.entry.name) },
            ok: `${dialog.entry.name} dihapus.`,
          })
        }
        onCancel={close}
      />
      {editing && (
        <Editor
          vmId={vmId}
          path={editing}
          onClose={() => {
            setEditing(null);
            if (sp.get('edit')) {
              const n = new URLSearchParams(sp);
              n.delete('edit');
              setSp(n);
            }
          }}
        />
      )}
    </div>
  );
}
