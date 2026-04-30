#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brev launchable startup script — NemoClaw + Multi-Provider + Telegram
#
# Installs NemoClaw from the fork (nikvenk/NemoClaw), runs non-interactive
# onboarding with a user-chosen inference provider and optional Telegram bridge.
#
# Fixes included vs. the upstream default launchable:
#   1. Provider-aware credential routing: only the API key for the selected
#      provider is exported.  The upstream launchable hard-codes NVIDIA_API_KEY,
#      which causes HTTP 401 when OpenAI, Anthropic, or Gemini is selected.
#   2. NVIDIA Endpoints tool-call fix: forces openai-completions for the
#      "build" (NVIDIA Endpoints) provider so Nemotron models execute tools
#      through structured tool_calls instead of printing raw XML markup.
#      The fix is in src/lib/onboard.ts and compiled automatically below.
#   3. Telegram first-class support: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_IDS
#      are read from environment and passed to nemoclaw onboard.
#
# ── Required environment variables ───────────────────────────────────────────
#
#   NEMOCLAW_PROVIDER   Inference provider.  One of:
#                         cloud                — NVIDIA Endpoints (build.nvidia.com)
#                         openai               — OpenAI API
#                         anthropic            — Anthropic API
#                         gemini               — Google Gemini
#                         compatible-endpoint  — Any OpenAI-compatible endpoint
#
#   Then provide the matching API key:
#     cloud               → NVIDIA_API_KEY     (nvapi-* from build.nvidia.com)
#     openai              → OPENAI_API_KEY
#     anthropic           → ANTHROPIC_API_KEY
#     gemini              → GEMINI_API_KEY
#     compatible-endpoint → COMPATIBLE_API_KEY (optional) + NEMOCLAW_ENDPOINT_URL
#
#   NEMOCLAW_MODEL      Model ID for the chosen provider, e.g.:
#                         nvidia/nemotron-3-super-120b-a12b  (cloud)
#                         gpt-4o                              (openai)
#                         claude-sonnet-4-6                   (anthropic)
#
# ── Optional environment variables ───────────────────────────────────────────
#
#   TELEGRAM_BOT_TOKEN    Bot token from @BotFather.  Leave empty to skip Telegram.
#   TELEGRAM_ALLOWED_IDS  Comma-separated Telegram user IDs allowed to DM the bot.
#
#   NEMOCLAW_SANDBOX_NAME  Name for the sandbox (default: my-assistant)
#   NEMOCLAW_POLICY_TIER   restricted | balanced (default) | open
#
#   NEMOCLAW_REPO          GitHub repo to clone (default: nikvenk/NemoClaw)
#   NEMOCLAW_REF           Branch/tag/commit to use  (default: main)
#   OPENSHELL_VERSION      OpenShell CLI release tag  (default: v0.0.36)
#   SKIP_DOCKER_PULL       Set to 1 to skip pre-pulling Docker images
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#
#   Paste this script in the Brev Console → Launchables → Create Launchable
#   → Step 2 (Environment → Setup Script).  Configure the environment variables
#   listed above as inputs on the launchable deploy page.
#
#   Or curl it directly on an existing Brev instance:
#     curl -fsSL https://raw.githubusercontent.com/nikvenk/NemoClaw/main/scripts/brev-setup-openai-telegram.sh | bash
#
# ── Readiness detection ───────────────────────────────────────────────────────
#
#   Writes /var/run/nemoclaw-launchable-ready when complete.
#   Also appends "=== Ready ===" to /tmp/launch-plugin.log.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-cloud}"
NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-}"
NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-balanced}"

NEMOCLAW_REPO="${NEMOCLAW_REPO:-nikvenk/NemoClaw}"
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.36}"

TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${TARGET_HOME}/NemoClaw}"

LAUNCH_LOG="${LAUNCH_LOG:-/tmp/launch-plugin.log}"
SENTINEL="/var/run/nemoclaw-launchable-ready"

DOCKER_IMAGES=(
  "ghcr.io/nvidia/nemoclaw/sandbox-base:latest"
  "node:22-slim"
)

# ── Suppress apt noise ────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# ── Logging ───────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$LAUNCH_LOG")"
exec > >(tee -a "$LAUNCH_LOG") 2>&1

_ts() { date '+%H:%M:%S'; }
info() { printf '\033[0;32m[%s setup]\033[0m %s\n' "$(_ts)" "$1"; }
warn() { printf '\033[1;33m[%s setup]\033[0m %s\n' "$(_ts)" "$1"; }
fail() {
  printf '\033[0;31m[%s setup]\033[0m %s\n' "$(_ts)" "$1"
  exit 1
}

