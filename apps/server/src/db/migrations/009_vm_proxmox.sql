-- VM yang dibuat lewat panel ditautkan ke node dan nomor VM di Proxmox (untuk tombol daya di tahap berikutnya).
-- Menghapus baris vms (di panel) ikut menghapus tautan ini; VM di Proxmox TIDAK disentuh.
CREATE TABLE vm_proxmox (
  vm_id TEXT PRIMARY KEY REFERENCES vms (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES proxmox_connections (id),
  node TEXT NOT NULL,
  vmid INTEGER NOT NULL,
  template_vmid INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
