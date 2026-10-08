-- Mode akses preview: publik (siapa pun yang tahu alamatnya) atau dilindungi kata sandi (hash argon2id).
-- access_version dinaikkan setiap mode/kata sandi berubah sehingga cookie akses lama langsung tidak berlaku.
ALTER TABLE previews ADD COLUMN access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'password'));
ALTER TABLE previews ADD COLUMN password_hash TEXT;
ALTER TABLE previews ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1;
