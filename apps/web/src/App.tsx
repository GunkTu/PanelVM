import { Badge } from './components';

/** Placeholder Fase 0. Layout sidebar/header dibangun di Fase 1 bersama auth. */
export function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 bg-navy p-4 text-white">
        <p className="text-sm text-slate-300">VM aktif</p>
        <p className="font-semibold">Belum dipilih</p>
      </aside>
      <main className="flex-1 p-6">
        <h1 className="text-2xl font-semibold text-navy">Panel VM</h1>
        <p className="mt-2 text-slate-600">Fondasi aplikasi siap. Fitur dibangun mulai Fase 1.</p>
        <div className="mt-4">
          <Badge tone="info">Fase 0</Badge>
        </div>
      </main>
    </div>
  );
}
