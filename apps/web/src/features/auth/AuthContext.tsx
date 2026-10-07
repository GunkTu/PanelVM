import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Skeleton, useToast } from '../../components';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from '../../lib/api';
import type { Me } from '../../lib/types';

const AuthContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(AuthContext);
  if (!me) throw new Error('useMe dipakai di luar area terautentikasi');
  return me;
}

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const me = await api<Me>('/api/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

/** Menjaga rute: butuh login penuh (stage active), opsional khusus admin. */
export function RequireAuth({ admin = false, children }: { admin?: boolean; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const location = useLocation();
  const { data: me, isLoading, error } = useMeQuery();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], null);
      toast.show('warning', 'Sesi Anda berakhir. Silakan masuk kembali.');
    });
  }, [qc, toast]);

  if (isLoading) {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-64" />
      </div>
    );
  }
  if (error) {
    return (
      <p
        role="alert"
        className="m-8 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
      >
        Tidak bisa memuat data akun. Muat ulang halaman; bila berlanjut, hubungi admin.
      </p>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.stage === 'pending_2fa') return <Navigate to="/login/2fa" replace />;
  if (me.stage === 'pending_setup') return <Navigate to="/login/2fa-setup" replace />;
  if (admin && me.user.role !== 'admin') return <Navigate to="/" replace />;
  return <AuthContext.Provider value={me}>{children}</AuthContext.Provider>;
}
