#!/usr/bin/env bash
#
# firecracker-sandbox.sh — the DATA PLANE for our mini "Vercel Sandbox".
#
# Each sandbox is one Firecracker microVM (own kernel, own rootfs, own tap NIC).
# This is the part that only runs on Linux + KVM (e.g. an EC2 *.metal instance).
# The control plane (control-plane.mjs) shells out to these subcommands; it never
# touches the VM directly — exactly like @vercel/sandbox only ever talks to the
# Vercel control plane, which brokers the microVM.
#
# Subcommands:
#   deps                 Download firecracker + kernel + build a rootfs (with ssh key)
#   net                  Enable IP forwarding + NAT masquerade for guest egress
#   start <id>           Boot a microVM for sandbox <id>; prints JSON {id,ip,pid}
#   exec  <id>           Read a shell script from stdin, run it in the VM, stream out
#   write <id> <path>    Read base64 from stdin, write it to <path> in the VM
#   read  <id> <path>    Print base64 of <path> from the VM (exit 44 if missing)
#   stop  <id>           Kill the VM + tear down its tap (keeps state dir)
#   destroy <id>         Stop, then remove the VM's state dir (irreversible)
#   list                 List running sandbox VMs
#
# Isolation vs Vercel: VM boundary matches (dedicated kernel). What we DON'T
# replicate here: snapshot/restore persistence, the egress firewall/allowlist,
# multi-host scheduling, and signed-OIDC port routing. See the chat notes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${FC_STATE_DIR:-$HERE/.state}"
ASSETS="$STATE/assets"
VMS="$STATE/vms"
CI_VERSION="${FC_CI_VERSION:-v1.11}"
VCPU="${FC_VCPU:-1}"
MEM_MIB="${FC_MEM_MIB:-512}"
EGRESS_IF="${FC_EGRESS_IF:-$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)

log() { printf '[fc] %s\n' "$*" >&2; }
die() { printf '[fc] ERROR: %s\n' "$*" >&2; exit 1; }

require_linux_kvm() {
  [ "$(uname -s)" = "Linux" ] || die "Firecracker requires Linux (this is $(uname -s)). Run on an EC2 *.metal host."
  [ -e /dev/kvm ] || die "/dev/kvm not found. Use a bare-metal/nested-virt-capable instance and load KVM."
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "No r/w on /dev/kvm. Add your user to the 'kvm' group or run as root."
}

# ---------------------------------------------------------------------------
# deps: fetch firecracker binary, a guest kernel, and a rootfs with an ssh key
# ---------------------------------------------------------------------------
cmd_deps() {
  require_linux_kvm
  mkdir -p "$ASSETS"
  local arch; arch="$(uname -m)"

  if [ ! -x "$ASSETS/firecracker" ]; then
    log "downloading firecracker release ($arch)"
    local rel="https://github.com/firecracker-microvm/firecracker/releases"
    local latest; latest="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$rel/latest")")"
    curl -fsSL "$rel/download/$latest/firecracker-$latest-$arch.tgz" | tar -xz -C "$ASSETS"
    cp "$ASSETS/release-$latest-$arch/firecracker-$latest-$arch" "$ASSETS/firecracker"
    chmod +x "$ASSETS/firecracker"
  fi

  if [ ! -f "$ASSETS/vmlinux" ]; then
    log "downloading guest kernel"
    local kkey
    kkey="$(curl -fsSL "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/$CI_VERSION/$arch/vmlinux-5.10&list-type=2" \
      | grep -oP "(?<=<Key>)(firecracker-ci/$CI_VERSION/$arch/vmlinux-5\.10\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)"
    [ -n "$kkey" ] || die "could not locate a kernel artifact in CI bucket"
    curl -fsSL -o "$ASSETS/vmlinux" "https://s3.amazonaws.com/spec.ccfc.min/$kkey"
  fi

  if [ ! -f "$ASSETS/rootfs.ext4" ]; then
    log "building rootfs.ext4 from ubuntu squashfs (+ ssh key)"
    command -v unsquashfs >/dev/null || die "need 'unsquashfs' (apt-get install -y squashfs-tools)"
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/rootfs.squashfs" \
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/$CI_VERSION/$arch/ubuntu-24.04.squashfs"
    ( cd "$tmp" && unsquashfs -q rootfs.squashfs )
    [ -f "$ASSETS/id_rsa" ] || ssh-keygen -q -f "$ASSETS/id_rsa" -N ""
    mkdir -p "$tmp/squashfs-root/root/.ssh"
    cp "$ASSETS/id_rsa.pub" "$tmp/squashfs-root/root/.ssh/authorized_keys"
    sudo chown -R root:root "$tmp/squashfs-root"
    truncate -s 1G "$ASSETS/rootfs.ext4"
    sudo mkfs.ext4 -q -d "$tmp/squashfs-root" -F "$ASSETS/rootfs.ext4"
    chmod 600 "$ASSETS/id_rsa"
    sudo rm -rf "$tmp"
  fi
  log "deps ready in $ASSETS"
}

