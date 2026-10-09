# Proxmox: membuat VM dari panel

Panel bisa terhubung ke API Proxmox (satu cluster atau satu server) agar admin dapat melihat node, template, storage, dan bridge, lalu (tahap berikutnya) membuat VM dari template. **Panel tidak pernah menghapus apa pun di Proxmox**: klien API panel hanya boleh memanggil daftar endpoint tertentu (lihat `ALLOWED_CALLS` di `apps/server/src/modules/proxmox/api.ts`), tanpa `DELETE` dan tanpa endpoint penghapusan. Penghapusan VM dilakukan admin langsung di Proxmox.

## Status

| Tahap | Isi | Status |
| --- | --- | --- |
| A | Koneksi, pin sertifikat, tes koneksi, daftar node/template/storage/bridge, periksa hak token. **Hanya membaca.** | Selesai |
| B | Wizard Buat VM (clone template, isi cloud-init, nyalakan, daftarkan ke panel) | Berikutnya |
| C | Tombol nyalakan, matikan, reboot | Setelah B |

**[belum diuji di Proxmox 8.4 nyata]**: panel diuji dengan server Proxmox tiruan (HTTPS, pin sertifikat, token). Nama hak akses di bawah mengikuti dokumentasi Proxmox VE 8; tombol **Tes** di halaman Proxmox memeriksanya dan memberi saran. Jalankan Tes dulu sebelum mempercayai konfigurasi ini.

## 1. Firewall

VM/CT panel harus bisa menjangkau **port 8006 di setiap node** Proxmox. VM client **tidak boleh** menjangkau port itu (aturan keamanan proyek). Tidak ada port lain yang dibutuhkan untuk Tahap A.

## 2. Token API dengan hak minimal

Jalankan di shell salah satu node (konfigurasi pengguna dan ACL berlaku untuk seluruh cluster). Satu perintah per kali; token hanya menampilkan secret **sekali**.

```
pveum pool add panel --comment "VM yang dibuat oleh Panel VM"
pveum role add PanelVM --privs "VM.Allocate VM.Clone VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Network VM.Config.Cloudinit VM.Config.Options VM.PowerMgmt VM.Audit Datastore.AllocateSpace Datastore.Audit SDN.Use Pool.Audit Sys.Audit"
pveum user add panel@pve --comment "Panel VM"
pveum user token add panel@pve panel --privsep 1
```

Catat **Token ID** (`panel@pve!panel`) dan **secret** dari keluaran terakhir.

**Hak harus diberikan ke user DAN token.** Token ber-_privilege separation_ (bawaan) hanya punya hak yang ada di kedua sisi: hak efektifnya adalah irisan hak token dan hak user `panel@pve`. Bila hanya salah satu yang diberi hak, Tes di panel menampilkan semua daftar kosong. Satu perintah per kali:

```
pveum acl modify /pool/panel --users panel@pve --roles PanelVM
pveum acl modify /storage/local-lvm --users panel@pve --roles PanelVM
pveum acl modify /sdn/zones/localnetwork --users panel@pve --roles PanelVM
pveum acl modify /nodes --users panel@pve --roles PVEAuditor
pveum acl modify /pool/panel --tokens 'panel@pve!panel' --roles PanelVM
pveum acl modify /storage/local-lvm --tokens 'panel@pve!panel' --roles PanelVM
pveum acl modify /sdn/zones/localnetwork --tokens 'panel@pve!panel' --roles PanelVM
pveum acl modify /nodes --tokens 'panel@pve!panel' --roles PVEAuditor
```

Setiap template juga perlu hak clone untuk user dan token, begitu pula storage bersama bila template disimpan di sana (ganti nomor dan nama sesuai template Anda, lihat bagian 3):

```
pveum acl modify /vms/9000 --users panel@pve --roles PanelVM
pveum acl modify /vms/9000 --tokens 'panel@pve!panel' --roles PanelVM
pveum acl modify /storage/tpl-smb --users panel@pve --roles PanelVM
pveum acl modify /storage/tpl-smb --tokens 'panel@pve!panel' --roles PanelVM
```

Cek hak efektif token (semua yang dibutuhkan harus muncul):

