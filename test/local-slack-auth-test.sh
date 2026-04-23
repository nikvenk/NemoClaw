#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local end-to-end test for validate_slack_auth() from nemoclaw-start.sh.
#
# Extracts the real function, patches hardcoded paths to use a temp dir,
# patches the Slack API URL to hit a local HTTP mock, then runs each
# code path and checks the results.
#
# Usage:  bash test/local-slack-auth-test.sh
#
# Requirements: python3, bash, sha256sum (or shasum on macOS)
#
# shellcheck disable=SC1090  # dynamic source paths are intentional
# shellcheck disable=SC2030  # subshell-local exports are intentional (test isolation)
# shellcheck disable=SC2031  # subshell-local exports are intentional (test isolation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/../scripts/nemoclaw-start.sh"
PASS=0
FAIL=0

# ── Helpers ──────────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

pass() {
  green "  PASS: $1"
  PASS=$((PASS + 1))
}
fail() {
  red "  FAIL: $1"
  FAIL=$((FAIL + 1))
}
header() { printf '\n── %s ──\n' "$1"; }

# Detect sha256sum vs shasum (macOS)
if command -v sha256sum >/dev/null 2>&1; then
  SHA256CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256CMD="shasum -a 256"
else
  echo "ERROR: neither sha256sum nor shasum found" >&2
  exit 1
fi

# ── Setup temp sandbox dir ───────────────────────────────────────

TMPDIR_BASE="$(mktemp -d)"
SANDBOX_DIR="$TMPDIR_BASE/sandbox/.openclaw"
mkdir -p "$SANDBOX_DIR"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

SAMPLE_CONFIG='{
  "channels": {
    "slack": {
      "accounts": {
        "default": {
          "enabled": true,
          "bot_token_env": "SLACK_BOT_TOKEN",
          "app_token_env": "SLACK_APP_TOKEN"
        }
      }
    }
  }
}'

reset_config() {
  echo "$SAMPLE_CONFIG" >"$SANDBOX_DIR/openclaw.json"
  (cd "$SANDBOX_DIR" && $SHA256CMD openclaw.json >.config-hash)
}

# ── Extract and patch the function ───────────────────────────────

# Pull validate_slack_auth() from the real start script
FUNC_BODY=$(sed -n '/^validate_slack_auth() {$/,/^}$/p' "$START_SCRIPT")

if [ -z "$FUNC_BODY" ]; then
  echo "ERROR: could not extract validate_slack_auth from $START_SCRIPT" >&2
  exit 1
fi

# Patch hardcoded paths → temp dir
FUNC_BODY="${FUNC_BODY//\/sandbox\/.openclaw/$SANDBOX_DIR}"

# Patch the Python heredoc so the URL comes from an env var instead of
# being hardcoded. The heredoc is single-quoted (<<'PYAUTHTEST') so shell
# vars won't expand — we inject a Python os.environ lookup instead.
FUNC_BODY="${FUNC_BODY//\"https:\/\/slack.com\/api\/auth.test\"/os.environ[\"SLACK_AUTH_TEST_URL\"]}"

# Patch sha256sum → our portable command
FUNC_BODY="${FUNC_BODY//sha256sum/$SHA256CMD}"

# Write the patched function to a sourceable file
FUNC_FILE="$TMPDIR_BASE/validate_slack_auth.sh"
printf '#!/usr/bin/env bash\n%s\n' "$FUNC_BODY" >"$FUNC_FILE"

# ── Mock HTTP server ─────────────────────────────────────────────

start_mock_server() {
  local response_body="$1"

  # Let the OS pick a free port, then report it back via a temp file
  local port_file="$TMPDIR_BASE/mock_port"

  python3 - "$response_body" "$port_file" <<'PYMOCK' &
import http.server, socketserver, sys

body = sys.argv[1]
port_file = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self, *args):
        pass  # silence logs

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

srv = ReusableTCPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
with open(port_file, "w") as f:
    f.write(str(port))
srv.handle_request()  # serve exactly one request, then exit
PYMOCK

  MOCK_PID=$!
  # Wait for the port file to appear (server is bound)
  for _ in $(seq 1 20); do
    [ -s "$port_file" ] && break
    sleep 0.1
  done
  MOCK_PORT=$(cat "$port_file")
  rm -f "$port_file"
}

# ══════════════════════════════════════════════════════════════════
# TESTS
# ══════════════════════════════════════════════════════════════════