# ---------------------------------------------------------------------------
# net: host-side NAT so guests can reach the internet (optional for Pi)
# ---------------------------------------------------------------------------
cmd_net() {
  require_linux_kvm
  [ -n "$EGRESS_IF" ] || die "could not detect egress interface; set FC_EGRESS_IF"
  sudo sysctl -wq net.ipv4.ip_forward=1
  sudo iptables -t nat -C POSTROUTING -o "$EGRESS_IF" -j MASQUERADE 2>/dev/null \
    || sudo iptables -t nat -A POSTROUTING -o "$EGRESS_IF" -j MASQUERADE
  sudo iptables -C FORWARD -i fc-+ -o "$EGRESS_IF" -j ACCEPT 2>/dev/null \
    || sudo iptables -A FORWARD -i fc-+ -o "$EGRESS_IF" -j ACCEPT
  sudo iptables -C FORWARD -o fc-+ -i "$EGRESS_IF" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || sudo iptables -A FORWARD -o fc-+ -i "$EGRESS_IF" -m state --state RELATED,ESTABLISHED -j ACCEPT
  log "NAT enabled via $EGRESS_IF"
}

_alloc_index() {
  mkdir -p "$STATE"
  local f="$STATE/.next_index" lock="$STATE/.next_index.lock"
  # Atomic allocation so parallel `start` calls never collide on tap/IP.
  exec 9>"$lock"
  flock 9
  local n=2
  [ -f "$f" ] && n="$(cat "$f")"
  echo $(( n + 1 )) > "$f"
  flock -u 9
  exec 9>&-
  echo "$n"
}

_vmdir() { echo "$VMS/$1"; }
_ip_of() { cat "$(_vmdir "$1")/ip"; }

# ---------------------------------------------------------------------------
# start <id>
# ---------------------------------------------------------------------------
cmd_start() {
  require_linux_kvm
  local id="${1:?usage: start <id>}"
  [ -f "$ASSETS/firecracker" ] || die "missing deps; run: $0 deps"
  local d; d="$(_vmdir "$id")"
  [ -d "$d" ] && die "sandbox '$id' already exists"
  mkdir -p "$d"

  local n; n="$(_alloc_index)"
  local tap="fc-$n"
  local host_ip="172.16.$n.1" guest_ip="172.16.$n.2" mask="255.255.255.0"
  local mac; mac="$(printf '06:00:AC:10:%02X:02' "$n")"

  sudo ip link del "$tap" 2>/dev/null || true
  sudo ip tuntap add dev "$tap" mode tap
  sudo ip addr add "$host_ip/24" dev "$tap"
  sudo ip link set "$tap" up

  cp --reflink=auto "$ASSETS/rootfs.ext4" "$d/rootfs.ext4"

  cat > "$d/config.json" <<JSON
{
  "boot-source": {
    "kernel_image_path": "$ASSETS/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off ip=$guest_ip::$host_ip:$mask::eth0:off"
  },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "$d/rootfs.ext4", "is_root_device": true, "is_read_only": false }
  ],
  "machine-config": { "vcpu_count": $VCPU, "mem_size_mib": $MEM_MIB },
  "network-interfaces": [
    { "iface_id": "eth0", "guest_mac": "$mac", "host_dev_name": "$tap" }
  ]
}
JSON

  echo "$guest_ip" > "$d/ip"
  echo "$tap"      > "$d/tap"
  echo "$n"        > "$d/n"

  sudo "$ASSETS/firecracker" --api-sock "$d/fc.sock" --config-file "$d/config.json" \
    >"$d/console.log" 2>&1 &
  echo $! > "$d/pid"

  # Wait for sshd in the guest.
  local up=0
  for _ in $(seq 1 80); do
    if ssh "${SSH_OPTS[@]}" -i "$ASSETS/id_rsa" "root@$guest_ip" true 2>/dev/null; then up=1; break; fi
    sleep 0.25
  done
  [ "$up" = 1 ] || { cmd_stop "$id" >/dev/null 2>&1 || true; die "VM '$id' did not come up (see $d/console.log)"; }

  ssh "${SSH_OPTS[@]}" -i "$ASSETS/id_rsa" "root@$guest_ip" \
    "mkdir -p /workspace; echo 'nameserver 8.8.8.8' > /etc/resolv.conf" 2>/dev/null || true

  printf '{"id":"%s","ip":"%s","pid":%s,"tap":"%s","vcpus":%s,"mem_mib":%s}\n' \
    "$id" "$guest_ip" "$(cat "$d/pid")" "$tap" "$VCPU" "$MEM_MIB"
}

