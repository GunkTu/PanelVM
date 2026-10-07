import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminAuditPage } from './features/admin/AdminAuditPage';
import { AdminUsersPage } from './features/admin/AdminUsersPage';
import { AdminVmsPage } from './features/admin/AdminVmsPage';
import { RequireAuth } from './features/auth/AuthContext';
import { LoginPage } from './features/auth/LoginPage';
import { SetupTwoFactorPage } from './features/auth/SetupTwoFactorPage';
import { TwoFactorPage } from './features/auth/TwoFactorPage';
import { AppLayout } from './features/layout/AppLayout';
import { VmListPage } from './features/vms/VmListPage';

// xterm cukup besar; muat hanya saat halaman terminal dibuka.
const TerminalPage = lazy(() =>
  import('./features/terminal/TerminalPage').then((m) => ({ default: m.TerminalPage })),
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/2fa" element={<TwoFactorPage />} />
      <Route path="/login/2fa-setup" element={<SetupTwoFactorPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/vms" replace />} />
        <Route path="/vms" element={<VmListPage />} />
        <Route
          path="/vms/:vmId/terminal"
          element={
            <Suspense fallback={<p className="text-sm text-slate-500">Memuat terminal...</p>}>
              <TerminalPage />
            </Suspense>
          }
        />
        <Route
          path="/admin/vms"
          element={
            <RequireAuth admin>
              <AdminVmsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAuth admin>
              <AdminUsersPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequireAuth admin>
              <AdminAuditPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/vms" replace />} />
      </Route>
    </Routes>
  );
}