header "T1: No SLACK_BOT_TOKEN set — should be a no-op"
reset_config
(
  unset SLACK_BOT_TOKEN 2>/dev/null || true
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:1" # should never be hit
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T1_EXIT=$?
T1_STDERR=$(cat "$TMPDIR_BASE/stderr.log")

if [ "$T1_EXIT" -eq 0 ] && [ -z "$T1_STDERR" ]; then
  pass "no-op when SLACK_BOT_TOKEN is unset (exit=$T1_EXIT, no output)"
else
  fail "expected silent exit 0, got exit=$T1_EXIT stderr='$T1_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T2: Non-xoxb token prefix — should be a no-op"
reset_config
(
  export SLACK_BOT_TOKEN="xoxp-not-a-bot-token"
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:1"
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T2_EXIT=$?
T2_STDERR=$(cat "$TMPDIR_BASE/stderr.log")

if [ "$T2_EXIT" -eq 0 ] && [ -z "$T2_STDERR" ]; then
  pass "no-op for non-xoxb prefix (exit=$T2_EXIT, no output)"
else
  fail "expected silent exit 0, got exit=$T2_EXIT stderr='$T2_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T3: Valid token — mock returns ok"
reset_config
start_mock_server '{"ok": true}'
(
  export SLACK_BOT_TOKEN="xoxb-test-valid-token"
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:$MOCK_PORT/api/auth.test"
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T3_EXIT=$?
T3_STDERR=$(cat "$TMPDIR_BASE/stderr.log")
wait "$MOCK_PID" 2>/dev/null || true

if [ "$T3_EXIT" -eq 0 ] && echo "$T3_STDERR" | grep -q "validated successfully"; then
  pass "valid token accepted (exit=$T3_EXIT)"
else
  fail "expected 'validated successfully', got exit=$T3_EXIT stderr='$T3_STDERR'"
fi

# Check config was NOT modified (channel should still be enabled)
if python3 -c "
import json, sys
cfg = json.load(open('$SANDBOX_DIR/openclaw.json'))
acct = cfg['channels']['slack']['accounts']['default']
sys.exit(0 if acct['enabled'] is True else 1)
"; then
  pass "config unchanged — Slack channel still enabled"
else
  fail "config was modified on a successful auth"
fi

# ──────────────────────────────────────────────────────────────────

header "T4: Auth failure — mock returns invalid_auth"
reset_config
HASH_BEFORE=$(cat "$SANDBOX_DIR/.config-hash")
start_mock_server '{"ok": false, "error": "invalid_auth"}'
(
  export SLACK_BOT_TOKEN="xoxb-test-revoked-token"
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:$MOCK_PORT/api/auth.test"
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T4_EXIT=$?
T4_STDERR=$(cat "$TMPDIR_BASE/stderr.log")
wait "$MOCK_PID" 2>/dev/null || true

if [ "$T4_EXIT" -eq 0 ] && echo "$T4_STDERR" | grep -q "provider failed to start: invalid_auth"; then
  pass "auth failure detected and logged (exit=$T4_EXIT)"
else
  fail "expected 'provider failed to start: invalid_auth', got exit=$T4_EXIT stderr='$T4_STDERR'"
fi

if echo "$T4_STDERR" | grep -q "channel disabled"; then
  pass "log says channel was disabled"
else
  fail "missing 'channel disabled' in log"
fi

# Check config was modified — channel should now be disabled
if python3 -c "
import json, sys
cfg = json.load(open('$SANDBOX_DIR/openclaw.json'))
acct = cfg['channels']['slack']['accounts']['default']
sys.exit(0 if acct['enabled'] is False else 1)
"; then
  pass "config updated — Slack channel disabled"
else
  fail "config was NOT updated after auth failure"
fi

# Check hash was recomputed
HASH_AFTER=$(cat "$SANDBOX_DIR/.config-hash")
if [ "$HASH_BEFORE" != "$HASH_AFTER" ]; then
  pass "config hash was recomputed"
else
  fail "config hash was NOT recomputed after config change"
fi

if echo "$T4_STDERR" | grep -q "Config hash recomputed after disabling"; then
  pass "hash recompute logged"
else
  fail "missing hash recompute log message"
fi

# ──────────────────────────────────────────────────────────────────

header "T5: Network error — mock server not running"
reset_config
(
  export SLACK_BOT_TOKEN="xoxb-test-network-fail"
  # Point at a port nothing is listening on
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:19999/api/auth.test"
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T5_EXIT=$?
T5_STDERR=$(cat "$TMPDIR_BASE/stderr.log")

if [ "$T5_EXIT" -eq 0 ] && echo "$T5_STDERR" | grep -q "channel left enabled"; then
  pass "network error treated as transient (exit=$T5_EXIT)"
else
  fail "expected 'channel left enabled', got exit=$T5_EXIT stderr='$T5_STDERR'"
fi

# Config should NOT have been modified
if python3 -c "
import json, sys
cfg = json.load(open('$SANDBOX_DIR/openclaw.json'))
acct = cfg['channels']['slack']['accounts']['default']
sys.exit(0 if acct['enabled'] is True else 1)
"; then
  pass "config unchanged — channel still enabled after network error"
else
  fail "config was modified on a network error (should be transient)"
fi

# ──────────────────────────────────────────────────────────────────

header "T6: Symlink config file — should refuse"
reset_config
# Replace the real config with a symlink
mv "$SANDBOX_DIR/openclaw.json" "$SANDBOX_DIR/openclaw.json.real"
ln -s "$SANDBOX_DIR/openclaw.json.real" "$SANDBOX_DIR/openclaw.json"

T6_STDERR=$(SLACK_BOT_TOKEN="xoxb-test-symlink" SLACK_AUTH_TEST_URL="http://127.0.0.1:1" \
  bash -c "set +e; source '$FUNC_FILE'; validate_slack_auth; echo EXIT_CODE=\$?" 2>&1 >/tmp/slack-t6-stdout.txt)
T6_EXIT=$(grep -o 'EXIT_CODE=[0-9]*' /tmp/slack-t6-stdout.txt | cut -d= -f2)
T6_EXIT="${T6_EXIT:-999}"

# Restore for subsequent tests
rm -f "$SANDBOX_DIR/openclaw.json"
mv "$SANDBOX_DIR/openclaw.json.real" "$SANDBOX_DIR/openclaw.json"

if [ "$T6_EXIT" -ne 0 ] && echo "$T6_STDERR" | grep -q "Refusing Slack auth validation"; then
  pass "symlink attack blocked (exit=$T6_EXIT)"
else
  fail "expected refusal, got exit=$T6_EXIT stderr='$T6_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T7: Symlink hash file — should refuse"
reset_config
mv "$SANDBOX_DIR/.config-hash" "$SANDBOX_DIR/.config-hash.real"
ln -s "$SANDBOX_DIR/.config-hash.real" "$SANDBOX_DIR/.config-hash"

T7_STDERR=$(SLACK_BOT_TOKEN="xoxb-test-symlink-hash" SLACK_AUTH_TEST_URL="http://127.0.0.1:1" \
  bash -c "set +e; source '$FUNC_FILE'; validate_slack_auth; echo EXIT_CODE=\$?" 2>&1 >/tmp/slack-t7-stdout.txt)
T7_EXIT=$(grep -o 'EXIT_CODE=[0-9]*' /tmp/slack-t7-stdout.txt | cut -d= -f2)
T7_EXIT="${T7_EXIT:-999}"
rm -f "$SANDBOX_DIR/.config-hash"
mv "$SANDBOX_DIR/.config-hash.real" "$SANDBOX_DIR/.config-hash"

if [ "$T7_EXIT" -ne 0 ] && echo "$T7_STDERR" | grep -q "Refusing Slack auth validation"; then
  pass "symlink hash attack blocked (exit=$T7_EXIT)"
else
  fail "expected refusal, got exit=$T7_EXIT stderr='$T7_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T8: token_revoked error — same disable path as invalid_auth"
reset_config
start_mock_server '{"ok": false, "error": "token_revoked"}'
(
  export SLACK_BOT_TOKEN="xoxb-test-revoked"
  export SLACK_AUTH_TEST_URL="http://127.0.0.1:$MOCK_PORT/api/auth.test"
  source "$FUNC_FILE"
  validate_slack_auth
) 2>"$TMPDIR_BASE/stderr.log"
T8_STDERR=$(cat "$TMPDIR_BASE/stderr.log")
wait "$MOCK_PID" 2>/dev/null || true

if echo "$T8_STDERR" | grep -q "provider failed to start: token_revoked"; then
  pass "token_revoked triggers disable path"
else
  fail "expected 'provider failed to start: token_revoked', got stderr='$T8_STDERR'"
fi

if python3 -c "
import json, sys
cfg = json.load(open('$SANDBOX_DIR/openclaw.json'))
acct = cfg['channels']['slack']['accounts']['default']
sys.exit(0 if acct['enabled'] is False else 1)
"; then
  pass "config updated — channel disabled after token_revoked"
else
  fail "channel was NOT disabled after token_revoked"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════"
printf "  Results: "
green "$PASS passed"
if [ "$FAIL" -gt 0 ]; then
  printf "           "
  red "$FAIL failed"
fi
echo "═══════════════════════════════════════"

exit "$FAIL"
