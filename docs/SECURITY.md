# Keamanan

Panel ini adalah pintu masuk ke akses root semua VM, dan terbuka ke internet lewat NPM. Dokumen ini merangkum model ancaman, kontrol yang ada beserta buktinya (test), hasil review Fase 3, dan risiko yang masih tersisa. Aturan wajib ada di `CLAUDE.md` bagian 5.

**Status:** review keamanan dilakukan sendiri oleh pengembang (bukan pihak independen). Belum ada pen-test eksternal. Jangan menganggap dokumen ini sebagai jaminan; lihat "Risiko tersisa".

## Model ancaman singkat

| Ancaman | Kontrol utama | Bukti |
|---|---|---|
| Penyerang dari internet menebak/mencuri kredensial | argon2id, password >= 12 karakter, lockout 5x/15 menit, rate limit login/2FA per IP, pesan error seragam, 2FA TOTP wajib, TOTP anti-replay atomik, recovery code argon2 sekali pakai | `test/auth.test.ts`, E2E `auth.spec.ts` |
| Pencurian sesi / CSRF / clickjacking | cookie `__Host-` `Secure` `HttpOnly` `SameSite=Strict`, token sesi acak (DB hanya menyimpan HMAC), idle 30 menit + absolut 12 jam, token CSRF terikat sesi + validasi `Origin`, CSP ketat, `frame-ancestors 'none'` | `test/auth.test.ts`, `test/security-headers.test.ts` |
| Client mengakses VM/data client lain (IDOR) | `assertVmAccess` di setiap endpoint/WS; bukan pemilik = 404; modul dimatikan = 403 (termasuk admin); role dicek di server | matriks IDOR otomatis (`test/rbac.test.ts`), E2E `isolation.spec.ts` |
| Akun disuspend masih punya akses | sesi dihapus dan terminal diputus seketika; liveness check tiap 15 detik | `test/rbac.test.ts`, E2E (terminal "Ditutup" di browser) |
| Pencurian kredensial VM | kunci SSH ed25519 per VM, AES-256-GCM (nonce unik, AAD terikat id), tidak pernah ke browser/log/audit/error, host key wajib disetujui admin dan dicek tiap koneksi | `test/secrets.test.ts`, `test/rbac.test.ts` |
| Injeksi perintah/SQL | perintah SSH = argv tetap + `shellQuote` (diuji dengan shell sungguhan), data lewat stdin, skrip shell statis; nama DB/user regex ketat + daftar terlarang; SQLite panel parameter binding | `test/shell.test.ts`, integrasi files/database/sites |
| Pemalsuan IP klien (rate limit, audit) | `TRUST_PROXY` bisa daftar IP/CIDR NPM; header dipercaya hanya dari proxy terdaftar | `test/trustproxy.test.ts` |
| Kebocoran informasi | error 500 generik, tidak ada stack/path; pino redact cookie/CSRF; password DB tidak di audit/job/notifikasi | `test/security-headers.test.ts`, test pemindaian audit/job di `databases.test.ts` |
| Kehilangan/kebocoran secret | master key terpisah dari DB, rotasi atomik teruji, DB dan backup 0600, `.env` di luar repo | `test/hardening.test.ts` |
| Penyalahgunaan terminal/unggahan | batas pesan 64 KB, maks 5 terminal per user/VM, idle 30 menit, batas upload `MAX_UPLOAD_MB`, upload streaming | `test/rbac.test.ts`, `test/integration/*` |
| Preview web disalahgunakan (XSS lintas origin, akses lintas client, link bocor) | origin preview terpisah dari panel (cookie `__Host-` tidak terkirim); host preview diambil alih sebelum hook auth sehingga `/api` di host preview menuju aplikasi, bukan panel; tujuan tunnel selalu loopback VM pemilik; kelayakan (kedaluwarsa, pemilik aktif, modul, kepemilikan VM) dicek di setiap request; alamat acak 130 bit, kedaluwarsa, bisa dicabut; pencabutan/suspend/lepas VM memutus koneksi terbuka; batas 3 preview per VM, 64 koneksi per preview; alamat tidak masuk audit log | `test/previews.test.ts` (IDOR, suspend, kedaluwarsa, `/api` di host preview) |

## Kontrol per area

