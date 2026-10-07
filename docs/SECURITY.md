# Catatan Keamanan

Dokumen ini diisi bertahap. Aturan wajib ada di `CLAUDE.md` bagian 5.

## Status Fase 0

- CSP ketat aktif lewat `@fastify/helmet` (tanpa `unsafe-inline` untuk script). `style-src` mengizinkan `unsafe-inline` karena xterm.js memakai style dinamis; tinjau ulang di Fase 1 saat terminal dibangun.
- HSTS sengaja dinonaktifkan di aplikasi; diatur di NPM sampai HTTPS stabil.
- `trustProxy` dikendalikan env `TRUST_PROXY` (default `false`; set `true` hanya di belakang NPM).
- Env divalidasi zod saat startup. Pesan error menyebut nama variabel, tidak pernah nilainya.
- Kontras tombol utama (teks biru tua di atas kuning): 8,89:1 (lulus WCAG AA).

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
| eslint, typescript-eslint, @eslint/js, eslint-plugin-react-hooks, globals, prettier | Lint dan format | Ditetapkan di CLAUDE.md; plugin hooks dan globals pelengkap |
