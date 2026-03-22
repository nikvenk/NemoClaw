#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Test sidecar inference — run prompts through the OpenShell gateway against
# the running sidecar backend.  Requires a running gateway + sidecar.
#
# Usage: bash test/e2e/test-sidecar-inference.sh [--json] [model]
#
# Flags:
#   --json   Output one JSON line per test + a summary line (for machine parsing)
#
# Default model: whatever is set in `openshell inference get`.

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0
JSON_MODE=false

# Parse flags
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --json) JSON_MODE=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  MODEL=$(openshell inference get 2>&1 | grep "Model:" | awk '{print $NF}' | sed 's/\x1b\[[0-9;]*m//g') || true
fi

if [ -z "$MODEL" ]; then
  echo -e "${RED}No model configured. Run nemoclaw onboard first.${NC}"
  exit 1
fi

# Get the gateway container IP for direct API calls
GW_CONTAINER=$(docker ps --filter "name=openshell-cluster-nemoclaw" --format '{{.Names}}' | head -1) || true
if [ -z "$GW_CONTAINER" ]; then
  echo -e "${RED}No gateway container found. Is the gateway running?${NC}"
  if [ "$JSON_MODE" = true ]; then
    echo "{\"summary\":{\"pass\":0,\"fail\":1,\"total\":1,\"model\":\"$MODEL\",\"provider\":\"unknown\",\"error\":\"no gateway container\"}}"
  fi
  exit 1
fi

