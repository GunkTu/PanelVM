# Deploy

Daftar ini harus diverifikasi di lingkungan nyata. Bagian yang belum diuji ditandai **[belum diuji]**.

## Konfigurasi yang sudah ditetapkan pemilik

- Domain panel: `vm.thegt.my.id` (jadi `APP_ORIGIN=https://vm.thegt.my.id`).
- IP publik tetap; trafik lewat router MikroTik (L2TP) menuju Nginx Proxy Manager.
- SMTP: **belum ditentukan**. Email notifikasi (akun baru, login perangkat baru, VM offline) ditunda sampai SMTP dipilih. Notifikasi in-app sudah aktif.
- Versi OS dan database tiap VM: **belum ditentukan**. Rencana: database diinstal dari panel (lihat "Instalasi database dari panel" di bawah).

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

## Instalasi database dari panel (rencana Fase 2)

Permintaan pemilik: client bisa memasang database (MySQL/MariaDB/PostgreSQL) dari panel dengan versi pilihan. Rencana implementasi:

- Panel mendeteksi OS VM (`/etc/os-release`) dan versi paket yang tersedia (`apt-cache policy`), lalu menampilkan pilihan yang benar-benar ada di repositori VM tersebut.
- Instalasi memakai perintah apt berdaftar putih dengan nama paket dari daftar tetap (bukan input bebas), non-interaktif, dengan output ditampilkan ke pengguna.
- Versi tertentu di luar repositori bawaan butuh repositori resmi vendor; ini keputusan tambahan yang perlu persetujuan karena menambah sumber paket.
- Perilaku autentikasi root MySQL vs MariaDB berbeda per versi; hasil deteksi dicatat di sini setelah diuji di VM nyata.

## Backup

SQLite panel (gunakan `sqlite3 .backup`, bukan salin file saat berjalan) dan snapshot Proxmox. **[belum diatur]**
