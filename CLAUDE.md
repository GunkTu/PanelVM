# CLAUDE.md: Panel Multi-VM Internal (Proxmox)

File ini dibaca otomatis oleh Claude Code di awal sesi. Ikuti isinya. Jika ada konflik antara file ini dan permintaan di chat, tanyakan dulu ke pemilik proyek sebelum melanggar aturan keamanan di bagian 5.

Dokumen produk lengkap ada di `docs/PRD.md`. Baca sebelum mengerjakan fitur baru.

---

## 1. Ringkasan Proyek

Satu aplikasi web untuk mengakses beberapa VM Linux (Debian/Ubuntu) di Proxmox lewat browser.

- Admin (pemilik proyek) mendaftarkan VM dan membuat akun client.
- Setiap client terhubung ke tepat 1 VM dan mendapat: terminal web, file manager (SFTP), database manager (MySQL default, PostgreSQL opsional), notifikasi sistem.
- Pengguna hanya teman dan kerabat pemilik. Tidak ada registrasi publik, billing, atau multi-tenant skala besar.
- Jumlah VM saat ini: 2. Panel berjalan di VM khusus (bukan di VM client) pada Proxmox yang sama, diakses publik lewat Nginx Proxy Manager (NPM).
- Client punya akses root penuh, hanya di dalam VM miliknya.

**Aplikasi ini adalah pintu masuk ke akses root semua VM. Keamanan lebih penting daripada kecepatan pengerjaan fitur.**

## 2. Di Luar Cakupan v1 (jangan dibangun kecuali diminta)

- Billing, registrasi mandiri, sub-user
- Pembuatan VM otomatis lewat Proxmox API (ini P2)
- Dukungan Windows/RDP
- Mobile app
- Arsitektur agent di dalam VM (v1 memakai agentless SSH dari server panel)

## 3. Tech Stack

Versi paket harus dicek ke registry saat instalasi. Jangan menebak nomor versi dari ingatan. Gunakan versi stabil terbaru yang kompatibel dengan Node LTS yang terpasang.

