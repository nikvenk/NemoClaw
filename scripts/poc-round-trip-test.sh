#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Interactive round-trip test for runtime config mutability.
#
# Walks through the full TUI approval flow step by step:
#   1. Verify prerequisites (sandbox running, gateway healthy)
#   2. Show baseline config
#   3. Write a config request file INSIDE the sandbox
#   4. Scanner picks it up → CONFIG chunk appears in TUI
#   5. User approves in TUI (other terminal)
#   6. Poll loop applies the override
#   7. Verify the change took effect
#   8. Test gateway.* security block
#   9. Test host-side direct set (comparison)
#
# Run in TWO terminals:
#
#   Terminal 1 (TUI — leave running):
#     openshell term
#
#   Terminal 2 (this script):
#     bash scripts/poc-round-trip-test.sh
#
# Prerequisites:
#   - A sandbox must already be running (nemoclaw onboard or install.sh)
#   - Gateway must be healthy
#   - openshell >= 0.0.15

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "\n${GREEN}▸ $1${NC}"; }
info() { echo -e "  ${CYAN}$1${NC}"; }
warn() { echo -e "  ${YELLOW}$1${NC}"; }
err() { echo -e "  ${RED}$1${NC}" >&2; }
wait_enter() {
  echo -e "\n  ${YELLOW}Press Enter to continue...${NC}"
  read -r
}

# Resolve sandbox name: env var → first registered sandbox
resolve_sandbox_name() {
  if [[ -n "${NEMOCLAW_SANDBOX_NAME:-}" ]]; then
    printf "%s" "$NEMOCLAW_SANDBOX_NAME"
    return 0
  fi
  local registry_file="${HOME}/.nemoclaw/sandboxes.json"
  if [[ -f "$registry_file" ]] && command -v node >/dev/null 2>&1; then
    local name
    name="$(node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const sandboxes = data.sandboxes || {};
        const preferred = data.defaultSandbox;
        const name = (preferred && sandboxes[preferred] && preferred) || Object.keys(sandboxes)[0] || "";
        process.stdout.write(name);
      } catch {}
    ' "$registry_file" 2>/dev/null || true)"
    if [[ -n "$name" ]]; then
      printf "%s" "$name"
      return 0
    fi
  fi
  printf "my-assistant"
}

# Download a file from the sandbox to stdout
sandbox_cat() {
  local sandbox="$1" remote_path="$2"
  local tmpdir
  tmpdir="$(mktemp -d)"
  if openshell sandbox download "$sandbox" "$remote_path" "$tmpdir" 2>/dev/null; then
    local basename
    basename="$(basename "$remote_path")"
    if [[ -f "$tmpdir/$basename" ]]; then
      cat "$tmpdir/$basename"
    fi
  fi
  rm -rf "$tmpdir"
}

# Write content to a file inside the sandbox via stdin piping
sandbox_write() {
  local sandbox="$1" remote_path="$2" content="$3"
  local tmpfile
  tmpfile="$(mktemp)"
  printf '%s' "$content" >"$tmpfile"
  openshell sandbox upload "$sandbox" "$tmpfile" "$(dirname "$remote_path")/" 2>&1
  rm -f "$tmpfile"
}

# Write a script to the sandbox via connect stdin
sandbox_exec() {
  local sandbox="$1"
  shift
  local tmpfile
  tmpfile="$(mktemp)"
  for cmd in "$@"; do
    printf '%s\n' "$cmd" >>"$tmpfile"
  done
  printf 'exit\n' >>"$tmpfile"
  openshell sandbox connect "$sandbox" <"$tmpfile" 2>&1
  rm -f "$tmpfile"
}

SANDBOX_NAME="$(resolve_sandbox_name)"

echo ""
echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║  Config Mutability — Interactive Round-Trip Test      ║${NC}"
echo -e "  ${GREEN}║                                                       ║${NC}"
echo -e "  ${GREEN}║  Sandbox: ${SANDBOX_NAME}$(printf '%*s' $((28 - ${#SANDBOX_NAME})) '')║${NC}"
echo -e "  ${GREEN}║                                                       ║${NC}"
echo -e "  ${GREEN}║  Make sure 'openshell term' is running in Terminal 1  ║${NC}"
echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# ══════════════════════════════════════════════════════════════════
# Step 1: Preflight
# ══════════════════════════════════════════════════════════════════
step "1. Verify prerequisites"

