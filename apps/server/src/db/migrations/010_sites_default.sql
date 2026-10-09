-- Situs utama (Nginx): melayani semua permintaan yang Host-nya tidak cocok dengan domain mana pun (mis. dibuka lewat IP VM).
-- Hanya satu situs per VM yang boleh menjadi situs utama.
ALTER TABLE sites ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