| Lapisan | Pilihan |
|---|---|
| Runtime | Node.js LTS, TypeScript strict |
| Backend | Fastify, `@fastify/websocket`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/csrf-protection` (atau mekanisme CSRF setara) |
| SSH/SFTP | `ssh2` |
| Validasi | `zod` untuk semua input (body, query, params, pesan WebSocket) |
| Password hash | `argon2` (varian argon2id) |
| 2FA | TOTP (`otplib` atau setara) |
| Database panel | SQLite lewat `better-sqlite3`, migrasi lewat skrip SQL berurutan |
| Frontend | React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query |
| Terminal UI | `@xterm/xterm` + addon fit dan web-links |
| Email | `nodemailer` (SMTP dikonfigurasi lewat env) |
| Test | Vitest (unit dan integrasi), Playwright (E2E, fase akhir) |
| Lint/format | ESLint + Prettier |

Jika ingin mengganti library, jelaskan alasannya dulu dan minta persetujuan.

## 4. Struktur Folder

```
.
├── CLAUDE.md
├── docs/
│   ├── PRD.md
│   ├── SECURITY.md          # catatan keamanan dan hasil uji manual
│   └── DEPLOY.md            # setup VM panel, NPM, firewall
├── apps/
│   ├── server/              # Fastify API + WebSocket gateway
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config/      # env loader tervalidasi (zod)
│   │   │   ├── db/          # koneksi, migrations/, repositori
│   │   │   ├── auth/        # login, sesi, 2FA, lockout
│   │   │   ├── rbac/        # guard otorisasi (cek kepemilikan VM)
│   │   │   ├── modules/
│   │   │   │   ├── vms/
│   │   │   │   ├── users/
│   │   │   │   ├── terminal/
│   │   │   │   ├── files/
│   │   │   │   ├── databases/   # driver per engine: mysql.ts, postgres.ts
│   │   │   │   ├── monitoring/
│   │   │   │   ├── services/
│   │   │   │   └── notifications/
│   │   │   ├── ssh/         # pool koneksi, verifikasi host key
│   │   │   ├── crypto/      # enkripsi AES-256-GCM untuk secret
│   │   │   ├── audit/
│   │   │   └── scripts/     # create-admin.ts, rotate-key.ts
│   │   └── test/
│   └── web/                 # React SPA
│       └── src/
│           ├── components/  # design system (Button, Toast, Modal, dll)
│           ├── features/    # auth, vms, terminal, files, databases, admin
│           ├── hooks/
│           ├── lib/
│           └── styles/
├── .env.example
└── package.json             # workspace (pnpm atau npm workspaces)
```

## 5. Aturan Keamanan (WAJIB, tidak boleh dilanggar)

Panel ini terbuka ke internet lewat NPM. Perlakukan setiap input sebagai tidak tepercaya.

### 5.1 Autentikasi dan sesi
- Tidak ada endpoint registrasi publik. Admin pertama dibuat lewat skrip CLI `scripts/create-admin.ts`. Client dibuat oleh admin.
- Password di-hash dengan argon2id. Panjang minimal 12 karakter.
- 2FA TOTP **wajib** untuk semua akun, termasuk admin. Simpan secret TOTP terenkripsi. Sediakan recovery code sekali pakai (di-hash).
- Rate limiting pada login, verifikasi 2FA, dan reset password. Lockout sementara setelah percobaan gagal berulang. Pesan error login tidak boleh membedakan "email tidak ada" dan "password salah".
- Sesi berbasis cookie `HttpOnly`, `Secure`, `SameSite=Strict` (atau `Lax` jika terbukti perlu). Token sesi acak panjang, disimpan sebagai hash di DB, dengan idle timeout dan absolute timeout.
- Perlindungan CSRF untuk semua request yang mengubah state.
- Deteksi login dari perangkat/IP baru: catat dan kirim notifikasi email.
- Aktifkan `trustProxy` di Fastify dengan benar karena ada NPM di depan. IP klien untuk rate limit dan audit harus diambil dari header proxy yang tepercaya saja.

### 5.2 Otorisasi (cegah IDOR)
- Setiap endpoint dan setiap pesan WebSocket yang menyentuh VM wajib memanggil guard `assertVmAccess(user, vmId, module)` sebelum melakukan apa pun.
- Client hanya boleh mengakses VM yang terhubung ke akunnya. Jangan pernah mempercayai `vmId` dari request tanpa pengecekan.
- Admin dan client dibedakan oleh role di server, bukan oleh flag dari frontend.
- Setiap kali menambah endpoint baru, tambahkan test negatif: user A mencoba mengakses sumber daya user B, hasilnya harus 403/404.
- Akun yang di-suspend harus kehilangan akses langsung, termasuk memutus sesi terminal yang sedang berjalan.

### 5.3 Kredensial VM
- Kunci SSH privat VM disimpan terenkripsi (AES-256-GCM, nonce unik per enkripsi) di database panel. Master key dari environment variable atau file di luar repo.
- Kredensial **tidak pernah** dikirim ke browser, tidak masuk log, tidak masuk pesan error, tidak masuk audit log.
- Gunakan kunci SSH khusus panel per VM. Utamakan autentikasi kunci, bukan password.
- Verifikasi host key SSH: simpan fingerprint saat pertama kali terhubung (setelah konfirmasi admin), dan tolak koneksi jika fingerprint berubah sampai admin menyetujui ulang. Jangan menonaktifkan verifikasi host key.

### 5.4 Pencegahan injeksi
- **Dilarang** membangun perintah shell dengan menggabungkan string dari input user.
- Perintah yang dijalankan lewat SSH exec harus berupa daftar argumen tetap (whitelist). Data dinamis dikirim lewat stdin atau di-quote dengan fungsi escape yang diuji, bukan interpolasi mentah.
- Nama database dan user MySQL/PostgreSQL divalidasi dengan regex ketat, misalnya `^[a-z][a-z0-9_]{2,31}$`, dan dicek terhadap daftar nama terlarang (`mysql`, `information_schema`, `performance_schema`, `sys`, `root`, `postgres`, dan sejenisnya).
- Password database tidak boleh muncul di argumen perintah (terlihat di `ps`). Kirim lewat stdin atau file opsi sementara dengan permission ketat yang dihapus sesudahnya.
- Semua query ke SQLite panel memakai parameter binding. Tidak ada SQL hasil concatenation.
- Path file manager dinormalisasi di sisi server. Karena client memang root di VM-nya, tujuan pengecekan path di sini adalah mencegah kebingungan dan serangan lintas VM, bukan membatasi root.

### 5.5 WebSocket (terminal)
- Autentikasi memakai sesi cookie saat handshake. Validasi header `Origin` terhadap domain panel yang diizinkan.
- Validasi setiap pesan masuk dengan zod (tipe: input, resize, ping). Batasi ukuran pesan.
- Batasi jumlah sesi terminal bersamaan per user dan per VM. Tutup sesi idle.
- Saat sesi diputus (logout, suspend, timeout), tutup koneksi SSH di belakangnya.

### 5.6 Header dan transport
- `@fastify/helmet` aktif dengan CSP ketat (tanpa `unsafe-inline` untuk script). Izinkan hanya yang dibutuhkan xterm dan aset sendiri.
- Aplikasi berasumsi HTTPS dari NPM. HSTS diatur di NPM atau di aplikasi setelah HTTPS stabil.
- CORS: default tertutup. Frontend disajikan dari origin yang sama dengan API bila memungkinkan.

### 5.7 Audit log
Catat: login berhasil/gagal, 2FA, perubahan akun, pembuatan/penghapusan VM, pembukaan dan penutupan sesi terminal, aksi file (upload, hapus, ubah permission, edit), aksi database (buat, hapus, import, export), perubahan konfigurasi modul. Setiap entri: waktu, user, IP, VM, aksi, hasil. Audit log bersifat append-only dari sisi aplikasi. **Jangan** mencatat isi file, password, atau isi keystroke terminal.

### 5.8 Dependensi dan rahasia
- Jangan commit `.env`, kunci, atau master key. Pastikan `.gitignore` mencakupnya sejak awal.
- Setiap menambah dependensi baru: sebutkan nama, fungsi, dan alasan. Jangan menambah paket yang tidak diperlukan. Jalankan `npm audit` (atau setara) secara berkala dan laporkan hasilnya.
- Jangan pernah mencetak secret ke console, log, atau test snapshot.

## 6. Model Data (SQLite panel)

Rancangan awal. Boleh disesuaikan lewat migrasi, tetapi beri tahu alasannya.

- `users`: id, email (unik), password_hash, role (`admin` | `client`), status (`active` | `suspended`), totp_secret_enc, totp_enabled, created_at, last_login_at
- `recovery_codes`: id, user_id, code_hash, used_at
- `sessions`: id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at
- `vms`: id, name, host, ssh_port, ssh_user, ssh_private_key_enc, host_key_fingerprint, status, modules_enabled (JSON: terminal, files, database, monitoring, services), created_at
- `vm_access`: id, user_id, vm_id, role, **UNIQUE(vm_id)** (satu VM hanya untuk satu client saat ini; constraint ini sengaja dipisah di tabel agar mudah dilonggarkan nanti)
- `db_instances`: id, vm_id, engine (`mysql` | `postgres`), is_default
- `notifications`: id, user_id, type, title, message, read_at, created_at
- `audit_logs`: id, ts, user_id, vm_id, ip, action, target, result, meta (JSON tanpa data sensitif)

## 7. Modul Fitur: Catatan Implementasi

### 7.1 Terminal
- Browser (xterm.js) <-> WebSocket <-> server <-> `ssh2` `shell()` dengan PTY.
- Dukung resize, copy-paste, multi-tab (satu koneksi WS per tab), auto-reconnect di sisi UI dengan indikator status jelas.
- Tema terminal gelap.

### 7.2 File Manager
- Berbasis SFTP lewat `ssh2`. Fitur: browse, upload (stream, bukan buffer penuh di memori), download (stream), buat folder, rename, hapus (dengan konfirmasi), ubah permission, edit file teks (batasi ukuran, deteksi file biner), compress/extract jika memungkinkan.
- Batasi ukuran upload dan beri progress bar.

### 7.3 Database Manager
- Arsitektur driver per engine: interface `DbDriver` dengan implementasi `MysqlDriver` (default, v1) dan `PostgresDriver` (tahap berikutnya).
- Operasi: daftar database, buat/hapus database, buat/hapus user, atur privilege, import `.sql`, export (dump), query editor sederhana.
- Perilaku autentikasi root MySQL berbeda antara MySQL dan MariaDB serta antar versi Debian/Ubuntu. **Jangan berasumsi.** Deteksi dulu di VM (`mysql --version`, cek socket auth) dan tulis catatan hasilnya di `docs/DEPLOY.md`.
- Kredensial database baru ditampilkan satu kali ke client, tidak disimpan dalam bentuk plaintext.
- Aksi destruktif (hapus database/user) butuh konfirmasi dengan mengetik nama resource.

### 7.4 Monitoring dan Service (P1)
- CPU, RAM, disk, uptime lewat perintah baca-saja yang tetap (whitelist).
- Daftar service systemd, start/stop/restart, lihat log `journalctl` dengan batas baris.

### 7.5 Notifikasi
- Toast in-app: sukses (hijau), error (merah), peringatan (kuning), info (biru). Auto-dismiss untuk sukses/info, error tetap sampai ditutup.
- Notification center dengan status baca.
- Email: akun baru, login perangkat baru, VM offline, aksi berisiko.
- Setiap pesan error harus menyebutkan **apa yang terjadi** dan **langkah berikutnya**. Dilarang pesan generik seperti "Terjadi kesalahan".
- Jangan membocorkan detail internal (stack trace, path server, kredensial) ke pesan error pengguna. Detail teknis hanya di log server.

## 8. Panduan UI/UX

**Design tokens** (definisikan sebagai CSS variables / Tailwind theme):

| Token | Nilai |
|---|---|
| `--navy` (primer) | `#0B1F4B` |
| `--navy-dark` | tentukan satu tingkat lebih gelap untuk hover/aktif |
| `--white` | `#FFFFFF` |
| `--yellow` (aksen) | `#F5B700` |
| Abu netral | skala slate/gray untuk teks sekunder dan border |
| Success / Error / Warning / Info | hijau / merah / kuning / biru |

