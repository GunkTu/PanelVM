# Deploy

Dokumen ini memisahkan dengan jelas **apa yang sudah teruji** dan **apa yang harus Anda verifikasi di lingkungan nyata** (ditandai **[belum diuji]**). Rangkuman akhir ada di bagian "Yang masih harus diverifikasi".

## Keputusan pemilik yang berlaku

- Domain panel: `vm.thegt.my.id` (`APP_ORIGIN=https://vm.thegt.my.id`).
- IP publik tetap; trafik masuk lewat MikroTik (L2TP) ke Nginx Proxy Manager (NPM).
- Email/SMTP: **tidak dipakai**. Semua notifikasi lewat notification center (akun baru, login perangkat baru, VM offline/online, proses selesai/gagal, aksi berisiko). Variabel `SMTP_*` boleh kosong.
- Retensi audit log: **90 hari** (bawaan), ubah lewat `AUDIT_RETENTION_DAYS` (minimal 7). Dibersihkan otomatis tiap hari, bersama job lama (30 hari) dan notifikasi terbaca (90 hari).
- Versi OS dan database tiap VM: **dideteksi panel dari VM**, tidak diasumsikan. Database dipasang dari panel (menu Aplikasi).

## Checklist produksi (urutan)

1. **VM panel** (Debian/Ubuntu, terpisah dari VM client): pasang Node.js LTS (>= 22), `build-essential` dan `python3` (untuk modul native `better-sqlite3`/`argon2` bila tidak ada binari siap pakai).
2. **User non-root**: `useradd --system --home /opt/panelvm --shell /usr/sbin/nologin panelvm`.
3. **Kode dan build** (sebagai root atau user deploy, kepemilikan file ke root agar service tidak bisa mengubah kodenya):
   ```
   git clone <repo> /opt/panelvm && cd /opt/panelvm
   npm ci && npm run build
   ```
4. **Konfigurasi**: `install -d -m 0750 -o root -g panelvm /etc/panelvm`, salin `.env.example` ke `/etc/panelvm/panel.env`, isi nilainya, lalu `chmod 0640` dan `chown root:panelvm`. Buat kunci: `openssl rand -base64 32` (master key) dan `openssl rand -base64 48` (session secret). **Jangan commit** file ini.
5. **Data**: `install -d -m 0700 -o panelvm -g panelvm /var/lib/panel` (DB `panel.db` dibuat berizin 0600).
6. **Migrasi dan admin pertama** (skrip hasil build dijalankan sebagai `panelvm`; env dibaca langsung dari file dengan `--env-file`, teruji):
   ```
   cd /opt/panelvm/apps/server
   sudo -u panelvm node --env-file=/etc/panelvm/panel.env dist/scripts/migrate.js
   sudo -u panelvm node --env-file=/etc/panelvm/panel.env dist/scripts/create-admin.js   # interaktif
   ```
   Admin mengaktifkan 2FA saat login pertama. (`npm run db:migrate`/`create-admin` untuk pengembangan memakai `.env` di root repo.)
7. **systemd**: salin `deploy/panelvm.service`, `deploy/panelvm-backup.service`, `deploy/panelvm-backup.timer` ke `/etc/systemd/system/`, lalu `systemctl daemon-reload && systemctl enable --now panelvm panelvm-backup.timer`. Cek hardening dengan `systemd-analyze security panelvm.service`. Jika panel crash terus saat start, lihat `journalctl -u panelvm -n 50` (restart otomatis tiap 3 detik membuatnya tampak "running" padahal tidak mendengarkan di port). Catatan: unit wajib mengizinkan `AF_NETLINK` di `RestrictAddressFamilies`, kalau tidak Node gagal dengan "Unknown system error 97". **[belum diuji di systemd nyata]** (sintaks terverifikasi dengan `systemd-analyze verify`).
8. **NPM**: lihat bagian berikut.
9. **Firewall**: lihat bagian berikut.
10. **Uji penerimaan**: login dengan 2FA, buat VM + setujui host key, buka terminal, uji isolasi (client A tidak bisa membuka VM B), suspend akun, dan uji dari **dalam VM client** bahwa VM panel/Proxmox tidak terjangkau.

## Uji lewat IP lokal tanpa HTTPS (sementara)

Sebelum domain dan NPM siap, panel bisa dites lewat `http://<IP-VM-panel>:3000` di jaringan lokal:

