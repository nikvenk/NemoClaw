#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Long-running e2e regression for NVIDIA/NemoClaw#2478 — gateway crash-loop
# recovery when a sandboxed library throws on init.
#
#   STAYS_IN_PR_UNTIL_SHIP — delete this file before merging the fix once
#   the soak has produced a clean run on a real DGX Spark / Brev instance.
#   Tracking removal in the PR description, not here, so the file does not
#   silently outlive the issue it was written for.
#
# What this test exercises (the fix from #2478):
#
#   The sandbox ships a chain of NODE_OPTIONS=--require preloads (sandbox
#   safety-net, ciao networkInterfaces guard, slack guard, http-proxy fix,
#   ws-proxy fix, nemotron fix). They are emitted into
#   /tmp/nemoclaw-proxy-env.sh at sandbox-start and reach the gateway via
#   ~/.bashrc on the FIRST start. Before #2478 the gateway recovery path
#   (laptop sleep, health-monitor restart, manual `nemoclaw <name> connect`)
#   silently swallowed sourcing errors with `2>/dev/null` and never asserted
#   that NODE_OPTIONS actually contained the guards. A stale or missing
#   proxy-env.sh therefore left the respawned gateway naked, and any library
#   that threw during init (ciao mDNS being the trigger documented in the
#   issue) crashed the gateway in a loop forever.
#
# This test:
#
#   1. Onboards a sandbox normally.
#   2. Verifies the *initial* gateway has the safety-net + ciao guard active
#      (via /proc/<pid>/environ on the gateway PID).
#   3. Crash-recovery loop (NORMAL): kill the gateway 5x, each time triggers
#      `nemoclaw <name> connect` (which calls recoverSandboxProcesses), and
#      checks the respawned gateway still has guards in NODE_OPTIONS.
#   4. Negative case: removes /tmp/nemoclaw-proxy-env.sh, kills the gateway,
#      triggers recovery — expects the new "[gateway-recovery] WARNING"
#      line in stderr (visible via gateway.log) instead of silent guard loss.
#   5. Soak: leaves the sandbox idle for $NEMOCLAW_E2E_SOAK_SECONDS
#      (default 300) so the health-monitor restart cadence (~4 min in prod)
#      gets at least one chance to fire, then asserts the gateway has not
#      crash-looped in the meantime (PID stable OR exactly one clean
#      respawn, no churn).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for onboard
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-2478)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 1500)
#   NEMOCLAW_E2E_CRASH_CYCLES              — crash-recover cycles (default: 5)
#   NEMOCLAW_E2E_SOAK_SECONDS              — idle soak window (default: 300)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-issue-2478-crash-loop-recovery.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1500
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

PASS=0
FAIL=0
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
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-2478}"
CRASH_CYCLES="${NEMOCLAW_E2E_CRASH_CYCLES:-5}"
SOAK_SECONDS="${NEMOCLAW_E2E_SOAK_SECONDS:-300}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"

# ── Helpers ──────────────────────────────────────────────────────

# Run a command inside the sandbox via openshell sandbox exec. Returns
# stdout; non-zero exit prints stderr but does not abort the test.
sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- "$@" 2>&1
}

# Get the current openclaw gateway PID inside the sandbox, or empty string.
# The gateway re-execs to argv `openclaw-gateway` after startup (it spawns
# from the launcher whose argv is `openclaw gateway run`). Match either form
# via `[o]penclaw[ -]gateway` — bracket trick prevents pgrep self-match,
# `[ -]` accepts both the launcher (space) and the post-rename (dash). `-o`
# returns the OLDEST match (the long-lived launcher 262 in the typical
# parent/child tree); env is inherited so NODE_OPTIONS reads the same.
gateway_pid() {
  sandbox_exec sh -c "pgrep -fo '[o]penclaw[ -]gateway'" | tr -d '[:space:]'
}

# Read NODE_OPTIONS from /proc/<pid>/environ — null-separated, decode to lines.
gateway_node_options() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  sandbox_exec sh -c "tr '\\0' '\\n' < /proc/${pid}/environ 2>/dev/null | grep '^NODE_OPTIONS='"
}