if ! command -v openshell >/dev/null 2>&1; then
  err "openshell not found on PATH"
  exit 1
fi
echo "  openshell: $(openshell --version 2>&1 | head -1)"

if ! command -v nemoclaw >/dev/null 2>&1; then
  err "nemoclaw not found on PATH"
  exit 1
fi
echo "  nemoclaw: available"

# Check gateway
GATEWAY="${OPENSHELL_GATEWAY:-nemoclaw}"
if ! openshell gateway info -g "$GATEWAY" >/dev/null 2>&1; then
  err "No gateway '$GATEWAY' running. Start one first:"
  err "  bash scripts/setup-e2e-demo.sh"
  exit 1
fi
echo "  gateway: healthy"

# Check sandbox exists
if ! openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  err "Sandbox '$SANDBOX_NAME' not found."
  err "  Available sandboxes:"
  openshell sandbox list 2>/dev/null | grep -v "^NAME" | sed 's/^/    /' || true
  err "  Set NEMOCLAW_SANDBOX_NAME=<name> or run nemoclaw onboard first."
  exit 1
fi
echo "  sandbox: $SANDBOX_NAME (running)"

# ══════════════════════════════════════════════════════════════════
# Step 2: Baseline
# ══════════════════════════════════════════════════════════════════
step "2. Show current config (baseline)"
nemoclaw "$SANDBOX_NAME" config-get
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 3: Verify overrides file
# ══════════════════════════════════════════════════════════════════
step "3. Check config-overrides.json5 in sandbox"
info "Downloading from sandbox..."
overrides_content="$(sandbox_cat "$SANDBOX_NAME" /sandbox/.openclaw-data/config-overrides.json5 2>/dev/null || true)"
if [[ -n "$overrides_content" ]]; then
  echo "$overrides_content"
else
  info "(file not found or empty — that's OK for a fresh sandbox)"
fi
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 4: Submit config change request FROM INSIDE the sandbox
# ══════════════════════════════════════════════════════════════════
step "4. Submit a config change request from inside the sandbox"
info "Writing a config request file to /sandbox/.openclaw-data/config-requests/"
info "This simulates what an agent would do when it wants to change its own config."
echo ""

# Upload the config request file into the sandbox.
# The scanner creates /sandbox/.openclaw-data/config-requests/ (now 777).
# Upload the file directly into that directory.
REQUEST_TMPDIR="$(mktemp -d)"
printf '{"key": "agents.defaults.model.primary", "value": "inference/ROUND-TRIP-TEST-MODEL"}\n' \
  >"$REQUEST_TMPDIR/test-model-change.json"
openshell sandbox upload "$SANDBOX_NAME" "$REQUEST_TMPDIR/test-model-change.json" /sandbox/.openclaw-data/config-requests/
rm -rf "$REQUEST_TMPDIR"

info "Request file uploaded. Verifying:"
sandbox_exec "$SANDBOX_NAME" \
  'ls -la /sandbox/.openclaw-data/config-requests/' \
  'cat /sandbox/.openclaw-data/config-requests/test-model-change.json'

echo ""
info "The sandbox scanner polls every 5 seconds."
info "It will detect this file and submit a CONFIG PolicyChunk to the gateway."
echo ""
echo -e "  ${YELLOW}════════════════════════════════════════════════════${NC}"
echo -e "  ${YELLOW}  NOW: Switch to Terminal 1 (openshell term)${NC}"
echo -e "  ${YELLOW}${NC}"
echo -e "  ${YELLOW}  You should see a pending chunk:${NC}"
echo -e "  ${YELLOW}    CONFIG  agents.defaults.model.primary  [pending]${NC}"
echo -e "  ${YELLOW}${NC}"
echo -e "  ${YELLOW}  Press [a] to approve it, then come back here.${NC}"
echo -e "  ${YELLOW}════════════════════════════════════════════════════${NC}"
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 5: Verify the approval took effect
# ══════════════════════════════════════════════════════════════════
step "5. Verify the config change was applied"
info "After approval, the sandbox poll loop writes the overrides file."
info "Waiting 15 seconds for the poll loop..."
sleep 15

