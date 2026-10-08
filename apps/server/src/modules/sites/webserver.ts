import { apacheAvailable, apacheConf, apacheEnabled } from './apache.js';
import { confAvailable, confEnabled, nginxConf, type SiteKind } from './nginx.js';

export type WebServer = 'nginx' | 'apache';

/** Perbedaan Nginx dan Apache yang dipakai modul situs: lokasi file, perintah uji/muat ulang, dan isi konfigurasi. */
export interface WebServerSpec {
  title: string;
  available(domain: string): string;
  enabled(domain: string): string;
  /** Perintah uji sintaks konfigurasi; kode keluar 0 = valid. */
  test: string[];
  /** Perintah muat ulang tanpa memutus koneksi. */
  reload: string[];
  /** Perintah deteksi keberadaan server di VM (kode keluar 0 = terpasang). */
  detect: string[];
  conf(
    domain: string,
    kind: SiteKind,
    phpVersion: string | null,
    docRootRel?: string | null,
  ): string;
}

export const WEB_SERVERS: Record<WebServer, WebServerSpec> = {
  nginx: {
    title: 'Nginx',
    available: confAvailable,
    enabled: confEnabled,
    test: ['nginx', '-t'],
    reload: ['sh', '-c', 'systemctl reload nginx 2>/dev/null || nginx -s reload'],
    detect: ['sh', '-c', 'command -v nginx'],
    conf: nginxConf,
  },
  apache: {
    title: 'Apache',
    available: apacheAvailable,
    enabled: apacheEnabled,
    test: ['apache2ctl', 'configtest'],
    reload: ['sh', '-c', 'systemctl reload apache2 2>/dev/null || apache2ctl graceful'],
    detect: ['sh', '-c', 'command -v apache2ctl'],
    conf: apacheConf,
  },
};