- **Autentikasi:** tidak ada registrasi publik (admin awal lewat CLI). Login password lalu 2FA wajib (akun tanpa 2FA hanya bisa menyelesaikan setup). Sesi `pending` tidak bisa mengakses data. Token baru dibuat setelah 2FA (anti session fixation). Deteksi login perangkat/IP baru menghasilkan notifikasi.
- **Otorisasi:** guard auth berjalan di tahap `onRequest`, **sebelum body diparse**, sehingga permintaan tanpa sesi ditolak tanpa memproses payload. Pengecekan `Origin` dan CSRF berlaku untuk semua metode yang mengubah state pada URL apa pun yang memuat `/api` (bukan hanya yang diawali `/api/`).
- **Terminal (WebSocket):** auth + cek `Origin` + kepemilikan VM terjadi sebelum upgrade; setiap pesan divalidasi zod; backpressure; keystroke tidak pernah dicatat.
- **File manager:** SFTP; path dinormalisasi di server; folder sistem tingkat atas dilindungi dari hapus/pindah/chmod rekursif; edit teks dibatasi 1 MB + deteksi biner/non-UTF-8; unduhan selalu `attachment` + `nosniff`.
- **Database manager:** SQL lewat stdin (tidak ada password di argumen proses); password dibuat panel, tampil sekali; hapus butuh konfirmasi nama di server dan UI; aksi berisiko memberi notifikasi ke admin; isi query tidak dicatat di audit.
- **Installer/situs/deploy:** katalog tetap, versi divalidasi dan harus ada di repositori VM; repositori pihak ketiga hanya dengan persetujuan eksplisit; domain divalidasi ketat; konfigurasi nginx diuji dan di-rollback; dotfile diblokir; artisan hanya daftar tetap; Git hanya `https://` tanpa kredensial; `.env` dan `storage/app` tidak ditimpa saat update.
- **Service manager:** nama unit regex ketat (tanpa awalan `-`), unit harus ada, layanan sistem hanya boleh `reload`, log maks. 500 baris.
- **Audit log:** append-only dari sisi aplikasi (trigger melarang UPDATE), kunci meta sensitif dibuang otomatis, retensi 90 hari (`AUDIT_RETENTION_DAYS`). Tidak mencatat isi file, password, atau keystroke.
- **Rate limit:** global 300/menit per IP; login dan 2FA 10/menit; ganti password 5/menit; endpoint berat (install, deploy, import/export, query, status software) lebih ketat.

## Hasil review Fase 3

Temuan yang **ditemukan dan sudah diperbaiki** selama Fase 1-3 (sebagian besar tertangkap oleh uji terhadap layanan nyata):

| # | Temuan | Perbaikan |
|---|---|---|
| 1 | Guard auth berjalan setelah body diparse (permintaan tanpa sesi tetap memicu parsing JSON) | Dipindah ke `onRequest`; test memastikan body rusak tanpa sesi = 401 |
| 2 | Pembaruan `totp_last_step` tidak atomik: dua verifikasi bersamaan dengan kode yang sama bisa lolos dua-duanya | `UPDATE ... WHERE totp_last_step < ?` + cek `changes`; test konkurensi |
| 3 | Recovery code di-HMAC dengan kunci turunan master key (rotasi kunci akan merusaknya, dan 50-bit rawan tebak offline bila DB bocor) | Diganti argon2id; konsumsi atomik; test konkurensi |
| 4 | `TRUST_PROXY=true` mempercayai semua header `X-Forwarded-For` | Bisa daftar IP/CIDR proxy; test header palsu diabaikan |
| 5 | Pengecekan Origin/CSRF hanya untuk URL berawalan `/api/` | Berlaku untuk semua metode mengubah state pada URL yang memuat `/api`; test variasi URL |
| 6 | Nama unit service `--now.service` lolos validasi (aman karena memakai `--`, tapi lemah) | Awalan `-` ditolak |
| 7 | Hak database "baca saja" tidak benar-benar membatasi (GRANT menambah) | Cabut hak lama dulu (MariaDB dan PostgreSQL) |
| 8 | Edit file mereset izin ke 0666 (perilaku ssh2) | Izin dipulihkan eksplisit |
| 9 | Deploy pertama Laravel melewatkan `storage/app` (placeholder dianggap deploy sebelumnya) | "Update" hanya bila `artisan` sudah ada |
| 10 | `ssh2` (CommonJS) gagal diimpor di Node ESM produksi | Default import; terdeteksi smoke test build |
| 11 | User PostgreSQL berawalan `pg_` gagal dengan pesan tidak jelas | Ditolak lebih awal dengan pesan jelas |
| 12 | Rotasi key membandingkan string base64 (padding bisa berbeda) | Dibandingkan sebagai byte |

Pemeriksaan tanpa temuan: tidak ada SQL dengan interpolasi (grep), tidak ada `child_process`/`eval` di server, tidak ada sink XSS di frontend (`dangerouslySetInnerHTML`/`innerHTML`), tidak ada token di URL, tidak ada `localStorage`, path traversal pada penyajian SPA mengembalikan halaman SPA (bukan file), file DB tidak tersaji, `npm audit`: 0 vulnerability.

## Risiko tersisa dan keterbatasan

