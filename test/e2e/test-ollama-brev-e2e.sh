#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Brev Ollama E2E — verifies the local Ollama inference path on a real Brev
# instance (the environment that produces issue #1924).
#
# Runs ON the Brev VM after the launchable has provisioned nemoclaw. Exercises
# the "sandbox → host.openshell.internal → Ollama auth proxy → Ollama"
# networking chain that the auth proxy architecture (PR #1922) introduced.
#
# Why CPU + tiny model:
#   #1924 is a networking bug (container cannot reach host Ollama), not an
#   inference bug. qwen2.5:0.5b (~400MB) is small enough to run on the CPU
#   Brev instance the launchable already provisions — we do not need a GPU
#   to verify the auth proxy chain is reachable end to end.
#
# Prerequisites (supplied by the launchable + brev-e2e.test.ts runner):
#   - Docker running (socket chmod 666)
#   - nemoclaw installed and on PATH
#   - NVIDIA_API_KEY set (unused for Ollama path but needed for onboard
#     wizard env validation on some paths)
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment variables:
#   NEMOCLAW_SANDBOX_NAME     — sandbox name (default: e2e-ollama-brev)
#   OLLAMA_MODEL              — model tag to pull (default: qwen2.5:0.5b)
#   SKIP_INFERENCE            — set to 1 to skip the inference probe
#                                (reachability-only mode, ~5 min faster)

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-ollama-brev}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"
OLLAMA_PORT=11434
# Matches OLLAMA_CONTAINER_PORT in nemoclaw/src/lib/ports.ts — keep in sync.
OLLAMA_CONTAINER_PORT=11435

# shellcheck disable=SC2329  # invoked via trap EXIT
cleanup() {
  # Best-effort teardown. Leaves Ollama installed — removal is expensive
  # and CI instances are ephemeral.
  set +e
  info "Teardown: destroying sandbox and gateway..."
  nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
  openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  set -e
}
trap cleanup EXIT

# ── Preflight ───────────────────────────────────────────────────────────────
section "Preflight"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "Preflight" "nemoclaw not on PATH — launchable setup incomplete"
  exit 1
fi
pass "nemoclaw on PATH ($(nemoclaw --version 2>/dev/null || echo unknown))"

if ! docker info >/dev/null 2>&1; then
  fail "Preflight" "Docker not running"
  exit 1
fi
pass "Docker running"

# ── Install Ollama on the host ──────────────────────────────────────────────
section "Install Ollama on host"

if command -v ollama >/dev/null 2>&1; then
  info "Ollama already installed ($(ollama --version 2>/dev/null | head -1))"
  pass "Ollama present on host"
else
  info "Installing Ollama via upstream install script..."
  if curl -fsSL https://ollama.com/install.sh | sh >/tmp/ollama-install.log 2>&1; then
    pass "Ollama install script completed"
  else
    fail "Ollama install" "install.sh exited non-zero — see /tmp/ollama-install.log"
    cat /tmp/ollama-install.log || true
    exit 1
  fi
fi

# Wait for systemd ollama service to accept connections. Bind is 127.0.0.1
# by default — the auth proxy architecture expects this (PR #1922).
info "Waiting for Ollama to accept connections on 127.0.0.1:${OLLAMA_PORT}..."
for i in $(seq 1 30); do
  if curl -sf --max-time 2 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
    pass "Ollama responding on 127.0.0.1:${OLLAMA_PORT} (after ${i}s)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    fail "Ollama readiness" "no response on 127.0.0.1:${OLLAMA_PORT} after 30s"
    exit 1
  fi
  sleep 1
done

# ── Pull the tiny model ─────────────────────────────────────────────────────
section "Pull model: $OLLAMA_MODEL"
info "This is a small model (~400MB) sized for CPU-based reachability testing."

if ollama pull "$OLLAMA_MODEL" 2>&1 | tail -5; then
  pass "Model $OLLAMA_MODEL pulled"
else
  fail "Model pull" "ollama pull $OLLAMA_MODEL failed"
  exit 1
fi

# Sanity: model appears in local registry
if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qxF "$OLLAMA_MODEL"; then
  pass "Model listed by 'ollama list'"
else
  fail "Model registry" "$OLLAMA_MODEL not in ollama list output"
fi

# ── Onboard with Ollama provider ────────────────────────────────────────────
section "Onboard NemoClaw with Ollama provider"

rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

onboard_exit=0
NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL="$OLLAMA_MODEL" \
  nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
  2>&1 | tee /tmp/ollama-onboard.log || onboard_exit=$?

if [[ $onboard_exit -ne 0 ]]; then
  fail "Onboard" "nemoclaw onboard exited with code $onboard_exit — see /tmp/ollama-onboard.log"
  exit 1
fi
pass "nemoclaw onboard --non-interactive completed"

