#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Set up the config mutability E2E demo from scratch.
#
# Assumes NOTHING is running. Builds everything from source.
# At the end, prints instructions for the two-terminal interactive demo.
#
# Prerequisites (will error if missing):
#   - Docker running (Colima or Docker Desktop)
#   - mise (https://mise.jdx.dev)
#   - cargo (Rust toolchain)
#   - bash 4+ (macOS ships 3.2; install via: brew install bash)
#   - NVIDIA_API_KEY set
#   - GITHUB_TOKEN set (or gh auth login)
#
# Usage:
#   bash scripts/setup-e2e-demo.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENSHELL_SOURCE="/tmp/openshell-source"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
GATEWAY_NAME="openshell-source"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

step() {
  echo -e "\n${GREEN}═══════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}▸ $1${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
}
info() { echo -e "  ${CYAN}$1${NC}"; }
err() {
  echo -e "  ${RED}$1${NC}" >&2
  exit 1
}
ok() { echo -e "  ${GREEN}✓ $1${NC}"; }

# ══════════════════════════════════════════════════════════════════
# Step 0: Check prerequisites
# ══════════════════════════════════════════════════════════════════
step "0. Checking prerequisites"

command -v docker >/dev/null 2>&1 || err "docker not found. Install Docker Desktop or Colima."
docker info >/dev/null 2>&1 || err "Docker is not running. Start it first."
ok "Docker running"

command -v mise >/dev/null 2>&1 || err "mise not found. Install: curl https://mise.run | sh"
ok "mise installed ($(mise --version 2>&1 | head -1))"

command -v cargo >/dev/null 2>&1 || err "cargo not found. Install Rust: https://rustup.rs"
ok "cargo installed"

# Check bash version (mapfile requires bash 4+)
BASH_MAJOR="${BASH_VERSINFO[0]}"
if [[ "$BASH_MAJOR" -lt 4 ]]; then
  err "bash $BASH_VERSION is too old (need 4+). Install: brew install bash"
fi
ok "bash $BASH_VERSION"

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  err "NVIDIA_API_KEY not set"
fi
ok "NVIDIA_API_KEY set"

# Resolve GitHub token for mise (avoids API rate limits)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1; then
    GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
    export GITHUB_TOKEN
  fi
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  err "GITHUB_TOKEN not set and gh CLI not authenticated. Run: gh auth login"
fi
export MISE_GITHUB_TOKEN="$GITHUB_TOKEN"
export MISE_AQUA_SKIP_VERIFY=1
ok "GitHub token available"

# ══════════════════════════════════════════════════════════════════
# Step 1: Clean everything from previous runs
# ══════════════════════════════════════════════════════════════════
step "1. Cleaning previous state"

pkill -f openshell 2>/dev/null || true
openshell gateway destroy -g "$GATEWAY_NAME" 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
docker rm -f "openshell-cluster-${GATEWAY_NAME}" 2>/dev/null || true
docker volume rm "openshell-cluster-${GATEWAY_NAME}" 2>/dev/null || true
docker rm -f openshell-cluster-nemoclaw 2>/dev/null || true
docker volume rm openshell-cluster-nemoclaw 2>/dev/null || true
lsof -ti :8080,:18789 2>/dev/null | xargs kill 2>/dev/null || true
docker buildx prune -af 2>/dev/null || true
docker images --format '{{.Repository}}:{{.Tag}}' | grep openshell | xargs -r docker rmi -f 2>/dev/null || true
rm -rf "$OPENSHELL_SOURCE"
ok "Clean slate"

# ══════════════════════════════════════════════════════════════════
# Step 2: Clone OpenShell and apply patch
# ══════════════════════════════════════════════════════════════════
step "2. Cloning OpenShell and applying config-approval patch"

# Read min_openshell_version from blueprint
OS_VERSION="$(sed -nE 's/^min_openshell_version:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/nemoclaw-blueprint/blueprint.yaml" | head -1)"
OS_VERSION="${OS_VERSION:-0.0.15}"
info "OpenShell version: v${OS_VERSION} (from blueprint.yaml)"

git clone --branch "v${OS_VERSION}" --depth 1 https://github.com/NVIDIA/OpenShell.git "$OPENSHELL_SOURCE"
cd "$OPENSHELL_SOURCE"
git apply "$ROOT/patches/openshell-config-approval.patch"
ok "Patch applied"

# ══════════════════════════════════════════════════════════════════
# Step 3: Build patched OpenShell and deploy cluster
# ══════════════════════════════════════════════════════════════════
step "3. Building patched OpenShell from source (mise run cluster)"
info "This builds gateway + cluster Docker images from Rust source"
info "and deploys a local k3s cluster. Takes ~10-15 min on first run."

cd "$OPENSHELL_SOURCE"
mise trust
mise run cluster
ok "Cluster deployed with patched OpenShell"