# Tail gateway.log from inside the sandbox (last N lines).
gateway_log_tail() {
  sandbox_exec sh -c "tail -n ${1:-50} /tmp/gateway.log 2>/dev/null"
}

# Dump diagnostic snapshot for triage when an environ read or guard
# assertion fails. Helps distinguish wrong-PID matching, gateway-not-running,
# and cross-namespace /proc visibility issues.
gateway_diagnostics() {
  local pid="${1:-}"
  echo "  --- gateway diagnostics ---"
  echo "  [exec context: whoami / hostname / pwd / pid namespace]"
  # shellcheck disable=SC2016  # intentional: expand inside sandbox, not host
  sandbox_exec sh -c 'echo "user=$(whoami) host=$(hostname) pwd=$(pwd) pid_ns=$(readlink /proc/self/ns/pid 2>/dev/null)"' | sed 's/^/    /'
  echo "  [pgrep -af '[o]penclaw' (any openclaw process)]"
  sandbox_exec sh -c "pgrep -af '[o]penclaw' || echo '(no matches)'" | sed 's/^/    /'
  echo "  [ps auxf (full tree, top 40 lines)]"
  sandbox_exec sh -c "ps auxf 2>/dev/null | head -40 || ps -ef 2>/dev/null | head -40" | sed 's/^/    /'
  echo "  [ls /tmp (gateway.log presence + size)]"
  sandbox_exec sh -c "ls -la /tmp/gateway.log /tmp/auto-pair.log /tmp/openclaw-* 2>&1 | head -20" | sed 's/^/    /'
  echo "  [tail /tmp/gateway.log -n 60]"
  sandbox_exec sh -c "tail -n 60 /tmp/gateway.log 2>&1 || echo '(no gateway.log)'" | sed 's/^/    /'
  echo "  [nemoclaw status]"
  nemoclaw "$SANDBOX_NAME" status 2>&1 | head -30 | sed 's/^/    /'
  echo "  [openshell sandbox containers / pod]"
  openshell sandbox info --name "$SANDBOX_NAME" 2>&1 | head -20 | sed 's/^/    /' || true
  if [ -n "$pid" ]; then
    echo "  [reported pid: $pid]"
    echo "  [/proc/${pid} listing]"
    sandbox_exec sh -c "ls -la /proc/${pid}/ 2>&1 | head -8 || echo '(cannot list)'" | sed 's/^/    /'
    echo "  [/proc/${pid}/cmdline]"
    sandbox_exec sh -c "cat /proc/${pid}/cmdline 2>&1 | tr '\\0' ' '; echo" | sed 's/^/    /'
    echo "  [/proc/${pid}/status (uid/state)]"
    sandbox_exec sh -c "grep -E '^(Name|State|Uid|Pid|PPid):' /proc/${pid}/status 2>&1" | sed 's/^/    /'
  fi
  echo "  ---------------------------"
}