```
APP_ORIGIN=http://192.168.1.50:3000     # persis alamat yang diketik di browser (IP dan port)
INSECURE_HTTP=true
TRUST_PROXY=false
```

`INSECURE_HTTP` membuat cookie sesi tanpa `Secure`/`__Host-` (browser menolak cookie aman di HTTP biasa). Konsekuensinya password, kode 2FA, dan sesi berjalan sebagai **teks biasa** di jaringan. Pakai hanya di LAN tepercaya, **jangan** buka port 3000 ke internet, dan hapus `INSECURE_HTTP` begitu pindah ke domain + HTTPS (ganti `APP_ORIGIN` ke `https://...`). Panel menolak start bila `INSECURE_HTTP=true` tetapi `APP_ORIGIN` berawalan `https://`. Teruji di level test; belum dicoba dari browser di jaringan Anda.

## Nginx Proxy Manager

- Proxy host `vm.thegt.my.id` ke `http://<IP VM panel>:3000`. Aktifkan **Websockets Support** (terminal), SSL Let's Encrypt, dan **Force SSL**. Antarmuka admin NPM (port 81) jangan terbuka ke internet.
- **`TRUST_PROXY`**: isi dengan **IP NPM** (atau beberapa IP/CIDR dipisah koma), mis. `TRUST_PROXY=192.168.1.10`. Dengan begitu header `X-Forwarded-For` hanya dipercaya dari NPM dan tidak bisa dipalsukan oleh pihak lain (ada test yang membuktikan). `TRUST_PROXY=true` mempercayai semua hop dan hanya aman bila port panel **tidak** bisa dijangkau selain lewat NPM; `false` berarti IP klien yang tercatat adalah IP NPM (rate limit akan berlaku untuk semua pengguna sekaligus).
- HSTS diatur di NPM (aktifkan setelah HTTPS stabil); aplikasi tidak mengirim HSTS.
- Panel menyajikan SPA dan API dari origin yang sama (tanpa CORS). Cookie sesi `__Host-sid` mewajibkan HTTPS.

## Firewall dan isolasi jaringan **[belum diuji di jaringan Anda]**

- **VM panel**: hanya menerima dari NPM (port 3000) dan SSH dari jaringan admin; hanya keluar ke port SSH VM target (+ DNS). Contoh `deploy/nftables.panel-vm.conf.example` (sintaks lolos `nft -c`; terapkan dari konsol Proxmox, bukan dari SSH).
- **VM client**: tidak boleh menjangkau VM panel, port 8006 Proxmox, maupun SSH host Proxmox. Terapkan dengan Proxmox Firewall (aturan per VM/IPSet) atau di MikroTik, lalu **uji dari dalam VM client** (`nc -zv <ip-panel> 3000`, `nc -zv <ip-proxmox> 8006`, `nc -zv <ip-proxmox> 22` harus gagal).
- MikroTik/L2TP: yang diteruskan ke luar hanya port 443 menuju NPM.
- Akses darurat ke VM tetap lewat konsol Proxmox bila kunci SSH panel terhapus oleh client.

## Menambah VM

1. Admin: Kelola VM, Tambah VM. Panel membuat kunci SSH ed25519 khusus VM itu (private key tidak pernah keluar dari server panel).
2. Pasang public key yang tampil ke `~/.ssh/authorized_keys` user SSH di VM (disarankan `root` agar semua fitur bekerja; user lain butuh `sudo -n` tanpa password).
3. Pindai host key, cocokkan fingerprint dengan `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` di VM, lalu setujui. Bila fingerprint berubah kelak, koneksi ditolak sampai admin menyetujui ulang.
4. Tes koneksi, lalu hubungkan ke client. Panel memeriksa status VM tiap `VM_CHECK_INTERVAL_SEC` detik (60 bawaan, 0 = mati) dan memberi notifikasi saat online/offline berubah.

## Fitur per modul: catatan operasional

### Aplikasi (installer)

