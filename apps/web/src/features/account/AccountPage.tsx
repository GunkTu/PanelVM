import { useMutation } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Input, PageHeader, useToast } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { useMe } from '../auth/AuthContext';

const MIN_LENGTH = 12;

/** "Akun Saya": ganti password login panel. Sesi di perangkat lain otomatis diputus oleh server. */
export function AccountPage() {
  const { user } = useMe();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  const problem =
    next && next.length < MIN_LENGTH
      ? `Password baru minimal ${MIN_LENGTH} karakter.`
      : repeat && repeat !== next
        ? 'Ulangi password baru dengan teks yang sama.'
        : next && next === current
          ? 'Password baru harus berbeda dari yang lama.'
          : '';
  const ready = !!current && next.length >= MIN_LENGTH && repeat === next && next !== current;

  const change = useMutation({
    mutationFn: () =>
      api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      }),
    onSuccess: () => {
      toast.show(
        'success',
        'Password diganti. Sesi Anda di perangkat lain sudah diputus; di perangkat ini Anda tetap masuk.',
      );
      setCurrent('');
      setNext('');
      setRepeat('');
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) change.mutate();
  };

  return (
    <div>
      <PageHeader
        icon={<UserRound className="h-5 w-5" />}
        title="Akun Saya"
        description="Kelola keamanan akun Anda."
      />
      <div className="grid max-w-3xl gap-6">
        <Card>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium break-all">{user.email}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Peran</dt>
              <dd className="font-medium">{user.role === 'admin' ? 'Admin' : 'Client'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">2FA</dt>
              <dd>
                <Badge tone={user.totpEnabled ? 'success' : 'warning'}>
                  {user.totpEnabled ? 'Aktif' : 'Belum aktif'}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Login terakhir</dt>
              <dd className="font-medium">{formatTime(user.lastLoginAt)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 text-lg font-semibold text-navy">Ganti password</h2>
          <p className="mb-4 text-sm text-slate-600">
            Setelah diganti, semua sesi Anda di perangkat lain diputus dan harus masuk ulang.
          </p>
          <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
            <Input
              label="Password saat ini"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
            <Input
              label="Password baru"
              type="password"
              autoComplete="new-password"
              hint={`Minimal ${MIN_LENGTH} karakter. Kalimat panjang lebih aman daripada kata pendek.`}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
            <Input
              label="Ulangi password baru"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              error={problem || undefined}
              required
            />
            <div>
              <Button type="submit" disabled={!ready} loading={change.isPending}>
                Ganti password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
