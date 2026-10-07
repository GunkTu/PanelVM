import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  // Aksi utama: latar kuning, teks biru tua (kontras 8,9:1).
  primary: 'bg-yellow text-navy shadow-xs hover:bg-yellow-dark hover:shadow-md',
  secondary: 'bg-navy text-white shadow-xs hover:bg-navy-light hover:shadow-md',
  danger: 'bg-error text-white shadow-xs hover:bg-red-800 hover:shadow-md',
  ghost:
    'border border-slate-300 bg-white text-navy shadow-xs hover:border-slate-400 hover:bg-slate-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
};

/** Kelas tombol yang sama untuk <a>/<Link> yang tampil seperti tombol. */
export const buttonClasses = (variant: Variant = 'ghost', size: Size = 'md', extra = ''): string =>
  `inline-flex shrink-0 items-center justify-center rounded-lg font-semibold whitespace-nowrap transition-all duration-150 active:scale-[0.98] ${sizes[size]} ${variants[variant]} ${extra}`;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Ikon di kiri teks (dekoratif; nama tombol tetap dari teksnya). */
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold whitespace-nowrap transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100 ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        icon && (
          <span aria-hidden="true" className="inline-flex">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  );
}
