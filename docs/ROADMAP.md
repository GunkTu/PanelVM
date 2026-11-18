# Roadmap (disepakati dengan pemilik proyek)

Status: poin 1-6 sudah dikerjakan (lihat bagian "Fitur tambahan" di docs/DEPLOY.md); semuanya belum diuji di VM nyata. Yang belum: ide tambahan di bagian bawah.

Urutan dikerjakan bersamaan nanti. Setiap butir tetap mengikuti aturan CLAUDE.md (tanpa interpolasi shell, test negatif lintas user, audit log, pesan error Indonesia).

## 1. Database: phpMyAdmin (rencana B)

- Tombol "Pasang phpMyAdmin" di halaman Database: unduh tarball resmi terbaru (bukan paket apt), dengar hanya di `127.0.0.1` VM, `AllowRoot=false`, `AllowNoPassword=false`.
- Tombol "Buka phpMyAdmin" lewat mekanisme preview (tunnel SSH + host terpisah). Perlu mode akses baru: hanya pemilik VM/admin yang sedang login (sesi panel + 2FA).
- Pengguna masuk dengan user/password database mereka sendiri (password DB tidak disimpan panel). Tombol "Perbarui phpMyAdmin" dan penanda versi.
- Belum diputuskan: phpMyAdmin atau Adminer (satu file, ringan, MySQL + PostgreSQL). Default usulan: phpMyAdmin sesuai permintaan.

## 2. Deploy lebih mudah

- Buat database + user otomatis dan isi `.env` (Laravel) / `database.php` (PHP biasa); password ditampilkan sekali.
- Impor `.sql` dari halaman Situs Web, dengan peringatan sebelum file berisi `DROP DATABASE` / `DROP TABLE` dijalankan.
- Tambahan yang diusulkan: lihat bagian "Usulan tambahan deploy" di bawah.

## 3. Cron dan queue worker

- Pengelola cron per situs (mis. `php artisan schedule:run` tiap menit) dan worker queue (`queue:work`) lewat systemd/supervisor, dengan start/stop/restart dan log.

## 4. Aplikasi non-PHP

- Node, Next.js, Python (dan lainnya) lewat PM2 atau unit systemd + reverse proxy Nginx. Pilih versi runtime, perintah start, port, variabel lingkungan; status dan log.

## 5. Ganti password login panel

- Endpoint server `POST /api/auth/password` SUDAH ada (rate limit 5). Yang belum: halaman/menu "Akun saya" di UI (ganti password, mungkin juga ganti 2FA dan lihat sesi aktif).

## 6. Tab Aplikasi

- Tambahkan fitur-fitur yang berguna di dalam halaman Aplikasi (software). Detail dibahas saat pengerjaan.

## Status lain

- Mode maintenance (tombol admin + layar pemeliharaan) sudah dibuat tetapi belum di-commit saat catatan ini ditulis.
- Ide berikutnya (belum disetujui): log viewer situs, backup/restore per VM + snapshot Proxmox, SSL certbot, ufw/fail2ban, Proxmox lanjutan (nyalakan/matikan, snapshot, resize), kunci SSH dan pengaturan PHP, peringatan email, rilis + rollback otomatis.
