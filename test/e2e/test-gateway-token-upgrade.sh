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

# ── tui_smoke: drives `openclaw tui` inside the sandbox and asserts
# the auth-resolution path works. The original #2480 bug surfaced as
# "Missing gateway auth token" on stderr — we treat any output that
# omits that string AND yields a non-empty resolved token as success.
tui_smoke() {
  local sandbox_name="$1"
  local label="$2"

  info "${label}: running TUI smoke test inside ${sandbox_name}..."

  # Step 1: replicate openclaw tui's token resolution exactly so we can
  # tell a "missing token" failure from a "TUI doesn't like our pty"
  # failure. Resolution order matches OpenClaw 2026.4.9: env var first,
  # then gateway.auth.token from config.
  local resolved
  resolved="$(openshell sandbox exec --name "${sandbox_name}" -- bash -lc '
    python3 - <<"PY"
import json, os, sys
token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
if not token:
    try:
        with open("/sandbox/.openclaw/openclaw.json") as f:
            token = json.load(f).get("gateway", {}).get("auth", {}).get("token", "")
    except Exception:
        pass
if not token:
    print("MISSING_GATEWAY_AUTH_TOKEN", file=sys.stderr)
    sys.exit(2)
print(token)
PY
  ' 2>&1 || true)"

  if echo "${resolved}" | grep -q "MISSING_GATEWAY_AUTH_TOKEN"; then
    fail "${label}: token resolution path mirrors 'openclaw tui' and returned empty — TUI would fail with 'Missing gateway auth token'"
  fi

  # Pull the actual token off the last line (the python script may emit
  # warnings before printing) and reject anything that doesn't look like
  # a hex string of plausible length.
  local token
  token="$(echo "${resolved}" | tail -n 1)"
  if [ -z "${token}" ] || [ "${#token}" -lt 16 ]; then
    fail "${label}: resolved token is empty or implausibly short: '${token}'"
  fi

  # Step 2: actually start `openclaw tui`. We can't drive it
  # interactively without a pty, but we can confirm it gets past the
  # auth-resolution step — the bug we're guarding against was an early
  # exit with "Missing gateway auth token" before any UI work.
  local tui_out
  tui_out="$(openshell sandbox exec --name "${sandbox_name}" -- bash -lc '
    timeout --preserve-status 6 openclaw tui </dev/null 2>&1 | head -c 8192
  ' 2>&1 || true)"

  if echo "${tui_out}" | grep -qi "Missing gateway auth token"; then
    echo "${tui_out}" | head -40 >&2
    fail "${label}: 'openclaw tui' emitted 'Missing gateway auth token' (#2480 regression)"
  fi

  pass "${label}: TUI startup resolved gateway token (${#token} chars)"
  printf '%s' "${token}"
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
PRE_TOKEN="$(tui_smoke "${SANDBOX_NAME}" "Phase 3 pre-upgrade")"

# Sanity: in the OLD design the token comes from the Docker layer, so
# it must be identical across container restarts. Restart and reread to
# pin down the current behavior we're upgrading away from.
openshell sandbox restart "${SANDBOX_NAME}" >/dev/null 2>&1 || true
for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
PRE_TOKEN_AFTER_RESTART="$(tui_smoke "${SANDBOX_NAME}" "Phase 3 pre-upgrade post-restart")"
if [ "${PRE_TOKEN}" != "${PRE_TOKEN_AFTER_RESTART}" ]; then
  fail "Phase 3: build-baked token unexpectedly changed across restart — PRE_REF may already include runtime injection"
fi
pass "Phase 3: pre-upgrade token is stable across restart (build-baked behavior confirmed)"

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
POST_TOKEN="$(tui_smoke "${SANDBOX_NAME}" "Phase 5 post-upgrade")"

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

openshell sandbox restart "${SANDBOX_NAME}" >/dev/null 2>&1 || true
for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done

ROTATED_TOKEN="$(tui_smoke "${SANDBOX_NAME}" "Phase 6 post-restart")"

if [ "${ROTATED_TOKEN}" = "${POST_TOKEN}" ]; then
  fail "Phase 6: token did not rotate across restart — entrypoint inject_gateway_token() did not run"
fi
pass "Phase 6: token rotated on restart (runtime injection confirmed)"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway-token upgrade E2E PASSED${NC}"
echo -e "${GREEN}  pre-upgrade token: ${PRE_TOKEN:0:8}…${NC}"
echo -e "${GREEN}  post-upgrade token: ${POST_TOKEN:0:8}…${NC}"
echo -e "${GREEN}  rotated token: ${ROTATED_TOKEN:0:8}…${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
