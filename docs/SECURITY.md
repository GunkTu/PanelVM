# Catatan Keamanan

Dokumen ini diisi bertahap. Aturan wajib ada di `CLAUDE.md` bagian 5.

## Status Fase 0

- CSP ketat aktif lewat `@fastify/helmet` (tanpa `unsafe-inline` untuk script). `style-src` mengizinkan `unsafe-inline` karena xterm.js memakai style dinamis; tinjau ulang di Fase 1 saat terminal dibangun.
- HSTS sengaja dinonaktifkan di aplikasi; diatur di NPM sampai HTTPS stabil.
- `trustProxy` dikendalikan env `TRUST_PROXY` (default `false`; set `true` hanya di belakang NPM).
- Env divalidasi zod saat startup. Pesan error menyebut nama variabel, tidak pernah nilainya.
- Kontras tombol utama (teks biru tua di atas kuning): 8,89:1 (lulus WCAG AA).

## Status Fase 1

- Autentikasi: argon2id, password minimal 12 karakter, tanpa endpoint registrasi (ada test). Pesan login sama untuk email tidak ada / password salah / akun terkunci / disuspend, dan waktu respons disamakan dengan verifikasi palsu.
- Lockout: 5 password salah mengunci akun 15 menit. Rate limit: login dan 2FA 10/menit per IP, ganti password 5/menit, lainnya 300/menit.
- 2FA TOTP wajib untuk semua akun (login tanpa 2FA hanya mencapai tahap setup). Secret TOTP terenkripsi AES-256-GCM. Kode TOTP tidak bisa dipakai ulang (anti-replay lewat langkah waktu). Recovery code 10 buah, disimpan sebagai HMAC, sekali pakai. 5 kode salah menghancurkan sesi pending.
- Sesi: cookie `HttpOnly`, `SameSite=Strict`, `Secure` + prefiks `__Host-` di produksi. Token acak 32 byte, DB hanya menyimpan HMAC. Idle 30 menit, absolut 12 jam. Token baru dibuat setelah 2FA (anti session fixation).
- CSRF: token terikat sesi (HMAC) wajib di header `X-CSRF-Token` untuk semua request mengubah state, ditambah validasi header `Origin` terhadap `APP_ORIGIN`.
- Otorisasi: `assertVmAccess` dipakai di setiap route VM/terminal. Client non-pemilik mendapat 404. Admin dicek di server lewat role. Ada test negatif lintas akun untuk semua endpoint VM, user, audit, notifikasi, dan terminal.
- Suspend, reset password, reset 2FA, ganti pemilik VM, dan hapus VM langsung memutus sesi dan terminal yang berjalan (ada test).
- Kredensial VM: kunci SSH ed25519 dibuat panel per VM, disimpan terenkripsi (AES-256-GCM, nonce unik, AAD terikat ke id VM). Tidak pernah dikirim ke browser (ada test pada respons API). Host key wajib disetujui admin dan dicek tiap koneksi.
- Terminal WebSocket: auth dan cek Origin dan kepemilikan VM terjadi sebelum upgrade; pesan divalidasi zod; batas 64 KB per pesan; maksimal 5 terminal per user dan per VM; idle 30 menit; liveness check tiap 15 detik. Keystroke tidak dicatat.
- Audit log append-only (trigger melarang UPDATE; aplikasi hanya INSERT). Kunci meta yang mengandung pass/secret/token/key/code/content dibuang otomatis.

### Catatan dan risiko yang diketahui

- `npm audit`: 0 vulnerability saat ini; jalankan berkala.
- Retensi audit log belum ditentukan pemilik; belum ada penghapusan otomatis.
- Rotasi master key (`scripts/rotate-key.ts`) belum dibuat.
- Email notifikasi menunggu SMTP; notifikasi in-app sudah jalan.
- Admin dapat membuka terminal semua VM (sengaja: admin adalah pemilik). Aksinya tercatat di audit.
- Verifikasi di browser nyata (Playwright) dilakukan manual sekali pada Fase 1; belum ada suite E2E otomatis (direncanakan akhir proyek).

## Hasil `npm audit`

- 2026-10-07: 0 vulnerabilities (setelah instal dependensi Fase 0).

## Dependensi Fase 0

| Paket | Fungsi | Alasan |
|---|---|---|
| fastify, @fastify/helmet | HTTP server, header keamanan | Stack ditetapkan di CLAUDE.md |
| zod | Validasi env dan input | Stack ditetapkan di CLAUDE.md |
| react, react-dom, react-router-dom, @tanstack/react-query | SPA | Stack ditetapkan di CLAUDE.md |
| vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite | Build dan styling | Stack ditetapkan di CLAUDE.md |
| vitest, jsdom, @testing-library/react, @testing-library/jest-dom | Test | Vitest ditetapkan; jsdom dan testing-library untuk test komponen |
| tsx | Menjalankan TypeScript saat dev | Alternatif ringan untuk dev server |
| better-sqlite3 | Database panel | Ditetapkan di CLAUDE.md |
| argon2 | Hash password (argon2id) | Ditetapkan di CLAUDE.md |
| otplib | TOTP | Ditetapkan di CLAUDE.md |
| @fastify/cookie, @fastify/websocket, @fastify/rate-limit | Cookie sesi, WebSocket terminal, rate limit | Ditetapkan di CLAUDE.md |
| @fastify/static | Menyajikan SPA dari origin yang sama | Dibutuhkan agar tanpa CORS (CLAUDE.md 5.6); tidak ada di daftar awal |
| ssh2 | SSH/SFTP | Ditetapkan di CLAUDE.md |
| @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links | Terminal di browser | Ditetapkan di CLAUDE.md |
| qrcode | QR untuk setup 2FA di browser | Tidak ada di daftar awal; menghindari mengetik secret manual |
| @types/better-sqlite3, @types/ssh2, @types/ws, @types/qrcode | Tipe TypeScript | Dev saja |

Catatan CSRF: `@fastify/csrf-protection` tidak dipakai; diganti token terikat sesi buatan sendiri (HMAC) yang dibolehkan CLAUDE.md ("atau mekanisme setara"), karena sesi sudah berbasis server.
| eslint, typescript-eslint, @eslint/js, eslint-plugin-react-hooks, globals, prettier | Lint dan format | Ditetapkan di CLAUDE.md; plugin hooks dan globals pelengkap |
