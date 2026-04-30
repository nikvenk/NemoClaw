#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brev launchable: NemoClaw + multi-provider + Telegram
# Source: https://github.com/nikvenk/NemoClaw
#
# This script runs automatically at VM boot and pre-installs everything.
# When you SSH in, run:  nemoclaw onboard
# The interactive wizard will ask for your provider, API key, model,
# Telegram bot token, and any other settings.

set -euo pipefail

NEMOCLAW_REPO="${NEMOCLAW_REPO:-nikvenk/NemoClaw}"
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.36}"
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${TARGET_HOME}/NemoClaw}"
LAUNCH_LOG="${LAUNCH_LOG:-/tmp/launch-plugin.log}"
SENTINEL="/var/run/nemoclaw-launchable-ready"
DOCKER_IMAGES=("ghcr.io/nvidia/nemoclaw/sandbox-base:latest" "node:22-slim")
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

mkdir -p "$(dirname "$LAUNCH_LOG")"
exec > >(tee -a "$LAUNCH_LOG") 2>&1

_ts() { date '+%H:%M:%S'; }
info() { printf '\033[0;32m[%s]\033[0m %s\n' "$(_ts)" "$1"; }
warn() { printf '\033[1;33m[%s]\033[0m %s\n' "$(_ts)" "$1"; }
fail() { printf '\033[0;31m[%s]\033[0m %s\n' "$(_ts)" "$1"; exit 1; }

retry() {
  local n="$1" s="$2" d="$3"; shift 3; local i=1
  while true; do "$@" && return 0
    ((i >= n)) && { warn "Failed after $n attempts: $d"; return 1; }
    info "Retry $i/$n: $d (${s}s)"; sleep "$s"; ((i++))
  done
}

wait_apt() {
  local w=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
     || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    ((w >= 120)) && { warn "apt lock timeout — proceeding"; return; }
    ((w % 15 == 0)) && info "Waiting for apt lock (${w}s)..."
    sleep 5; ((w += 5))
  done
}

# ── 1. System packages ────────────────────────────────────────────────────────
sudo systemctl stop unattended-upgrades 2>/dev/null || true
sudo systemctl disable unattended-upgrades 2>/dev/null || true
sudo killall -9 unattended-upgr 2>/dev/null || true
wait_apt
retry 3 10 "apt-get update" sudo apt-get update -qq
retry 3 10 "apt-get install" sudo apt-get install -y -qq ca-certificates curl git jq tar >/dev/null 2>&1
info "System packages ready"

# ── 2. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  wait_apt
  retry 3 10 "install docker" sudo apt-get install -y -qq docker.io >/dev/null 2>&1
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$TARGET_USER" 2>/dev/null || true
sudo chmod 666 /var/run/docker.sock
info "Docker ready ($(docker --version 2>/dev/null | cut -c1-40))"

# ── 3. Node.js 22 ─────────────────────────────────────────────────────────────
_node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || (( $(_node_major) < 22 )); then
  info "Installing Node.js 22..."
  NODESOURCE_URL="https://deb.nodesource.com/setup_22.x"
  NODESOURCE_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
  ns_tmp="$(mktemp)"
  curl -fsSL "$NODESOURCE_URL" -o "$ns_tmp" || { rm -f "$ns_tmp"; fail "NodeSource download failed"; }
  actual="$(sha256sum "$ns_tmp" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$ns_tmp" | awk '{print $1}')"
  [[ "$actual" == "$NODESOURCE_SHA256" ]] || { rm -f "$ns_tmp"; fail "NodeSource hash mismatch"; }
  sudo -E bash "$ns_tmp" >/dev/null 2>&1; rm -f "$ns_tmp"
  wait_apt
  retry 3 10 "install nodejs" sudo apt-get install -y -qq nodejs >/dev/null 2>&1
fi
info "Node.js $(node --version)"