- OS yang didukung: **Debian dan Ubuntu** (dibaca dari `/etc/os-release`). Katalog tetap: alat dasar, Nginx, PHP-FPM (banyak versi, ekstensi umum Laravel + opsional), Composer (installer resmi + verifikasi checksum SHA-384), MariaDB, MySQL, PostgreSQL, Redis. Versi mengikuti repositori OS di VM (Ubuntu 24.04: PHP 8.3, MariaDB 10.11, PostgreSQL 16 pada uji kami).
- **Repositori PHP tambahan (Ondřej Surý)** untuk banyak versi PHP: opsional dengan persetujuan eksplisit di UI. Ubuntu memakai PPA `ppa:ondrej/php`; Debian memakai paket keyring `debsuryorg-archive-keyring`. **[belum diuji di Debian/Ubuntu nyata]**; langkah Debian disusun dari sumber sekunder (situs resmi diblokir dari lingkungan pengembangan). Gagal dengan pesan jelas bila ada yang tidak cocok.
- Repositori vendor database (dev.mysql.com, mariadb.org, PGDG) belum ada; menambahnya butuh keputusan Anda. MySQL dan MariaDB tidak bisa dipasang bersamaan. Satu proses instalasi per VM pada satu waktu.

### Database manager

- **MySQL/MariaDB**: klien `mariadb`/`mysql` dijalankan sebagai user SSH lewat unix socket, SQL lewat stdin. Teruji pada **MariaDB 10.11 di Ubuntu 24.04**. **[belum diuji]** pada MySQL Oracle, MariaDB versi lain, dan Debian. Bila root database memakai password, panel menampilkan "root DB butuh password" dan tidak mengelola database itu sampai root memakai `unix_socket`/`auth_socket`. User dibuat untuk host `localhost` dan `127.0.0.1`.
- **PostgreSQL**: perintah dijalankan sebagai user sistem `postgres` lewat `runuser` + `psql` (peer auth). Teruji pada **PostgreSQL 16 di Ubuntu 24.04**; **[belum diuji]** pada versi lain (terutama perilaku schema `public` pada PG <= 14). Model akses: "Penuh" = pemilik database; "Baca saja" = CONNECT + SELECT pada tabel yang ada saat ini (tabel baru perlu "Beri akses" ulang). Nama user berawalan `pg_` ditolak (dicadangkan PostgreSQL). Aplikasi di VM yang sama memakai `DB_HOST=127.0.0.1` dan butuh `scram-sha-256`/`md5` untuk `127.0.0.1` di `pg_hba.conf` (bawaan Debian/Ubuntu sudah benar).
- Password database dibuat panel (24 karakter), ditampilkan **sekali**, tidak disimpan di DB panel, audit, notifikasi, atau job.

### Situs web dan deploy kode

