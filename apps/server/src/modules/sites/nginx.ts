export type SiteKind = 'laravel' | 'php' | 'static';

/** Domain huruf kecil, minimal dua label. Divalidasi ketat karena dipakai di nama file dan konfigurasi. */
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const siteRoot = (domain: string): string => `/var/www/${domain}`;

/**
 * Folder dokumen relatif terhadap folder situs: "." = folder utama, atau 1-3 segmen subfolder. Segmen tidak boleh
 * diawali titik (mencegah "..", ".git", ".env") dan hanya berisi karakter aman untuk path dan konfigurasi.
 */
export const DOC_ROOT_RE =
  /^(?:\.|[A-Za-z0-9_][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}){0,2})$/;

/** Folder dokumen bawaan menurut jenis situs (Laravel: public). */
export const defaultDocRootRel = (kind: SiteKind): string => (kind === 'laravel' ? 'public' : '.');

/** Path absolut folder dokumen. `rel` null/undefined = bawaan menurut jenis situs. */
export function docRoot(domain: string, kind: SiteKind, rel?: string | null): string {
  const r = rel ?? defaultDocRootRel(kind);
  if (!DOC_ROOT_RE.test(r)) throw new Error('Folder dokumen tidak valid');
  return r === '.' ? siteRoot(domain) : `${siteRoot(domain)}/${r}`;
}
export const confAvailable = (domain: string): string =>
  `/etc/nginx/sites-available/${domain}.conf`;
export const confEnabled = (domain: string): string => `/etc/nginx/sites-enabled/${domain}.conf`;
export const phpSocket = (version: string): string => `/run/php/php${version}-fpm.sock`;

/**
 * Konfigurasi server block. Semua nilai yang dimasukkan (domain, versi PHP) sudah divalidasi regex ketat
 * sebelum sampai ke sini, dan tidak ada input bebas lain.
 */
export function nginxConf(
  domain: string,
  kind: SiteKind,
  phpVersion: string | null,
  docRootRel?: string | null,
): string {
  if (!DOMAIN_RE.test(domain)) throw new Error('Domain tidak valid');
  if (kind !== 'static' && !(phpVersion && /^[5-9]\.\d$/.test(phpVersion)))
    throw new Error('Versi PHP tidak valid');
  const head = `server {
    listen 80;
    server_name ${domain};
    root ${docRoot(domain, kind, docRootRel)};
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
