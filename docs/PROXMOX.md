# Proxmox: membuat VM dari panel

Panel bisa terhubung ke API Proxmox (satu cluster atau satu server) agar admin dapat melihat node, template, storage, dan bridge, lalu membuat VM dari template. **Panel tidak pernah menghapus apa pun di Proxmox**: klien API panel hanya boleh memanggil daftar endpoint tertentu (lihat `ALLOWED_CALLS` di `apps/server/src/modules/proxmox/api.ts`), tanpa `DELETE` dan tanpa endpoint penghapusan. Penghapusan VM dilakukan admin langsung di Proxmox.

## Status

| Tahap | Isi | Status |
| --- | --- | --- |
| A | Koneksi, pin sertifikat, tes koneksi, daftar node/template/storage/bridge, periksa hak token. **Hanya membaca.** | Selesai |
| B | Wizard Buat VM (clone template, isi cloud-init, nyalakan, daftarkan ke panel) | Selesai (belum diuji di Proxmox nyata) |
| C | Tombol restart VM (reboot) di header; nyalakan/matikan menyusul | Restart selesai |

**[belum diuji di Proxmox 8.4 nyata]**: panel diuji dengan server Proxmox tiruan (HTTPS, pin sertifikat, token). Nama hak akses di bawah mengikuti dokumentasi Proxmox VE 8; tombol **Tes** di halaman Proxmox memeriksanya dan memberi saran. Jalankan Tes dulu sebelum mempercayai konfigurasi ini.

## 1. Firewall

VM/CT panel harus bisa menjangkau **port 8006 di setiap node** Proxmox. VM client **tidak boleh** menjangkau port itu (aturan keamanan proyek). Tahap B juga membutuhkan VM panel menjangkau **VM baru di port SSH-nya** (bawaan 22) untuk menunggu SSH hidup dan membaca host key; VM client tetap tidak boleh menjangkau VM panel.

## 2. Token API dengan hak minimal

Jalankan di shell salah satu node (konfigurasi pengguna dan ACL berlaku untuk seluruh cluster). Satu perintah per kali; token hanya menampilkan secret **sekali**.

```
pveum pool add panel --comment "VM yang dibuat oleh Panel VM"
pveum role add PanelVM --privs "VM.Allocate VM.Clone VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Network VM.Config.Cloudinit VM.Config.CDROM VM.Config.Options VM.PowerMgmt VM.Audit Datastore.AllocateSpace Datastore.Audit SDN.Use Pool.Audit Sys.Audit"
pveum user add panel@pve --comment "Panel VM"
pveum user token add panel@pve panel --privsep 1
```

Bila peran `PanelVM` sudah dibuat sebelum hak `VM.Config.CDROM` masuk daftar (panel menambah disk cloud-init, yang dihitung Proxmox sebagai drive CD-ROM), tambahkan tanpa mengganti yang lama: `pveum role modify PanelVM --privs "VM.Config.CDROM" --append 1`. Pesan galat 403 di log pembuatan VM menyebut hak yang diminta Proxmox.

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

Storage VM Anda `local-lvm` per node (tidak dipakai bersama), jadi template harus ada **di setiap node tempat VM akan dibuat**: Proxmox hanya mengizinkan clone lintas node ke storage bersama, sehingga VM di `local-lvm` harus di-clone dari template di node yang sama. Disk template sendiri boleh di storage bersama (mis. share SMB `tpl-smb`).

**Template tanpa disk cloud-init.** Perintah di bawah sengaja tidak menambahkan disk cloud-init (`--ide2 ...:cloudinit`) ke template: panel menambahkannya sendiri di storage VM saat membuat VM. Alasannya, Proxmox menolak meng-clone template ke node lain bila ada satu saja volumenya di storage lokal ("can't clone VM to node ... (VM uses local storage)"), dan disk cloud-init di `local-lvm` termasuk. Bila template Anda sudah punya disk itu, hapus (aman; hanya disk cloud-init kecil yang dibuat ulang otomatis): `qm set 9000 --delete ide2`.

**Template di storage bersama (share SMB `tpl-smb`).** Bila disk template ingin disimpan di share, ganti `local-lvm` dengan `tpl-smb` pada dua langkah ini (dan tambahkan `--format qcow2` pada import), lalu lanjutkan seperti biasa. Pesan `chattr: Operation not supported` saat `qm template` boleh diabaikan (SMB tidak mendukung penguncian berkas; periksa `qm config` memuat `template: 1`). Jangan menulis apa pun di folder template pada share.

```
qm disk import $ID <file-image> tpl-smb --format qcow2
qm set $ID --scsi0 tpl-smb:$ID/vm-$ID-disk-0.qcow2 --boot order=scsi0 --serial0 socket --vga serial0
```

**Cara cepat untuk node lain** bila Anda sudah punya template dengan disk di storage bersama (mis. di PxThegt): salin lewat storage bersama, lalu jadikan template. Halaman Buat VM dan Tes menampilkan perintah yang pas untuk node Anda. Bentuknya (di Shell node pemilik template, satu perintah per kali):

```
qm clone 9000 9001 --name tpl-debian12-thegt1 --full 1 --storage tpl-smb --target TheGt1 --pool panel
pvesh create /nodes/TheGt1/qemu/9001/template
```

Peringatan `chattr` pada storage SMB boleh diabaikan. Template baru masuk pool `panel` sehingga hak token yang ada berlaku. **[belum diuji di Proxmox nyata]**.

