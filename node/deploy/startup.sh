#!/bin/bash
# GCE startup-script (runs as root on every boot). Ubuntu 24.04, TDX or SEV-SNP VM.
# Expects daemon code at /opt/sol-vpn/node (copy it with gcloud compute scp, see README).
set -euo pipefail
NODE_VER=v24.10.0

if ! command -v wg >/dev/null || ! command -v node >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools unbound iptables curl xz-utils
  # tdx_guest lives here on some GCP Ubuntu kernels; harmless if the package doesn't exist
  DEBIAN_FRONTEND=noninteractive apt-get install -y "linux-modules-extra-$(uname -r)" || true
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep "node-$NODE_VER-linux-x64.tar.xz" \
    | sed 's#  .*#  /tmp/node.tar.xz#' | sha256sum -c -
  tar -xJf /tmp/node.tar.xz -C /opt && ln -sf "/opt/node-$NODE_VER-linux-x64/bin/node" /usr/local/bin/node
fi

# Attestation: configfs-tsm (CONFIG_TSM_REPORTS) + vendor guest driver.
modprobe tdx_guest 2>/dev/null || modprobe sev-guest 2>/dev/null || true
mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config
ls /sys/kernel/config/tsm/report >/dev/null || echo "WARN: configfs-tsm missing, /attest will fail"

# Routing + NAT. No packet/conntrack logging anywhere.
sysctl -w net.ipv4.ip_forward=1
WAN=$(ip route show default | awk '{print $5; exit}')
iptables -t nat -C POSTROUTING -s 10.8.0.0/24 -o "$WAN" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o "$WAN" -j MASQUERADE
iptables -C FORWARD -i wg0 -o wg0 -j DROP 2>/dev/null || iptables -I FORWARD -i wg0 -o wg0 -j DROP                       # no client<->client
iptables -C FORWARD -i wg0 -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I FORWARD -i wg0 -d 169.254.169.254 -j DROP # no metadata server

# DNS resolver on 10.8.0.1 (recursive from this VM, so ipleak.net shows the node, not the client ISP).
cat > /etc/unbound/unbound.conf.d/sol-vpn.conf <<'EOF'
server:
  interface: 10.8.0.1
  ip-freebind: yes          # wg0 is created later by the daemon
  access-control: 10.8.0.0/24 allow
  verbosity: 0
  log-queries: no
  log-replies: no
  hide-identity: yes
  hide-version: yes
  qname-minimisation: yes
EOF
systemctl restart unbound

EXT_IP=$(curl -fsH 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
NODE_ID=$(curl -fsH 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/node-id || true)  # empty -> daemon refuses to start
cat > /etc/systemd/system/sol-vpn-node.service <<EOF
[Unit]
Description=sol-vpn node daemon
After=network-online.target
[Service]
Environment=NODE_ENDPOINT=$EXT_IP:51820
Environment=NODE_ID=$NODE_ID
Environment=NODE_KEYPAIR=/opt/sol-vpn/node-keypair.json
ExecStart=/usr/local/bin/node /opt/sol-vpn/node/dist/main.cjs
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload   # not enabled: only started below, after the code is measured into RTMR3
[ -f /opt/sol-vpn/node/dist/main.cjs ] || { echo "daemon code not present yet; copy it and reboot"; exit 0; }
# TDX: measure the daemon bundle (the only code ExecStart runs) into RTMR3 (kernel >= 6.16). set -e: extend fails -> daemon not started.
# SEV-SNP has no RTMRs; it runs with firmware-only measurement.
[ -e /dev/tdx_guest ] && node /opt/sol-vpn/node/deploy/expected-rtmr3.ts --extend
systemctl restart sol-vpn-node
