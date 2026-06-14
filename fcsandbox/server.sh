#!/usr/bin/env bash
#
# server.sh — bring up the "firecracker server" (control plane) INSIDE the Linux
# host that has /dev/kvm (the Lima nested-virt VM, or an EC2 *.metal box).
#
# It (1) puts sandbox state on the guest's native disk (NOT the slow virtiofs
# mount), (2) fetches the firecracker binary + kernel + rootfs once, (3) enables
# NAT for guest egress, then (4) runs the control plane on 0.0.0.0:$PORT.
#
# Lima auto-forwards the guest port to 127.0.0.1:$PORT on the Mac, so the Pi
# harness on the Mac just points at http://127.0.0.1:$PORT.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export FC_STATE_DIR="${FC_STATE_DIR:-$HOME/fcstate}"
export PORT="${PORT:-7070}"
mkdir -p "$FC_STATE_DIR"

echo "[server] state dir: $FC_STATE_DIR"
echo "[server] fetching firecracker assets (once)…"
bash "$HERE/firecracker-sandbox.sh" deps

echo "[server] enabling NAT for guest egress…"
bash "$HERE/firecracker-sandbox.sh" net || echo "[server] (net setup skipped/failed; sandboxes still work without egress)"

echo "[server] starting control plane on 0.0.0.0:$PORT"
exec node "$HERE/control-plane.mjs"