```
pveum user permissions 'panel@pve!panel'
```
Catatan keamanan:

- Hak membuat VM (`VM.Allocate`) di Proxmox juga mencakup menghapus VM; tidak ada hak "buat tetapi tidak boleh hapus". Larangan hapus ditegakkan oleh kode panel (dan test yang gagal bila ada `DELETE`), bukan oleh Proxmox. Karena itu token dibatasi ke satu pool `panel`: hanya VM di pool itu yang bisa disentuh.
- Token tidak diberi hak `Sys.Modify`, `Permissions.Modify`, atau akses ke storage lain.
- Bila token bocor, hapus di Proxmox (`pveum user token remove panel@pve panel`) lalu buat ulang.

## 3. Template Debian dan Ubuntu (satu per OS per node)

Storage VM Anda `local-lvm` per node (tidak dipakai bersama), jadi template harus ada **di setiap node**. Nomor VM (VMID) harus unik se-cluster:

| Node | Debian 12 | Ubuntu 24.04 |
| --- | --- | --- |
| node 1 | 9000 | 9010 |
| node 2 | 9001 | 9011 |
| node 3 | 9002 | 9012 |

**Nama harus mengikuti pola** `tpl-debian12-<node>` atau `tpl-ubuntu2404-<node>`: panel mengenali OS dan user SSH (`debian` atau `ubuntu`) dari nama. Template dengan nama lain diabaikan.

Jalankan di shell **tiap node**, satu perintah per kali. Cek `qm list` dulu agar nomornya belum dipakai, dan `pvesm status` untuk memastikan nama storage `local-lvm`. Perintah ini hanya menambah satu VM template baru dan tidak menyentuh VM lain; untuk membatalkan jalankan `qm destroy <nomor>`.

Debian 12:

```
cd /var/tmp
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2
qm create 9000 --name tpl-debian12-<node> --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci
qm disk import 9000 debian-12-generic-amd64.qcow2 local-lvm
qm set 9000 --scsi0 local-lvm:vm-9000-disk-0 --ide2 local-lvm:cloudinit --boot order=scsi0 --serial0 socket --vga serial0
qm template 9000
```

Ubuntu 24.04:

```
cd /var/tmp
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
qm create 9010 --name tpl-ubuntu2404-<node> --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci
qm disk import 9010 noble-server-cloudimg-amd64.img local-lvm
qm set 9010 --scsi0 local-lvm:vm-9010-disk-0 --ide2 local-lvm:cloudinit --boot order=scsi0 --serial0 socket --vga serial0
qm template 9010
```

## 4. Menghubungkan panel (Admin, Proxmox)

1. Klik **Tambah koneksi**, isi nama dan alamat ketiga node (`https://<ip>:8006`, satu per baris; bila satu mati panel memakai yang lain).
2. Klik **Ambil sertifikat**. Cocokkan fingerprint SHA-256 yang tampil dengan yang ada di Proxmox (Datacenter, node, System, Certificates), lalu centang konfirmasi. Panel hanya mau terhubung ke sertifikat yang Anda konfirmasi (pin), dan memeriksanya **sebelum** mengirim token.
3. Isi Token ID dan secret, lalu **Uji dan simpan**. Koneksi hanya tersimpan bila token terbukti bisa membaca daftar node. Secret disimpan terenkripsi (AES-256-GCM) dan ikut dirotasi oleh `rotate-key`.
4. Klik **Tes**: lihat node (CPU, RAM bebas), template yang dikenali, storage, bridge, dan saran hak yang kurang.

Bila sertifikat sebuah node diganti, panel menolak dengan pesan "Sertifikat ... berbeda dari yang Anda konfirmasi" (ini juga tanda kemungkinan penyamaran). Periksa node itu, lalu perbarui pin.

## 5. CT (LXC)

Tahap ini untuk **VM (QEMU)**. Dukungan CT (LXC) direncanakan menyusul; alurnya lebih sederhana (tanpa cloud-init, memakai template CT resmi) tetapi isolasinya lebih lemah daripada VM, jadi hanya CT unprivileged yang akan dibuat.
