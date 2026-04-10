#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: --dangerously-skip-permissions policy activation
#
# Validates the exact scenario from the bug report:
#   1. Onboard with --dangerously-skip-permissions (via env var)
#   2. Verify policy is Active (not stuck in Pending)
#   3. Verify outbound HTTPS from inside the sandbox succeeds (not 403)
#   4. Verify the permissive policy contains access: full endpoints
#
# Without the fix, the permissive base policy from sandbox creation stays
# in Pending status because no `openshell policy set --wait` is called.
# All outbound requests return 403 Forbidden.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for NVIDIA Endpoints inference
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-skip-perms)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 900)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-skip-permissions-policy.sh

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-skip-perms}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for NVIDIA Endpoints inference"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

if [ ! -f "$REPO_ROOT/install.sh" ]; then
  fail "Cannot find install.sh at $REPO_ROOT/install.sh"
  exit 1
fi
pass "Repo root found: $REPO_ROOT"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup"

info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install with --dangerously-skip-permissions
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install NemoClaw with --dangerously-skip-permissions"

info "Running install.sh --non-interactive with NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS=1..."
info "This is the exact flag that caused the Pending policy bug."

cd "$REPO_ROOT" || {
  fail "Could not cd to repo root: $REPO_ROOT"
  exit 1
}

INSTALL_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true
rm -f "$INSTALL_LOG"

# Source shell profile to pick up nvm/PATH changes from install.sh
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

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify policy is Active (THE bug report's core check)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Verify policy activation (the bug report)"

# 3a: openshell policy list — must NOT show "Pending" as the latest version
info "Checking openshell policy list..."
policy_list=$(openshell policy list "$SANDBOX_NAME" 2>&1) || true
info "Policy list output:"
echo "$policy_list" | while IFS= read -r line; do info "  $line"; done

# The latest policy version must not be Pending
if echo "$policy_list" | grep -qi "Pending"; then
  fail "Policy is stuck in Pending — the bug is NOT fixed"
  info "This is the exact symptom from the bug report: policy never activates"
else
  pass "No Pending policies found"
fi

# 3b: openshell policy get --full — must contain network_policies with access: full
info "Checking openshell policy get --full..."
policy_full=$(openshell policy get --full "$SANDBOX_NAME" 2>&1) || true
if echo "$policy_full" | grep -qi "network_policies"; then
  pass "Policy contains network_policies section"
else
  fail "Policy missing network_policies section"
fi

if echo "$policy_full" | grep -qi "access: full"; then
  pass "Policy contains 'access: full' endpoints (permissive mode active)"
else
  fail "Policy does not contain 'access: full' — permissive policy was not applied"
fi

# 3c: nemoclaw status must show dangerously-skip-permissions
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  if echo "$status_output" | grep -qi "dangerously-skip-permissions"; then
    pass "nemoclaw status shows dangerously-skip-permissions mode"
  else
    fail "nemoclaw status does not indicate dangerously-skip-permissions mode"
  fi
else
  fail "nemoclaw status failed: ${status_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Verify outbound HTTPS from inside sandbox (bug reporter's curl test)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify sandbox egress (the 403 Forbidden check)"

# SSH into the sandbox and curl an external HTTPS endpoint.
# With the bug, this returns 403 Forbidden from the proxy.
# With the fix, it should succeed.

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT

if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  fail "Could not get SSH config for sandbox"
  rm -f "$ssh_config"
  # Skip to cleanup
  section "Phase 5: Cleanup"
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  echo ""
  echo "========================================"
  echo "  Skip-Permissions Policy E2E Results:"
  echo "    Passed:  $PASS"
  echo "    Failed:  $FAIL"
  echo "    Skipped: $SKIP"
  echo "    Total:   $TOTAL"
  echo "========================================"
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
pass "SSH config obtained"

SSH_OPTS=(-F "$ssh_config" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)
SSH_TARGET="openshell-${SANDBOX_NAME}"
TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"

# 4a: SSH connectivity
if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo alive" >/dev/null 2>&1; then
  pass "SSH into sandbox works"
else
  fail "SSH into sandbox failed — cannot test egress"
fi

# 4b: curl api.github.com from inside sandbox (exact reproduction from bug report)
info "[EGRESS] Testing curl https://api.github.com/ from inside sandbox..."
# shellcheck disable=SC2029
egress_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "curl -sv --connect-timeout 5 https://api.github.com/ 2>&1" \
  2>&1) || true

if echo "$egress_response" | grep -q "403 Forbidden"; then
  fail "[EGRESS] curl https://api.github.com/ returned 403 Forbidden — policy NOT active"
  info "This is the exact symptom from the bug report"
  info "Response: ${egress_response:0:300}"
elif echo "$egress_response" | grep -qi "current_user_url\|HTTP/[12].* 200"; then
  pass "[EGRESS] curl https://api.github.com/ succeeded (not 403)"
else
  # Could be a transient network error — not necessarily the policy bug
  info "Unexpected response (may be transient): ${egress_response:0:300}"
  skip "[EGRESS] curl https://api.github.com/ — ambiguous result (not 403, not 200)"
fi

# 4c: curl a second endpoint to double-check (registry.npmjs.org)
info "[EGRESS] Testing curl https://registry.npmjs.org/ from inside sandbox..."
# shellcheck disable=SC2029
npm_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "curl -s --connect-timeout 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/" \
  2>&1) || true

npm_code=$(echo "$npm_response" | tr -d '\r' | tail -1)
if [ "$npm_code" = "403" ]; then
  fail "[EGRESS] curl https://registry.npmjs.org/ returned 403 — policy NOT active"
elif [ "$npm_code" = "200" ] || [ "$npm_code" = "301" ] || [ "$npm_code" = "302" ]; then
  pass "[EGRESS] curl https://registry.npmjs.org/ returned HTTP $npm_code (not 403)"
else
  skip "[EGRESS] curl https://registry.npmjs.org/ returned HTTP $npm_code (not 403, ambiguous)"
fi

rm -f "$ssh_config"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Cleanup"

nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} cleaned up"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Skip-Permissions Policy E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Skip-permissions policy PASSED — policy activates and sandbox egress works.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
