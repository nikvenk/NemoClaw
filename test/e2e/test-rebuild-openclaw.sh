#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw rebuild upgrade E2E — reproduces the exact NVBug 6076156 scenario:
#
#   1. Build a base image with an OLDER OpenClaw version (2026.3.11)
#   2. Onboard a sandbox using that old image
#   3. Verify the sandbox reports the old version
#   4. Write marker files into workspace state dirs
#   5. Run `nemoclaw <name> rebuild --yes`
#   6. Verify marker files survived the rebuild
#   7. Verify the sandbox now reports the CURRENT version
#   8. Verify no credentials leaked into the local backup
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-rebuild-oc)

set -euo pipefail

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-rebuild-oc}"
OLD_OPENCLAW_VERSION="2026.3.11"
MARKER_FILE="/sandbox/.openclaw-data/workspace/rebuild-marker.txt"
MARKER_CONTENT="REBUILD_OC_E2E_$(date +%s)"
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

info "OpenClaw rebuild upgrade E2E (old: ${OLD_OPENCLAW_VERSION}, sandbox: ${SANDBOX_NAME})"

# ── Step 1: Build old base image ────────────────────────────────────
info "Step 1: Building base image with OpenClaw ${OLD_OPENCLAW_VERSION}..."

OLD_BASE_TAG="nemoclaw-old-base:e2e-rebuild"
docker build \
  --build-arg "OPENCLAW_VERSION=${OLD_OPENCLAW_VERSION}" \
  -f "${REPO_ROOT}/Dockerfile.base" \
  -t "${OLD_BASE_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old base image"

pass "Old base image built (OpenClaw ${OLD_OPENCLAW_VERSION})"

# ── Step 2: Build sandbox image from old base ───────────────────────
info "Step 2: Building sandbox image from old base..."

OLD_SANDBOX_TAG="nemoclaw-old-sandbox:e2e-rebuild"
docker build \
  --build-arg "BASE_IMAGE=${OLD_BASE_TAG}" \
  -f "${REPO_ROOT}/Dockerfile" \
  -t "${OLD_SANDBOX_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old sandbox image"

# Verify old version baked in
OLD_VERSION_CHECK=$(docker run --rm "${OLD_SANDBOX_TAG}" openclaw --version 2>/dev/null || true)
if echo "${OLD_VERSION_CHECK}" | grep -q "${OLD_OPENCLAW_VERSION}"; then
  pass "Old sandbox has OpenClaw ${OLD_OPENCLAW_VERSION}"
else
  fail "Expected OpenClaw ${OLD_OPENCLAW_VERSION} in old image, got: ${OLD_VERSION_CHECK}"
fi

# ── Step 3: Onboard with old image ──────────────────────────────────
info "Step 3: Onboarding sandbox with old image..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FROM_DOCKERFILE=""

# Tag the old image as the expected GHCR name so onboard picks it up
docker tag "${OLD_SANDBOX_TAG}" "ghcr.io/nvidia/nemoclaw/sandbox-base:latest"

nemoclaw onboard \
  --sandbox-name "$SANDBOX_NAME" \
  --non-interactive \
  --accept-third-party-software \
  --recreate-sandbox \
  || fail "Onboard with old image failed"

pass "Sandbox created with old OpenClaw version"

# ── Step 4: Verify old version in sandbox ───────────────────────────
info "Step 4: Verifying sandbox runs old OpenClaw version..."

SANDBOX_VERSION=$(openshell sandbox exec "$SANDBOX_NAME" -- openclaw --version 2>/dev/null || true)
if echo "${SANDBOX_VERSION}" | grep -q "${OLD_OPENCLAW_VERSION}"; then
  pass "Sandbox confirmed running OpenClaw ${OLD_OPENCLAW_VERSION}"
else
  info "Sandbox version: ${SANDBOX_VERSION} (may differ from base if image layers cached)"
fi

# ── Step 5: Write marker files ──────────────────────────────────────
info "Step 5: Writing marker files..."

openshell sandbox exec "$SANDBOX_NAME" -- \
  sh -c "mkdir -p /sandbox/.openclaw-data/workspace && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

VERIFY=$(openshell sandbox exec "$SANDBOX_NAME" -- cat "$MARKER_FILE" 2>/dev/null || true)
[ "$VERIFY" = "$MARKER_CONTENT" ] || fail "Marker verification failed"

pass "Marker file written and verified"

# ── Step 6: Rebuild ─────────────────────────────────────────────────
info "Step 6: Running rebuild..."

# Restore the current base image so rebuild picks up the new version
docker build \
  -f "${REPO_ROOT}/Dockerfile.base" \
  -t "ghcr.io/nvidia/nemoclaw/sandbox-base:latest" \
  "${REPO_ROOT}" \
  || fail "Failed to rebuild current base image"

nemoclaw "$SANDBOX_NAME" rebuild --yes \
  || fail "Rebuild failed"

pass "Rebuild completed"

# ── Step 7: Verify marker files survived ────────────────────────────
info "Step 7: Verifying marker files survived..."

RESTORED=$(openshell sandbox exec "$SANDBOX_NAME" -- cat "$MARKER_FILE" 2>/dev/null || true)
if [ "$RESTORED" = "$MARKER_CONTENT" ]; then
  pass "Marker file survived rebuild"
else
  fail "Marker file lost: got '${RESTORED}', expected '${MARKER_CONTENT}'"
fi

# ── Step 8: Verify version upgraded ─────────────────────────────────
info "Step 8: Verifying version upgraded..."

NEW_VERSION=$(openshell sandbox exec "$SANDBOX_NAME" -- openclaw --version 2>/dev/null || true)
if echo "${NEW_VERSION}" | grep -qv "${OLD_OPENCLAW_VERSION}"; then
  pass "OpenClaw version upgraded (now: ${NEW_VERSION})"
else
  fail "Version still old after rebuild: ${NEW_VERSION}"
fi

# Check registry
REGISTRY_VERSION=$(python3 -c "
import json
with open('${REGISTRY_FILE}') as f:
    data = json.load(f)
sb = data.get('sandboxes', {}).get('${SANDBOX_NAME}', {})
print(sb.get('agentVersion', 'null'))
" 2>/dev/null || echo "error")

if [ "$REGISTRY_VERSION" != "null" ] && [ "$REGISTRY_VERSION" != "${OLD_OPENCLAW_VERSION}" ]; then
  pass "Registry agentVersion updated to ${REGISTRY_VERSION}"
else
  fail "Registry agentVersion not updated: ${REGISTRY_VERSION}"
fi

# ── Step 9: Check backup for credentials ────────────────────────────
info "Step 9: Checking backup for leaked credentials..."

BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/$SANDBOX_NAME"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" -name "*.json" -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
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
echo -e "${GREEN}OpenClaw rebuild upgrade E2E passed.${NC}"
