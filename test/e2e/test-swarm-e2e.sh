#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Multi-Agent Swarm E2E Tests
#
# Validates multi-agent swarm support: adding agents to a sandbox,
# inter-agent communication via the swarm bus, and observer/status
# integration. Each implementation phase extends this script.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-swarm)
#   NEMOCLAW_RECREATE_SANDBOX=1            — recreate sandbox if exists
#   NVIDIA_API_KEY                         — required for inference
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-swarm-e2e.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
# shellcheck disable=SC2329  # invoked in later phases
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-swarm}"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"

# ── Phase 1: Prerequisites ──────────────────────────────────────

section "Phase 1: Prerequisites"

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY set and valid"
else
  fail "NVIDIA_API_KEY not set or invalid (must start with nvapi-)"
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  pass "docker found"
else
  fail "docker not found"
  exit 1
fi

# ── Phase 2: Pre-cleanup ────────────────────────────────────────

section "Phase 2: Pre-cleanup"

info "Destroying any leftover $SANDBOX_NAME sandbox..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  pass "nemoclaw destroy (or no leftover)"
else
  info "nemoclaw not yet installed, skipping destroy"
fi

if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  pass "openshell cleanup (or nothing to clean)"
else
  info "openshell not yet installed, skipping cleanup"
fi

# ── Phase 3: Install & Onboard ──────────────────────────────────

section "Phase 3: Install & Onboard"

info "Running install.sh --non-interactive..."
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1

INSTALL_LOG="/tmp/nemoclaw-e2e-swarm-install.log"
if bash "$REPO/install.sh" --non-interactive 2>&1 | tee "$INSTALL_LOG"; then
  pass "install.sh completed"
else
  fail "install.sh failed (see $INSTALL_LOG)"
  exit 1
fi

# Verify nemoclaw and openshell are now on PATH
# (install.sh may have modified PATH; re-source)
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH"
else
  fail "nemoclaw not on PATH"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH"
else
  fail "openshell not on PATH"
  exit 1
fi

# Wait for sandbox to be ready
info "Waiting for sandbox '$SANDBOX_NAME' to be Ready..."
MAX_WAIT=600
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  info "  waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
  pass "Sandbox '$SANDBOX_NAME' is Ready"
else
  fail "Sandbox '$SANDBOX_NAME' not Ready after ${MAX_WAIT}s"
  exit 1
fi

# ── Phase 4: Registry backwards compatibility ────────────────────

section "Phase 4: Registry backwards compatibility"

if [ -f "$REGISTRY_FILE" ]; then
  pass "Registry file exists at $REGISTRY_FILE"
else
  fail "Registry file not found"
  exit 1
fi

# Verify the legacy 'agent' field is still present (backwards compat)
if python3 -c "
import json, sys
data = json.load(open('$REGISTRY_FILE'))
sb = data.get('sandboxes', {}).get('$SANDBOX_NAME')
if sb is None:
    print('Sandbox not found in registry', file=sys.stderr)
    sys.exit(1)
# Legacy field must still be present after onboard
if 'agent' not in sb:
    print('Legacy agent field missing', file=sys.stderr)
    sys.exit(1)
print(f'agent={sb[\"agent\"]}')
"; then
  pass "Legacy 'agent' field present in registry"
else
  fail "Legacy 'agent' field missing from registry"
fi

# Verify sandbox is functional (basic status check)
if nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "nemoclaw status works for single-agent sandbox"
else
  fail "nemoclaw status failed"
fi

# Verify default sandbox is set
DEFAULT_SB=$(python3 -c "
import json
data = json.load(open('$REGISTRY_FILE'))
print(data.get('defaultSandbox', ''))
" 2>/dev/null)
if [ "$DEFAULT_SB" = "$SANDBOX_NAME" ]; then
  pass "Default sandbox set to '$SANDBOX_NAME'"
else
  fail "Default sandbox is '$DEFAULT_SB', expected '$SANDBOX_NAME'"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Swarm E2E Results (Phase 1):"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  SWARM E2E PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed\033[0m\n' "$FAIL"
  exit 1
fi