# ── Retry helper ──────────────────────────────────────────────────────────────
retry() {
  local max_attempts="$1" sleep_sec="$2" desc="$3"
  shift 3
  local attempt=1
  while true; do
    if "$@"; then return 0; fi
    if ((attempt >= max_attempts)); then
      warn "Failed after $max_attempts attempts: $desc"
      return 1
    fi
    info "Retry $attempt/$max_attempts for: $desc (sleeping ${sleep_sec}s)"
    sleep "$sleep_sec"
    ((attempt++))
  done
}

# ── Wait for apt locks ────────────────────────────────────────────────────────
wait_for_apt_lock() {
  local max_wait=120 elapsed=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
    || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if ((elapsed >= max_wait)); then
      warn "apt lock not released after ${max_wait}s — proceeding anyway"
      return 0
    fi
    if ((elapsed % 15 == 0)); then
      info "Waiting for apt lock... (${elapsed}s)"
    fi
    sleep 5
    ((elapsed += 5))
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# 0.  Validate credentials early — fail fast before spending time on installs
# ══════════════════════════════════════════════════════════════════════════════
info "Provider: $NEMOCLAW_PROVIDER"

case "$NEMOCLAW_PROVIDER" in
  cloud)
    [[ -n "${NVIDIA_API_KEY:-}" ]] \
      || fail "NVIDIA_API_KEY is required for provider=cloud (nvapi-* key from build.nvidia.com)"
    export NVIDIA_API_KEY
    ;;
  openai)
    [[ -n "${OPENAI_API_KEY:-}" ]] \
      || fail "OPENAI_API_KEY is required for provider=openai"
    export OPENAI_API_KEY
    # Ensure NVIDIA_API_KEY is absent so onboard doesn't try to validate it
    unset NVIDIA_API_KEY 2>/dev/null || true
    ;;
  anthropic)
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] \
      || fail "ANTHROPIC_API_KEY is required for provider=anthropic"
    export ANTHROPIC_API_KEY
    unset NVIDIA_API_KEY 2>/dev/null || true
    ;;
  gemini)
    [[ -n "${GEMINI_API_KEY:-}" ]] \
      || fail "GEMINI_API_KEY is required for provider=gemini"
    export GEMINI_API_KEY
    unset NVIDIA_API_KEY 2>/dev/null || true
    ;;
  compatible-endpoint)
    [[ -n "${NEMOCLAW_ENDPOINT_URL:-}" ]] \
      || fail "NEMOCLAW_ENDPOINT_URL is required for provider=compatible-endpoint"
    export NEMOCLAW_ENDPOINT_URL
    export COMPATIBLE_API_KEY="${COMPATIBLE_API_KEY:-dummy}"
    unset NVIDIA_API_KEY 2>/dev/null || true
    ;;
  *)
    fail "Unknown NEMOCLAW_PROVIDER='$NEMOCLAW_PROVIDER'. Valid: cloud | openai | anthropic | gemini | compatible-endpoint"
    ;;
esac

# ── Telegram (optional) ───────────────────────────────────────────────────────
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
export TELEGRAM_ALLOWED_IDS="${TELEGRAM_ALLOWED_IDS:-}"

if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
  info "Telegram: enabled (bot token set)"
else
  info "Telegram: disabled (TELEGRAM_BOT_TOKEN not set)"
fi

# ── Non-interactive onboard flags ─────────────────────────────────────────────
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME
export NEMOCLAW_POLICY_TIER
[[ -n "$NEMOCLAW_MODEL" ]] && export NEMOCLAW_MODEL

# ══════════════════════════════════════════════════════════════════════════════
# 1. System packages
# ══════════════════════════════════════════════════════════════════════════════
sudo systemctl stop unattended-upgrades 2>/dev/null || true
sudo systemctl disable unattended-upgrades 2>/dev/null || true
sudo killall -9 unattended-upgr 2>/dev/null || true

info "Installing system packages..."
wait_for_apt_lock
retry 3 10 "apt-get update" sudo apt-get update -qq
retry 3 10 "apt-get install" sudo apt-get install -y -qq \
  ca-certificates curl git jq tar >/dev/null 2>&1
info "System packages installed"

