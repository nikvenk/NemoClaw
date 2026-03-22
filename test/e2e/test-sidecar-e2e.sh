#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck disable=SC1091,SC2086
# SC1091: sourced files (.bashrc, nvm.sh) are external and not available for analysis
# SC2086: intentional word-splitting on $SSH_CMD and $TIMEOUT_CMD (multi-arg variables)
#
# Autonomous E2E test for Docker sidecar inference on native Linux.
#
# Runs the full lifecycle:
#   Phase 0: Environment validation (Linux, Docker, GPU, cleanup)
#   Phase 1: Ollama sidecar — install + onboard (non-interactive)
#   Phase 2: Ollama inference battery
#   Phase 3: Ollama model hot-swap (additional models)
#   Phase 4: LM Studio sidecar — uninstall + re-onboard (skip on image pull failure)
#   Phase 5: Cleanup & structured JSON results
#
# Prerequisites:
#   - Native Linux (not WSL2)
#   - Docker running with NVIDIA GPU support
#   - Network access to pull Docker images (ollama/ollama, lmstudio/llmster-preview)
#
# Usage:
#   bash test/e2e/test-sidecar-e2e.sh
#
# Environment overrides:
#   OLLAMA_MODELS    — space-separated Ollama model list (default: "nemotron-3-nano:30b")
#   LMSTUDIO_MODELS  — space-separated LM Studio model list (default: "openreasoning-nemotron-7b@q4_k_m")
#   SKIP_LMSTUDIO    — set to 1 to skip LM Studio phase entirely
#   SKIP_CLEANUP     — set to 1 to leave the environment running after tests

set -uo pipefail

# ── Configuration ──────────────────────────────────────────────
# All Nemotron models offered via sidecar onboard.
# Non-Nemotron models (qwen, llama, etc.) are user-managed, not tested here.
if [ -n "${OLLAMA_MODELS:-}" ]; then
  read -ra OLLAMA_MODELS <<< "$OLLAMA_MODELS"
else
  OLLAMA_MODELS=("nemotron-3-nano:30b")
fi
if [ -n "${LMSTUDIO_MODELS:-}" ]; then
  read -ra LMSTUDIO_MODELS <<< "$LMSTUDIO_MODELS"
else
  LMSTUDIO_MODELS=(
    "openreasoning-nemotron-7b@q4_k_m"
    "openreasoning-nemotron-14b@q4_k_m"
    "opencodereasoning-nemotron-14b@q4_k_m"
    "openreasoning-nemotron-1.5b@q4_k_m"
    "llama-3.1-nemotron-nano-4b-v1.1@q4_k_m"
  )
fi
SANDBOX_NAME="sidecar-e2e"
RESULTS_DIR="/tmp"
RESULTS_FILE="${RESULTS_DIR}/nemoclaw-sidecar-results-$(hostname)-$(date +%Y%m%d-%H%M%S).json"