Aturan:
- Sidebar dan header berwarna biru tua, area konten putih, tombol aksi utama kuning dengan **teks biru tua**. Jangan pakai teks kuning di atas latar putih (kontras rendah). Periksa kontras sesuai WCAG AA.
- Layout: sidebar kiri (nama VM aktif di atas), konten di tengah, ikon notifikasi di kanan atas.
- UX halus: skeleton loading, transisi singkat, tidak ada reload halaman penuh, state loading/kosong/error dirancang di setiap layar.
- Status VM (online/offline) dan status koneksi terminal selalu terlihat.
- Tablet didukung. Terminal di ponsel bukan prioritas v1.
- Semua teks antarmuka dalam Bahasa Indonesia, kecuali istilah teknis yang lazim.
- Buat komponen reusable di `components/` (Button, Input, Modal, ConfirmDialog, Toast, Table, Badge, Skeleton) sebelum membuat layar.

## 9. Konfigurasi dan Environment

Semua konfigurasi lewat env, divalidasi zod saat startup (gagal cepat jika kurang). Sediakan `.env.example` tanpa nilai rahasia sungguhan.

```
NODE_ENV=production
PORT=3000
APP_ORIGIN=https://panel.contoh.com
DATABASE_PATH=/var/lib/panel/panel.db
SECRETS_MASTER_KEY=           # 32 byte, base64; JANGAN commit
SESSION_SECRET=               # acak panjang; JANGAN commit
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
TRUST_PROXY=true
```