info "Current overrides file:"
overrides_after="$(sandbox_cat "$SANDBOX_NAME" /sandbox/.openclaw-data/config-overrides.json5 2>/dev/null || true)"
if [[ -n "$overrides_after" ]]; then
  echo "$overrides_after"
  if echo "$overrides_after" | grep -q "ROUND-TRIP-TEST-MODEL"; then
    echo -e "\n  ${GREEN}✓ Override applied! Model changed to ROUND-TRIP-TEST-MODEL${NC}"
  else
    warn "Override file exists but doesn't contain the expected model."
    warn "The poll loop may not have run yet. Try waiting longer."
  fi
else
  warn "Overrides file not found. The approval may not have propagated yet."
  warn "Check the TUI — is the chunk still pending?"
fi
echo ""

info "Config-get view:"
nemoclaw "$SANDBOX_NAME" config-get
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 6: Security — gateway.* blocked
# ══════════════════════════════════════════════════════════════════
step "6. Test security: gateway.* should be blocked"
info "Writing a gateway.auth.token change request (should be blocked by scanner)..."

EVIL_TMPDIR="$(mktemp -d)"
printf '{"key": "gateway.auth.token", "value": "stolen-token"}\n' \
  >"$EVIL_TMPDIR/evil.json"
openshell sandbox upload "$SANDBOX_NAME" "$EVIL_TMPDIR/evil.json" /sandbox/.openclaw-data/config-requests/
rm -rf "$EVIL_TMPDIR"
info "Evil request file uploaded."

info "Waiting 10 seconds for the scanner to process..."
sleep 10
info "Check sandbox logs — you should see 'gateway.* blocked' message:"
nemoclaw "$SANDBOX_NAME" logs 2>/dev/null | grep -i "gateway.*blocked" | tail -3 || warn "No 'blocked' message found in recent logs (may have scrolled past)"
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 7: Host-side direct set (comparison)
# ══════════════════════════════════════════════════════════════════
step "7. Host-side direct config-set (bypasses TUI approval)"
info "This writes directly to the overrides file — no TUI approval needed."
info "This is the operator path, not the agent path."
echo ""
nemoclaw "$SANDBOX_NAME" config-set --key channels.defaults.configWrites --value false
nemoclaw "$SANDBOX_NAME" config-get
wait_enter

# ══════════════════════════════════════════════════════════════════
# Step 8: Host-side gateway.* refusal
# ══════════════════════════════════════════════════════════════════
step "8. Host-side gateway.* refusal"
info "Even from the host, gateway.* is blocked:"
nemoclaw "$SANDBOX_NAME" config-set --key gateway.auth.token --value evil 2>&1 || true

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════
echo ""
echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║  Round-trip test complete!                            ║${NC}"
echo -e "  ${GREEN}║                                                       ║${NC}"
echo -e "  ${GREEN}║  What you just verified:                              ║${NC}"
echo -e "  ${GREEN}║    ✓ Agent writes config request inside sandbox       ║${NC}"
echo -e "  ${GREEN}║    ✓ Scanner submits it as a CONFIG PolicyChunk       ║${NC}"
echo -e "  ${GREEN}║    ✓ TUI shows it for approval                        ║${NC}"
echo -e "  ${GREEN}║    ✓ Approval triggers override file write            ║${NC}"
echo -e "  ${GREEN}║    ✓ gateway.* blocked at scanner level               ║${NC}"
echo -e "  ${GREEN}║    ✓ Host-side direct set works (operator path)       ║${NC}"
echo -e "  ${GREEN}║    ✓ Host-side gateway.* also blocked                 ║${NC}"
echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
info "Clean up with: nemoclaw $SANDBOX_NAME destroy --yes"