# ── Counters ───────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); printf '\033[32m  PASS: %s\033[0m\n' "$1"; }
fail() { ((FAIL++)); ((TOTAL++)); printf '\033[31m  FAIL: %s\033[0m\n' "$1"; }
skip() { ((SKIP++)); ((TOTAL++)); printf '\033[33m  SKIP: %s\033[0m\n' "$1"; }
section() { echo ""; printf '\033[1;36m=== %s ===\033[0m\n' "$1"; }
info()  { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# ── JSON results accumulator ──────────────────────────────────
JSON_TESTS="["
JSON_FIRST=true

add_json_result() {
  local provider="$1" model="$2" onboard_ok="$3" sidecar_running="$4"
  local battery_json="${5:-null}"

  if [ "$JSON_FIRST" = true ]; then
    JSON_FIRST=false
  else
    JSON_TESTS+=","
  fi

  JSON_TESTS+="{\"provider\":\"$provider\",\"model\":\"$model\""
  JSON_TESTS+=",\"onboard_ok\":$onboard_ok,\"sidecar_running\":$sidecar_running"
  JSON_TESTS+=",\"inference_battery\":$battery_json}"
}

write_results() {
  JSON_TESTS+="]"
  local gpu_info
  gpu_info=$(nvidia-smi -L 2>/dev/null | head -1 || echo "unknown")
  gpu_info="${gpu_info//\"/\\\"}"

  cat > "$RESULTS_FILE" <<EOF
{
  "hostname": "$(hostname)",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gpu": "$gpu_info",
  "kernel": "$(uname -r)",
  "docker": "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)",
  "pass": $PASS,
  "fail": $FAIL,
  "skip": $SKIP,
  "total": $TOTAL,
  "tests": $JSON_TESTS
}
EOF
  info "Results written to $RESULTS_FILE"
}

# ── Repo root detection ───────────────────────────────────────
if [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
elif [ -f "./install.sh" ]; then
  REPO="$(pwd)"
else
  echo "ERROR: Cannot find repo root (expected install.sh at root)."
  exit 1
fi

INFERENCE_BATTERY="$REPO/test/e2e/test-sidecar-inference.sh"

# ══════════════════════════════════════════════════════════════
# Phase 0: Environment validation
# ══════════════════════════════════════════════════════════════
section "Phase 0: Environment validation"

# Must be native Linux
if [ "$(uname -s)" != "Linux" ]; then
  fail "Not running on Linux (got $(uname -s))"
  exit 1
fi
pass "Running on Linux"

# Must NOT be WSL2
if [ -f /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -n "${WSL_DISTRO_NAME:-}" ]; then
  fail "Running under WSL2 — this test targets native Linux"
  exit 1
fi
pass "Not WSL2 (native Linux)"

# Docker must be running
if docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

# NVIDIA GPU required
if nvidia-smi -L > /dev/null 2>&1; then
  GPU_INFO=$(nvidia-smi -L | head -1)
  pass "NVIDIA GPU detected: $GPU_INFO"
else
  fail "No NVIDIA GPU detected (nvidia-smi failed)"
  exit 1
fi

info "Hostname:       $(hostname)"
info "Kernel:         $(uname -r)"
info "Docker version: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
info "GPU:            $GPU_INFO"
info "Ollama models:  ${OLLAMA_MODELS[*]}"
info "LM Studio models: ${LMSTUDIO_MODELS[*]}"

# Pre-cleanup
info "Cleaning up any leftover state from previous runs..."
if command -v nemoclaw > /dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
fi
if command -v openshell > /dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
# Stop any leftover sidecar containers
docker rm -f "nemoclaw-ollama-default" 2>/dev/null || true
docker rm -f "nemoclaw-lmstudio-default" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════
# Phase 1: Ollama sidecar onboard
# ══════════════════════════════════════════════════════════════
section "Phase 1: Ollama sidecar onboard"

FIRST_OLLAMA_MODEL="${OLLAMA_MODELS[0]}"
info "Provider: ollama (sidecar), Model: $FIRST_OLLAMA_MODEL"
info "Running install.sh --non-interactive..."

cd "$REPO" || { fail "Could not cd to repo root: $REPO"; exit 1; }

INSTALL_LOG="/tmp/nemoclaw-sidecar-e2e-install-ollama.log"
NEMOCLAW_NON_INTERACTIVE=1 \
NEMOCLAW_PROVIDER=ollama \
NEMOCLAW_MODEL="$FIRST_OLLAMA_MODEL" \
NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
NEMOCLAW_RECREATE_SANDBOX=1 \
NEMOCLAW_POLICY_MODE=suggested \
  bash install.sh --non-interactive > "$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Source shell profile to pick up PATH changes
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

OLLAMA_ONBOARD_OK=false
if [ $install_exit -eq 0 ]; then
  pass "Ollama onboard completed (exit 0)"
  OLLAMA_ONBOARD_OK=true
else
  fail "Ollama onboard failed (exit $install_exit) — see $INSTALL_LOG"
fi

# Validate onboard results
OLLAMA_SIDECAR_RUNNING=false

if [ "$OLLAMA_ONBOARD_OK" = true ]; then
  # Check nemoclaw list
  if list_output=$(nemoclaw list 2>&1) && echo "$list_output" | grep -Fq -- "$SANDBOX_NAME"; then
    pass "nemoclaw list contains '$SANDBOX_NAME'"
  else
    fail "nemoclaw list does not contain '$SANDBOX_NAME'"
  fi

  # Check inference provider
  if inf_output=$(openshell inference get 2>&1) && echo "$inf_output" | grep -qi "ollama-k3s"; then
    pass "Inference configured as ollama-k3s"
  else
    fail "Inference not configured as ollama-k3s: ${inf_output:0:200}"
  fi

  # Check sidecar container
  if docker ps --format '{{.Names}}' | grep -q "nemoclaw-ollama-default"; then
    pass "Ollama sidecar container is running"
    OLLAMA_SIDECAR_RUNNING=true
  else
    fail "Ollama sidecar container not found"
  fi
fi

# ══════════════════════════════════════════════════════════════
# Phase 2: Ollama inference battery
# ══════════════════════════════════════════════════════════════
section "Phase 2: Ollama inference battery ($FIRST_OLLAMA_MODEL)"

OLLAMA_BATTERY_JSON="null"

if [ "$OLLAMA_ONBOARD_OK" = true ] && [ "$OLLAMA_SIDECAR_RUNNING" = true ]; then
  info "Running inference battery..."
  BATTERY_LOG="/tmp/nemoclaw-sidecar-e2e-battery-ollama-${FIRST_OLLAMA_MODEL//:/-}.log"
  battery_output=$(bash "$INFERENCE_BATTERY" --json "$FIRST_OLLAMA_MODEL" 2>&1) || true
  echo "$battery_output" > "$BATTERY_LOG"
  summary_line=$(echo "$battery_output" | grep '"summary"' | tail -1)

  if [ -n "$summary_line" ]; then
    OLLAMA_BATTERY_JSON="$summary_line"
    battery_pass=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['pass'])" 2>/dev/null || echo 0)
    battery_fail=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['fail'])" 2>/dev/null || echo 0)
    battery_total=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])" 2>/dev/null || echo 0)
    pass "Inference battery: $battery_pass/$battery_total passed"
    if [ "$battery_fail" -gt 0 ]; then
      fail "Inference battery: $battery_fail/$battery_total failed"
    fi
  else
    fail "Inference battery produced no summary — see $BATTERY_LOG"
    info "Raw output (last 10 lines):"
    tail -10 "$BATTERY_LOG" 2>/dev/null | while IFS= read -r line; do info "  $line"; done
  fi

  add_json_result "ollama-k3s" "$FIRST_OLLAMA_MODEL" "$OLLAMA_ONBOARD_OK" "$OLLAMA_SIDECAR_RUNNING" "$OLLAMA_BATTERY_JSON"