- Jenis: **Laravel** (document root `public/`), **PHP** biasa/framework lain, **statis**. Struktur di VM: `/var/www/<domain>`, `/etc/nginx/sites-available/<domain>.conf` (+ symlink ke `sites-enabled`), PHP-FPM lewat `/run/php/php<versi>-fpm.sock`. Konfigurasi diuji `nginx -t` dengan rollback otomatis.
- Nginx di VM mendengarkan **port 80**; arahkan domain di NPM ke `IP-VM:80` (SSL diurus NPM). Nginx memilih situs menurut header Host.
- Deploy dari **arsip** (.zip/.tar.gz/.tgz/.tar, unggah streaming) atau **Git publik** (https tanpa kredensial; repositori privat: unggah arsip). Preset Laravel: folder tulis, `.env` dari `.env.example`, `composer install --no-dev`, `APP_KEY`, `storage:link`, migrasi/optimize (opsional), pemilik `www-data`, reload PHP-FPM. Update tidak menimpa `.env` dan `storage/app`/`storage/logs`. Teruji dengan proyek Laravel **tiruan** (artisan + composer.json tanpa dependensi); **[belum diuji]** dengan Laravel asli yang menarik dependensi dari Packagist.
- **Web server: Nginx atau Apache, salah satu per VM.** Keduanya saling konflik di menu Aplikasi (yang satu tidak bisa dipasang bila yang lain sudah ada), seperti MySQL dan MariaDB. Situs memakai yang terpasang; bila keduanya ada (dipasang di luar panel), pembuatan situs meminta pilihan. Apache memakai VirtualHost di `/etc/apache2/sites-available/<domain>.conf`, PHP lewat PHP-FPM (`proxy_fcgi`), `.htaccess` diizinkan, modul `rewrite proxy proxy_fcgi setenvif headers` diaktifkan otomatis, dan konfigurasi diuji `apache2ctl configtest` dengan rollback. Sintaks VirtualHost diperiksa dengan `httpd -t` Apache 2.4 sungguhan; **[belum diuji]** di Apache Debian/Ubuntu nyata (soket PHP-FPM, `a2enmod`).
- **Folder dokumen** dapat dipilih per situs (tombol *Folder dokumen*): panel mendaftar subfolder (maks. 3 tingkat, melewati `vendor`, `node_modules`, `storage`, `.git`) dan menandai yang berisi `index.php`/`index.html`. Setelah deploy, bila folder bawaan (Laravel: `public`) tidak berisi index, panel memilih otomatis folder yang berisi index (satu kandidat, atau nama umum seperti `public_html`, `dist`); bila ambigu, pengguna diberi tahu di log untuk memilih sendiri.
- **Deploy dari URL** (tab *Dari URL / Google Drive*): VM mengunduh arsip langsung dari sumbernya, tidak lewat panel dan Cloudflare, sehingga cepat untuk file besar. Hanya `https`; link file Google Drive dan Dropbox dinormalkan, link folder Drive dan Google Docs ditolak dengan petunjuk. Jenis arsip (zip/gzip/tar) dideteksi dari isi berkas; bila yang kembali halaman web (mis. akses Drive belum "Siapa saja yang memiliki link"), job gagal dengan pesan jelas. Batas ukuran `MAX_URL_DEPLOY_MB` (bawaan 2048). Audit hanya mencatat host. **[belum diuji]** terhadap Google Drive sungguhan (perilaku halaman peringatan file besar bisa berubah); skrip unduh diuji dengan `curl` tiruan.
- **Migrasi Laravel yang menunggu `.env`**: sebelum `artisan migrate`, deploy memeriksa koneksi database dari `.env` (skrip PHP statis, tidak pernah mencetak password). Bila belum bisa, job berhenti berstatus *Menunggu Anda* dengan petunjuk; setelah `.env` diperbaiki, tekan **Lanjutkan** (diperiksa ulang) atau **Batalkan**. Menunggu lebih dari 30 menit atau server panel restart membatalkan job. Panduan langkah demi langkah ada di halaman Situs Web.
- **"Welcome to nginx" setelah deploy** bukan berarti deploy gagal: halaman itu milik server bawaan Debian (`listen 80 default_server`), yang melayani setiap permintaan yang header Host-nya tidak cocok dengan domain situs mana pun, misalnya dibuka lewat IP VM, lewat domain lain, atau lewat Preview Web tanpa kolom *Host situs*. Situs panel hanya cocok bila Host = domain-nya. Cara memperbaiki: buka lewat domain situs (atau isi *Host situs* di preview), atau pakai tombol **Jadikan situs utama** (khusus Nginx): panel melepas symlink `/etc/nginx/sites-enabled/default` (berkas `sites-available/default` tidak dihapus) dan menulis ulang konfigurasi situs dengan `listen 80 default_server`; diuji `nginx -t` dengan rollback otomatis (halaman bawaan dipulihkan bila ditolak). Hanya satu situs utama per VM; melepasnya memulihkan halaman bawaan. Untuk Apache belum ada tombolnya: jalankan `sudo a2dissite 000-default && sudo systemctl reload apache2` di terminal.
- Node.js/Python (proses panjang, reverse proxy) belum didukung.

### Monitoring dan Service

- Monitoring: satu skrip statis baca-saja (`/proc`, `df`, `ps`); CPU diukur dari dua sampel `/proc/stat` selang 1 detik; UI memperbarui tiap 5 detik.
- Service manager (systemd): `list-units`, `start/stop/restart/reload/enable/disable`, dan `journalctl` (maks. 500 baris). Layanan sistem (`ssh`, `sshd`, `dbus`, `systemd-*`, `networking`, `NetworkManager`) dilindungi: hanya `reload`. **[belum diuji di systemd nyata]**: sandbox pengembangan tidak memakai systemd, jadi integrasi diuji dengan `systemctl`/`journalctl` **palsu** di VM nyata, dan parser diuji dengan format keluaran sesuai dokumentasi systemd. Verifikasi di satu VM nyata sebelum diandalkan.

### Preview web (alamat sementara ke aplikasi di VM)

