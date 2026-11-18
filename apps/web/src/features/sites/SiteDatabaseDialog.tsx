import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Input, Modal, useToast } from '../../components';
import { api } from '../../lib/api';

interface Result {
  database: string;
  user: string;
  password: string;
  envWritten: boolean;
  envPath: string | null;
}

/**
 * Buat database + user khusus untuk satu situs dan (Laravel) isi .env otomatis. Password hanya tampil sekali
 * di sini dan tidak disimpan di panel.
 */
export function SiteDatabaseDialog({
  open,
  vmId,
  site,
  onClose,
}: {
  open: boolean;
  vmId: string;
  site: { id: string; domain: string; kind: 'laravel' | 'php' | 'static' } | undefined;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const close = () => {
    setName('');
    setResult(null);
    onClose();
  };

  const setup = useMutation({
    mutationFn: () =>
      api<Result>(`/api/vms/${vmId}/sites/${site?.id}/database`, {
        method: 'POST',
        body: name ? { name } : {},
      }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['db-overview', vmId] });
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  const copy = (t: string) =>
    void navigator.clipboard?.writeText(t).then(() => toast.show('info', 'Disalin.'));

  if (result) {
    const snippet = [
      `DB_CONNECTION=mysql`,
      `DB_HOST=127.0.0.1`,
      `DB_PORT=3306`,
      `DB_DATABASE=${result.database}`,
      `DB_USERNAME=${result.user}`,
      `DB_PASSWORD=${result.password}`,
    ].join('\n');
    return (
      <Modal
        open={open}
        wide
        title="Database siap dipakai"
        onClose={close}
        footer={<Button onClick={close}>Sudah saya simpan</Button>}
      >
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
          Password hanya ditampilkan sekali ini dan tidak disimpan di panel. Salin sekarang.
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-slate-500">Database</dt>
          <dd className="font-mono">{result.database}</dd>
          <dt className="text-slate-500">User</dt>
          <dd className="font-mono">{result.user}</dd>
          <dt className="text-slate-500">Password</dt>
          <dd className="font-mono break-all select-all">{result.password}</dd>
        </dl>
        {result.envWritten ? (
          <p className="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-900">
            File <code>{result.envPath}</code> sudah diisi otomatis (DB_*). Bila aplikasi memakai
            cache konfigurasi, jalankan Artisan <code>optimize:clear</code>, lalu{' '}
            <code>migrate</code> bila perlu.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-slate-600">
              {site?.kind === 'static'
                ? 'Situs statis tidak memakai database; kredensial ini untuk dipakai di aplikasi lain.'
                : 'File .env tidak ditemukan atau tidak bisa ditulis, jadi tempel ini ke konfigurasi aplikasi Anda:'}
            </p>
            <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100 select-all">
              {snippet}
            </pre>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => copy(snippet)}>
              Salin
            </Button>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title={`Siapkan database: ${site?.domain ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Batal
          </Button>
          <Button loading={setup.isPending} onClick={() => setup.mutate()}>
            Buat database
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        Panel membuat database dan user khusus (bukan root) dengan password acak.{' '}
        {site?.kind === 'laravel'
          ? 'Isi DB_* di file .env situs ini diperbarui otomatis.'
          : 'Bila situs punya file .env, isinya diperbarui; kalau tidak, kredensial ditampilkan untuk Anda salin.'}
      </p>
      <div className="mt-3">
        <Input
          label="Nama database (opsional)"
          hint="Kosongkan agar dibuat dari nama domain. 3-32 karakter: huruf kecil, angka, _."
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="mis. toko_saya"
        />
      </div>
    </Modal>
  );
}