## 10. Perintah Umum

Sesuaikan jika skrip di `package.json` berbeda. Perbarui bagian ini begitu skrip final.

```
npm install                 # instal dependensi workspace
npm run dev                 # jalankan server dan web (development)
npm run build               # build produksi
npm run test                # unit + integrasi
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit
npm run db:migrate          # jalankan migrasi
npm run create-admin        # buat admin pertama (interaktif)
```

## 11. Cara Bekerja (Alur untuk Claude Code)

1. **Rencanakan dulu.** Untuk setiap fase atau fitur besar, tulis rencana singkat (file yang akan disentuh, risiko keamanan, cara uji) dan tunggu persetujuan sebelum menulis kode banyak.
2. **Kerjakan per langkah kecil**, satu fitur per commit. Pesan commit jelas (misalnya `feat(auth): tambah verifikasi TOTP`).
3. **Test dulu atau bersamaan.** Fitur dianggap belum selesai tanpa test. Untuk keamanan, wajib ada test negatif (akses lintas user, input berbahaya, sesi kedaluwarsa).
4. **Definisi selesai (Definition of Done):**
   - `npm run typecheck`, `npm run lint`, `npm run test` lolos
   - Tidak ada secret di kode atau log
   - Otorisasi dicek di setiap endpoint baru
   - Pesan error pengguna sudah jelas dan berbahasa Indonesia
   - Audit log tercatat untuk aksi sensitif
   - Dokumentasi singkat di `docs/` diperbarui bila ada perubahan perilaku