# ── 4. OpenShell CLI ──────────────────────────────────────────────────────────
_os_ver() { openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo 0.0.0; }
_install_os() {
  local arch; arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)   local asset="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64|arm64)  local asset="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported arch: $arch" ;;
  esac
  local tmp; tmp="$(mktemp -d)"
  retry 3 10 "download openshell" \
    curl -fsSL -o "$tmp/$asset" \
    "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${asset}"
  tar xzf "$tmp/$asset" -C "$tmp"
  sudo install -m 755 "$tmp/openshell" /usr/local/bin/openshell
  rm -rf "$tmp"
}
if ! command -v openshell >/dev/null 2>&1 || [[ "$(_os_ver)" != "${OPENSHELL_VERSION#v}" ]]; then
  info "Installing OpenShell ${OPENSHELL_VERSION}..."
  _install_os
fi
info "OpenShell $(openshell --version 2>&1 || echo unknown)"

# ── 5. Clone fork + build ─────────────────────────────────────────────────────
# Cloning nikvenk/NemoClaw compiles the tool-call fix for NVIDIA Endpoints
# (forces openai-completions so Nemotron models execute tools correctly).
if [[ -d "$NEMOCLAW_CLONE_DIR/.git" ]]; then
  git -C "$NEMOCLAW_CLONE_DIR" fetch origin "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" checkout "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" pull --ff-only origin "$NEMOCLAW_REF" || true
else
  info "Cloning ${NEMOCLAW_REPO}@${NEMOCLAW_REF}..."
  git clone --branch "$NEMOCLAW_REF" --depth 1 \
    "https://github.com/${NEMOCLAW_REPO}.git" "$NEMOCLAW_CLONE_DIR"
fi

# Pre-pull Docker images in background while npm builds
if [[ "${SKIP_DOCKER_PULL:-0}" != "1" ]]; then
  (
    CLUSTER_TAG="${OPENSHELL_VERSION#v}"
    for img in "${DOCKER_IMAGES[@]}" "ghcr.io/nvidia/openshell/cluster:${CLUSTER_TAG}"; do
      sg docker -c "docker pull $img" 2>&1 | tail -1 &
    done
    wait
  ) &
  PULL_PID=$!
else
  PULL_PID=""
fi

info "Building NemoClaw CLI from fork..."
cd "$NEMOCLAW_CLONE_DIR"
npm install --ignore-scripts 2>&1 | tail -2
npm run build:cli 2>&1 | tail -2
cd nemoclaw && npm install --ignore-scripts 2>&1 | tail -1 && npm run build 2>&1 | tail -1
cd "$NEMOCLAW_CLONE_DIR"

sudo ln -sf "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js" /usr/local/bin/nemoclaw
sudo chmod +x "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js"
info "nemoclaw $(nemoclaw --version 2>/dev/null || echo unknown) linked"

[[ -n "$PULL_PID" ]] && { wait "$PULL_PID" || warn "Some Docker pulls failed (will pull at onboard time)"; }

# ── 6. Install configure script and write MOTD ────────────────────────────────
sudo cp "$NEMOCLAW_CLONE_DIR/scripts/nemoclaw-configure.sh" /usr/local/bin/nemoclaw-configure
sudo chmod +x /usr/local/bin/nemoclaw-configure

cat > /etc/motd << 'MOTD'

  ╔══════════════════════════════════════════════════════════════╗
  ║           NemoClaw — Ready to Configure                      ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Run the configuration wizard to set up your AI assistant:   ║
  ║                                                              ║
  ║    nemoclaw-configure                                        ║
  ║                                                              ║
  ║  It will ask you to choose:                                  ║
  ║    • Inference provider (NVIDIA, OpenAI, Anthropic, Gemini)  ║
  ║    • API key for that provider                               ║
  ║    • Model (e.g. nvidia/nemotron-3-super-120b-a12b, gpt-4o)  ║
  ║    • Telegram bot token (optional)                           ║
  ║    • Telegram allowed user IDs (optional)                    ║
  ║                                                              ║
  ║  After setup:                                                ║
  ║    nemoclaw my-assistant connect   → enter sandbox           ║
  ║    openclaw tui                    → open chat UI            ║
  ╚══════════════════════════════════════════════════════════════╝

MOTD

# ── 7. Sentinel ───────────────────────────────────────────────────────────────
sudo touch "$SENTINEL"
echo "=== Ready ===" | sudo tee -a "$LAUNCH_LOG" >/dev/null
info "Pre-installation complete. SSH in and run: nemoclaw onboard"
