import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { buttonClasses } from './Button';

type Look = {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  icon?: ReactNode;
};

/** Tautan internal (react-router) yang tampil seperti tombol. */
export function ButtonLink({
  variant = 'ghost',
  size = 'md',
  icon,
  className = '',
  children,
  ...rest
}: LinkProps & Look) {
  return (
    <Link className={buttonClasses(variant, size, `gap-1.5 ${className}`)} {...rest}>
      {icon && (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      )}
      {children}
    </Link>
  );
}

/** Tautan biasa (<a>, mis. unduhan) yang tampil seperti tombol. */
export function ButtonAnchor({
  variant = 'ghost',
  size = 'md',
  icon,
  className = '',
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & Look) {
  return (
    <a className={buttonClasses(variant, size, `gap-1.5 ${className}`)} {...rest}>
      {icon && (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      )}
      {children}
    </a>
  );
}