Nomor VM (VMID) harus unik se-cluster. Bila membuat sendiri dari image:

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
qm set 9000 --scsi0 local-lvm:vm-9000-disk-0 --boot order=scsi0 --serial0 socket --vga serial0
qm template 9000
```

Ubuntu 24.04:

```
cd /var/tmp
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
qm create 9010 --name tpl-ubuntu2404-<node> --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci
qm disk import 9010 noble-server-cloudimg-amd64.img local-lvm
qm set 9010 --scsi0 local-lvm:vm-9010-disk-0 --boot order=scsi0 --serial0 socket --vga serial0
qm template 9010
```

## 4. Menghubungkan panel (Admin, Proxmox)

1. Klik **Tambah koneksi**, isi nama dan alamat ketiga node (`https://<ip>:8006`, satu per baris; bila satu mati panel memakai yang lain).
2. Klik **Ambil sertifikat**. Cocokkan fingerprint SHA-256 yang tampil dengan yang ada di Proxmox (Datacenter, node, System, Certificates), lalu centang konfirmasi. Panel hanya mau terhubung ke sertifikat yang Anda konfirmasi (pin), dan memeriksanya **sebelum** mengirim token.
3. Isi Token ID dan secret, lalu **Uji dan simpan**. Koneksi hanya tersimpan bila token terbukti bisa membaca daftar node. Secret disimpan terenkripsi (AES-256-GCM) dan ikut dirotasi oleh `rotate-key`.
4. Klik **Tes**: lihat node (CPU, RAM bebas), template yang dikenali, storage, bridge, dan saran hak yang kurang.

Bila sertifikat sebuah node diganti, panel menolak dengan pesan "Sertifikat ... berbeda dari yang Anda konfirmasi" (ini juga tanda kemungkinan penyamaran). Periksa node itu, lalu perbarui pin.

## 5. Membuat VM (Admin, Proxmox, Buat VM)

Klik **Buat VM** pada koneksi. Pilihan di wizard datang langsung dari Proxmox: node yang online (dengan CPU dan RAM bebas), OS yang template-nya tersedia di node itu, storage, dan bridge. Server memeriksa ulang semuanya sebelum bekerja (node online, template, storage, bridge, ukuran disk, subnet IP dan gateway, nama dan IP belum dipakai VM lain).

Panel lalu menjalankan job berlog:

1. Meminta nomor VM kosong dari Proxmox (`/cluster/nextid`).
2. **Clone penuh** template yang ada **di node tujuan** ke storage pilihan (mis. `local-lvm`), ditaruh di pool `panel`. Panel tidak pernah meng-clone lintas node: Proxmox hanya mengizinkannya ke storage bersama (galat "can't clone to non-shared storage"), sedangkan VM sebaiknya berjalan di storage lokal. Karena itu tiap node perlu template sendiri (lihat bagian 3).
3. Mengisi cloud-init: CPU, RAM, user (`debian` atau `ubuntu`), kunci SSH publik khusus VM itu, `ipconfig0` (IP, gateway), DNS, dan bridge/VLAN.
4. Memperbesar disk ke ukuran pilihan (disk hanya bisa diperbesar), lalu menyalakan VM.
5. Menunggu port SSH menjawab, lalu membaca host key.

Setelah job selesai: buka **Admin, Kelola VM**, pindai dan setujui host key VM (fingerprint ditampilkan di log), lalu hubungkan VM ke client. VM langsung terdaftar di panel dengan semua modul aktif.

**Yang tidak pernah dilakukan panel:** menghapus, mematikan, atau memigrasi VM di Proxmox. Bila job gagal di tengah, log menyebut node dan nomor VM yang sudah ada di Proxmox dan meminta Anda memeriksa atau menghapusnya manual. Bila gagal sebelum clone selesai, tidak ada VM di Proxmox dan catatan di panel bisa dihapus lewat Kelola VM. Menghapus catatan VM di panel tidak menyentuh Proxmox; koneksi yang masih dipakai VM tidak bisa dihapus catatannya.

**Satu pembuatan pada satu waktu per koneksi** (agar nomor VM dan clone tidak berebut).

**[belum diuji di Proxmox 8.4 nyata]**: urutan dan isi panggilan diuji dengan server Proxmox tiruan. Hal yang baru terbukti saat VM uji pertama dibuat:

- Clone lokal di node yang punya template ke `local-lvm` (clone lintas node tidak dipakai; lihat bagian 3).
- Format nilai `sshkeys` (dikirim ter-URL-encode sekali, sesuai dokumentasi API) dan user cloud-init bawaan image.
- Disk cloud-init (`ide2`) di template tertaut ke `local-lvm` node pemilik; pada clone ke node lain Proxmox seharusnya membuatnya ulang di storage tujuan.
- Perilaku jaringan: VM panel harus bisa menjangkau IP VM baru agar langkah "menunggu SSH" berhasil.

Uji pertama yang disarankan: buat satu VM kecil (1 CPU, 1 GB RAM, disk 8 GB) di node yang punya template, lalu satu lagi di node lain setelah template node itu dibuat (bagian 3).
## 6. CT (LXC)

Tahap ini untuk **VM (QEMU)**. Dukungan CT (LXC) direncanakan menyusul; alurnya lebih sederhana (tanpa cloud-init, memakai template CT resmi) tetapi isolasinya lebih lemah daripada VM, jadi hanya CT unprivileged yang akan dibuat.