GW_IP=$(docker inspect "$GW_CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}') || true
if [ -z "$GW_IP" ]; then
  echo -e "${RED}Cannot determine gateway IP for $GW_CONTAINER${NC}"
  if [ "$JSON_MODE" = true ]; then
    echo "{\"summary\":{\"pass\":0,\"fail\":1,\"total\":1,\"model\":\"$MODEL\",\"provider\":\"unknown\",\"error\":\"no gateway IP\"}}"
  fi
  exit 1
fi

# Detect which port (Ollama=11434, LM Studio=1234)
PROVIDER=$(openshell inference get 2>&1 | grep "Provider:" | awk '{print $NF}' | sed 's/\x1b\[[0-9;]*m//g') || true
if [[ "$PROVIDER" == *lmstudio* ]]; then
  PORT=1234
else
  PORT=11434
fi

if [ "$JSON_MODE" = false ]; then
  echo "============================================"
  echo "Sidecar Inference Test"
  echo "============================================"
  echo "  Model:    $MODEL"
  echo "  Provider: $PROVIDER"
  echo "  Gateway:  $GW_CONTAINER ($GW_IP:$PORT)"
  echo ""
fi

run_test() {
  local test_name="$1"
  local prompt="$2"
  local max_tokens="${3:-200}"
  local expect_pattern="${4:-}"

  [ "$JSON_MODE" = false ] && echo -n "  $test_name... "

  local start_time
  start_time=$(date +%s%N)

  local payload="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt\"}],\"max_tokens\":$max_tokens}"

  local response
  response=$(docker exec "$GW_CONTAINER" wget -qO- \
    --post-data "$payload" \
    --header 'Content-Type: application/json' \
    "http://${GW_IP}:${PORT}/v1/chat/completions" 2>&1) || true

  local end_time
  end_time=$(date +%s%N)
  local latency_ms
  latency_ms=$(( (end_time - start_time) / 1000000 ))

  # Parse response
  local ok=false
  local content=""
  local reasoning=""
  local tokens=""
  local finish=""

  if echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['choices'][0]['message']
content = c.get('content') or ''
# Check all known reasoning field names across providers
reasoning = c.get('reasoning_content') or c.get('reasoning') or ''
tokens = d.get('usage', {}).get('total_tokens', 0)
finish = d['choices'][0].get('finish_reason', 'unknown')
print(f'CONTENT:{content}')
print(f'REASONING:{reasoning[:2000]}')
print(f'TOKENS:{tokens}')
print(f'FINISH:{finish}')
" 2>/dev/null > /tmp/nemoclaw-test-result; then
    content=$(grep "^CONTENT:" /tmp/nemoclaw-test-result | sed 's/^CONTENT://')
    reasoning=$(grep "^REASONING:" /tmp/nemoclaw-test-result | sed 's/^REASONING://')
    tokens=$(grep "^TOKENS:" /tmp/nemoclaw-test-result | sed 's/^TOKENS://')
    finish=$(grep "^FINISH:" /tmp/nemoclaw-test-result | sed 's/^FINISH://')
    ok=true
  fi

  local passed=false
  local error_msg=""

  if [ "$ok" = true ]; then
    if [ -n "$expect_pattern" ]; then
      # Check both content and reasoning (reasoning may contain multi-line thinking tokens)
      local combined
      combined=$(printf '%s\n%s' "$content" "$reasoning")
      if echo "$combined" | tr '\n' ' ' | grep -qi "$expect_pattern"; then
        passed=true
      else
        error_msg="expected '$expect_pattern' not found"
      fi
    else
      passed=true
    fi
  else
    error_msg="invalid response"
  fi

  if [ "$passed" = true ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi

  if [ "$JSON_MODE" = true ]; then
    # Show content if available, otherwise show reasoning preview
    local preview="${content:0:200}"
    if [ -z "$preview" ] && [ -n "$reasoning" ]; then
      preview="[reasoning] ${reasoning:0:200}"
    fi
    local preview_json
    preview_json=$(echo "$preview" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null) || preview_json='""'
    local error_json="null"
    if [ -n "$error_msg" ]; then
      error_json=$(echo "$error_msg" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null) || error_json='""'
    fi
    echo "{\"name\":\"$test_name\",\"pass\":$passed,\"latency_ms\":$latency_ms,\"tokens\":${tokens:-0},\"finish_reason\":\"${finish:-null}\",\"content_preview\":$preview_json,\"error\":$error_json}"
  else
    if [ "$passed" = true ]; then
      echo -e "${GREEN}PASS${NC} (${latency_ms}ms, ${tokens} tokens, finish=${finish})"
    elif [ "$ok" = true ]; then
      echo -e "${RED}FAIL${NC} ($error_msg)"
      echo "    Content: $content"
      echo "    Reasoning: ${reasoning:0:100}"
    else
      echo -e "${RED}FAIL${NC} (invalid response)"
      echo "    Raw: ${response:0:200}"
    fi
  fi
}

section() { [ "$JSON_MODE" = false ] && echo "$1"; }

section "--- Simple Prompts ---"
run_test "Math (2+2)"          "What is 2+2?"                                    200 "4"
run_test "Capital"             "What is the capital of France?"                   200 "Paris"
run_test "Greeting"            "Hello, how are you?"                              150 ""

section ""
section "--- Reasoning ---"
run_test "Bat and ball"        "A bat and ball cost 1.10 total. The bat costs 1.00 more than the ball. How much does the ball cost? Think step by step." 500 "0.05"
run_test "Logic"               "If all roses are flowers and all flowers are plants, are all roses plants? Explain." 300 "yes"

section ""
section "--- Long-form ---"
run_test "Photosynthesis"      "Explain photosynthesis in 3 sentences."           300 ""
run_test "Code generation"     "Write a Python function is_prime(n)"              400 "def"

section ""
section "--- Performance ---"
run_test "Short response"      "Say OK"                                           20  ""
run_test "Medium response"     "List 5 programming languages"                    200  ""

rm -f /tmp/nemoclaw-test-result

if [ "$JSON_MODE" = true ]; then
  echo "{\"summary\":{\"pass\":$PASS,\"fail\":$FAIL,\"total\":$((PASS + FAIL)),\"model\":\"$MODEL\",\"provider\":\"$PROVIDER\"}}"
else
  echo ""
  echo "============================================"
  echo "Results: ${PASS} passed, ${FAIL} failed"
  echo "============================================"
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
