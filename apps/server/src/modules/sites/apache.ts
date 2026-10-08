import { DOMAIN_RE, docRoot, siteRoot, phpSocket, type SiteKind } from './nginx.js';

export const apacheAvailable = (domain: string): string =>
  `/etc/apache2/sites-available/${domain}.conf`;
export const apacheEnabled = (domain: string): string =>
  `/etc/apache2/sites-enabled/${domain}.conf`;

/** Modul Apache yang dibutuhkan situs (PHP-FPM lewat proxy_fcgi, .htaccess lewat rewrite). */
export const APACHE_MODULES = ['rewrite', 'proxy', 'proxy_fcgi', 'setenvif', 'headers'] as const;

/**
 * Konfigurasi VirtualHost Apache. Semua nilai (domain, versi PHP, folder dokumen) sudah divalidasi regex ketat
 * sebelum sampai ke sini dan tidak ada input bebas lain. PHP dijalankan lewat PHP-FPM (bukan mod_php) agar versi
 * PHP per situs bisa berbeda, sama seperti di Nginx.
 */
export function apacheConf(
  domain: string,
  kind: SiteKind,
  phpVersion: string | null,
  docRootRel?: string | null,
): string {
  if (!DOMAIN_RE.test(domain)) throw new Error('Domain tidak valid');
  if (kind !== 'static' && !(phpVersion && /^[5-9]\.\d$/.test(phpVersion)))
    throw new Error('Versi PHP tidak valid');
  const root = docRoot(domain, kind, docRootRel);
  const php =
    kind === 'static'
      ? ''
      : `
    <FilesMatch "\\.php$">
        SetHandler "proxy:unix:${phpSocket(phpVersion!)}|fcgi://localhost"
    </FilesMatch>
`;
  const fallback = kind === 'static' ? '' : '\n        FallbackResource /index.php';
  return `<VirtualHost *:80>
    ServerName ${domain}
    DocumentRoot ${root}

    <Directory ${siteRoot(domain)}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
        DirectoryIndex index.php index.html${fallback}
    </Directory>
${php}
    <FilesMatch "^\\.(?!well-known)">
        Require all denied
    </FilesMatch>
    <DirectoryMatch "(^|/)\\.(?!well-known)">
        Require all denied
    </DirectoryMatch>

    ErrorLog \${APACHE_LOG_DIR}/${domain}.error.log
    CustomLog \${APACHE_LOG_DIR}/${domain}.access.log combined
</VirtualHost>
`;
}