5. **Jujur soal ketidakpastian.** Jika tidak yakin tentang API library, perilaku MySQL/MariaDB di Debian/Ubuntu, atau konfigurasi jaringan, katakan dan cek dokumentasi resmi atau uji langsung. Jangan mengarang nama fungsi atau opsi.
6. **Jangan menjalankan perintah destruktif** (hapus data, drop database, `rm -rf`, force push) tanpa konfirmasi eksplisit.
7. **Jangan mengubah file di luar cakupan tugas.** Jika menemukan masalah di tempat lain, laporkan dulu.

## 12. Urutan Fase Pengerjaan

**Fase 0: Fondasi**
Setup monorepo, TypeScript, lint, test, struktur folder, `.env.example`, design tokens, komponen dasar UI.

**Fase 1: Inti dan Terminal**
Migrasi DB, auth (login, sesi, argon2id), 2FA TOTP + recovery code, rate limit/lockout, RBAC + guard VM, audit log, CRUD VM (enkripsi kredensial, verifikasi host key, tes koneksi), manajemen client dan assign VM, terminal web.
*Kriteria selesai:* admin membuat client, client login dengan 2FA dan membuka terminal ke VM miliknya saja; uji lintas akun gagal akses; suspend memutus sesi.

**Fase 2: File dan Database**
File manager SFTP, database manager MySQL (driver pertama), notifikasi lengkap (toast, center, email).
*Kriteria selesai:* alur upload/edit/download berjalan, buat database + user berjalan dengan validasi nama ketat, tidak ada interpolasi shell mentah.

**Fase 3: Penyempurnaan**
Monitoring, service manager, driver PostgreSQL + pilihan engine, hardening, review keamanan, `docs/SECURITY.md` dan `docs/DEPLOY.md`.

**Opsional (P2):** integrasi Proxmox API untuk start/stop/reboot VM.

## 13. Catatan Deployment (untuk `docs/DEPLOY.md`)

Ini daftar yang harus diverifikasi dan didokumentasikan di lingkungan nyata, bukan klaim bahwa semuanya sudah benar.

- NPM: aktifkan SSL (Let's Encrypt), Force SSL, **Websockets Support** untuk proxy host panel. Antarmuka admin NPM (port 81) jangan terbuka ke internet.
- Firewall Proxmox/VLAN: VM panel hanya menerima dari NPM dan hanya keluar ke port SSH VM target. VM client tidak boleh menjangkau VM panel, port 8006 Proxmox, maupun SSH host Proxmox. Uji dari dalam VM client.
- Jalankan aplikasi sebagai user non-root di VM panel (misalnya via systemd), dengan permission ketat pada file DB dan master key.
- Backup rutin SQLite panel dan snapshot Proxmox.
- Akses darurat ke VM tetap lewat Proxmox console jika kunci SSH panel terhapus oleh client.
- Pertimbangkan VPN atau tunnel untuk mengurangi paparan publik. Keputusan ada pada pemilik proyek.

## 14. Hal yang Harus Ditanyakan ke Pemilik Proyek Sebelum Lanjut

Jika salah satu belum terjawab saat mengerjakan fitur terkait, berhenti dan tanyakan:
- Domain dan origin final panel (untuk cookie, CSP, validasi Origin)
- Penyedia SMTP untuk email notifikasi
- Versi OS dan database persis di tiap VM (Debian/Ubuntu versi berapa, MySQL atau MariaDB)
- Apakah IP publik tetap atau dinamis, dan bagaimana trafik menuju NPM
- Kebijakan retensi audit log
