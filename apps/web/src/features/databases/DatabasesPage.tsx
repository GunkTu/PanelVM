import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  Modal,
  Skeleton,
  Table,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import type { Credentials } from '../../lib/types';
import { uploadRaw } from '../../lib/upload';
import { useVmId } from '../layout/useVmId';

type EngineKey = 'mysql' | 'postgres';
interface EngineInfo {
  engine: string;
  flavor: string;
  version: string;
  running: boolean;
  managed: boolean;
  problem?: string;
}
interface DbUser {
  name: string;
  databases: { name: string; level: 'all' | 'readonly' | 'custom' }[];
}
interface Overview {
  databases: { name: string; sizeBytes: number }[];
  users: DbUser[];
}
interface QueryResult {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

const levelLabel = { all: 'Penuh', readonly: 'Baca saja', custom: 'Khusus' } as const;
const NAME_HINT = '3-32 karakter: huruf kecil di awal, lalu huruf kecil, angka, atau _.';

/** Kredensial ditampilkan SEKALI. Password tidak disimpan di panel. */
function CredentialsModal({ cred, onClose }: { cred: Credentials; onClose: () => void }) {
  const toast = useToast();
  const copy = (t: string) =>
    void navigator.clipboard?.writeText(t).then(() => toast.show('info', 'Disalin.'));
  return (
    <Modal
      open
      wide
      title="Simpan kredensial database"
      onClose={onClose}
      footer={<Button onClick={onClose}>Sudah saya simpan</Button>}
    >
      <p className="rounded-md border border-warning bg-yellow-50 p-3 text-yellow-900">
        Password hanya ditampilkan sekali ini dan tidak disimpan di panel. Salin sekarang. Bila
        hilang, buat password baru lewat "Reset password".
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {cred.database && (
          <>
            <dt className="text-slate-500">Database</dt>
            <dd className="font-mono">{cred.database}</dd>
          </>
        )}
        <dt className="text-slate-500">User</dt>
        <dd className="font-mono">{cred.user}</dd>
        <dt className="text-slate-500">Password</dt>
        <dd className="select-all break-all font-mono">{cred.password}</dd>
      </dl>
      <p className="mt-3 text-slate-600">
        Untuk Laravel, tempel ke file <code>.env</code> situs:
      </p>
      <pre className="mt-1 select-all whitespace-pre-wrap rounded-md bg-slate-100 p-3 font-mono text-xs">
        {cred.envSnippet}
      </pre>
      <Button variant="ghost" className="mt-2" onClick={() => copy(cred.envSnippet)}>
        Salin untuk .env
      </Button>
    </Modal>
  );
}

function QueryEditor({
  vmId,
  engine,
  databases,
  initial,
  onClose,
}: {
  vmId: string;
  engine: EngineKey;
  databases: string[];
  initial: string | null;
  onClose: () => void;
}) {
  const [db, setDb] = useState<string>(initial ?? '');
  const [sql, setSql] = useState(
    engine === 'postgres'
      ? "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
      : 'SHOW TABLES;',
  );
  const run = useMutation({
    mutationFn: () =>
      api<QueryResult>(`/api/vms/${vmId}/databases/query?engine=${engine}`, {
        method: 'POST',
        body: { database: db || null, sql },
      }),
  });
  return (
    <Modal
      open
      wide
      title="Query editor"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Tutup
          </Button>
          <Button loading={run.isPending} onClick={() => run.mutate()}>
            Jalankan
          </Button>
        </>
      }
    >
      <label className="text-sm font-medium text-slate-700" htmlFor="qdb">
        Database
      </label>
      <select
        id="qdb"
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        value={db}
        onChange={(e) => setDb(e.target.value)}
      >
        <option value="">(tanpa database)</option>
        {databases.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Perintah SQL"
        spellCheck={false}
        className="mt-3 h-32 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
      />
      {run.error && (
        <p role="alert" className="mt-2 rounded-md border border-error bg-red-50 p-3 text-red-900">
          {run.error.message}
        </p>
      )}
      {run.data &&
        (run.data.columns.length === 0 ? (
          <p className="mt-3 text-slate-600">
            Perintah dijalankan. Tidak ada hasil tabel untuk ditampilkan.
          </p>
        ) : (
          <div className="mt-3 max-h-80 overflow-auto rounded-md border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  {run.data.columns.map((c, i) => (
                    <th key={i} className="px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {run.data.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className="whitespace-pre-wrap px-2 py-1 font-mono">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {run.data.truncated && (
              <p className="p-2 text-warning">
                Hasil dipotong karena terlalu besar. Persempit dengan LIMIT.
              </p>
            )}
          </div>
        ))}
    </Modal>
  );
}