# ══════════════════════════════════════════════════════════════════════════════
# 2. Docker
# ══════════════════════════════════════════════════════════════════════════════
if command -v docker >/dev/null 2>&1; then
  info "Docker already installed"
else
  info "Installing Docker..."
  wait_for_apt_lock
  retry 3 10 "install docker" sudo apt-get install -y -qq docker.io >/dev/null 2>&1
  info "Docker installed"
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$TARGET_USER" 2>/dev/null || true
sudo chmod 666 /var/run/docker.sock
info "Docker enabled ($(docker --version 2>/dev/null | head -c 40))"

# ══════════════════════════════════════════════════════════════════════════════
# 3. Node.js 22
# ══════════════════════════════════════════════════════════════════════════════
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi

if command -v npm >/dev/null 2>&1 && [[ -n "$node_major" ]] && ((node_major >= 22)); then
  info "Node.js already installed: $(node --version)"
else
  info "Installing Node.js 22..."
  # Update NODESOURCE_SHA256 if the setup_22.x URL content changes.
  NODESOURCE_URL="https://deb.nodesource.com/setup_22.x"
  NODESOURCE_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
  ns_tmp="$(mktemp)"
  curl -fsSL "$NODESOURCE_URL" -o "$ns_tmp" \
    || { rm -f "$ns_tmp"; fail "Failed to download NodeSource installer"; }
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$ns_tmp" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$ns_tmp" | awk '{print $1}')"
  else
    warn "No SHA-256 tool found — skipping NodeSource integrity check"
    actual_hash="$NODESOURCE_SHA256"
  fi
  if [[ "$actual_hash" != "$NODESOURCE_SHA256" ]]; then
    rm -f "$ns_tmp"
    fail "NodeSource installer integrity check failed\n  Expected: $NODESOURCE_SHA256\n  Actual:   $actual_hash"
  fi
  info "NodeSource installer verified"
  sudo -E bash "$ns_tmp" >/dev/null 2>&1
  rm -f "$ns_tmp"
  wait_for_apt_lock
  retry 3 10 "install nodejs" sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  info "Node.js $(node --version) installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 4. OpenShell CLI
# ══════════════════════════════════════════════════════════════════════════════
install_openshell() {
  local version="$1"
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64)  ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64 | arm64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac
  local tmpdir
  tmpdir="$(mktemp -d)"
  retry 3 10 "download openshell" \
    curl -fsSL -o "$tmpdir/$ASSET" \
    "https://github.com/NVIDIA/OpenShell/releases/download/${version}/${ASSET}"
  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
}

if command -v openshell >/dev/null 2>&1; then
  _installed_ver="$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '0.0.0')"
  _pinned_ver="${OPENSHELL_VERSION#v}"
  if [[ "$_installed_ver" == "$_pinned_ver" ]]; then
    info "OpenShell CLI already at pinned version: $_installed_ver"
  else
    info "OpenShell $_installed_ver → upgrading to ${_pinned_ver}..."
    install_openshell "$OPENSHELL_VERSION"
    info "OpenShell CLI upgraded: $(openshell --version 2>&1 || echo unknown)"
  fi
else
  info "Installing OpenShell CLI ${OPENSHELL_VERSION}..."
  install_openshell "$OPENSHELL_VERSION"
  info "OpenShell CLI installed: $(openshell --version 2>&1 || echo unknown)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 5. Clone fork and build NemoClaw
#
#    Cloning from nikvenk/NemoClaw (the fork) ensures the tool-call fix in
#    src/lib/onboard.ts is compiled into the binary.  The fix forces the
#    "build" (NVIDIA Endpoints) provider to use openai-completions so that
#    Nemotron models return structured tool_calls instead of raw XML markup.
# ══════════════════════════════════════════════════════════════════════════════
REPO_URL="https://github.com/${NEMOCLAW_REPO}.git"

if [[ -d "$NEMOCLAW_CLONE_DIR/.git" ]]; then
  info "NemoClaw repo exists at $NEMOCLAW_CLONE_DIR — refreshing to $NEMOCLAW_REF..."
  git -C "$NEMOCLAW_CLONE_DIR" fetch origin "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" checkout "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" pull --ff-only origin "$NEMOCLAW_REF" || true
else
  info "Cloning ${NEMOCLAW_REPO} (ref: $NEMOCLAW_REF)..."
  git clone --branch "$NEMOCLAW_REF" --depth 1 "$REPO_URL" "$NEMOCLAW_CLONE_DIR"
fi

