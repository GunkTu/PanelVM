import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountPage } from './features/account/AccountPage';
import { AdminAuditPage } from './features/admin/AdminAuditPage';
import { AdminMaintenancePage } from './features/admin/AdminMaintenancePage';
import { AdminPreviewsPage } from './features/admin/AdminPreviewsPage';
import { AdminProxmoxPage } from './features/admin/AdminProxmoxPage';
import { AdminUsersPage } from './features/admin/AdminUsersPage';
import { AdminVmsPage } from './features/admin/AdminVmsPage';
import { RequireAuth } from './features/auth/AuthContext';
import { MaintenanceGate } from './features/auth/MaintenanceGate';
import { LoginPage } from './features/auth/LoginPage';
import { SetupTwoFactorPage } from './features/auth/SetupTwoFactorPage';
import { TwoFactorPage } from './features/auth/TwoFactorPage';
import { AppLayout } from './features/layout/AppLayout';
import { DatabasesPage } from './features/databases/DatabasesPage';
import { FilesPage } from './features/files/FilesPage';
import { MonitoringPage } from './features/monitoring/MonitoringPage';
import { PreviewsPage } from './features/previews/PreviewsPage';
import { ServicesPage } from './features/services/ServicesPage';
import { SitesPage } from './features/sites/SitesPage';
import { SoftwarePage } from './features/software/SoftwarePage';
import { VmListPage } from './features/vms/VmListPage';

// xterm cukup besar; muat hanya saat halaman terminal dibuka.
const TerminalPage = lazy(() =>
  import('./features/terminal/TerminalPage').then((m) => ({ default: m.TerminalPage })),
);

export function App() {
  return (
    <MaintenanceGate>
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
          <Route path="/account" element={<AccountPage />} />
          <Route
            path="/vms/:vmId/terminal"
            element={
              <Suspense fallback={<p className="text-sm text-slate-500">Memuat terminal...</p>}>
                <TerminalPage />
              </Suspense>
            }
          />
          <Route path="/vms/:vmId/files" element={<FilesPage />} />
          <Route path="/vms/:vmId/databases" element={<DatabasesPage />} />
          <Route path="/vms/:vmId/software" element={<SoftwarePage />} />
          <Route path="/vms/:vmId/sites" element={<SitesPage />} />
          <Route path="/vms/:vmId/previews" element={<PreviewsPage />} />
          <Route path="/vms/:vmId/monitoring" element={<MonitoringPage />} />
          <Route path="/vms/:vmId/services" element={<ServicesPage />} />
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
            path="/admin/proxmox"
            element={
              <RequireAuth admin>
                <AdminProxmoxPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/previews"
            element={
              <RequireAuth admin>
                <AdminPreviewsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/maintenance"
            element={
              <RequireAuth admin>
                <AdminMaintenancePage />
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
    </MaintenanceGate>
  );
}
