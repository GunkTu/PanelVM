import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Input, Skeleton } from '../../components';
import { api, setCsrfToken } from '../../lib/api';
import { AuthShell } from './AuthShell';
import { useMeQuery } from './AuthContext';

export function SetupTwoFactorPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: me, isLoading } = useMeQuery();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const setup = useQuery({
    queryKey: ['2fa-setup'],
    enabled: me?.stage === 'pending_setup',
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async () => {
      const r = await api<{ secret: string; uri: string }>('/api/auth/2fa/setup', {
        method: 'POST',
        body: {},
      });
      return { ...r, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) };
    },
  });

  const enable = useMutation({
    mutationFn: () =>
      api<{ csrfToken: string; recoveryCodes: string[] }>('/api/auth/2fa/enable', {
        method: 'POST',
        body: { code },
      }),
    onSuccess: (r) => {
      setCsrfToken(r.csrfToken);
      setRecovery(r.recoveryCodes);
    },
  });

  if (isLoading) return null;
  if (recovery) {
    return (
      <AuthShell
        title="Simpan recovery code"
        subtitle="Tiap kode hanya bisa dipakai sekali bila Anda kehilangan akses ke aplikasi autentikator. Kode ini tidak akan ditampilkan lagi."
      >
        <ul className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm tracking-wide text-navy">
          {recovery.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2">
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(recovery.join('\n'))}
          >
            Salin
          </Button>
          <Button
            onClick={async () => {
              await qc.invalidateQueries({ queryKey: ['me'] });
              nav('/', { replace: true });
            }}
          >
            Sudah saya simpan, lanjut
          </Button>
        </div>
      </AuthShell>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  if (me.stage !== 'pending_setup')
    return <Navigate to={me.stage === 'active' ? '/' : '/login/2fa'} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate();
  };

  return (
    <AuthShell
      title="Aktifkan 2FA"
      subtitle="2FA wajib untuk semua akun. Pindai QR dengan aplikasi autentikator (misalnya Google Authenticator), lalu masukkan kodenya."
    >
      {setup.isLoading ? (
        <Skeleton className="mx-auto h-56 w-56" />
      ) : setup.error ? (
        <p role="alert" className="text-sm text-error">
          {setup.error.message}
        </p>
      ) : (
        setup.data && (
          <div className="flex flex-col items-center gap-2">
            <img
              src={setup.data.qr}
              alt="Kode QR untuk aplikasi autentikator"
              width={220}
              height={220}
            />
            <p className="text-center text-xs text-slate-500">
              Tidak bisa memindai? Masukkan manual:{' '}
              <span className="select-all font-mono">{setup.data.secret}</span>
            </p>
          </div>
        )
      )}
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Input
          label="Kode 6 digit"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={enable.error?.message}
          required
        />
        <Button type="submit" loading={enable.isPending}>
          Aktifkan dan masuk
        </Button>
      </form>
    </AuthShell>
  );
}
