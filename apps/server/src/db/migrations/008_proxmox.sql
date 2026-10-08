-- Koneksi ke API Proxmox (satu cluster atau satu server). Hanya admin yang mengelolanya.
-- endpoints: JSON [{url, fingerprint}] — alamat node (cadangan bila satu mati) beserta pin SHA-256 sertifikat TLS-nya.
-- token_secret_enc: AES-256-GCM (konteks proxmox.token:<id>); tidak pernah dikirim ke browser atau log.
CREATE TABLE proxmox_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  endpoints TEXT NOT NULL,
  token_id TEXT NOT NULL,
  token_secret_enc TEXT NOT NULL,
  pool TEXT NOT NULL DEFAULT 'panel',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