Client dapat menampilkan aplikasi yang sedang dikembangkan di VM-nya lewat alamat `https://pv-<acak>.<PREVIEW_BASE_DOMAIN>`, tanpa mengatur IP/port/NPM/Cloudflare per VM. Panel meneruskan trafik HTTP dan WebSocket ke `127.0.0.1:<port>` **di dalam VM** lewat koneksi SSH yang sudah ada (port-forward, seperti `ssh -L`). Tidak ada port tambahan di VM dan tidak ada perubahan firewall: VM panel tetap hanya keluar ke port SSH VM.

- **Siapa:** hanya client pemilik VM yang bisa membuat preview. Admin memantau semua preview aktif (menu *Preview Live*, lengkap dengan status live dan jumlah koneksi) dan bisa mencabutnya.
- **Alamat:** `https://pv-<alias>.<PREVIEW_BASE_DOMAIN>`. Alias dipilih client (3-30 huruf kecil/angka/tanda hubung, unik; kata yang menyesatkan seperti `login` atau `admin` ditolak) atau dikosongkan untuk alamat acak 130 bit yang tidak bisa ditebak. Alias tidak bisa diganti setelah dibuat (cabut lalu buat baru).
- **Akses (dipilih client per preview):** *publik* (siapa pun yang tahu alamatnya) atau *dengan kata sandi* (minimal 8 karakter, disimpan sebagai hash argon2id). Pengunjung memasukkan kata sandi di halaman panel di host preview, lalu mendapat cookie 12 jam (`HttpOnly`, terikat ke satu preview) yang mati seketika bila kata sandi/mode diubah. Tebakan kata sandi dibatasi 8 per IP dan 60 total per 10 menit; IP yang terus membuka alias tak dikenal diperlambat (40 per menit). Path `/__pv/login` di host preview dipakai panel dan tidak diteruskan ke aplikasi. **Alias dengan akses publik mudah ditebak**: pakai kata sandi bila isinya bukan untuk umum.
- **Masa berlaku dan pencabutan:** 1 jam sampai 7 hari (bawaan 24 jam), bisa diperpanjang dan dicabut. Maksimal 3 preview aktif per VM. Preview terhapus otomatis saat dicabut, kedaluwarsa, akun pemilik disuspend, VM dilepas/dihapus, atau modul `previews` dimatikan; koneksi yang sedang terbuka ikut diputus.
- **Keamanan:** preview berjalan di origin terpisah dari panel, jadi script aplikasi pengguna tidak bisa memakai sesi panel. Request di host preview tidak pernah mencapai rute panel (termasuk `/api`). Alamat preview tidak dicatat di audit log.

**Menyalakan fitur**

1. Isi `PREVIEW_BASE_DOMAIN=thegt.my.id` di `/etc/panelvm/panel.env`, lalu `sudo systemctl restart panelvm`. Kosong = fitur mati.
2. Arahkan **semua** `*.thegt.my.id` ke panel. Karena IP publik dari penyedia mengganti IP sumber paket, jalur yang disarankan adalah **Cloudflare Tunnel**: di Zero Trust > Networks > Tunnels > tunnel Anda > *Published application routes*, tambahkan hostname `*.thegt.my.id` dengan layanan `http://<IP VM panel>:3000`. Bila DNS wildcard tidak dibuat otomatis, tambahkan CNAME `*` ke `<id-tunnel>.cfargotunnel.com` (proxied). Sertifikat Universal SSL Cloudflare mencakup `*.thegt.my.id` (satu tingkat); sertifikat wildcard di NPM tidak diperlukan pada jalur ini.
3. `TRUST_PROXY` harus berisi IP host `cloudflared` (mis. `192.168.10.150`) agar IP pengunjung yang tercatat benar. Tutup port 80/443 publik di MikroTik sehingga tunnel menjadi satu-satunya pintu masuk.
4. Alternatif lewat NPM (tidak disarankan selama IP sumber diganti penyedia): proxy host `*.thegt.my.id` ke panel dengan sertifikat wildcard (DNS challenge) dan **Websockets Support** aktif.

**Catatan operasional**