# ── Pre-pull Docker images in background (parallel with npm install) ──────────
DOCKER_PULL_PID=""
if [[ "${SKIP_DOCKER_PULL:-0}" != "1" ]]; then
  info "Pre-pulling Docker images in background..."
  (
    CLUSTER_TAG="${OPENSHELL_VERSION#v}"
    CLUSTER_IMAGE="ghcr.io/nvidia/openshell/cluster:${CLUSTER_TAG}"
    for image in "${DOCKER_IMAGES[@]}" "$CLUSTER_IMAGE"; do
      sg docker -c "docker pull $image" 2>&1 | tail -1 &
    done
    wait
    if ! sg docker -c "docker image inspect $CLUSTER_IMAGE" >/dev/null 2>&1; then
      warn "  Could not pull ${CLUSTER_IMAGE} — trying :latest"
      sg docker -c "docker pull ghcr.io/nvidia/openshell/cluster:latest" 2>&1 | tail -1 \
        || warn "  Failed to pull openshell/cluster:latest (will be pulled at onboard time)"
    fi
  ) &
  DOCKER_PULL_PID=$!
fi

# ── Build NemoClaw from source ────────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$NEMOCLAW_CLONE_DIR"
npm install --ignore-scripts 2>&1 | tail -3
info "Root deps installed"

info "Compiling TypeScript CLI (dist/)..."
npm run build:cli 2>&1 | tail -3
info "CLI compiled — tool-call fix for NVIDIA Endpoints is now active"

info "Building TypeScript plugin..."
cd "$NEMOCLAW_CLONE_DIR/nemoclaw"
npm install --ignore-scripts 2>&1 | tail -3
npm run build 2>&1 | tail -3
cd "$NEMOCLAW_CLONE_DIR"
info "Plugin built"

# ── Link binary ───────────────────────────────────────────────────────────────
info "Linking nemoclaw CLI..."
sudo ln -sf "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js" /usr/local/bin/nemoclaw
sudo chmod +x "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js"
info "nemoclaw CLI linked at /usr/local/bin/nemoclaw → $(nemoclaw --version 2>/dev/null || echo unknown)"

# ══════════════════════════════════════════════════════════════════════════════
# 6. Wait for Docker image pre-pulls
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$DOCKER_PULL_PID" ]]; then
  info "Waiting for background Docker pulls..."
  wait "$DOCKER_PULL_PID" || warn "Some Docker pulls failed (will be pulled at onboard time)"
  info "Docker images ready"
elif [[ "${SKIP_DOCKER_PULL:-0}" == "1" ]]; then
  info "Skipping Docker image pre-pulls (SKIP_DOCKER_PULL=1)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 7. Run nemoclaw onboard
# ══════════════════════════════════════════════════════════════════════════════
info "Running nemoclaw onboard (provider=$NEMOCLAW_PROVIDER, sandbox=$NEMOCLAW_SANDBOX_NAME)..."

nemoclaw onboard --non-interactive --yes-i-accept-third-party-software

# ══════════════════════════════════════════════════════════════════════════════
# 8. Readiness sentinel
# ══════════════════════════════════════════════════════════════════════════════
sudo touch "$SENTINEL"
echo "=== Ready ===" | sudo tee -a "$LAUNCH_LOG" >/dev/null

info "════════════════════════════════════════════════════════"
info "  NemoClaw launchable setup complete"
info "  Repo:      ${NEMOCLAW_REPO} @ ${NEMOCLAW_REF}"
info "  Provider:  $NEMOCLAW_PROVIDER"
[[ -n "$NEMOCLAW_MODEL" ]] && info "  Model:     $NEMOCLAW_MODEL"
[[ -n "$TELEGRAM_BOT_TOKEN" ]] && info "  Telegram:  enabled"
info "  Sandbox:   $NEMOCLAW_SANDBOX_NAME"
info "  Policy:    $NEMOCLAW_POLICY_TIER"
info "  OpenShell: $(openshell --version 2>&1 || echo unknown)"
info "  Node.js:   $(node --version)"
info "  Docker:    $(docker --version 2>/dev/null | head -c 40)"
info "  Sentinel:  $SENTINEL"
info "════════════════════════════════════════════════════════"
info ""
info "  Connect:  nemoclaw ${NEMOCLAW_SANDBOX_NAME} connect"
info "  Chat:     openclaw tui"
info "  Status:   nemoclaw ${NEMOCLAW_SANDBOX_NAME} status"
info "════════════════════════════════════════════════════════"
