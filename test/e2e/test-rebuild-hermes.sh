#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes rebuild upgrade E2E — same scenario as NVBug 6076156 but for Hermes:
#
#   1. Build a Hermes base image with an OLDER version (v2026.3.0)
#   2. Onboard a sandbox with --agent hermes using that old image
#   3. Write marker files into Hermes state dirs
#   4. Run `nemoclaw <name> rebuild --yes`
#   5. Verify marker files survived the rebuild
#   6. Verify the sandbox now reports the CURRENT Hermes version
#   7. Verify no credentials leaked into the local backup
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-rebuild-hm)

set -euo pipefail

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-rebuild-hm}"
OLD_HERMES_VERSION="v2026.3.0"
MARKER_FILE="/sandbox/.hermes-data/memories/rebuild-marker.txt"
MARKER_CONTENT="REBUILD_HM_E2E_$(date +%s)"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

info "Hermes rebuild upgrade E2E (old: ${OLD_HERMES_VERSION}, sandbox: ${SANDBOX_NAME})"

# ── Step 1: Build old Hermes base image ─────────────────────────────
info "Step 1: Building Hermes base image with ${OLD_HERMES_VERSION}..."

OLD_BASE_TAG="nemoclaw-hermes-old-base:e2e-rebuild"
docker build \
  --build-arg "HERMES_VERSION=${OLD_HERMES_VERSION}" \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
  -t "${OLD_BASE_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old Hermes base image"

pass "Old Hermes base image built (${OLD_HERMES_VERSION})"

# ── Step 2: Build Hermes sandbox image from old base ────────────────
info "Step 2: Building Hermes sandbox image from old base..."

OLD_SANDBOX_TAG="nemoclaw-hermes-old-sandbox:e2e-rebuild"
docker build \
  --build-arg "BASE_IMAGE=${OLD_BASE_TAG}" \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
  -t "${OLD_SANDBOX_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old Hermes sandbox image"

# Verify old version baked in
OLD_VERSION_CHECK=$(docker run --rm "${OLD_SANDBOX_TAG}" hermes --version 2>/dev/null || true)
info "Old Hermes image version: ${OLD_VERSION_CHECK}"

pass "Old Hermes sandbox image built"

# ── Step 3: Onboard with old Hermes image ───────────────────────────
info "Step 3: Onboarding sandbox with old Hermes image..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_AGENT=hermes

# Tag the old image as the expected GHCR name so onboard picks it up
docker tag "${OLD_SANDBOX_TAG}" "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest"

nemoclaw onboard \
  --sandbox-name "$SANDBOX_NAME" \
  --agent hermes \
  --non-interactive \
  --accept-third-party-software \
  --recreate-sandbox \
  || fail "Onboard with old Hermes image failed"

pass "Hermes sandbox created with old version"

# ── Step 4: Write marker files ──────────────────────────────────────
info "Step 4: Writing marker files into Hermes state dirs..."

openshell sandbox exec "$SANDBOX_NAME" -- \
  sh -c "mkdir -p /sandbox/.hermes-data/memories && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

VERIFY=$(openshell sandbox exec "$SANDBOX_NAME" -- cat "$MARKER_FILE" 2>/dev/null || true)
[ "$VERIFY" = "$MARKER_CONTENT" ] || fail "Marker verification failed"

pass "Marker file written and verified"

# ── Step 5: Rebuild ─────────────────────────────────────────────────
info "Step 5: Running rebuild..."

# Restore the current Hermes base image so rebuild picks up the new version
docker build \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
  -t "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest" \
  "${REPO_ROOT}" \
  || fail "Failed to rebuild current Hermes base image"

nemoclaw "$SANDBOX_NAME" rebuild --yes \
  || fail "Rebuild failed"

pass "Rebuild completed"

# ── Step 6: Verify marker files survived ────────────────────────────
info "Step 6: Verifying marker files survived..."

RESTORED=$(openshell sandbox exec "$SANDBOX_NAME" -- cat "$MARKER_FILE" 2>/dev/null || true)
if [ "$RESTORED" = "$MARKER_CONTENT" ]; then
  pass "Marker file survived rebuild"
else
  fail "Marker file lost: got '${RESTORED}', expected '${MARKER_CONTENT}'"
fi

# ── Step 7: Verify version upgraded ─────────────────────────────────
info "Step 7: Verifying Hermes version upgraded..."

NEW_VERSION=$(openshell sandbox exec "$SANDBOX_NAME" -- hermes --version 2>/dev/null || true)
info "New Hermes version: ${NEW_VERSION}"

# Check registry
REGISTRY_VERSION=$(python3 -c "
import json
with open('${REGISTRY_FILE}') as f:
    data = json.load(f)
sb = data.get('sandboxes', {}).get('${SANDBOX_NAME}', {})
print(sb.get('agentVersion', 'null'))
" 2>/dev/null || echo "error")

if [ "$REGISTRY_VERSION" != "null" ] && [ "$REGISTRY_VERSION" != "error" ]; then
  pass "Registry agentVersion updated to ${REGISTRY_VERSION}"
else
  fail "Registry agentVersion not updated: ${REGISTRY_VERSION}"
fi

# ── Step 8: Check backup for credentials ────────────────────────────
info "Step 8: Checking backup for leaked credentials..."

BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/$SANDBOX_NAME"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" -name "*.json" -name "*.yaml" -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
  if [ -z "$CRED_LEAKS" ]; then
    pass "No credentials in backup"
  else
    fail "Credentials found: $CRED_LEAKS"
  fi
fi

# ── Cleanup ─────────────────────────────────────────────────────────
info "Cleaning up..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
docker rmi "${OLD_BASE_TAG}" "${OLD_SANDBOX_TAG}" 2>/dev/null || true

echo ""
echo -e "${GREEN}Hermes rebuild upgrade E2E passed.${NC}"