- `sshd` di VM harus mengizinkan `AllowTcpForwarding yes` (bawaan Debian/Ubuntu). Bila dilarang, halaman preview dan tombol *Cek port* menjelaskannya.
- **Port:** 80 atau 1024-65535 (selain port SSH VM). Port sistem lain (22, 25, 443, dst.) ditolak. Untuk situs Nginx di port 80, isi kolom *Host situs* (mis. `blog.contoh.com`) agar Nginx memilih situs yang benar; tanpa itu Nginx menampilkan situs default. Aplikasi yang membuat URL absolut dari domain aslinya (mis. `APP_URL` Laravel) akan mengarahkan pengunjung ke domain itu, bukan ke alamat preview.
- Header `Host` ke aplikasi ditulis ulang menjadi `localhost:<port>`; `X-Forwarded-For/Host/Proto` diisi panel. Respons diberi `X-Robots-Tag: noindex` dan `Cache-Control: no-cache` bila aplikasi tidak menentukannya.
- Paket gratis Cloudflare membatasi body request 100 MB; ini berlaku untuk upload lewat preview, bukan untuk file manager panel bila jalurnya sama (periksa batasnya di jalur Anda).
- **[belum diuji]** di lingkungan nyata: Cloudflare Tunnel dengan hostname wildcard, HMR Vite lewat Cloudflare, dan sshd asli (diuji dengan server SSH tiruan yang meniru kode penolakan sshd). Verifikasi dengan satu aplikasi nyata sebelum dibagikan ke orang lain.

## Backup, restore, dan rotasi kunci

- **Backup DB**: timer `panelvm-backup.timer` atau manual `sudo -u panelvm node --env-file=/etc/panelvm/panel.env dist/scripts/backup-db.js` membuat salinan konsisten (API backup SQLite, aman saat panel berjalan), berizin 0600, menyisakan `BACKUP_KEEP` (14) terbaru di `BACKUP_DIR` (bawaan `<folder DB>/backups`). Cadangan **tidak** berisi master key.
- **Simpan `SECRETS_MASTER_KEY` terpisah dari backup DB** (mis. password manager). Tanpa kunci ini, kunci SSH tiap VM dan secret 2FA tidak bisa dibuka dan harus dibuat ulang.
- **Restore**: hentikan panel, salin berkas cadangan ke `DATABASE_PATH` (izin 0600, pemilik `panelvm`), pastikan `SECRETS_MASTER_KEY` sama dengan saat backup dibuat, jalankan panel. Uji restore secara berkala. Tambahkan juga snapshot Proxmox untuk VM panel.
- **Rotasi master key** (teruji, atomik). Hentikan panel (`systemctl stop panelvm`), lalu:
  ```
  cd /opt/panelvm/apps/server
  export NEW_SECRETS_MASTER_KEY="$(openssl rand -base64 32)"
  sudo --preserve-env=NEW_SECRETS_MASTER_KEY -u panelvm node --env-file=/etc/panelvm/panel.env dist/scripts/rotate-key.js
  echo "$NEW_SECRETS_MASTER_KEY"      # salin ke SECRETS_MASTER_KEY di /etc/panelvm/panel.env
  unset NEW_SECRETS_MASTER_KEY
  systemctl start panelvm
  ```
  Skrip membuat backup `*.pre-rotate-*.bak`, mengenkripsi ulang semua kunci SSH VM dan secret 2FA dalam satu transaksi (gagal = tidak ada yang berubah), dan membuang semua sesi. Kunci baru wajib berbeda dari yang lama (dibandingkan sebagai byte). Semua pengguna harus login ulang. Recovery code tidak terpengaruh (argon2). Simpan kunci baru di tempat aman, lalu hapus file `.bak` setelah memastikan panel berjalan dengan kunci baru. Kunci dibaca dari environment, bukan argumen, agar tidak terlihat di daftar proses.

## Menjalankan test

```
npm run lint && npm run typecheck && npm test        # unit + integrasi
npm run e2e                                          # E2E Playwright (butuh Chromium)
```

- **Integrasi VM nyata** (file, database, installer, situs, monitoring, service): jalankan `sudo apps/server/test/integration/setup-test-vm.sh /tmp/panel-test-vm` pada mesin sekali pakai (memasang sshd, MariaDB, Nginx, PHP-FPM lewat apt), lalu `PANEL_TEST_SSH_PORT=2222 PANEL_TEST_AUTHORIZED_KEYS=/tmp/panel-test-vm/authorized_keys npm test`. Tanpa variabel itu, suite integrasi dilewati otomatis. Untuk PostgreSQL pasang juga paket `postgresql` dan jalankan cluster-nya.
- **E2E**: `PLAYWRIGHT_CHROMIUM_PATH=/path/ke/chromium npm run e2e` (opsional; bila kosong Playwright memakai browsernya sendiri). Spesifikasi auth dan isolasi memakai server SSH palsu; spesifikasi `real-vm` ikut jalan bila variabel `PANEL_TEST_*` di atas diset.
- Test negatif lintas akun (IDOR) untuk semua endpoint modul selalu jalan tanpa VM nyata.

