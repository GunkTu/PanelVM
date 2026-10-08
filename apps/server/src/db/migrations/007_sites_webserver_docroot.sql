-- Situs bisa memakai Nginx atau Apache (salah satu per VM), dan folder dokumen (document root) bisa dipilih.
-- doc_root: NULL = bawaan menurut jenis situs (Laravel: public); '.' = folder utama situs; selain itu subfolder relatif.
ALTER TABLE sites ADD COLUMN web_server TEXT NOT NULL DEFAULT 'nginx' CHECK (web_server IN ('nginx', 'apache'));
ALTER TABLE sites ADD COLUMN doc_root TEXT;
