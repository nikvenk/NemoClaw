#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Gateway-token upgrade E2E — proves `openclaw tui` keeps working
# across the build-baked-token → runtime-injected-token transition that
# landed in the runtime-gateway-token PR (issue #2480).
#
# `openclaw tui` is the user-visible canary: the original failure mode
# was "Missing gateway auth token" inside the sandbox, so we run TUI as
# the proof-of-life for the broader gateway-auth capability.
#
#   1. Install current NemoClaw via install.sh.
#   2. Build a sandbox from the PRE-PR source revision (token baked
#      into openclaw.json at build time via secrets.token_hex(32)).
#   3. Drive `openclaw tui` inside that sandbox and capture the token.
#   4. Rebuild the sandbox using the CURRENT source (runtime injection).
#   5. Drive `openclaw tui` again — must still authenticate.
#   6. Restart the sandbox — token must rotate (runtime-generated, not
#      baked into the image layer).
#
# Prerequisites:
#   - Docker running on the runner.
#   - NVIDIA_API_KEY set (real key, starts with nvapi-).
#   - GHCR access for ghcr.io/nvidia/nemoclaw/sandbox-base:latest.

set -euo pipefail

# Last commit before the runtime-gateway-token PR. This is the
# externalization-revert (PR #2482) so the build still bakes a real
# token via secrets.token_hex(32) into openclaw.json. If this commit
# disappears from history (rebased out, etc.), pin a tag instead.
PRE_REF="${NEMOCLAW_PRE_UPGRADE_REF:-31c782c02732819df86e6af6116e75135cd8b7e2}"

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-gateway-token-upgrade}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- Failure diagnostics ---" >&2
  echo -e "${YELLOW}[DIAG]${NC} Registry: $(cat "${REGISTRY_FILE}" 2>/dev/null || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Sandboxes: $(openshell sandbox list 2>&1 || echo 'openshell unavailable')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Docker: $(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>&1 | head -5)" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- End diagnostics ---" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# ── Preflight ──────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

info "Gateway-token upgrade E2E (pre-ref: ${PRE_REF:0:12}, sandbox: ${SANDBOX_NAME})"

# Ensure the pre-ref is fetchable (CI checkout is shallow by default).
if ! git -C "${REPO_ROOT}" cat-file -e "${PRE_REF}^{commit}" 2>/dev/null; then
  info "Pre-ref ${PRE_REF:0:12} not in local history — fetching..."
  git -C "${REPO_ROOT}" fetch --depth 200 origin "${PRE_REF}" 2>/dev/null \
    || git -C "${REPO_ROOT}" fetch --unshallow origin 2>/dev/null \
    || fail "Could not fetch pre-ref ${PRE_REF}"
fi

# ── fetch_resolved_token: replicates `openclaw tui`'s token resolution
# (env var → gateway.auth.token in config) without failing the test on
# transient errors. Sets RESOLVED_TOKEN on success, leaves it empty on
# failure. Used by both tui_smoke (assertive) and the rotation poll in
# Phase 6 (best-effort).
#
# Important: `openshell sandbox exec` rejects arguments that contain
# newlines or carriage returns (gRPC InvalidArgument), so every
# in-sandbox command here must be a single line.
fetch_resolved_token() {
  local sandbox_name="$1"
  RESOLVED_TOKEN=""

  # 1a: env var the same way `openclaw tui` would inherit it.
  local env_token=""
  # shellcheck disable=SC2016 # ${OPENCLAW_GATEWAY_TOKEN} must expand in-sandbox, not on host.
  env_token="$(openshell sandbox exec --name "${sandbox_name}" -- bash -lc 'printf %s "${OPENCLAW_GATEWAY_TOKEN:-}"' 2>/dev/null || true)"

  # 1b: download openclaw.json and parse on the host (avoids multi-line
  # python -c arguments inside openshell exec).
  local cfg_token=""
  local fetch_dir
  fetch_dir="$(mktemp -d -t nemoclaw-tui-XXXXXX)"
  if openshell sandbox download "${sandbox_name}" /sandbox/.openclaw/openclaw.json "${fetch_dir}/" >/dev/null 2>&1; then
    local cfg_path
    cfg_path="$(find "${fetch_dir}" -name openclaw.json -print -quit)"
    if [ -n "${cfg_path}" ]; then
      cfg_token="$(python3 -c "import json,sys; cfg=json.load(open(sys.argv[1])); print(cfg.get('gateway',{}).get('auth',{}).get('token',''))" "${cfg_path}" 2>/dev/null || true)"
    fi
  fi
  rm -rf "${fetch_dir}"

  RESOLVED_TOKEN="${env_token:-${cfg_token}}"
}