export function DatabasesPage() {
  const vmId = useVmId();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}/databases`;
  const engines = useQuery({
    queryKey: ['db-engines', vmId],
    retry: false,
    queryFn: () => api<{ engines: EngineInfo[] }>(`${base}/engines`),
  });
  const infoOf = (k: EngineKey) => engines.data?.engines.find((e) => e.engine === k);
  const [chosen, setChosen] = useState<EngineKey | null>(null);
  const engine: EngineKey =
    chosen ??
    (infoOf('mysql')?.managed ? 'mysql' : infoOf('postgres')?.managed ? 'postgres' : 'mysql');
  const mysql = infoOf(engine); // info engine yang sedang dipilih
  const overview = useQuery({
    queryKey: ['db-overview', vmId, engine],
    enabled: mysql?.managed === true,
    retry: false,
    queryFn: () => api<Overview>(`${base}?engine=${engine}`),
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', user: '', withUser: true });
  const [newUser, setNewUser] = useState<string | null>(null);
  const [cred, setCred] = useState<Credentials | null>(null);
  const [dropDb, setDropDb] = useState<string | null>(null);
  const [dropUser, setDropUser] = useState<string | null>(null);
  const [grantFor, setGrantFor] = useState<DbUser | null>(null);
  const [grant, setGrant] = useState({ database: '', level: 'all' });
  const [query, setQuery] = useState<string | null | false>(false);
  const [importDb, setImportDb] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['db-overview', vmId] });
  const onErr = (e: Error) => toast.show('error', e.message);

  const create = useMutation({
    mutationFn: () =>
      api<{ credentials: Credentials | null }>(`${base}?engine=${engine}`, {
        method: 'POST',
        body: { name: form.name, ...(form.withUser ? { user: form.user || undefined } : {}) },
      }),
    onSuccess: async (r) => {
      setCreating(false);
      setForm({ name: '', user: '', withUser: true });
      if (r.credentials) setCred(r.credentials);
      else toast.show('success', 'Database dibuat.');
      await refresh();
    },
    onError: onErr,
  });
  const createUser = useMutation({
    mutationFn: () =>
      api<{ credentials: Credentials }>(`${base}/users?engine=${engine}`, {
        method: 'POST',
        body: { name: newUser },
      }),
    onSuccess: async (r) => {
      setNewUser(null);
      setCred(r.credentials);
      await refresh();
    },
    onError: onErr,
  });
  const resetPw = useMutation({
    mutationFn: (name: string) =>
      api<{ credentials: Credentials }>(`${base}/users/password?engine=${engine}`, {
        method: 'POST',
        body: { name },
      }),
    onSuccess: (r) => setCred(r.credentials),
    onError: onErr,
  });
  const drop = useMutation({
    mutationFn: (v: { kind: 'db' | 'user'; name: string }) =>
      api(`${base}/${v.kind === 'db' ? 'drop' : 'users/drop'}?engine=${engine}`, {
        method: 'POST',
        body: { name: v.name, confirm: v.name },
      }),
    onSuccess: async (_r, v) => {
      setDropDb(null);
      setDropUser(null);
      toast.show('success', `${v.name} dihapus.`);
      await refresh();
    },
    onError: onErr,
  });
  const doGrant = useMutation({
    mutationFn: () =>
      api(`${base}/grant?engine=${engine}`, {
        method: 'POST',
        body: { user: grantFor?.name, database: grant.database, level: grant.level },
      }),
    onSuccess: async () => {
      setGrantFor(null);
      toast.show('success', 'Hak akses diperbarui.');
      await refresh();
    },
    onError: onErr,
  });
  const revoke = useMutation({
    mutationFn: (v: { user: string; database: string }) =>
      api(`${base}/revoke?engine=${engine}`, { method: 'POST', body: v }),
    onSuccess: async () => {
      toast.show('success', 'Hak akses dicabut.');
      await refresh();
    },
    onError: onErr,
  });

  const doImport = async (f: File | undefined) => {
    if (!f || !importDb) return;
    setProgress(0);
    try {
      await uploadRaw(
        'POST',
        `${base}/import?database=${encodeURIComponent(importDb)}&engine=${engine}`,
        f,
        setProgress,
      );
      toast.show('success', `${f.name} berhasil diimpor ke ${importDb}.`);
      await refresh();
    } catch (e) {
      toast.show('error', (e as Error).message);
    }
    setProgress(null);
    setImportDb(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const dbNames = overview.data?.databases.map((d) => d.name) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-navy">Database</h1>
        {mysql?.managed && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setQuery(null)}>
              Query editor
            </Button>
            <Button onClick={() => setCreating(true)}>Buat database</Button>
          </div>
        )}
      </div>

      {engines.data && (
        <div role="tablist" aria-label="Engine database" className="mt-3 flex gap-2">
          {(['mysql', 'postgres'] as const).map((k) => {
            const i = infoOf(k);
            const label =
              k === 'postgres'
                ? 'PostgreSQL'
                : i?.flavor === 'mariadb'
                  ? 'MariaDB'
                  : i?.flavor === 'mysql' && i.version
                    ? 'MySQL'
                    : 'MySQL / MariaDB';
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={engine === k}
                onClick={() => setChosen(k)}
                className={`rounded-md border px-3 py-1.5 text-sm ${engine === k ? 'border-navy bg-navy text-white' : 'border-slate-300 hover:border-navy'}`}
              >
                {label} {i?.version ?? ''}
              </button>
            );
          })}
        </div>
      )}

      {engines.isLoading && <Skeleton className="mt-4 h-20" />}
      {engines.error && (
        <p role="alert" className="mt-4 rounded-md border border-error bg-red-50 p-3 text-red-900">
          {engines.error.message}
        </p>
      )}
      {engines.data && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {engines.data.engines
            .filter((e) => e.engine === engine && e.version)
            .map((e) => (
              <div key={e.engine} className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-navy">
                    {e.engine === 'postgres'
                      ? 'PostgreSQL'
                      : e.flavor === 'mariadb'
                        ? 'MariaDB'
                        : 'MySQL'}{' '}
                    {e.version}
                  </span>
                  {e.managed ? (
                    <Badge tone="success">Siap dikelola</Badge>
                  ) : e.running ? (
                    <Badge tone="warning">Tidak bisa dikelola</Badge>
                  ) : (
                    <Badge tone="error">Tidak berjalan</Badge>
                  )}
                </div>
                {e.problem && <p className="mt-2 text-sm text-slate-600">{e.problem}</p>}
              </div>
            ))}
          {!mysql?.version && (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-700">
              Belum ada {engine === 'postgres' ? 'PostgreSQL' : 'MySQL/MariaDB'} di VM ini.{' '}
              <Link className="text-info underline" to={`/vms/${vmId}/software`}>
                Pasang dari menu Aplikasi
              </Link>
              , lalu kembali ke sini.
            </div>
          )}
        </div>
      )}

      {mysql?.managed && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-navy">Database</h2>
          <div className="mt-2">
            <Table
              rows={overview.data?.databases}
              loading={overview.isLoading}
              error={overview.error?.message}
              rowKey={(d) => d.name}
              emptyMessage='Belum ada database. Klik "Buat database" untuk memulai.'
              columns={[
                { header: 'Nama', render: (d) => <span className="font-mono">{d.name}</span> },
                { header: 'Ukuran', render: (d) => formatBytes(d.sizeBytes) },
                {
                  header: 'Aksi',
                  render: (d) => (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => setQuery(d.name)}
                      >
                        Query
                      </Button>
                      <a
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:border-navy"
                        href={`${base}/export?database=${encodeURIComponent(d.name)}&engine=${engine}`}
                      >
                        Export
                      </a>
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => {
                          setImportDb(d.name);
                          setTimeout(() => fileInput.current?.click(), 0);
                        }}
                      >
                        Import .sql
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs !text-error"
                        onClick={() => setDropDb(d.name)}
                      >
                        Hapus
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".sql,text/plain"
            hidden
            onChange={(e) => void doImport(e.target.files?.[0])}
          />
          {progress !== null && (
            <p className="mt-2 text-sm text-slate-600" role="status">
              Mengimpor ke {importDb}... {progress}% terunggah
            </p>
          )}

          {engine === 'postgres' && (
            <p className="mt-3 rounded-md bg-slate-50 p-3 text-sm text-slate-600">
              PostgreSQL: akses "Penuh" berarti user menjadi <strong>pemilik</strong> database.
              "Baca saja" mencakup tabel yang ada saat ini; tabel baru perlu "Beri akses" ulang.
              Objek yang dibuat user sendiri tetap miliknya meski aksesnya dicabut.
            </p>
          )}
          <div className="mt-8 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-navy">User database</h2>
            <Button variant="ghost" onClick={() => setNewUser('')}>
              Tambah user
            </Button>
          </div>
          <div className="mt-2">
            <Table
              rows={overview.data?.users}
              loading={overview.isLoading}
              rowKey={(u) => u.name}
              emptyMessage="Belum ada user database."
              columns={[
                { header: 'User', render: (u) => <span className="font-mono">{u.name}</span> },
                {
                  header: 'Akses',
                  render: (u) =>
                    u.databases.length ? (
                      <div className="flex flex-wrap gap-1">
                        {u.databases.map((d) => (
                          <span key={d.name} className="inline-flex items-center gap-1">
                            <Badge tone="info">
                              {d.name}: {levelLabel[d.level]}
                            </Badge>
                            <button
                              type="button"
                              aria-label={`Cabut akses ${u.name} ke ${d.name}`}
                              className="text-xs text-error"
                              onClick={() => revoke.mutate({ user: u.name, database: d.name })}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-500">Belum ada</span>
                    ),
                },
                {
                  header: 'Aksi',
                  render: (u) => (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => {
                          setGrant({ database: dbNames[0] ?? '', level: 'all' });
                          setGrantFor(u);
                        }}
                      >
                        Beri akses
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        loading={resetPw.isPending}
                        onClick={() => resetPw.mutate(u.name)}
                      >
                        Reset password
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs !text-error"
                        onClick={() => setDropUser(u.name)}
                      >
                        Hapus
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}

      <Modal
        open={creating}
        title="Buat database"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              Buat
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Nama database"
            value={form.name}
            onChange={(e) =>
              setForm((f) => ({ ...f, name: e.target.value, user: f.user || e.target.value }))
            }
            hint={NAME_HINT}
            autoFocus
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.withUser}
              onChange={(e) => setForm((f) => ({ ...f, withUser: e.target.checked }))}
            />{' '}
            Buat user dengan akses penuh ke database ini
          </label>
          {form.withUser && (
            <Input
              label="Nama user"
              value={form.user}
              onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
              hint={`${NAME_HINT} Password dibuat otomatis.`}
            />
          )}
        </div>
      </Modal>
      <Modal
        open={newUser !== null}
        title="Tambah user database"
        onClose={() => setNewUser(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewUser(null)}>
              Batal
            </Button>
            <Button loading={createUser.isPending} onClick={() => createUser.mutate()}>
              Buat
            </Button>
          </>
        }
      >
        <Input
          label="Nama user"
          value={newUser ?? ''}
          onChange={(e) => setNewUser(e.target.value)}
          hint={`${NAME_HINT} Password dibuat otomatis.`}
          autoFocus
        />
      </Modal>
      <Modal
        open={grantFor !== null}
        title={`Beri akses: ${grantFor?.name ?? ''}`}
        onClose={() => setGrantFor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setGrantFor(null)}>
              Batal
            </Button>
            <Button
              loading={doGrant.isPending}
              disabled={!grant.database}
              onClick={() => doGrant.mutate()}
            >
              Terapkan
            </Button>
          </>
        }
      >
        <label className="text-sm font-medium text-slate-700" htmlFor="gdb">
          Database
        </label>
        <select
          id="gdb"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          value={grant.database}
          onChange={(e) => setGrant((g) => ({ ...g, database: e.target.value }))}
        >
          {dbNames.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <label className="mt-3 block text-sm font-medium text-slate-700" htmlFor="glv">
          Level akses
        </label>
        <select
          id="glv"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          value={grant.level}
          onChange={(e) => setGrant((g) => ({ ...g, level: e.target.value }))}
        >
          <option value="all">Penuh (baca, tulis, ubah struktur)</option>
          <option value="readonly">Baca saja</option>
        </select>
      </Modal>
      {cred && <CredentialsModal cred={cred} onClose={() => setCred(null)} />}
      {query !== false && (
        <QueryEditor
          vmId={vmId}
          engine={engine}
          databases={dbNames}
          initial={query}
          onClose={() => setQuery(false)}
        />
      )}
      <ConfirmDialog
        open={dropDb !== null}
        title="Hapus database"
        message="Database beserta semua tabel dan datanya dihapus permanen. Ekspor dulu bila masih butuh datanya."
        requireText={dropDb ?? undefined}
        confirmLabel="Hapus database"
        loading={drop.isPending}
        onConfirm={() => dropDb && drop.mutate({ kind: 'db', name: dropDb })}
        onCancel={() => setDropDb(null)}
      />
      <ConfirmDialog
        open={dropUser !== null}
        title="Hapus user database"
        message="Aplikasi yang memakai user ini tidak akan bisa terhubung lagi ke database."
        requireText={dropUser ?? undefined}
        confirmLabel="Hapus user"
        loading={drop.isPending}
        onConfirm={() => dropUser && drop.mutate({ kind: 'user', name: dropUser })}
        onCancel={() => setDropUser(null)}
      />
    </div>
  );
}