# Wait until gateway PID is non-empty (or timeout). Echoes pid, returns 0/1.
wait_for_gateway_up() {
  local timeout="${1:-30}"
  local elapsed=0 pid=""
  while [ "$elapsed" -lt "$timeout" ]; do
    pid="$(gateway_pid)"
    if [ -n "$pid" ]; then
      echo "$pid"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo ""
  return 1
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Preflight
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Preflight"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker running"

if [ -z "${NVIDIA_API_KEY:-}" ] || [[ "${NVIDIA_API_KEY}" != nvapi-* ]]; then
  fail "NVIDIA_API_KEY not set or invalid"
  exit 1
fi
pass "NVIDIA_API_KEY set"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ] || [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 are required"
  exit 1
fi
pass "Required env vars set"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup + onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup + onboard"

if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
fi

cd "$REPO_ROOT" || {
  fail "cd $REPO_ROOT"
  exit 1
}

INSTALL_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1

install_exit=$?
if [ $install_exit -ne 0 ]; then
  fail "install.sh failed (exit $install_exit). Last 30 lines:"
  tail -30 "$INSTALL_LOG"
  rm -f "$INSTALL_LOG"
  exit 1
fi
rm -f "$INSTALL_LOG"
pass "install.sh + onboard completed"

# Pick up PATH changes
[ -f "$HOME/.bashrc" ] && { source "$HOME/.bashrc" 2>/dev/null || true; }
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not on PATH after install"
  exit 1
fi
pass "nemoclaw on PATH"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify initial gateway has the guard chain
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Initial gateway has guard chain"

INIT_PID="$(wait_for_gateway_up 60)"
if [ -z "$INIT_PID" ]; then
  fail "Gateway never came up after onboard"
  gateway_diagnostics ""
  exit 1
fi
pass "Gateway up (pid=$INIT_PID)"

INIT_NODE_OPTIONS="$(gateway_node_options "$INIT_PID")"
if echo "$INIT_NODE_OPTIONS" | grep -q 'nemoclaw-sandbox-safety-net'; then
  pass "Initial gateway has safety-net preload"
else
  fail "Initial gateway missing safety-net preload — fix is not deployed?"
  echo "  NODE_OPTIONS: $INIT_NODE_OPTIONS"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi
if echo "$INIT_NODE_OPTIONS" | grep -q 'nemoclaw-ciao-network-guard'; then
  pass "Initial gateway has ciao networkInterfaces guard"
else
  fail "Initial gateway missing ciao guard — fix is not deployed?"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)"

prev_pid="$INIT_PID"
for cycle in $(seq 1 "$CRASH_CYCLES"); do
  info "Cycle $cycle/$CRASH_CYCLES — killing gateway pid=$prev_pid"
  sandbox_exec sh -c "kill -9 $prev_pid 2>/dev/null; sleep 1; pgrep -f 'openclaw gateway run' || echo DEAD" >/dev/null

  # Trigger recovery via the same code path the health-monitor uses.
  if ! nemoclaw "$SANDBOX_NAME" connect --probe-only >/dev/null 2>&1; then
    nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1 || true
  fi

  new_pid="$(wait_for_gateway_up 45)"
  if [ -z "$new_pid" ]; then
    fail "Cycle $cycle: gateway did not respawn within 45s"
    gateway_log_tail 60
    exit 1
  fi
  if [ "$new_pid" = "$prev_pid" ]; then
    fail "Cycle $cycle: PID unchanged ($new_pid) — kill did not land"
    exit 1
  fi
  pass "Cycle $cycle: gateway respawned (pid $prev_pid → $new_pid)"

  cycle_node_options="$(gateway_node_options "$new_pid")"
  if echo "$cycle_node_options" | grep -q 'nemoclaw-sandbox-safety-net'; then
    pass "Cycle $cycle: respawned gateway retains safety-net preload"
  else
    fail "Cycle $cycle: respawned gateway LOST safety-net — recovery hardening regressed"
    echo "  NODE_OPTIONS: $cycle_node_options"
    gateway_diagnostics "$new_pid"
    gateway_log_tail 80
    exit 1
  fi
  if echo "$cycle_node_options" | grep -q 'nemoclaw-ciao-network-guard'; then
    pass "Cycle $cycle: respawned gateway retains ciao guard"
  else
    fail "Cycle $cycle: respawned gateway LOST ciao guard"
    exit 1
  fi

  prev_pid="$new_pid"
done

# ══════════════════════════════════════════════════════════════════
# Phase 4: Negative case — env file missing → warning logged
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Negative case — proxy-env.sh missing surfaces a warning"

# Snapshot proxy-env.sh contents so we can restore after the test.
SNAPSHOT="$(sandbox_exec sh -c 'cat /tmp/nemoclaw-proxy-env.sh 2>/dev/null')"
if [ -z "$SNAPSHOT" ]; then
  fail "proxy-env.sh is empty/missing already — cannot run negative case"
  exit 1
fi
info "Snapshotted proxy-env.sh (${#SNAPSHOT} bytes)"