# ── tui_smoke: asserts both that token resolution yields a 64-hex
# string AND that `openclaw tui` doesn't emit "Missing gateway auth
# token" (the #2480 failure mode).
tui_smoke() {
  local sandbox_name="$1"
  local label="$2"

  info "${label}: running TUI smoke test inside ${sandbox_name}..."

  RESOLVED_TOKEN=""
  fetch_resolved_token "${sandbox_name}"
  local token="${RESOLVED_TOKEN}"

  if [ -z "${token}" ]; then
    fail "${label}: no token resolvable (env var empty, config token empty) — TUI would fail with 'Missing gateway auth token'"
  fi
  if ! printf '%s' "${token}" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    fail "${label}: resolved token does not match secrets.token_hex(32) format: '${token}'"
  fi

  # Run `openclaw tui` itself with a 6s timeout and a single-line bash
  # command (no heredoc). The bug we guard against is a fast exit with
  # the #2480 error string before any UI work happens.
  local tui_out
  tui_out="$(openshell sandbox exec --name "${sandbox_name}" -- bash -c 'timeout --preserve-status 6 openclaw tui </dev/null 2>&1 | head -c 8192' 2>&1 || true)"

  if echo "${tui_out}" | grep -qi "Missing gateway auth token"; then
    echo "${tui_out}" | head -40 >&2
    fail "${label}: 'openclaw tui' emitted 'Missing gateway auth token' (#2480 regression)"
  fi

  pass "${label}: TUI startup resolved gateway token (${#token} chars)"
  TUI_RESULT_TOKEN="${token}"
}

# ── wait_for_token_change: polls fetch_resolved_token until the
# resolved token differs from the supplied baseline. Returns 0 with
# RESOLVED_TOKEN set on success, 1 (timed out) otherwise. Use this
# instead of waiting on `openshell sandbox list` after a restart —
# `sandbox restart` may return before the pod transitions, so the
# Ready→Ready window is too narrow to detect reliably.
wait_for_token_change() {
  local sandbox_name="$1"
  local baseline="$2"
  local timeout_seconds="${3:-90}"
  local deadline=$(($(date +%s) + timeout_seconds))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    RESOLVED_TOKEN=""
    fetch_resolved_token "${sandbox_name}"
    if [ -n "${RESOLVED_TOKEN}" ] \
      && [ "${RESOLVED_TOKEN}" != "${baseline}" ] \
      && printf '%s' "${RESOLVED_TOKEN}" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      return 0
    fi
  done
  return 1
}

# ── Phase 1: Install current NemoClaw ──────────────────────────────
info "Phase 1: Installing NemoClaw via install.sh..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_REBUILD_VERBOSE=1

INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
if ! bash "${REPO_ROOT}/install.sh" --non-interactive >"$INSTALL_LOG" 2>&1; then
  info "install.sh exited non-zero (may be expected on re-install). Continuing..."
fi

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

command -v nemoclaw >/dev/null 2>&1 || fail "nemoclaw not found on PATH after install"
command -v openshell >/dev/null 2>&1 || fail "openshell not found on PATH after install"
pass "NemoClaw installed; gateway running"

