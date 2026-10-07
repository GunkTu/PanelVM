# Deploy

Daftar ini harus diverifikasi di lingkungan nyata. Bagian yang belum diuji ditandai **[belum diuji]**.

## Konfigurasi yang sudah ditetapkan pemilik

- Domain panel: `vm.thegt.my.id` (jadi `APP_ORIGIN=https://vm.thegt.my.id`).
- IP publik tetap; trafik lewat router MikroTik (L2TP) menuju Nginx Proxy Manager.
- SMTP: **tidak dipakai** (keputusan pemilik). Semua notifikasi lewat notification center di panel (akun baru, login perangkat baru, proses selesai/gagal, aksi berisiko). Variabel `SMTP_*` di `.env.example` boleh dikosongkan.
- Retensi audit log: **90 hari** (bawaan), ubah lewat `AUDIT_RETENTION_DAYS` (minimal 7). Pembersihan jalan otomatis tiap hari. Job lama (30 hari) dan notifikasi terbaca (90 hari) juga dibersihkan.
- Versi OS dan database tiap VM: **dideteksi panel** dari VM (tidak diasumsikan). Database dipasang dari panel lewat menu Aplikasi (lihat di bawah).

## Menjalankan panel (VM panel)

```
cp .env.example .env     # isi SECRETS_MASTER_KEY dan SESSION_SECRET, jangan commit
chmod 600 .env
npm ci
npm run build
npm run db:migrate
npm run create-admin     # interaktif; 2FA diaktifkan saat login pertama
npm run start -w @panelvm/server
```

- Jalankan sebagai user non-root lewat systemd. File DB dibuat dengan izin 0600 dan foldernya 0700.
- Buat kunci: `openssl rand -base64 32` (master key) dan `openssl rand -base64 48` (session secret).
- **Backup `SECRETS_MASTER_KEY` terpisah dari backup DB.** Tanpa kunci ini, kunci SSH tiap VM tidak bisa didekripsi.
- Produksi (`NODE_ENV=production`): server menyajikan SPA dari `apps/web/dist` pada origin yang sama dan memakai cookie `__Host-sid` (wajib HTTPS).

## Nginx Proxy Manager

- Proxy host `vm.thegt.my.id` ke `http://<IP VM panel>:3000`.
- Aktifkan **Websockets Support** (terminal memakai WebSocket), SSL Let's Encrypt, dan Force SSL.
- Set `TRUST_PROXY=true` hanya bila panel hanya bisa dijangkau lewat NPM. Jika port 3000 bisa diakses langsung dari jaringan lain, header `X-Forwarded-For` bisa dipalsukan dan rate limit/audit IP jadi tidak andal.
- Antarmuka admin NPM (port 81) jangan terbuka ke internet.

## Firewall (Proxmox/VLAN/MikroTik) **[belum diuji]**

- VM panel hanya menerima dari NPM, dan hanya keluar ke port SSH VM target.
- VM client tidak boleh menjangkau VM panel, port 8006 Proxmox, maupun SSH host Proxmox. Uji dari dalam VM client.
- Karena IP publik tetap dan akses lewat L2TP di MikroTik, pastikan hanya port 443 (ke NPM) yang diteruskan ke luar.

## Menambah VM

1. Admin: Kelola VM, Tambah VM. Panel membuat kunci SSH ed25519 khusus VM itu.
2. Pasang public key yang tampil ke `~/.ssh/authorized_keys` user SSH di VM.
3. Pindai host key, cocokkan fingerprint dengan `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` di VM, lalu setujui.
4. Tes koneksi, lalu hubungkan ke client.

Bila fingerprint berubah, koneksi ditolak sampai admin menyetujui ulang.
Akses darurat tetap lewat Proxmox console bila kunci SSH panel terhapus oleh client.

## Aplikasi (installer ala cPanel)

Menu **Aplikasi** memasang software di VM dengan satu klik, dengan log berjalan langsung dan notifikasi saat selesai.

- Yang didukung: OS **Debian dan Ubuntu**. Panel membaca `/etc/os-release` dan tidak berasumsi.
- Katalog tetap: alat dasar (unzip, zip, curl, git, rsync), Nginx, PHP-FPM (banyak versi berdampingan, ekstensi umum Laravel + opsional redis/imagick/soap/gmp/ldap bila tersedia), Composer (installer resmi dengan verifikasi checksum SHA-384), MariaDB, MySQL, PostgreSQL (versi dipilih dari yang ditemukan), Redis. Nama paket hanya dari daftar tetap atau template dengan versi yang divalidasi dan harus ada di repositori VM.
- **Versi mengikuti repositori OS di VM.** Contoh: Ubuntu 24.04 menyediakan PHP 8.3 dan MariaDB 10.11 (terlihat di uji). Debian dan Ubuntu hanya punya satu versi PHP bawaan.
- **Repositori PHP tambahan (Ondřej Surý)** untuk banyak versi PHP: opsional, butuh persetujuan eksplisit di UI karena menambah sumber paket pihak ketiga yang berjalan sebagai root saat dipasang. Ubuntu memakai PPA `ppa:ondrej/php`. Debian memakai paket keyring `debsuryorg-archive-keyring` dari packages.sury.org. **[belum diuji di Debian/Ubuntu nyata]**: langkah ini dibuat dari dokumentasi sekunder, bukan dari uji langsung, dan gagal dengan pesan jelas bila keyring/URL berubah. Verifikasi manual sebelum diandalkan.
- Repositori vendor untuk versi database tertentu (MySQL 8.4 dari dev.mysql.com, MariaDB dari mariadb.org, PGDG) **belum** ada: versi database mengikuti repositori OS. Menambahnya butuh keputusan Anda (sumber paket tambahan).
- MySQL dan MariaDB tidak bisa dipasang bersamaan (panel menolak dengan pesan jelas). Hanya satu proses instalasi per VM pada satu waktu (apt memakai lock).
- Pengelolaan database dari panel (buat/hapus database dan user, hak akses, import/export, query editor) saat ini untuk MySQL/MariaDB. PostgreSQL bisa dipasang tetapi pengelolaannya menyusul (Fase 3).

