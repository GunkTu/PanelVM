import type { ReactNode } from 'react';

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
    <div className="flex min-h-screen items-center justify-center bg-navy p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-1 flex items-center gap-2">
          <span aria-hidden="true" className="h-3 w-3 rounded-full bg-yellow" />
          <span className="text-sm font-semibold uppercase tracking-wide text-navy">Panel VM</span>
        </div>
        <h1 className="text-xl font-semibold text-navy">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}
