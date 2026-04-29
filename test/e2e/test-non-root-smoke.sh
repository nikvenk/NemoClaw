#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Non-root sandbox smoke test.
#
# Validates that the sandbox container starts successfully under
# --security-opt=no-new-privileges (the constraint applied by OpenShell on
# Brev Launchable and DGX Spark). This is the exact failure mode that caused
# the 5-day outage in #2472 — install_configure_guard writing to .bashrc
# crashed under Landlock + set -e, preventing the gateway from starting.
#
# What this tests:
#   1. Container starts as non-root sandbox user with no-new-privileges
#   2. Gateway process comes up and responds on /health (HTTP 200 or 401)
#   3. openclaw tui --help succeeds (gateway auth token is available)
#   4. Non-root fallback path is exercised (log confirms "Running as non-root")
#
# Does NOT require:
#   - NVIDIA_API_KEY (no live inference)
#   - Network access to external services
#   - Full onboard flow
#
# Prerequisites:
#   - Docker running
#   - NEMOCLAW_TEST_IMAGE loaded (default: nemoclaw-production)
#
# Usage:
#   NEMOCLAW_TEST_IMAGE=nemoclaw-production bash test/e2e/test-non-root-smoke.sh
#
# CI usage (pr-self-hosted.yaml):
#   Runs after build-sandbox-images job loads the isolation-image artifact.
#
# See: https://github.com/NVIDIA/NemoClaw/issues/2571

set -euo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=300
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR}/e2e-timeout.sh"

# ── Configuration ────────────────────────────────────────────────

IMAGE="${NEMOCLAW_TEST_IMAGE:-nemoclaw-production}"
CONTAINER_NAME="nemoclaw-nonroot-smoke-$$"
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=2
DASHBOARD_PORT=18789
HOST_PORT="${NEMOCLAW_SMOKE_HOST_PORT:-18789}"

# ── Output helpers ───────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "${RED}FAIL${NC}: $1"
  FAILED=$((FAILED + 1))
}

info() { echo -e "${YELLOW}TEST${NC}: $1"; }

# ── Cleanup trap ─────────────────────────────────────────────────

cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME" 2>/dev/null; then
    echo ""
    info "Collecting container logs before cleanup..."
    docker logs "$CONTAINER_NAME" 2>&1 | tail -50 || true
    echo ""
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────

info "Preflight: Docker available"
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker running"

info "Preflight: Image exists"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "Image '$IMAGE' not found — load it before running this test"
  exit 1
fi
pass "Image '$IMAGE' available"

# ── Resolve sandbox user UID:GID ─────────────────────────────────

info "1. Resolve sandbox user UID:GID from image"
ID_OUTPUT=$(docker run --rm --entrypoint "" "$IMAGE" id sandbox 2>&1)
SB_UID=$(echo "$ID_OUTPUT" | sed -n 's/uid=\([0-9]*\).*/\1/p')
SB_GID=$(echo "$ID_OUTPUT" | sed -n 's/.*gid=\([0-9]*\).*/\1/p')

if [ -z "$SB_UID" ] || [ -z "$SB_GID" ]; then
  fail "Could not resolve sandbox UID:GID from image (output: $ID_OUTPUT)"
  exit 1
fi
pass "Sandbox user: uid=$SB_UID gid=$SB_GID"

# ── Start container with non-root constraints ────────────────────

info "2. Start container with --security-opt no-new-privileges --user $SB_UID:$SB_GID"
docker run -d \
  --name "$CONTAINER_NAME" \
  --security-opt no-new-privileges \
  --user "${SB_UID}:${SB_GID}" \
  -p "${HOST_PORT}:${DASHBOARD_PORT}" \
  "$IMAGE" >/dev/null 2>&1

# Verify container is running (not immediately crashed)
sleep 2
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  fail "Container exited immediately after start"
  echo "Exit code: $(docker inspect --format='{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo 'unknown')"
  echo "Last logs:"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -30 || true
  exit 1
fi
pass "Container running as non-root"

# ── Verify non-root path is exercised ────────────────────────────

info "3. Verify non-root fallback path in logs"
# Give a moment for the entrypoint to emit its startup messages
sleep 3
LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
if echo "$LOGS" | grep -q "Running as non-root"; then
  pass "Non-root fallback path confirmed in logs"
else
  fail "Expected 'Running as non-root' in container logs"
  echo "First 20 lines of logs:"
  echo "$LOGS" | head -20
fi

# ── Poll /health endpoint ────────────────────────────────────────

info "4. Poll gateway /health (timeout: ${HEALTH_TIMEOUT}s)"
ELAPSED=0
HEALTH_OK=false

while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HOST_PORT}/health" 2>/dev/null || echo "000")

  # 200 = healthy, 401 = gateway alive but auth required — both are valid
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
    HEALTH_OK=true
    break
  fi

  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if [ "$HEALTH_OK" = true ]; then
  pass "Gateway /health responded with HTTP $HTTP_CODE in ${ELAPSED}s"
else
  fail "Gateway /health did not respond within ${HEALTH_TIMEOUT}s (last HTTP code: $HTTP_CODE)"
  echo "Container status:"
  docker inspect --format='{{.State.Status}} (exit={{.State.ExitCode}})' "$CONTAINER_NAME" 2>/dev/null || true
  echo "Recent logs:"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -30 || true
fi

# ── Verify openclaw tui --help ────────────────────────────────────

info "5. Verify 'openclaw tui --help' succeeds inside container"
TUI_OUTPUT=$(docker exec "$CONTAINER_NAME" openclaw tui --help 2>&1) || TUI_RC=$?
TUI_RC=${TUI_RC:-0}

if [ "$TUI_RC" -eq 0 ]; then
  # Double-check: no "Missing gateway auth token" error
  if echo "$TUI_OUTPUT" | grep -qi "Missing gateway auth token"; then
    fail "'openclaw tui --help' succeeded but output contains 'Missing gateway auth token'"
  else
    pass "'openclaw tui --help' exited 0 without auth token errors"
  fi
else
  fail "'openclaw tui --help' failed (exit $TUI_RC)"
  echo "Output: $TUI_OUTPUT" | head -10
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
