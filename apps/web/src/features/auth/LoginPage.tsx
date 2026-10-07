import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Lock, Mail } from 'lucide-react';
import { Button, Input } from '../../components';
import { api, setCsrfToken } from '../../lib/api';
import type { Stage } from '../../lib/types';
import { AuthShell } from './AuthShell';
import { useMeQuery } from './AuthContext';

export function LoginPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: me } = useMeQuery();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () =>
      api<{ stage: Stage; csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      }),
    onSuccess: async (r) => {
      setCsrfToken(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(r.stage === 'pending_setup' ? '/login/2fa-setup' : '/login/2fa', { replace: true });
    },
  });

  if (me?.stage === 'active') return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthShell
      title="Masuk"
      subtitle="Gunakan akun yang dibuat admin. Tidak ada pendaftaran mandiri."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          icon={<Mail className="h-4 w-4" />}
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          icon={<Lock className="h-4 w-4" />}
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {login.error && (
          <p role="alert" className="text-sm text-error">
            {login.error.message}
          </p>
        )}
        <Button type="submit" loading={login.isPending}>
          Lanjut
        </Button>
      </form>
    </AuthShell>
  );
}