# exec <id> : remote script arrives on our stdin; pipe it straight into guest bash.
cmd_exec() {
  local id="${1:?usage: exec <id>}"; local d; d="$(_vmdir "$id")"
  [ -d "$d" ] || die "no such sandbox '$id'"
  exec ssh "${SSH_OPTS[@]}" -i "$ASSETS/id_rsa" "root@$(_ip_of "$id")" 'bash -ls'
}

# write <id> <path> : base64 content on stdin -> file in guest
cmd_write() {
  local id="${1:?}" path="${2:?usage: write <id> <path>}"; local d; d="$(_vmdir "$id")"
  [ -d "$d" ] || die "no such sandbox '$id'"
  local qpath; qpath="$(printf '%q' "$path")" # safe to re-parse by remote bash
  ssh "${SSH_OPTS[@]}" -i "$ASSETS/id_rsa" "root@$(_ip_of "$id")" \
    "set -e; mkdir -p \"\$(dirname $qpath)\"; base64 -d > $qpath"
}

# read <id> <path> : print base64 of file (exit 44 if missing)
cmd_read() {
  local id="${1:?}" path="${2:?usage: read <id> <path>}"; local d; d="$(_vmdir "$id")"
  [ -d "$d" ] || die "no such sandbox '$id'"
  local qpath; qpath="$(printf '%q' "$path")" # safe to re-parse by remote bash
  ssh "${SSH_OPTS[@]}" -i "$ASSETS/id_rsa" "root@$(_ip_of "$id")" \
    "test -f $qpath && base64 $qpath || exit 44"
}

# stop: kill the VM + tear down its tap, but KEEP $d so state stays consistent.
cmd_stop() {
  local id="${1:?usage: stop <id>}"; local d; d="$(_vmdir "$id")"
  [ -d "$d" ] || { log "no such sandbox '$id'"; return 0; }
  [ -f "$d/pid" ] && sudo kill "$(cat "$d/pid")" 2>/dev/null || true
  [ -f "$d/tap" ] && sudo ip link del "$(cat "$d/tap")" 2>/dev/null || true
  log "stopped '$id'"
}

# destroy: stop, then remove the VM's entire state dir (irreversible).
cmd_destroy() {
  local id="${1:?usage: destroy <id>}"; local d; d="$(_vmdir "$id")"
  cmd_stop "$id"
  rm -rf "$d"
  log "destroyed '$id'"
}

cmd_list() {
  mkdir -p "$VMS"
  for d in "$VMS"/*/; do
    [ -d "$d" ] || continue
    local id; id="$(basename "$d")"
    printf '%s\tip=%s\tpid=%s\n' "$id" "$(cat "$d/ip" 2>/dev/null)" "$(cat "$d/pid" 2>/dev/null)"
  done
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    deps)  cmd_deps "$@";;
    net)   cmd_net "$@";;
    start) cmd_start "$@";;
    exec)  cmd_exec "$@";;
    write) cmd_write "$@";;
    read)  cmd_read "$@";;
    stop)  cmd_stop "$@";;
    destroy) cmd_destroy "$@";;
    list)  cmd_list "$@";;
    *) cat >&2 <<USAGE
firecracker-sandbox.sh <subcommand>
  deps | net | start <id> | exec <id> | write <id> <path> | read <id> <path> | stop <id> | destroy <id> | list
USAGE
      exit 2;;
  esac
}
main "$@"
