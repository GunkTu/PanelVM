import { randomBytes } from 'node:crypto';

/**
 * phpMyAdmin terpasang di /opt/phpmyadmin (rilis di releases/<id>, tautan "current"), dilayani Nginx hanya di
 * 127.0.0.1:<port> VM. Tidak pernah terbuka ke jaringan: akses lewat tunnel preview dengan tiket dari panel.
 */
export const PMA_PORT = 8091;
export const PMA_DIR = '/opt/phpmyadmin';
export const PMA_TMP = '/var/lib/phpmyadmin/tmp';
export const PMA_CONF_NAME = 'panelvm-phpmyadmin.conf';
export const PMA_CONF_AVAILABLE = `/etc/nginx/sites-available/${PMA_CONF_NAME}`;
export const PMA_CONF_ENABLED = `/etc/nginx/sites-enabled/${PMA_CONF_NAME}`;
/** Sumber resmi (halaman unduhan phpMyAdmin) dan berkas checksum SHA-256 di sebelahnya. */
export const PMA_URL =
  'https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.tar.gz';

const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Rahasia cookie phpMyAdmin (blowfish_secret): 32 karakter acak, dibuat panel dan tidak pernah dikirim ke browser. */
export function newBlowfishSecret(): string {
  let out = '';
  for (const b of randomBytes(32)) out += SECRET_ALPHABET[b % SECRET_ALPHABET.length];
  return out;
}

/** Isi config.inc.php. Hanya login dengan user database biasa: root dan password kosong dilarang. */
export function pmaConfig(secret: string): string {
  if (!/^[A-Za-z0-9]{32}$/.test(secret)) throw new Error('Rahasia tidak valid');
  return `<?php
// Dikelola PanelVM. Jangan diedit manual; pasang ulang lewat panel untuk mengubahnya.
$cfg['blowfish_secret'] = '${secret}';
$i = 0;
$i++;
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['AllowArbitraryServer'] = false;
$cfg['LoginCookieValidity'] = 3600;
$cfg['LoginCookieStore'] = 0;
$cfg['ShowServerInfo'] = false;
$cfg['VersionCheck'] = false;
$cfg['TempDir'] = '${PMA_TMP}';
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
`;
}

/** Server block Nginx untuk phpMyAdmin, hanya di loopback. `docRootRel` = "." atau "public". */
export function pmaNginxConf(
  phpVersion: string,
  docRootRel: '.' | 'public',
  port = PMA_PORT,
): string {
  if (!/^[5-9]\.\d$/.test(phpVersion)) throw new Error('Versi PHP tidak valid');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port tidak valid');
  const root = docRootRel === '.' ? `${PMA_DIR}/current` : `${PMA_DIR}/current/public`;
  return `# Dikelola PanelVM. Hanya mendengarkan di loopback VM.
server {
    listen 127.0.0.1:${port};
    server_name _;
    root ${root};
    index index.php;
    client_max_body_size 64M;

    location ~ ^/(libraries|templates|vendor|setup|config|sql|examples|doc|test|tmp|locale)/ {
        deny all;
    }
    location ~ /\\.(?!well-known) {
        deny all;
    }
    location / {
        try_files $uri $uri/ =404;
    }
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${phpVersion}-fpm.sock;
        fastcgi_read_timeout 300;
    }
}
`;
}

/**
 * Skrip statis: unduh, verifikasi SHA-256 terhadap berkas checksum resmi, lalu ekstrak ke releases/<id>.
 * Argumen: $1 = URL, $2 = id rilis (angka), $3 = folder dasar. Tidak ada interpolasi string pengguna.
 */
export const DOWNLOAD_SCRIPT = `set -eu
url="$1"; id="$2"; base="$3"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 --max-time 300 -o "$tmp/pma.tgz" "$url"
curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$tmp/pma.sha256" "$url.sha256"
want=$(cut -d' ' -f1 "$tmp/pma.sha256" | head -n 1)
got=$(sha256sum "$tmp/pma.tgz" | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "Checksum SHA-256 tidak cocok; unduhan dibatalkan."; exit 1; }
mkdir -p "$base/releases/$id"
tar -xzf "$tmp/pma.tgz" -C "$base/releases/$id" --strip-components=1
echo "Checksum cocok dan arsip diekstrak ke $base/releases/$id"
`;

/** Deteksi folder dokumen rilis: "public" bila ada public/index.php, selain itu ".". */
export const DETECT_ROOT_SCRIPT = '[ -f "$1/public/index.php" ] && echo public || echo .';

/** Ambil nomor versi dari berkas Version.php (lokasi bergantung versi). Kosong bila tidak ditemukan. */
export const DETECT_VERSION_SCRIPT = `for f in libraries/classes/Version.php src/Version.php; do
  [ -f "$1/$f" ] && grep -m1 -oE "VERSION = '[0-9][0-9.a-zA-Z-]*'" "$1/$f" | grep -oE "[0-9][0-9.a-zA-Z-]*" && exit 0
done
exit 0`;

export const RELEASE_ID_RE = /^\d{10,16}$/;