# install.sh creates the default sandbox; we replace it with a build
# from the PRE_REF source tree, but keep the gateway it set up.
openshell sandbox delete "${SANDBOX_NAME}" 2>/dev/null || true

# ── Phase 2: Build PRE-upgrade sandbox from the old source tree ────
info "Phase 2: Materializing pre-upgrade source at ${PRE_REF:0:12}..."

WORKTREE_DIR="$(mktemp -d -t nemoclaw-pre-XXXXXX)"
trap 'git -C "${REPO_ROOT}" worktree remove -f "${WORKTREE_DIR}" 2>/dev/null || true; rm -rf "${WORKTREE_DIR}"' EXIT
git -C "${REPO_ROOT}" worktree add -f --detach "${WORKTREE_DIR}" "${PRE_REF}" >/dev/null

[ -f "${WORKTREE_DIR}/Dockerfile" ] || fail "Pre-ref worktree is missing Dockerfile — wrong commit?"
grep -q "secrets.token_hex" "${WORKTREE_DIR}/Dockerfile" \
  || fail "Pre-ref Dockerfile does not bake a token (expected secrets.token_hex). PRE_REF may be wrong."

info "Phase 2: Creating sandbox from pre-upgrade source..."
openshell sandbox create \
  --name "${SANDBOX_NAME}" \
  --from "${WORKTREE_DIR}/Dockerfile" \
  --gateway nemoclaw \
  --no-tty \
  -- true

for _i in $(seq 1 60); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" \
  || fail "Pre-upgrade sandbox did not reach Ready"

pass "Phase 2: pre-upgrade sandbox running (build-baked token design)"

# ── Phase 3: TUI smoke + capture pre-upgrade token ─────────────────
# Establish the pre-upgrade baseline. We do *not* exercise a restart
# here because `openshell sandbox restart` returns before the pod has
# transitioned, so a "token unchanged across restart" check on a
# build-baked token is satisfied even when the entrypoint never
# actually re-runs — false sense of security. The meaningful upgrade
# proof is the Phase 5/6 pair below: post-upgrade token differs from
# pre-upgrade, and post-restart token differs from post-upgrade.
TUI_RESULT_TOKEN=""
tui_smoke "${SANDBOX_NAME}" "Phase 3 pre-upgrade"
PRE_TOKEN="${TUI_RESULT_TOKEN}"

# Register the sandbox in NemoClaw's registry so `nemoclaw rebuild`
# treats it as a known sandbox (otherwise the rebuild command refuses).
python3 - <<PY
import json, os, datetime
reg_path = os.path.expanduser("${REGISTRY_FILE}")
sess_path = os.path.expanduser("${SESSION_FILE}")
now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
reg = {
    "sandboxes": {
        "${SANDBOX_NAME}": {
            "name": "${SANDBOX_NAME}",
            "createdAt": now,
            "model": "nvidia/nemotron-3-super-120b-a12b",
            "provider": "nvidia-prod",
            "gpuEnabled": False,
            "policies": [],
            "policyTier": None,
            "agent": None,
            "agentVersion": "pre-upgrade",
        }
    },
    "defaultSandbox": "${SANDBOX_NAME}",
}
os.makedirs(os.path.dirname(reg_path), exist_ok=True)
with open(reg_path, "w") as f:
    json.dump(reg, f, indent=2)

complete = {"status": "complete", "startedAt": now, "completedAt": now, "error": None}
pending = {"status": "pending", "startedAt": None, "completedAt": None, "error": None}
sess = {
    "sandboxName": "${SANDBOX_NAME}",
    "status": "complete",
    "resumable": True,
    "lastCompletedStep": "gateway",
    "failure": None,
    "steps": {
        "preflight": complete,
        "gateway": complete,
        "sandbox": pending,
        "provider_selection": pending,
        "inference": pending,
        "openclaw": pending,
        "agent_setup": pending,
        "policies": pending,
    },
}
with open(sess_path, "w") as f:
    json.dump(sess, f, indent=2)