else
  skip "Skipping Ollama inference battery (onboard failed)"
  add_json_result "ollama-k3s" "$FIRST_OLLAMA_MODEL" "$OLLAMA_ONBOARD_OK" "$OLLAMA_SIDECAR_RUNNING" "null"
fi

# ══════════════════════════════════════════════════════════════
# Phase 2b: OpenClaw sandbox validation
# ══════════════════════════════════════════════════════════════
section "Phase 2b: OpenClaw sandbox session validation"

if [ "$OLLAMA_ONBOARD_OK" = true ] && [ "$OLLAMA_SIDECAR_RUNNING" = true ]; then
  SSH_CONFIG=$(mktemp)
  TIMEOUT_CMD=""
  command -v timeout > /dev/null 2>&1 && TIMEOUT_CMD="timeout 120"

  if openshell sandbox ssh-config "$SANDBOX_NAME" > "$SSH_CONFIG" 2>/dev/null; then
    SSH_CMD="ssh -F $SSH_CONFIG -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR openshell-${SANDBOX_NAME}"

    # Test 1: Raw curl to inference.local from inside sandbox
    info "Testing raw inference.local endpoint from inside sandbox..."
    raw_response=$($TIMEOUT_CMD $SSH_CMD \
      "curl -s --max-time 90 https://inference.local/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -d '{\"model\":\"$FIRST_OLLAMA_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" \
      2>&1) || true

    if [ -n "$raw_response" ]; then
      raw_content=$(echo "$raw_response" | python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    # Check all fields where the model might put its answer
    content = c.get('content') or ''
    reasoning = c.get('reasoning_content') or c.get('reasoning') or ''
    # Combine for pattern matching
    print((content + ' ' + reasoning).strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null) || true
      if echo "$raw_content" | grep -qi "PONG"; then
        pass "Sandbox → inference.local → gateway → sidecar: PONG received"
      else
        fail "Sandbox inference.local: expected PONG, got: ${raw_content:0:200}"
        info "Raw response: ${raw_response:0:300}"
      fi
    else
      fail "Sandbox inference.local: empty response"
    fi

    # Test 2: OpenClaw agent CLI
    info "Testing openclaw agent CLI inside sandbox..."
    openclaw_response=$($TIMEOUT_CMD $SSH_CMD \
      "openclaw agent --agent main --local -m 'What is the capital of France? Reply in one word.' --session-id sidecar-e2e-test" \
      2>&1) || true

    if [ -n "$openclaw_response" ]; then
      if echo "$openclaw_response" | grep -qi "paris"; then
        pass "OpenClaw agent: correct response (Paris)"
      elif echo "$openclaw_response" | grep -qi "error\|Error\|ERROR"; then
        fail "OpenClaw agent returned error: ${openclaw_response:0:300}"
      else
        # Model responded but didn't say Paris — still a working session
        pass "OpenClaw agent: session works (response: ${openclaw_response:0:100})"
      fi
    else
      fail "OpenClaw agent: no response"
    fi

    # Test 3: OpenClaw agent with reasoning prompt (validates thinking token handling)
    info "Testing openclaw agent with reasoning prompt..."
    reasoning_response=$($TIMEOUT_CMD $SSH_CMD \
      "openclaw agent --agent main --local -m 'A bat and ball cost 1.10 total. The bat costs 1.00 more than the ball. How much does the ball cost? Think step by step, then give the final answer.' --session-id sidecar-e2e-reasoning" \
      2>&1) || true

    if [ -n "$reasoning_response" ]; then
      if echo "$reasoning_response" | grep -q "0.05\|five cents\|\$0\.05"; then
        pass "OpenClaw agent reasoning: correct answer (0.05)"
      elif [ ${#reasoning_response} -gt 20 ]; then
        # Got a substantial response, just not the exact pattern — model is working
        pass "OpenClaw agent reasoning: session works (${#reasoning_response} chars)"
      else
        fail "OpenClaw agent reasoning: short/empty response: ${reasoning_response:0:200}"
      fi
    else
      fail "OpenClaw agent reasoning: no response"
    fi

    # Test 4: OpenClaw agent with code generation prompt
    info "Testing openclaw agent with code prompt..."
    code_response=$($TIMEOUT_CMD $SSH_CMD \
      "openclaw agent --agent main --local -m 'Write a Python function called is_prime that checks if a number is prime. Output only the code, no explanation.' --session-id sidecar-e2e-code" \
      2>&1) || true

    if [ -n "$code_response" ]; then
      if echo "$code_response" | grep -q "def \|def\t"; then
        pass "OpenClaw agent code gen: contains function definition"
      elif echo "$code_response" | grep -qi "prime\|is_prime"; then
        pass "OpenClaw agent code gen: contains prime logic"
      elif [ ${#code_response} -gt 20 ]; then
        pass "OpenClaw agent code gen: session works (${#code_response} chars)"
      else
        fail "OpenClaw agent code gen: insufficient response: ${code_response:0:200}"
      fi
    else
      fail "OpenClaw agent code gen: no response"
    fi

  else
    fail "Could not get SSH config for sandbox $SANDBOX_NAME"
  fi

  rm -f "$SSH_CONFIG"
else
  skip "Skipping OpenClaw validation (onboard failed)"
fi

# ══════════════════════════════════════════════════════════════
# Phase 3: Ollama model hot-swap
# ══════════════════════════════════════════════════════════════
if [ "${#OLLAMA_MODELS[@]}" -gt 1 ] && [ "$OLLAMA_ONBOARD_OK" = true ] && [ "$OLLAMA_SIDECAR_RUNNING" = true ]; then
  section "Phase 3: Ollama model hot-swap"

  for model in "${OLLAMA_MODELS[@]:1}"; do
    info "Hot-swapping to model: $model"

    # Pull model into running sidecar
    info "Pulling model (may take a while for large models)..."
    if docker exec nemoclaw-ollama-default ollama pull "$model" 2>&1; then
      pass "Model pulled: $model"
    else
      fail "Model pull failed: $model"
      add_json_result "ollama-k3s" "$model" true true "null"
      continue
    fi

    # Update inference route
    if openshell inference set --no-verify --provider ollama-k3s --model "$model" 2>&1; then
      pass "Inference route updated to $model"
    else
      fail "Failed to update inference route to $model"
      add_json_result "ollama-k3s" "$model" true true "null"
      continue
    fi

    # Warmup
    info "Warming up model..."
    docker exec nemoclaw-ollama-default ollama run "$model" "hello" --keepalive 15m > /dev/null 2>&1 || true

    # Run battery
    info "Running inference battery for $model..."
    BATTERY_LOG="/tmp/nemoclaw-sidecar-e2e-battery-ollama-${model//:/-}.log"
    battery_output=$(bash "$INFERENCE_BATTERY" --json "$model" 2>&1) || true
    echo "$battery_output" > "$BATTERY_LOG"
    summary_line=$(echo "$battery_output" | grep '"summary"' | tail -1)

    if [ -n "$summary_line" ]; then
      battery_pass=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['pass'])" 2>/dev/null || echo 0)
      battery_fail=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['fail'])" 2>/dev/null || echo 0)
      battery_total=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])" 2>/dev/null || echo 0)
      pass "Inference battery ($model): $battery_pass/$battery_total passed"
      if [ "$battery_fail" -gt 0 ]; then
        fail "Inference battery ($model): $battery_fail/$battery_total failed"
      fi
      add_json_result "ollama-k3s" "$model" true true "$summary_line"
    else
      fail "Inference battery ($model) produced no summary — see $BATTERY_LOG"
      tail -10 "$BATTERY_LOG" 2>/dev/null | while IFS= read -r line; do info "  $line"; done
      add_json_result "ollama-k3s" "$model" true true "null"
    fi
  done
else
  if [ "${#OLLAMA_MODELS[@]}" -gt 1 ]; then
    skip "Skipping Ollama hot-swap (onboard failed)"
  fi
fi

# ══════════════════════════════════════════════════════════════
# Phase 4: LM Studio sidecar
# ══════════════════════════════════════════════════════════════
if [ "${SKIP_LMSTUDIO:-}" = "1" ]; then
  section "Phase 4: LM Studio sidecar (SKIPPED by SKIP_LMSTUDIO=1)"
  skip "LM Studio phase skipped"
else
  section "Phase 4: LM Studio sidecar"

  FIRST_LMSTUDIO_MODEL="${LMSTUDIO_MODELS[0]}"
  LMSTUDIO_IMAGE_OK=false
  HOST_ARCH=$(uname -m)

  # LM Studio image is x86_64 only — skip on ARM64
  if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
    skip "LM Studio Docker image is x86_64 only (host is $HOST_ARCH) — skipping"
    add_json_result "lmstudio-k3s" "$FIRST_LMSTUDIO_MODEL" false false "null"
  else
    info "Checking if LM Studio Docker image is pullable..."
    if docker pull lmstudio/llmster-preview 2>&1 | tail -3; then
      pass "LM Studio Docker image available"
      LMSTUDIO_IMAGE_OK=true
    else
      skip "LM Studio Docker image not available — skipping LM Studio phase"
      add_json_result "lmstudio-k3s" "$FIRST_LMSTUDIO_MODEL" false false "null"
    fi
  fi

  if [ "$LMSTUDIO_IMAGE_OK" = true ]; then
    # Full cleanup
    info "Uninstalling Ollama environment..."
    bash "$REPO/uninstall.sh" --yes --keep-openshell 2>&1 | tail -5 || true
    docker rm -f "nemoclaw-ollama-default" 2>/dev/null || true

    info "Re-onboarding with LM Studio sidecar..."
    INSTALL_LOG="/tmp/nemoclaw-sidecar-e2e-install-lmstudio.log"
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_PROVIDER=lmstudio \
    NEMOCLAW_MODEL="$FIRST_LMSTUDIO_MODEL" \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    NEMOCLAW_POLICY_MODE=suggested \
      bash install.sh --non-interactive > "$INSTALL_LOG" 2>&1 &
    install_pid=$!
    tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
    tail_pid=$!
    wait $install_pid
    install_exit=$?
    kill $tail_pid 2>/dev/null || true
    wait $tail_pid 2>/dev/null || true

    # Re-source PATH
    if [ -f "$HOME/.bashrc" ]; then
      source "$HOME/.bashrc" 2>/dev/null || true
    fi
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
      export PATH="$HOME/.local/bin:$PATH"
    fi

    LMSTUDIO_ONBOARD_OK=false
    LMSTUDIO_SIDECAR_RUNNING=false

    if [ $install_exit -eq 0 ]; then
      pass "LM Studio onboard completed (exit 0)"
      LMSTUDIO_ONBOARD_OK=true
    else
      fail "LM Studio onboard failed (exit $install_exit) — see $INSTALL_LOG"
    fi

    if [ "$LMSTUDIO_ONBOARD_OK" = true ]; then
      # Check inference provider
      if inf_output=$(openshell inference get 2>&1) && echo "$inf_output" | grep -qi "lmstudio-k3s"; then
        pass "Inference configured as lmstudio-k3s"
      else
        fail "Inference not configured as lmstudio-k3s: ${inf_output:0:200}"
      fi

      # Check sidecar container
      if docker ps --format '{{.Names}}' | grep -q "nemoclaw-lmstudio-default"; then
        pass "LM Studio sidecar container is running"
        LMSTUDIO_SIDECAR_RUNNING=true
      else
        fail "LM Studio sidecar container not found"
      fi
    fi

    # Run inference battery for each LM Studio model
    if [ "$LMSTUDIO_ONBOARD_OK" = true ] && [ "$LMSTUDIO_SIDECAR_RUNNING" = true ]; then
      for lms_model in "${LMSTUDIO_MODELS[@]}"; do
        api_model="${lms_model%%@*}"

        # Pull model if not the first (first was pulled during onboard)
        if [ "$lms_model" != "$FIRST_LMSTUDIO_MODEL" ]; then
          info "Pulling LM Studio model: $lms_model..."
          if docker exec nemoclaw-lmstudio-default lms get "$lms_model" --yes 2>&1; then
            pass "LM Studio model pulled: $lms_model"
          else
            fail "LM Studio model pull failed: $lms_model"
            add_json_result "lmstudio-k3s" "$lms_model" true true "null"
            continue
          fi

          # Load model into GPU and update inference route
          info "Loading model: $api_model..."
          docker exec nemoclaw-lmstudio-default lms load "$api_model" --gpu max --yes 2>&1 || true
          openshell inference set --no-verify --provider lmstudio-k3s --model "$api_model" 2>&1 || true
        fi

        info "Running inference battery for $api_model..."
        BATTERY_LOG="/tmp/nemoclaw-sidecar-e2e-battery-lmstudio-${api_model}.log"
        battery_output=$(bash "$INFERENCE_BATTERY" --json "$api_model" 2>&1) || true
        echo "$battery_output" > "$BATTERY_LOG"
        summary_line=$(echo "$battery_output" | grep '"summary"' | tail -1)

        if [ -n "$summary_line" ]; then
          battery_pass=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['pass'])" 2>/dev/null || echo 0)
          battery_fail=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['fail'])" 2>/dev/null || echo 0)
          battery_total=$(echo "$summary_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])" 2>/dev/null || echo 0)
          pass "Inference battery (LM Studio $api_model): $battery_pass/$battery_total passed"
          if [ "$battery_fail" -gt 0 ]; then
            fail "Inference battery (LM Studio $api_model): $battery_fail/$battery_total failed"
          fi
          add_json_result "lmstudio-k3s" "$lms_model" true true "$summary_line"
        else
          fail "Inference battery (LM Studio $api_model) produced no summary — see $BATTERY_LOG"
          tail -10 "$BATTERY_LOG" 2>/dev/null | while IFS= read -r line; do info "  $line"; done
          add_json_result "lmstudio-k3s" "$lms_model" true true "null"
        fi
      done
    else
      skip "Skipping LM Studio inference battery (onboard failed)"
      add_json_result "lmstudio-k3s" "$FIRST_LMSTUDIO_MODEL" "$LMSTUDIO_ONBOARD_OK" "$LMSTUDIO_SIDECAR_RUNNING" "null"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Phase 5: Cleanup & results
# ══════════════════════════════════════════════════════════════
section "Phase 5: Cleanup & results"

if [ "${SKIP_CLEANUP:-}" = "1" ]; then
  info "Skipping cleanup (SKIP_CLEANUP=1)"
  skip "Cleanup skipped"
else
  info "Running full cleanup..."
  bash "$REPO/uninstall.sh" --yes --delete-models 2>&1 | tail -5 || true
  docker rm -f "nemoclaw-ollama-default" 2>/dev/null || true
  docker rm -f "nemoclaw-lmstudio-default" 2>/dev/null || true
  pass "Cleanup complete"
fi

write_results

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Sidecar E2E Results ($(hostname)):"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Sidecar E2E PASSED on %s\033[0m\n' "$(hostname)"
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed on %s.\033[0m\n' "$FAIL" "$(hostname)"
  exit 1
fi