### Autentikasi root MySQL/MariaDB

Panel menjalankan klien `mariadb`/`mysql` sebagai user SSH (disarankan `root`) lewat unix socket, tanpa password di argumen. Teruji pada **MariaDB 10.11 di Ubuntu 24.04** (root lewat socket). Versi/distro lain **[belum diuji]**: bila root database memakai password, panel menampilkan pesan "root DB butuh password" dan tidak mengelola database itu sampai root diatur memakai `unix_socket`/`auth_socket`. Hasil deteksi flavor (MySQL vs MariaDB) dan versi ditampilkan di halaman Database.

User database dibuat untuk host `localhost` dan `127.0.0.1` sekaligus agar aplikasi di VM yang sama bisa memakai `DB_HOST=127.0.0.1` maupun socket. Password dibuat panel (24 karakter acak), ditampilkan **sekali**, dan tidak disimpan.

## Situs web dan deploy kode

Menu **Situs Web** membuat server block Nginx per domain dan men-deploy kode:

- Jenis: **Laravel** (document root `public/`, `try_files` ke `index.php`), **PHP** biasa/framework lain (CodeIgniter, WordPress, dll), dan **statis** (HTML/hasil build).
- Struktur di VM: `/var/www/<domain>`, konfigurasi `/etc/nginx/sites-available/<domain>.conf` (+ symlink ke `sites-enabled`), PHP-FPM lewat socket `/run/php/php<versi>-fpm.sock`. Konfigurasi diuji `nginx -t` sebelum dimuat ulang dan dibatalkan otomatis bila ditolak.
- Nginx di VM mendengarkan **port 80** saja. Arahkan domain di **Nginx Proxy Manager** ke `IP-VM:80` (SSL diurus NPM). Jangan buka port 80 VM ke internet langsung bila tidak perlu.
- Deploy dari **arsip** (.zip/.tar.gz/.tgz/.tar, unggah streaming) atau dari **Git publik** (https tanpa kredensial; repositori privat: unggah arsip). Arsip yang berisi satu folder pembungkus diratakan otomatis; `__MACOSX` diabaikan.
- Preset Laravel: membuat folder tulis (`storage/*`, `bootstrap/cache`), `.env` dari `.env.example` bila belum ada, `composer install --no-dev --optimize-autoloader` (opsional), `APP_KEY` bila kosong, `storage:link`, migrasi (opsional, tidak otomatis), cache konfigurasi (opsional), pemilik file `www-data`, dan muat ulang PHP-FPM.
- **Update** tidak menimpa `.env` dan isi `storage/app` + `storage/logs`. Edit `.env` lewat tombol "Edit .env" (membuka editor File Manager).
- Tombol **Artisan** hanya menjalankan perintah dari daftar tetap (migrate, migrate:status, db:seed, optimize, optimize:clear, cache:clear, config:clear, storage:link, queue:restart, key:generate).
- Node.js/Python (proses panjang, reverse proxy) **belum** didukung; hanya PHP dan statis.
- Nginx memakai server block pertama untuk Host yang tidak dikenal. Pasang situs default (bawaan paket Debian) atau pastikan NPM hanya meneruskan domain yang Anda daftarkan.

## Menjalankan test integrasi (VM uji nyata)

Suite integrasi (file manager, database, installer, situs) berjalan terhadap sshd, MariaDB, Nginx, dan PHP-FPM sungguhan dan **dilewati otomatis** bila tidak tersedia:

```
sudo apps/server/test/integration/setup-test-vm.sh /tmp/panel-test-vm   # sekali, mesin sekali pakai
PANEL_TEST_SSH_PORT=2222 PANEL_TEST_AUTHORIZED_KEYS=/tmp/panel-test-vm/authorized_keys npm test
```

Test negatif lintas akun (IDOR) untuk semua modul selalu jalan tanpa VM nyata.

## Backup

SQLite panel (gunakan `sqlite3 .backup`, bukan salin file saat berjalan) dan snapshot Proxmox. **[belum diatur]**