PY

# ── Phase 4: Rebuild using current source (the upgrade) ────────────
info "Phase 4: Rebuilding sandbox using current source (HEAD)..."

nemoclaw "${SANDBOX_NAME}" rebuild --yes 2>&1 \
  || fail "Phase 4: nemoclaw rebuild failed"

for _i in $(seq 1 60); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" \
  || fail "Phase 4: post-upgrade sandbox did not reach Ready"

pass "Phase 4: post-upgrade sandbox running (runtime-injection design)"

# ── Phase 5: TUI smoke after upgrade ───────────────────────────────
TUI_RESULT_TOKEN=""
tui_smoke "${SANDBOX_NAME}" "Phase 5 post-upgrade"
POST_TOKEN="${TUI_RESULT_TOKEN}"

if [ "${POST_TOKEN}" = "${PRE_TOKEN}" ]; then
  fail "Phase 5: post-upgrade token equals pre-upgrade token — rebuild reused the old image layer (NEMOCLAW_BUILD_ID cache miss?) or runtime injection didn't run"
fi
pass "Phase 5: post-upgrade token differs from pre-upgrade (upgrade installed runtime injection)"

# Cross-check the host CLI's token-fetch path matches what's in the
# sandbox. This guards against onboard.ts drifting from the entrypoint.
HOST_TOKEN="$(nemoclaw "${SANDBOX_NAME}" gateway-token --quiet 2>/dev/null || true)"
if [ -z "${HOST_TOKEN}" ]; then
  fail "Phase 5: 'nemoclaw ${SANDBOX_NAME} gateway-token' returned nothing"
fi
if [ "${HOST_TOKEN}" != "${POST_TOKEN}" ]; then
  fail "Phase 5: host gateway-token (${#HOST_TOKEN} chars) does not match in-sandbox token (${#POST_TOKEN} chars)"
fi
pass "Phase 5: host-side gateway-token matches in-sandbox token"

# ── Phase 6: Token rotates on restart (runtime mechanism) ──────────
info "Phase 6: Restarting sandbox to confirm runtime token rotation..."

# `openshell sandbox restart` returns before the pod has actually
# transitioned, and the kubelet may roll quickly enough that a "wait
# for non-Ready, then Ready" check misses the window entirely. Poll
# the resolved token directly — the entrypoint regenerates it on
# every start, so an observed rotation is unambiguous proof the
# entrypoint re-ran. A 90s deadline tolerates slow node-image pulls
# without hiding a real "entrypoint never ran" regression.
openshell sandbox restart "${SANDBOX_NAME}" >/dev/null 2>&1 || true

RESOLVED_TOKEN=""
if ! wait_for_token_change "${SANDBOX_NAME}" "${POST_TOKEN}" 90; then
  fail "Phase 6: token did not rotate within 90s — entrypoint inject_gateway_token() did not re-run, or sandbox restart did not propagate"
fi
ROTATED_TOKEN="${RESOLVED_TOKEN}"
pass "Phase 6: token rotated on restart (runtime injection confirmed)"

# Final TUI smoke against the rotated container — one more guard
# against a "Missing gateway auth token" regression after restart.
TUI_RESULT_TOKEN=""
tui_smoke "${SANDBOX_NAME}" "Phase 6 post-rotation"
if [ "${TUI_RESULT_TOKEN}" != "${ROTATED_TOKEN}" ]; then
  fail "Phase 6: TUI-resolved token (${#TUI_RESULT_TOKEN} chars) does not match polled rotated token (${#ROTATED_TOKEN} chars)"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway-token upgrade E2E PASSED${NC}"
echo -e "${GREEN}  pre-upgrade token: ${PRE_TOKEN:0:8}…${NC}"
echo -e "${GREEN}  post-upgrade token: ${POST_TOKEN:0:8}…${NC}"
echo -e "${GREEN}  rotated token: ${ROTATED_TOKEN:0:8}…${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