# ══════════════════════════════════════════════════════════════════
# Step 4: Build patched CLI binary
# ══════════════════════════════════════════════════════════════════
step "4. Building patched openshell CLI"
info "Compiling openshell-cli with config approval TUI support..."

cd "$OPENSHELL_SOURCE"
cargo build --release -p openshell-cli --features openshell-core/dev-settings

OPENSHELL_BIN="$(command -v openshell 2>/dev/null || echo "$HOME/.local/bin/openshell")"
mkdir -p "$(dirname "$OPENSHELL_BIN")"
cp "$OPENSHELL_SOURCE/target/release/openshell" "$OPENSHELL_BIN"
ok "Installed patched CLI: $(openshell --version 2>&1)"

# ══════════════════════════════════════════════════════════════════
# Step 5: Create NemoClaw sandbox on the patched gateway
# ══════════════════════════════════════════════════════════════════
step "5. Creating NemoClaw sandbox"
info "Staging build context and building sandbox Docker image..."

cd "$ROOT"
BUILDCTX="$(mktemp -d)"
cp Dockerfile "$BUILDCTX/"
cp -r nemoclaw "$BUILDCTX/nemoclaw"
cp -r nemoclaw-blueprint "$BUILDCTX/nemoclaw-blueprint"
cp -r scripts "$BUILDCTX/scripts"
cp -r patches "$BUILDCTX/patches"
rm -rf "$BUILDCTX/nemoclaw/node_modules"

openshell sandbox create \
  --from "$BUILDCTX/Dockerfile" \
  --name "$SANDBOX_NAME" \
  --policy nemoclaw-blueprint/policies/openclaw-sandbox.yaml \
  -g "$GATEWAY_NAME" \
  -- echo ready

rm -rf "$BUILDCTX"

# Wait for Ready
info "Waiting for sandbox to be ready..."
for _ in $(seq 1 30); do
  if openshell sandbox list -g "$GATEWAY_NAME" 2>/dev/null | grep -q "$SANDBOX_NAME.*Ready"; then
    break
  fi
  sleep 2
done
openshell sandbox list -g "$GATEWAY_NAME"
ok "Sandbox '$SANDBOX_NAME' is ready"

# Register in NemoClaw registry so nemoclaw CLI commands work
mkdir -p "$HOME/.nemoclaw"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
if [[ -f "$REGISTRY" ]]; then
  node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('$REGISTRY', 'utf8'));
    r.sandboxes = r.sandboxes || {};
    r.sandboxes['$SANDBOX_NAME'] = {
      name: '$SANDBOX_NAME',
      createdAt: new Date().toISOString(),
      model: null, nimContainer: null, provider: null, gpuEnabled: false, policies: []
    };
    fs.writeFileSync('$REGISTRY', JSON.stringify(r, null, 2));
  "
else
  node -e "
    const fs = require('fs');
    fs.writeFileSync('$REGISTRY', JSON.stringify({
      sandboxes: {
        '$SANDBOX_NAME': {
          name: '$SANDBOX_NAME',
          createdAt: new Date().toISOString(),
          model: null, nimContainer: null, provider: null, gpuEnabled: false, policies: []
        }
      },
      defaultSandbox: '$SANDBOX_NAME'
    }, null, 2));
  "
fi
ok "Registered in NemoClaw registry"

# ══════════════════════════════════════════════════════════════════
# Done — print instructions
# ══════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Setup complete. Ready for the interactive demo.         ║${NC}"
echo -e "${GREEN}║                                                          ║${NC}"
echo -e "${GREEN}║  Open TWO terminals:                                     ║${NC}"
echo -e "${GREEN}║                                                          ║${NC}"
echo -e "${GREEN}║  Terminal 1 (TUI):                                       ║${NC}"
echo -e "${GREEN}║    openshell term -g ${GATEWAY_NAME}$(printf '%*s' $((23 - ${#GATEWAY_NAME})) '')║${NC}"
echo -e "${GREEN}║                                                          ║${NC}"
echo -e "${GREEN}║  Terminal 2 (demo):                                      ║${NC}"
echo -e "${GREEN}║    NEMOCLAW_SANDBOX_NAME=${SANDBOX_NAME} \\${NC}"
echo -e "${GREEN}║      OPENSHELL_GATEWAY=${GATEWAY_NAME} \\${NC}"
echo -e "${GREEN}║      bash scripts/poc-round-trip-test.sh                 ║${NC}"
echo -e "${GREEN}║                                                          ║${NC}"
echo -e "${GREEN}║  The demo script pauses at each step. When it says       ║${NC}"
echo -e "${GREEN}║  'Switch to Terminal 1', look for the CONFIG chunk       ║${NC}"
echo -e "${GREEN}║  in the TUI and press [a] to approve.                    ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
