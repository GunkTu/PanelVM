#!/usr/bin/env bash
# Menyiapkan "VM" uji lokal (sshd + MariaDB + nginx + PHP-FPM) untuk test integrasi.
# Hanya untuk mesin pengembangan/CI sekali pakai (butuh root, memasang paket via apt).
#   sudo ./setup-test-vm.sh /tmp/panel-test-vm
# Lalu jalankan test dengan:
#   PANEL_TEST_SSH_PORT=2222 PANEL_TEST_AUTHORIZED_KEYS=/tmp/panel-test-vm/authorized_keys npm test -w @panelvm/server
set -euo pipefail
DIR="${1:?Beri folder kerja, contoh /tmp/panel-test-vm}"
mkdir -p "$DIR" /run/sshd /run/php
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  openssh-server mariadb-server nginx php-fpm php-mysql php-xml php-mbstring php-curl php-zip unzip zip rsync
ssh-keygen -q -t ed25519 -N '' -f "$DIR/hostkey" <<<y >/dev/null 2>&1 || true
touch "$DIR/authorized_keys"; chmod 600 "$DIR/authorized_keys" "$DIR/hostkey"
cat > "$DIR/sshd_config" <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey $DIR/hostkey
PermitRootLogin prohibit-password
PasswordAuthentication no
AuthorizedKeysFile $DIR/authorized_keys
StrictModes no
Subsystem sftp internal-sftp
PidFile $DIR/sshd.pid
CFG
/usr/sbin/sshd -f "$DIR/sshd_config"
(mysqld_safe >/dev/null 2>&1 &)
rm -f /etc/nginx/sites-enabled/default
PHPFPM="$(ls /usr/sbin/php-fpm* | head -1)"; "$PHPFPM" -D
nginx || true
echo "Siap. sshd di 127.0.0.1:2222, authorized_keys: $DIR/authorized_keys"