## Fitur tambahan: deploy, jadwal, aplikasi, phpMyAdmin

Semua fitur di bagian ini diuji dengan SSH dan Proxmox **tiruan**; **[belum diuji di VM nyata]**. Uji satu per satu di VM percobaan sebelum diandalkan.

- **Siapkan database untuk situs** (Situs Web): membuat database + user khusus (password acak, tampil sekali) dan mengisi `DB_*` di `.env` (Laravel; situs PHP biasa hanya bila `.env` sudah ada). Nama dibuat dari domain, bisa diubah.
- **Peringatan SQL berbahaya**: file `.sql` dipindai di browser sebelum diunggah. Bila berisi `DROP DATABASE/TABLE`, `TRUNCATE`, `CREATE DATABASE`, atau `USE`, pengguna harus mengetik nama database. Server juga mencatat jenis perintah itu di audit log dan memberi tahu admin untuk perintah yang menghapus data.
- **Jadwal & Worker**: cron di `/etc/cron.d/panelvm-<nama>` dan worker (mis. `queue:work`) sebagai unit systemd `panelvm-worker-<nama>.service`, semuanya sebagai `www-data`. Perintah dibatasi karakter aman (tanpa tanda kutip, `$`, `;`, `|`, `&`, `<`, `>`); untuk perintah rumit, buat skrip lalu panggil skripnya. Butuh paket `cron` (menu Aplikasi) untuk cron.
- **App Node/Python**: service systemd `panelvm-app-<nama>.service` + Nginx sebagai reverse proxy ke `127.0.0.1:<port>` (3001-3999, otomatis). Variabel `PORT` disediakan; variabel lain lewat `/var/www/<domain>/.env`. Hanya Nginx (Apache belum didukung). Butuh Node.js atau Python dari menu Aplikasi (versi mengikuti repositori OS).
- **phpMyAdmin**: dipasang di `/opt/phpmyadmin` (unduhan resmi + verifikasi SHA-256), dilayani Nginx **hanya di 127.0.0.1:8091 VM**, dibuka lewat tombol di halaman Database (tiket sekali pakai 60 detik, cookie akses 12 jam di host preview). Login memakai user database biasa; `root` dan password kosong dilarang. Syarat: Nginx, PHP-FPM, curl, `PREVIEW_BASE_DOMAIN`, dan modul Preview Web aktif untuk VM. URL unduhan memakai alamat "latest" resmi phpMyAdmin dan struktur folder rilis dideteksi otomatis; **periksa hasil pemasangan pertama dengan teliti**.
- **Mode Maintenance** (admin, menu Maintenance): non-admin melihat layar pemeliharaan dan API menjawab 503; admin tetap bekerja. Tersimpan di database sehingga bertahan saat panel di-restart. Saat panel benar-benar mati (restart), Nginx Proxy Manager menjawab 502; untuk halaman cantik pada kondisi itu, atur `error_page 502 503 504` di NPM (belum disiapkan di repo).
- **Batas situs per client** (Kelola Pengguna, kolom Situs web) dan **sesi login 24 jam** (idle dan absolut).

## Yang masih harus diverifikasi di lingkungan nyata

Daftar jujur hal yang **belum** teruji di lingkungan pengembangan:

1. Jaringan: firewall Proxmox/MikroTik, isolasi VM client dari VM panel dan host Proxmox, NPM + HTTPS + WebSocket di belakang domain asli.
2. systemd nyata: unit `panelvm.service`/backup timer, service manager (hanya diuji dengan `systemctl` palsu).
3. Debian nyata dan versi lain: repositori PHP Sury, MySQL Oracle, MariaDB selain 10.11, PostgreSQL selain 16, perilaku autentikasi root database.
4. Laravel asli dengan dependensi Packagist.
5. Perilaku `TRUST_PROXY` dengan NPM Anda (uji dengan header palsu dari luar lalu pastikan IP di audit log benar).
6. Pen-test oleh pihak independen (belum ada).
7. Preview web: Cloudflare Tunnel dengan hostname wildcard, HMR Vite lewat Cloudflare, dan `sshd` asli dengan `AllowTcpForwarding` (lihat bagian Preview web).
