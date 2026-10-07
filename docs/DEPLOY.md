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
7. **systemd**: salin `deploy/panelvm.service`, `deploy/panelvm-backup.service`, `deploy/panelvm-backup.timer` ke `/etc/systemd/system/`, lalu `systemctl daemon-reload && systemctl enable --now panelvm panelvm-backup.timer`. Cek hardening dengan `systemd-analyze security panelvm.service`. **[belum diuji di systemd nyata]** (sintaks terverifikasi dengan `systemd-analyze verify`).
8. **NPM**: lihat bagian berikut.
9. **Firewall**: lihat bagian berikut.
10. **Uji penerimaan**: login dengan 2FA, buat VM + setujui host key, buka terminal, uji isolasi (client A tidak bisa membuka VM B), suspend akun, dan uji dari **dalam VM client** bahwa VM panel/Proxmox tidak terjangkau.

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
- Nginx di VM mendengarkan **port 80**; arahkan domain di NPM ke `IP-VM:80` (SSL diurus NPM). Nginx memakai server block pertama untuk Host yang tidak dikenal; jaga agar NPM hanya meneruskan domain yang Anda daftarkan.
- Deploy dari **arsip** (.zip/.tar.gz/.tgz/.tar, unggah streaming) atau **Git publik** (https tanpa kredensial; repositori privat: unggah arsip). Preset Laravel: folder tulis, `.env` dari `.env.example`, `composer install --no-dev`, `APP_KEY`, `storage:link`, migrasi/optimize (opsional), pemilik `www-data`, reload PHP-FPM. Update tidak menimpa `.env` dan `storage/app`/`storage/logs`. Teruji dengan proyek Laravel **tiruan** (artisan + composer.json tanpa dependensi); **[belum diuji]** dengan Laravel asli yang menarik dependensi dari Packagist.
- Node.js/Python (proses panjang, reverse proxy) belum didukung.

### Monitoring dan Service

- Monitoring: satu skrip statis baca-saja (`/proc`, `df`, `ps`); CPU diukur dari dua sampel `/proc/stat` selang 1 detik; UI memperbarui tiap 5 detik.
- Service manager (systemd): `list-units`, `start/stop/restart/reload/enable/disable`, dan `journalctl` (maks. 500 baris). Layanan sistem (`ssh`, `sshd`, `dbus`, `systemd-*`, `networking`, `NetworkManager`) dilindungi: hanya `reload`. **[belum diuji di systemd nyata]**: sandbox pengembangan tidak memakai systemd, jadi integrasi diuji dengan `systemctl`/`journalctl` **palsu** di VM nyata, dan parser diuji dengan format keluaran sesuai dokumentasi systemd. Verifikasi di satu VM nyata sebelum diandalkan.

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

## Yang masih harus diverifikasi di lingkungan nyata

Daftar jujur hal yang **belum** teruji di lingkungan pengembangan:

1. Jaringan: firewall Proxmox/MikroTik, isolasi VM client dari VM panel dan host Proxmox, NPM + HTTPS + WebSocket di belakang domain asli.
2. systemd nyata: unit `panelvm.service`/backup timer, service manager (hanya diuji dengan `systemctl` palsu).
3. Debian nyata dan versi lain: repositori PHP Sury, MySQL Oracle, MariaDB selain 10.11, PostgreSQL selain 16, perilaku autentikasi root database.
4. Laravel asli dengan dependensi Packagist.
5. Perilaku `TRUST_PROXY` dengan NPM Anda (uji dengan header palsu dari luar lalu pastikan IP di audit log benar).
6. Pen-test oleh pihak independen (belum ada).
