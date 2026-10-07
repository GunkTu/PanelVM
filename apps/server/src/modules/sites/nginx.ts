export type SiteKind = 'laravel' | 'php' | 'static';

/** Domain huruf kecil, minimal dua label. Divalidasi ketat karena dipakai di nama file dan konfigurasi. */
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const siteRoot = (domain: string): string => `/var/www/${domain}`;
export const docRoot = (domain: string, kind: SiteKind): string =>
  kind === 'laravel' ? `${siteRoot(domain)}/public` : siteRoot(domain);
export const confAvailable = (domain: string): string =>
  `/etc/nginx/sites-available/${domain}.conf`;
export const confEnabled = (domain: string): string => `/etc/nginx/sites-enabled/${domain}.conf`;
export const phpSocket = (version: string): string => `/run/php/php${version}-fpm.sock`;

/**
 * Konfigurasi server block. Semua nilai yang dimasukkan (domain, versi PHP) sudah divalidasi regex ketat
 * sebelum sampai ke sini, dan tidak ada input bebas lain.
 */
export function nginxConf(domain: string, kind: SiteKind, phpVersion: string | null): string {
  if (!DOMAIN_RE.test(domain)) throw new Error('Domain tidak valid');
  if (kind !== 'static' && !(phpVersion && /^[5-9]\.\d$/.test(phpVersion)))
    throw new Error('Versi PHP tidak valid');
  const head = `server {
    listen 80;
    server_name ${domain};
    root ${docRoot(domain, kind)};
    index index.php index.html;
    client_max_body_size 64M;

    access_log /var/log/nginx/${domain}.access.log;
    error_log /var/log/nginx/${domain}.error.log;
`;
  const dotfiles = `
    location ~ /\\.(?!well-known) {
        deny all;
    }
`;
  if (kind === 'static') {
    return `${head}
    location / {
        try_files $uri $uri/ =404;
    }
${dotfiles}}
`;
  }
  const fallback = kind === 'laravel' ? '/index.php?$query_string' : '/index.php?$query_string';
  return `${head}
    location / {
        try_files $uri $uri/ ${fallback};
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket(phpVersion!)};
    }
${dotfiles}}
`;
}
