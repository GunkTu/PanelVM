import { KeyRound, ShieldCheck, SquareTerminal, TerminalSquare } from 'lucide-react';
import type { ReactNode } from 'react';

const POINTS = [
  {
    icon: TerminalSquare,
    title: 'Terminal, file, dan database',
    text: 'Kelola VM Anda dari satu tempat, langsung di browser.',
  },
  {
    icon: ShieldCheck,
    title: 'Aman secara bawaan',
    text: 'Verifikasi 2 langkah wajib dan akses terisolasi per VM.',
  },
  {
    icon: KeyRound,
    title: 'Tanpa berbagi kunci',
    text: 'Kredensial SSH tidak pernah meninggalkan server panel.',
  },
];

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-navy via-navy to-navy-dark p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-navy-light/70 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-navy-light/60 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:44px_44px]"
        />
        <div className="relative flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow text-navy shadow-lg"
          >
            <SquareTerminal className="h-5 w-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Panel VM</span>
        </div>
        <div className="relative max-w-lg">
          <h2 className="text-4xl leading-tight font-semibold tracking-tight">
            Akses VM Anda dengan aman dan nyaman.
          </h2>
          <ul className="mt-10 space-y-6">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-yellow ring-1 ring-white/15"
                >
                  <p.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold">{p.title}</p>
                  <p className="text-sm text-slate-300">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="flex min-h-screen flex-col items-center justify-center bg-canvas p-5 sm:p-8 lg:min-h-0">
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy text-yellow shadow-md"
          >
            <SquareTerminal className="h-5 w-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-navy">Panel VM</span>
        </div>
        <div className="w-full max-w-md animate-pop-in rounded-2xl border border-slate-200/80 bg-white p-7 shadow-(--shadow-lift) sm:p-8">
          <h1 className="text-2xl font-semibold text-navy">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