# Specific regression guard for #1924 — if the old error surfaces, fail.
if grep -q "Ensure Ollama listens on 0.0.0.0" /tmp/ollama-onboard.log; then
  fail "Onboard regression (#1924)" "legacy pre-auth-proxy error message detected"
fi

if ! nemoclaw list 2>/dev/null | awk '{print $1}' | grep -qxF "$SANDBOX_NAME"; then
  fail "Sandbox registry" "sandbox '$SANDBOX_NAME' not found in 'nemoclaw list'"
  exit 1
fi
pass "Sandbox '$SANDBOX_NAME' registered"

# ── Auth proxy running ──────────────────────────────────────────────────────
section "Auth proxy container"

if docker ps --format '{{.Names}} {{.Ports}}' | grep -qE "ollama.*${OLLAMA_CONTAINER_PORT}"; then
  pass "Ollama auth proxy container running on :${OLLAMA_CONTAINER_PORT}"
else
  # Non-fatal — the proxy may be a plain host process rather than a
  # container on some NemoClaw versions. The reachability test below is
  # the authoritative check.
  skip "Auth proxy container visibility (host-process implementation possible)"
fi

if curl -sf --max-time 5 "http://127.0.0.1:${OLLAMA_CONTAINER_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Auth proxy responding on 127.0.0.1:${OLLAMA_CONTAINER_PORT}"
else
  fail "Auth proxy reachability" "no response on 127.0.0.1:${OLLAMA_CONTAINER_PORT} — onboard did not start the proxy"
fi

# ── Container reachability (the core #1924 assertion) ───────────────────────
section "Container → host.openshell.internal reachability"

# Standalone docker probe: matches getLocalProviderContainerReachabilityCheck
# in src/lib/local-inference.ts:156-176. This validates that the host-gateway
# pathway works — the exact failure mode reported in #1924.
probe_output=$(docker run --rm \
  --add-host "host.openshell.internal:host-gateway" \
  curlimages/curl:latest \
  -sf --max-time 5 "http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags" 2>&1) || probe_output=""

if [[ -n "$probe_output" ]]; then
  pass "Docker container reached auth proxy via host.openshell.internal:${OLLAMA_CONTAINER_PORT}"
else
  fail "#1924 reachability" "container could not reach host.openshell.internal:${OLLAMA_CONTAINER_PORT}"
fi

# Sandbox-level probe: validates the same path through OpenShell-managed
# networking, which is what onboard uses.
sandbox_probe=$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
  curl -sf --max-time 5 "http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags" 2>&1) || sandbox_probe=""

if [[ -n "$sandbox_probe" ]]; then
  pass "Sandbox reached auth proxy via host.openshell.internal:${OLLAMA_CONTAINER_PORT}"
else
  fail "Sandbox reachability" "sandbox '$SANDBOX_NAME' could not reach auth proxy"
fi

# ── Inference end-to-end (optional) ─────────────────────────────────────────
if [[ "${SKIP_INFERENCE:-0}" == "1" ]]; then
  section "Inference probe (skipped)"
  skip "SKIP_INFERENCE=1 — reachability-only mode"
else
  section "Inference end-to-end (CPU — tolerant timeout)"
  info "Small model on CPU: response may take up to 90s"

  # Mirrors test-gpu-e2e.sh: ssh into the sandbox via openshell sandbox
  # ssh-config and hit inference.local from the inside. This exercises the
  # full sandbox → gateway → auth proxy → Ollama chain that #1924 is about.
  ssh_config=$(mktemp)
  inference_exit=0
  inference_output=""

  if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    inference_output=$(timeout 120 ssh -F "$ssh_config" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${SANDBOX_NAME}" \
      "curl -s --max-time 90 https://inference.local/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -d '{\"model\":\"$OLLAMA_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":20}'" \
      2>&1) || inference_exit=$?
  else
    inference_exit=127
  fi
  rm -f "$ssh_config"

  if [[ $inference_exit -eq 124 ]]; then
    fail "Inference" "timed out after 120s — model may be too slow on this CPU"
  elif [[ $inference_exit -eq 127 ]]; then
    fail "Inference" "openshell sandbox ssh-config failed"
  elif [[ $inference_exit -ne 0 ]]; then
    fail "Inference" "ssh to sandbox exited with $inference_exit: ${inference_output:0:200}"
  elif [[ -z "$inference_output" ]]; then
    fail "Inference" "empty response"
  else
    pass "Inference returned a response via sandbox → gateway → auth proxy → Ollama"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Brev Ollama E2E summary"
echo "============================================================"
printf '  \033[32mPASS:\033[0m %d\n' "$PASS"
printf '  \033[31mFAIL:\033[0m %d\n' "$FAIL"
printf '  \033[33mSKIP:\033[0m %d\n' "$SKIP"
printf '  TOTAL: %d\n' "$TOTAL"
echo "============================================================"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
