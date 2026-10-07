import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Input } from '../../components';
import { api, setCsrfToken } from '../../lib/api';
import type { Me } from '../../lib/types';
import { AuthShell } from './AuthShell';
import { useMeQuery } from './AuthContext';

export function TwoFactorPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: me, isLoading } = useMeQuery();
  const [code, setCode] = useState('');

  const verify = useMutation({
    mutationFn: () =>
      api<{ csrfToken: string }>('/api/auth/2fa/verify', { method: 'POST', body: { code } }),
    onSuccess: async (r) => {
      setCsrfToken(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/', { replace: true });
    },
    onError: (e) => {
      // Sesi pending dihancurkan server setelah terlalu banyak gagal.
      if (/Masuk ulang/.test(e.message)) {
        qc.setQueryData<Me | null>(['me'], null);
      }
    },
  });

  if (isLoading) return null;
  if (!me) return <Navigate to="/login" replace />;
  if (me.stage === 'active') return <Navigate to="/" replace />;
  if (me.stage === 'pending_setup') return <Navigate to="/login/2fa-setup" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    verify.mutate();
  };

  return (
    <AuthShell
      title="Verifikasi 2 langkah"
      subtitle="Masukkan kode 6 digit dari aplikasi autentikator, atau satu recovery code."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Kode"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={verify.error?.message}
          required
        />
        <Button type="submit" loading={verify.isPending}>
          Verifikasi
        </Button>
      </form>
    </AuthShell>
  );
}