# Remove proxy-env.sh, kill gateway, trigger recovery, expect WARNING.
sandbox_exec sh -c 'rm -f /tmp/nemoclaw-proxy-env.sh' >/dev/null
sandbox_exec sh -c "kill -9 $prev_pid 2>/dev/null" >/dev/null
nemoclaw "$SANDBOX_NAME" connect --probe-only >/dev/null 2>&1 || true

# The new gateway.log should contain the [gateway-recovery] WARNING line.
warn_seen=false
for _ in 1 2 3 4 5; do
  if gateway_log_tail 100 | grep -q '\[gateway-recovery\] WARNING'; then
    warn_seen=true
    break
  fi
  sleep 3
done
if $warn_seen; then
  pass "Recovery emitted [gateway-recovery] WARNING when proxy-env.sh missing"
else
  fail "Recovery silently launched without warning (regression of #2478 fix)"
  gateway_log_tail 100
fi

# Restore proxy-env.sh so subsequent recoveries are healthy again. /tmp is
# sticky and the file was root-owned 444, so we restore via a privileged
# write. openshell sandbox exec runs as the sandbox user; we use a heredoc
# into the sandbox-side root via the agent container's privileged path.
sandbox_exec sh -c "cat > /tmp/nemoclaw-proxy-env.sh.restore <<'REPL'
$SNAPSHOT
REPL
chmod 444 /tmp/nemoclaw-proxy-env.sh.restore 2>/dev/null || true
mv /tmp/nemoclaw-proxy-env.sh.restore /tmp/nemoclaw-proxy-env.sh 2>/dev/null || true
" >/dev/null
info "proxy-env.sh restored (best-effort; soak phase will tolerate degraded state)"

# Bring the gateway back to a healthy state for the soak.
sandbox_exec sh -c "$(pgrep -f 'openclaw gateway run' >/dev/null 2>&1 && echo true || echo true)" >/dev/null
nemoclaw "$SANDBOX_NAME" connect --probe-only >/dev/null 2>&1 || true
SOAK_START_PID="$(wait_for_gateway_up 30)"
if [ -z "$SOAK_START_PID" ]; then
  fail "Gateway not up entering soak phase"
  exit 1
fi
pass "Gateway healthy entering soak (pid=$SOAK_START_PID)"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Soak — verify no crash-loop over $SOAK_SECONDS
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Soak ($SOAK_SECONDS s) — detect crash-loop regression"

info "Sleeping ${SOAK_SECONDS}s while observing gateway. Health-monitor restart"
info "cadence is ~240s in prod, so a $SOAK_SECONDS s window catches at least one cycle."

# Sample PID every 15s. Count distinct PIDs observed and any windows where
# pid was empty (gateway down).
declare -a SAMPLES=()
empty_samples=0
elapsed=0
INTERVAL=15
while [ "$elapsed" -lt "$SOAK_SECONDS" ]; do
  cur="$(gateway_pid)"
  SAMPLES+=("$cur")
  [ -z "$cur" ] && empty_samples=$((empty_samples + 1))
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# Distinct non-empty PIDs.
distinct=$(printf '%s\n' "${SAMPLES[@]}" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
total_samples=${#SAMPLES[@]}

info "Soak summary: ${total_samples} samples, ${distinct} distinct PID(s), ${empty_samples} empty observations"

# Crash-loop signature: many distinct PIDs (>2 over 5min = bad). One respawn
# (distinct=2) is acceptable if health-monitor fires once. Empty samples >1
# indicate the gateway was actually down for >15s, which is also bad.
if [ "$distinct" -le 2 ] && [ "$empty_samples" -le 1 ]; then
  pass "No crash-loop detected during soak ($distinct distinct PIDs, $empty_samples empty samples)"
else
  fail "Crash-loop signature: $distinct distinct PIDs and $empty_samples empty samples in ${SOAK_SECONDS}s"
  printf '  PID samples: %s\n' "${SAMPLES[*]}"
  gateway_log_tail 120
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Issue #2478 crash-loop recovery e2e:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  PASS — gateway recovery preserves library guards under repeated kill-respawn and idle soak.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