1. **Bukan pen-test independen.** Review dilakukan oleh pengembang; ada kemungkinan celah yang terlewat. Pertimbangkan review pihak ketiga sebelum membuka panel ke banyak pengguna.
2. **Admin dan client punya root di VM masing-masing**; semua fitur beroperasi sebagai root di VM tujuan. Batas keamanan ada pada isolasi antar akun dan antar VM di panel, serta firewall jaringan (belum diuji; lihat DEPLOY.md).
3. **`style-src 'unsafe-inline'`** masih diizinkan karena xterm.js memakai style dinamis (script tetap `'self'` saja, tanpa `unsafe-inline`).
4. **Kompromi VM panel = kompromi semua VM**: master key, kunci SSH terenkripsi, dan akses jaringan ada di VM itu. Jaga VM panel minimal (tanpa layanan lain), perbarui rutin, batasi SSH ke jaringan admin, dan pakai firewall keluar.
5. **Pasangan kunci SSH panel** ada di DB (terenkripsi). Admin bisa membuka terminal ke semua VM (sengaja; tercatat di audit).
6. Pemasangan dan deploy berjalan lama di latar belakang dan tidak bisa dibatalkan dari UI.
7. Pengelolaan database tidak mencakup MySQL Oracle/versi lain yang belum diuji, dan PostgreSQL "baca saja" hanya mencakup tabel yang ada saat ini.
8. **Belum diuji di lingkungan nyata:** firewall Proxmox/MikroTik, NPM + HTTPS, systemd (unit dan service manager), Debian, repositori PHP Sury, Laravel asli. Lihat daftar di DEPLOY.md.
9. Satu kali percobaan login yang salah tetap menjalankan satu verifikasi argon2 (disamakan waktunya untuk email yang tidak ada), sehingga banjir percobaan login tetap membebani CPU sampai rate limit per IP menahannya.
10. **Preview web membuka sebagian aplikasi di VM ke internet.** Siapa pun yang memegang link bisa melihat aplikasinya selama berlaku. Client punya root di VM-nya sehingga bisa menyajikan konten apa saja di domain `PREVIEW_BASE_DOMAIN` (mis. halaman palsu). Mitigasi: hanya pemilik VM yang bisa membuat, batas jumlah, kedaluwarsa otomatis, audit pembuatan/pencabutan, dan admin bisa mencabut dari menu *Preview Live*. Karena origin preview berbeda dari panel, kontennya tidak bisa memakai sesi panel.

## Dependensi

`npm audit`: **0 vulnerability** (dijalankan saat penulisan; jalankan berkala). Dependensi runtime beserta alasannya:

| Paket | Fungsi | Catatan |
|---|---|---|
| fastify, @fastify/helmet, @fastify/cookie, @fastify/rate-limit, @fastify/websocket | HTTP, header keamanan, cookie, rate limit, terminal | ditetapkan CLAUDE.md |
| @fastify/static | Menyajikan SPA dari origin yang sama (tanpa CORS) | tambahan; dibutuhkan CLAUDE.md 5.6 |
| zod | Validasi semua input | ditetapkan |
| better-sqlite3, argon2, otplib, ssh2 | DB panel, hash password/recovery code, TOTP, SSH/SFTP | ditetapkan |
| react, react-dom, react-router-dom, @tanstack/react-query | SPA | ditetapkan |
| @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links | Terminal di browser | ditetapkan |
| lucide-react | Ikon antarmuka (SVG inline, tanpa permintaan jaringan) | redesain UI |
| @fontsource-variable/inter | Font Inter dilayani dari origin sendiri (CSP `font-src 'self'`, tanpa CDN) | redesain UI |
| qrcode | QR untuk setup 2FA | tambahan; menghindari mengetik secret manual |
| vite, tailwindcss, @tailwindcss/vite, @vitejs/plugin-react | Build dan styling | ditetapkan |
| vitest, jsdom, @testing-library/*, @playwright/test | Test (unit/integrasi/komponen/E2E) | ditetapkan; Playwright untuk E2E fase akhir |
| eslint, typescript-eslint, prettier, tsx, typescript | Lint, format, TypeScript, eksekusi dev | ditetapkan/pelengkap |

Catatan: `nodemailer` tidak dipasang karena email tidak dipakai (keputusan pemilik). `@fastify/csrf-protection` tidak dipakai; diganti token CSRF terikat sesi (HMAC) yang dibolehkan CLAUDE.md ("atau mekanisme setara"). TypeScript yang terpasang 6.0.x (bukan 7.x) karena peer dependency `typescript-eslint`.

## Cara memverifikasi ulang

```
npm run lint && npm run typecheck && npm test        # termasuk matriks IDOR dan test negatif
npm run e2e                                          # alur nyata di browser
npm audit
```

Saat menambah endpoint baru: panggil `assertVmAccess`, pasang guard `onRequest`, tambahkan ke matriks IDOR di `test/rbac.test.ts`, dan tambahkan test input berbahaya.

_Catatan UI:_ latar area konten memakai `#f4f6fa` (abu sangat muda) dengan kartu putih, sedikit menyimpang dari "area konten putih" di CLAUDE.md 8 demi kedalaman visual. Teks kuning tidak dipakai di latar putih; tombol utama kuning bersama teks biru tua.
