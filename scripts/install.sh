#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
#
# NemoClaw installer — installs Node.js, Ollama (if GPU present), and NemoClaw.

set -euo pipefail

# Global cleanup state — ensures background processes are killed and temp files
# are removed on any exit path (set -e, unhandled signal, unexpected error).
_cleanup_pids=()
_cleanup_files=()
_global_cleanup() {
  for pid in "${_cleanup_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for f in "${_cleanup_files[@]:-}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap _global_cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

resolve_repo_root() {
  local base="${NEMOCLAW_REPO_ROOT:-$SCRIPT_DIR}"
  if [[ -f "${base}/package.json" ]]; then
    (cd "${base}" && pwd)
    return
  fi
  if [[ -f "${base}/../package.json" ]]; then
    (cd "${base}/.." && pwd)
    return
  fi
  if [[ -f "${base}/../../package.json" ]]; then
    (cd "${base}/../.." && pwd)
    return
  fi
  printf "%s\n" "$base"
}
DEFAULT_NEMOCLAW_VERSION="0.1.0"
# Step layout matches NemoClaw_Installer_Recipe.docx §5 (Install Flow):
#   1. Platform + Dependencies   2. NemoClaw CLI   3. Backend Selection
#   4. Onboarding                5. Verification
TOTAL_STEPS=5

# Recipe §4 — pinned dependency floors.
MIN_DOCKER_VERSION="28.0"
MIN_OPENSHELL_VERSION="0.0.32"
NEMOCLAW_STATE_DIR="/var/lib/nemoclaw"
NEMOCLAW_MANIFEST_PATH="${NEMOCLAW_STATE_DIR}/manifest.json"
NEMOCLAW_MODEL_DIR="${NEMOCLAW_STATE_DIR}/models"
MODEL_PULL_UNIT="nemoclaw-model-pull.service"

# Selected backend (populated by select_backend); recorded in manifest.
NEMOCLAW_SELECTED_BACKEND=""
NEMOCLAW_SELECTED_BACKEND_ENDPOINT=""
NEMOCLAW_DETECTED_PLATFORM=""

resolve_installer_version() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" && "${NEMOCLAW_INSTALL_REF}" != "latest" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF#v}"
    return
  fi
  # Prefer git tags (works in dev clones and CI)
  if command -v git &>/dev/null && [[ -d "${repo_root}/.git" ]]; then
    local git_ver=""
    if git_ver="$(git -C "$repo_root" describe --tags --match 'v*' 2>/dev/null)"; then
      git_ver="${git_ver#v}"
      if [[ -n "$git_ver" ]]; then
        printf "%s" "$git_ver"
        return
      fi
    fi
  fi
  # Fall back to .version file (stamped during install)
  if [[ -f "${repo_root}/.version" ]]; then
    local file_ver
    file_ver="$(cat "${repo_root}/.version")"
    if [[ -n "$file_ver" ]]; then
      printf "%s" "$file_ver"
      return
    fi
  fi
  # Last resort: package.json
  local package_json="${repo_root}/package.json"
  local version=""
  if [[ -f "$package_json" ]]; then
    version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -1)"
  fi
  printf "%s" "${version:-$DEFAULT_NEMOCLAW_VERSION}"
}

NEMOCLAW_VERSION="$(resolve_installer_version)"

installer_version_for_display() {
  if [[ -z "${NEMOCLAW_VERSION:-}" || "${NEMOCLAW_VERSION}" == "${DEFAULT_NEMOCLAW_VERSION}" ]]; then
    printf ""
    return
  fi
  printf "  v%s" "$NEMOCLAW_VERSION"
}

# Resolve which Git ref to install from.
# Priority: NEMOCLAW_INSTALL_TAG env var > "latest" tag.
resolve_release_tag() {
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF}"
    return
  fi
  # Allow explicit override (for CI, pinning, or testing).
  # Otherwise default to the "latest" tag, which we maintain to point at
  # the commit we want everybody to install.
  printf "%s" "${NEMOCLAW_INSTALL_TAG:-latest}"
}

# ---------------------------------------------------------------------------
# Color / style — disabled when NO_COLOR is set or stdout is not a TTY.
# Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
# ---------------------------------------------------------------------------
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  if [[ "${COLORTERM:-}" == "truecolor" || "${COLORTERM:-}" == "24bit" ]]; then
    C_GREEN=$'\033[38;2;118;185;0m' # #76B900 — exact NVIDIA green
  else
    C_GREEN=$'\033[38;5;148m' # closest 256-color on dark backgrounds
  fi
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[1;31m'
  C_YELLOW=$'\033[1;33m'
  C_CYAN=$'\033[1;36m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_BOLD='' C_DIM='' C_RED='' C_YELLOW='' C_CYAN='' C_RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info() { printf "${C_CYAN}[INFO]${C_RESET}  %s\n" "$*"; }
warn() { printf "${C_YELLOW}[WARN]${C_RESET}  %s\n" "$*"; }
error() {
  printf "${C_RED}[ERROR]${C_RESET} %s\n" "$*" >&2
  exit 1
}
ok() { printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$*"; }

verify_downloaded_script() {
  local file="$1" label="${2:-script}" expected_hash="${3:-}"
  if [ ! -s "$file" ]; then
    error "$label download is empty or missing"
  fi
  if ! head -1 "$file" | grep -qE '^#!.*(sh|bash)'; then
    error "$label does not start with a shell shebang — possible download corruption"
  fi
  local actual_hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  if [ -n "$expected_hash" ]; then
    if [ -z "$actual_hash" ]; then
      error "No SHA-256 tool available — cannot verify $label integrity"
    fi
    if [ "$actual_hash" != "$expected_hash" ]; then
      rm -f "$file"
      error "$label integrity check failed\n  Expected: $expected_hash\n  Actual:   $actual_hash"
    fi
    info "$label integrity verified (SHA-256: ${actual_hash:0:16}…)"
  elif [ -n "$actual_hash" ]; then
    info "$label SHA-256: $actual_hash"
  fi
}

resolve_default_sandbox_name() {
  local registry_file="${HOME}/.nemoclaw/sandboxes.json"
  local sandbox_name="${NEMOCLAW_SANDBOX_NAME:-}"

  # Prefer the sandbox name from the current onboard session — it reflects
  # the sandbox just created, whereas sandboxes.json may hold a stale default
  # from a previous gateway that no longer exists (#1839).
  local session_file="${HOME}/.nemoclaw/onboard-session.json"
  if [[ -z "$sandbox_name" && -f "$session_file" ]] && command_exists node; then
    sandbox_name="$(
      node -e '
        const fs = require("fs");
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const name = data.sandboxName || "";
          process.stdout.write(name);
        } catch {}
      ' "$session_file" 2>/dev/null || true
    )"
  fi

  if [[ -z "$sandbox_name" && -f "$registry_file" ]] && command_exists node; then
    sandbox_name="$(
      node -e '
        const fs = require("fs");
        const file = process.argv[1];
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          const sandboxes = data.sandboxes || {};
          const preferred = data.defaultSandbox;
          const name = (preferred && sandboxes[preferred] && preferred) || Object.keys(sandboxes)[0] || "";
          process.stdout.write(name);
        } catch {}
      ' "$registry_file" 2>/dev/null || true
    )"
  fi

  printf "%s" "${sandbox_name:-my-assistant}"
}

resolve_onboarded_agent() {
  local session_file="${HOME}/.nemoclaw/onboard-session.json"
  if [[ -f "$session_file" ]] && command_exists node; then
    node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(data.agent || "openclaw");
      } catch { process.stdout.write("openclaw"); }
    ' "$session_file" 2>/dev/null || printf "openclaw"
  else
    printf "openclaw"
  fi
}

# step N "Description" — numbered section header
step() {
  local n=$1 msg=$2
  printf "\n${C_GREEN}[%s/%s]${C_RESET} ${C_BOLD}%s${C_RESET}\n" \
    "$n" "$TOTAL_STEPS" "$msg"
  printf "  ${C_DIM}──────────────────────────────────────────────────${C_RESET}\n"
}

print_banner() {
  local version_suffix
  version_suffix="$(installer_version_for_display)"
  printf "\n"
  # ANSI Shadow ASCII art — hand-crafted, no figlet dependency
  printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝${C_RESET}\n"
  printf "\n"
  if [[ -n "${NEMOCLAW_AGENT:-}" && "${NEMOCLAW_AGENT}" != "openclaw" ]]; then
    printf "  ${C_DIM}Launch %s in an OpenShell sandbox.%s${C_RESET}\n" "${NEMOCLAW_AGENT^}" "$version_suffix"
  else
    printf "  ${C_DIM}Launch OpenClaw in an OpenShell sandbox.%s${C_RESET}\n" "$version_suffix"
  fi
  printf "\n"
}

print_done() {
  local elapsed=$((SECONDS - _INSTALL_START))
  local _needs_reload=false
  needs_shell_reload && _needs_reload=true

  info "=== Installation complete ==="
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}NemoClaw${C_RESET}  ${C_DIM}(%ss)${C_RESET}\n" "$elapsed"
  printf "\n"
  if [[ "$ONBOARD_RAN" == true ]]; then
    local sandbox_name agent_name
    sandbox_name="$(resolve_default_sandbox_name)"
    agent_name="$(resolve_onboarded_agent)"
    if [[ "$agent_name" == "openclaw" || -z "$agent_name" ]]; then
      printf "  ${C_GREEN}Your OpenClaw Sandbox is live.${C_RESET}\n"
    else
      printf "  ${C_GREEN}Your %s Sandbox is live.${C_RESET}\n" "${agent_name^}"
    fi
    printf "  ${C_DIM}Sandbox in, break things, and tell us what you find.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ "$_needs_reload" == true ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$(detect_shell_profile)"
    fi
    printf "  %s$%s nemoclaw %s connect\n" "$C_GREEN" "$C_RESET" "$sandbox_name"
    local agent_cmd
    case "$agent_name" in
      hermes)
        agent_cmd="hermes"
        ;;
      "" | openclaw)
        agent_cmd="openclaw tui"
        ;;
      *)
        agent_cmd="$agent_name"
        ;;
    esac
    printf "  %ssandbox@%s$%s %s\n" "$C_GREEN" "$sandbox_name" "$C_RESET" "$agent_cmd"
  elif [[ "$NEMOCLAW_READY_NOW" == true ]]; then
    printf "  ${C_GREEN}NemoClaw CLI is installed.${C_RESET}\n"
    printf "  ${C_DIM}Onboarding has not run yet.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ "$_needs_reload" == true ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$(detect_shell_profile)"
    fi
    printf "  %s$%s nemoclaw onboard\n" "$C_GREEN" "$C_RESET"
  else
    printf "  ${C_GREEN}NemoClaw CLI is installed.${C_RESET}\n"
    printf "  ${C_DIM}Onboarding did not run because this shell cannot resolve 'nemoclaw' yet.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ -n "$NEMOCLAW_RECOVERY_EXPORT_DIR" ]]; then
      printf "  %s$%s export PATH=\"%s:\$PATH\"\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_EXPORT_DIR"
    fi
    if [[ -n "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_PROFILE"
    fi
    printf "  %s$%s nemoclaw onboard\n" "$C_GREEN" "$C_RESET"
  fi
  printf "\n"
  printf "  ${C_BOLD}GitHub${C_RESET}  ${C_DIM}https://github.com/nvidia/nemoclaw${C_RESET}\n"
  printf "  ${C_BOLD}Docs${C_RESET}    ${C_DIM}https://docs.nvidia.com/nemoclaw/latest/${C_RESET}\n"
  printf "\n"
}

usage() {
  local version_suffix
  version_suffix="$(installer_version_for_display)"
  printf "\n"
  printf "  ${C_BOLD}NemoClaw Installer${C_RESET}${C_DIM}%s${C_RESET}\n\n" "$version_suffix"
  printf "  ${C_DIM}Usage:${C_RESET}\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- [options]\n"
  printf "    sudo bash scripts/install.sh                     # local clone\n"
  printf "    sudo apt install -y nemoclaw                     # APT path (postinst runs scripts/install.sh)\n\n"

  printf "  ${C_DIM}Options:${C_RESET}\n"
  printf "    --non-interactive                       Skip prompts (uses env vars / defaults)\n"
  printf "    --yes-i-accept-third-party-software     Accept the third-party software notice in non-interactive mode\n"
  printf "    --fresh                                 Discard any failed/interrupted onboarding session and start over\n"
  printf "    --version, -v                           Print installer version and exit\n"
  printf "    --help, -h                              Show this help message and exit\n\n"

  printf "  ${C_DIM}Auto-detection (Recipe §6.2):${C_RESET}\n"
  printf "    Platform is auto-detected from firmware in this order:\n"
  printf "      1. /sys/firmware/devicetree/base/model     (aarch64 — Spark / Station / TH500 boards)\n"
  printf "      2. /sys/class/dmi/id/product_name          (SMBIOS fallback for x86 / UEFI servers)\n"
  printf "    Resulting value is one of: ${C_BOLD}spark${C_RESET} | ${C_BOLD}station${C_RESET} | ${C_BOLD}linux${C_RESET} (no fixups).\n"
  printf "    Bypass with ${C_BOLD}NEMOCLAW_PLATFORM_OVERRIDE=spark|station|linux${C_RESET}.\n"
  printf "    GPU / VRAM detection uses ${C_BOLD}nvidia-smi${C_RESET} — set ${C_BOLD}NEMOCLAW_FORCE_GPU=1${C_RESET} to skip the probe\n"
  printf "    on hosts where nvidia-smi is unavailable but a GPU is known to be present.\n\n"

  printf "  ${C_DIM}Environment — installer behavior:${C_RESET}\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1              Same as --non-interactive\n"
  printf "    NEMOCLAW_FRESH=1                        Same as --fresh\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1  Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_INSTALL_TAG                    Git ref to install (default: latest release)\n"
  printf "    NEMOCLAW_PLATFORM_OVERRIDE              Bypass auto-detect: spark | station | linux\n"
  printf "    NEMOCLAW_FORCE_GPU=1                    Skip nvidia-smi probe; assume GPU present\n"
  printf "    NEMOCLAW_REPO_ROOT                      Path to source checkout (auto-resolved otherwise)\n"
  printf "    NEMOCLAW_INSTALLING=1                   Set internally; suppresses npm 'prepare' link\n"
  printf "    NO_COLOR=1                              Disable ANSI colors in output\n\n"

  printf "  ${C_DIM}Environment — sandbox / session:${C_RESET}\n"
  printf "    NEMOCLAW_SANDBOX_NAME                   Sandbox name to create/use (default: my-assistant)\n"
  printf "    NEMOCLAW_AGENT                          openclaw (default) | hermes | <other>\n"
  printf "    NEMOCLAW_SINGLE_SESSION=1               Abort if active sandbox sessions exist\n"
  printf "    NEMOCLAW_RECREATE_SANDBOX=1             Recreate an existing sandbox\n\n"

  printf "  ${C_DIM}Environment — backend / inference:${C_RESET}\n"
  printf "    NEMOCLAW_PROVIDER                       build | openai | anthropic | anthropicCompatible\n"
  printf "                                            | gemini | ollama | custom | nim-local | vllm | sglang\n"
  printf "                                            (aliases: cloud -> build, nim -> nim-local)\n"
  printf "    NEMOCLAW_MODEL                          Inference model tag (e.g., nemotron-3-super:120b)\n"
  printf "    NEMOCLAW_BACKEND_ENDPOINT               Override auto-detected backend URL\n\n"

  printf "  ${C_DIM}Environment — policies:${C_RESET}\n"
  printf "    NEMOCLAW_POLICY_MODE                    suggested (default) | custom | skip\n"
  printf "    NEMOCLAW_POLICY_PRESETS                 Comma-separated policy presets\n"
  printf "    NEMOCLAW_EXPERIMENTAL=1                 Show experimental / local options\n\n"

  printf "  ${C_DIM}Environment — credentials & integrations:${C_RESET}\n"
  printf "    NVIDIA_API_KEY                          API key (skips credential prompt)\n"
  printf "    BRAVE_API_KEY                           Enable Brave Search inside sandbox\n"
  printf "    DISCORD_BOT_TOKEN                       Auto-enable Discord policy support\n"
  printf "    SLACK_BOT_TOKEN                         Auto-enable Slack policy support\n"
  printf "    TELEGRAM_BOT_TOKEN                      Auto-enable Telegram policy support\n"
  printf "    CHAT_UI_URL                             Chat UI URL to open after setup\n\n"

  printf "  ${C_DIM}State paths (Recipe §4 / §6):${C_RESET}\n"
  printf "    /var/lib/nemoclaw/manifest.json         Pinned dependency versions + chosen backend\n"
  printf "    /var/lib/nemoclaw/kv-cache-tiers.json   Station only — KV-cache tier preference\n"
  printf "    /etc/nvidia/profiles/nemoclaw-station.json   Station only — NONATS app profile\n"
  printf "    /etc/systemd/system/${MODEL_PULL_UNIT}      Backgrounded model pull unit\n"
  printf "    /var/log/nemoclaw/events.log            Local install.success / install.partial events\n"
  printf "    ~/.nemoclaw/config.toml                 [backend] block with selected endpoint\n\n"

  printf "  ${C_DIM}Examples:${C_RESET}\n"
  printf "    ${C_DIM}# Default install on a real DGX Station${C_RESET}\n"
  printf "    sudo bash scripts/install.sh\n\n"
  printf "    ${C_DIM}# Non-interactive CI install pinned to a specific tag${C_RESET}\n"
  printf "    sudo NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \\\\\n"
  printf "         NEMOCLAW_INSTALL_TAG=v0.0.24 bash scripts/install.sh\n\n"
  printf "    ${C_DIM}# Test Spark fixups on a non-Spark dev box${C_RESET}\n"
  printf "    sudo NEMOCLAW_PLATFORM_OVERRIDE=spark bash scripts/install.sh\n\n"
  printf "    ${C_DIM}# Reuse an existing vLLM at :8000 instead of installing Ollama${C_RESET}\n"
  printf "    sudo NEMOCLAW_PROVIDER=vllm NEMOCLAW_BACKEND_ENDPOINT=http://127.0.0.1:8000 \\\\\n"
  printf "         bash scripts/install.sh\n\n"
}

show_usage_notice() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  local source_root="${NEMOCLAW_SOURCE_ROOT:-$repo_root}"
  local notice_script="${source_root}/bin/lib/usage-notice.js"
  if [[ ! -f "$notice_script" ]]; then
    notice_script="${repo_root}/bin/lib/usage-notice.js"
  fi
  local -a notice_cmd=(node "$notice_script")
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    notice_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      notice_cmd+=(--yes-i-accept-third-party-software)
    fi
    "${notice_cmd[@]}"
  elif [ -t 0 ]; then
    "${notice_cmd[@]}"
  elif exec 3</dev/tty; then
    info "Installer stdin is piped; attaching the usage notice to /dev/tty…"
    local status=0
    "${notice_cmd[@]}" <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "Interactive third-party software acceptance requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
}

# spin "label" cmd [args...]
#   Runs a command in the background, showing a braille spinner until it exits.
#   Stdout/stderr are captured; dumped only on failure.
#   Falls back to plain output when stdout is not a TTY (CI / piped installs).
spin() {
  local msg="$1"
  shift

  if [[ ! -t 1 ]]; then
    info "$msg"
    "$@"
    return
  fi

  local log
  log=$(mktemp)
  "$@" >"$log" 2>&1 &
  local pid=$! i=0
  local status
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

  # Register with global cleanup so any exit path reaps the child and temp file.
  _cleanup_pids+=("$pid")
  _cleanup_files+=("$log")

  # Ensure Ctrl+C kills the background process and cleans up the temp file.
  trap 'kill "$pid" 2>/dev/null; rm -f "$log"; exit 130' INT TERM

  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_GREEN}%s${C_RESET}  %s" "${frames[$((i++ % 10))]}" "$msg"
    sleep 0.08
  done

  # Restore default signal handling after the background process exits.
  trap - INT TERM

  if wait "$pid"; then
    status=0
  else
    status=$?
  fi

  if [[ $status -eq 0 ]]; then
    printf "\r  ${C_GREEN}✓${C_RESET}  %s\n" "$msg"
  else
    printf "\r  ${C_RED}✗${C_RESET}  %s\n\n" "$msg"
    cat "$log" >&2
    printf "\n"
  fi
  rm -f "$log"

  # Deregister only after cleanup actions are complete, so the global EXIT
  # trap still covers this pid/log if a signal arrives before this point.
  _cleanup_pids=("${_cleanup_pids[@]/$pid/}")
  _cleanup_files=("${_cleanup_files[@]/$log/}")
  return $status
}

command_exists() { command -v "$1" &>/dev/null; }

MIN_NODE_VERSION="22.16.0"
MIN_NPM_MAJOR=10
RUNTIME_REQUIREMENT_MSG="NemoClaw requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR}."
NEMOCLAW_SHIM_DIR="${HOME}/.local/bin"
NEMOCLAW_READY_NOW=false
NEMOCLAW_RECOVERY_PROFILE=""
NEMOCLAW_RECOVERY_EXPORT_DIR=""
NEMOCLAW_SOURCE_ROOT="$(resolve_repo_root)"
ONBOARD_RAN=false

# Compare two semver strings (major.minor.patch). Returns 0 if $1 >= $2.
# Rejects prerelease suffixes (e.g. "22.16.0-rc.1") to avoid arithmetic errors.
version_gte() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  [[ "$2" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  local -a a b
  IFS=. read -ra a <<<"$1"
  IFS=. read -ra b <<<"$2"
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    if ((ai > bi)); then return 0; fi
    if ((ai < bi)); then return 1; fi
  done
  return 0
}

# Ensure nvm environment is loaded in the current shell.
# Skip if node is already on PATH — sourcing nvm.sh can reset PATH and
# override the caller's node/npm (e.g. in test environments with stubs).
# Pass --force to load nvm even when node is on PATH (needed when upgrading).
ensure_nvm_loaded() {
  if [[ "${1:-}" != "--force" ]]; then
    command -v node &>/dev/null && return 0
  fi
  if [[ -z "${NVM_DIR:-}" ]]; then
    export NVM_DIR="$HOME/.nvm"
  fi
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    \. "$NVM_DIR/nvm.sh"
  fi
}

# Resolve the active npm global bin without letting a host nvm install
# override an already-working node/npm on PATH.
resolve_npm_bin() {
  if ! command -v npm >/dev/null 2>&1; then
    ensure_nvm_loaded
  fi

  command -v npm >/dev/null 2>&1 || return 1

  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  [[ -n "$npm_prefix" ]] || return 1

  printf '%s/bin\n' "$npm_prefix"
}

detect_shell_profile() {
  local profile="$HOME/.bashrc"
  case "$(basename "${SHELL:-}")" in
    zsh)
      profile="$HOME/.zshrc"
      ;;
    fish)
      profile="$HOME/.config/fish/config.fish"
      ;;
    tcsh)
      profile="$HOME/.tcshrc"
      ;;
    csh)
      profile="$HOME/.cshrc"
      ;;
    *)
      if [[ ! -f "$HOME/.bashrc" && -f "$HOME/.profile" ]]; then
        profile="$HOME/.profile"
      fi
      ;;
  esac
  printf "%s" "$profile"
}

# Check whether npm link can write to the active prefix targets.
npm_link_targets_writable() {
  local npm_prefix="$1"
  local npm_bin_dir npm_lib_dir

  [ -n "$npm_prefix" ] || return 1

  npm_bin_dir="$npm_prefix/bin"
  npm_lib_dir="$npm_prefix/lib/node_modules"

  if [ -d "$npm_bin_dir" ]; then
    [ -w "$npm_bin_dir" ] || return 1
  elif [ ! -w "$npm_prefix" ]; then
    return 1
  fi

  if [ -d "$npm_lib_dir" ]; then
    [ -w "$npm_lib_dir" ] || return 1
  elif [ -d "$npm_prefix/lib" ]; then
    [ -w "$npm_prefix/lib" ] || return 1
  elif [ ! -w "$npm_prefix" ]; then
    return 1
  fi

  return 0
}

# Refresh PATH so that npm global bin is discoverable.
# After nvm installs Node.js the global bin lives under the nvm prefix,
# which may not yet be on PATH in the current session.
refresh_path() {
  local npm_bin
  npm_bin="$(resolve_npm_bin)" || true
  if [[ -n "$npm_bin" && -d "$npm_bin" && ":$PATH:" != *":$npm_bin:"* ]]; then
    export PATH="$npm_bin:$PATH"
  fi

  if [[ -d "$NEMOCLAW_SHIM_DIR" && ":$PATH:" != *":$NEMOCLAW_SHIM_DIR:"* ]]; then
    export PATH="$NEMOCLAW_SHIM_DIR:$PATH"
  fi
}

ensure_nemoclaw_shim() {
  local npm_bin shim_path node_path node_dir cli_path
  npm_bin="$(resolve_npm_bin)" || true
  shim_path="${NEMOCLAW_SHIM_DIR}/nemoclaw"

  if [[ -z "$npm_bin" || ! -x "$npm_bin/nemoclaw" ]]; then
    return 1
  fi

  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_path" || ! -x "$node_path" ]]; then
    return 1
  fi

  cli_path="$npm_bin/nemoclaw"
  if [[ -z "$cli_path" || ! -x "$cli_path" ]]; then
    return 1
  fi
  node_dir="$(dirname "$node_path")"

  # If npm placed the binary at the same path as the shim target (e.g. when
  # npm_config_prefix=$HOME/.local), writing a shim would overwrite the real
  # binary with a script that exec's itself — an infinite loop.  In that case
  # the binary is already where it needs to be; skip shim creation.
  if [[ "$cli_path" -ef "$shim_path" ]]; then
    refresh_path
    ensure_local_bin_in_profile
    return 0
  fi

  mkdir -p "$NEMOCLAW_SHIM_DIR"
  cat >"$shim_path" <<EOF
#!/usr/bin/env bash
export PATH="$node_dir:\$PATH"
exec "$cli_path" "\$@"
EOF
  chmod +x "$shim_path"
  refresh_path
  ensure_local_bin_in_profile
  info "Created user-local shim at $shim_path"
  return 0
}

# Detect whether the parent shell likely needs a reload after install.
# When running via `curl | bash`, the installer executes in a subprocess.
# Even when the bin directory is already in PATH, the parent shell may have
# stale bash hash-table entries pointing to a previously deleted binary
# (e.g. upgrade/reinstall after `rm $(which nemoclaw)`).  Sourcing the
# shell profile reassigns PATH which clears the hash table, so we always
# recommend it when the installer verified nemoclaw in the subprocess.
needs_shell_reload() {
  [[ "$NEMOCLAW_READY_NOW" != true ]] && return 1
  return 0
}

# Add ~/.local/bin (and for fish, the nvm node bin) to the user's shell
# profile PATH so that nemoclaw, openshell, and any future tools installed
# there are discoverable in new terminal sessions.
# Idempotent — skips if the marker comment is already present.
ensure_local_bin_in_profile() {
  local profile
  profile="$(detect_shell_profile)"
  [[ -n "$profile" ]] || return 0

  # Already present — nothing to do.
  if [[ -f "$profile" ]] && grep -qF '# NemoClaw PATH setup' "$profile" 2>/dev/null; then
    return 0
  fi

  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  local local_bin="$NEMOCLAW_SHIM_DIR"

  case "$shell_name" in
    fish)
      # fish needs both ~/.local/bin and the nvm node bin (nvm doesn't support fish).
      local node_bin=""
      node_bin="$(command -v node 2>/dev/null)" || true
      if [[ -n "$node_bin" ]]; then
        node_bin="$(dirname "$node_bin")"
      fi
      {
        printf '\n# NemoClaw PATH setup\n'
        printf 'fish_add_path --path --append "%s"\n' "$local_bin"
        if [[ -n "$node_bin" ]]; then
          printf 'fish_add_path --path --append "%s"\n' "$node_bin"
        fi
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
    tcsh | csh)
      {
        printf '\n# NemoClaw PATH setup\n'
        # shellcheck disable=SC2016
        printf 'setenv PATH "%s:${PATH}"\n' "$local_bin"
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
    *)
      # bash, zsh, and others — nvm already handles node PATH for these shells.
      {
        printf '\n# NemoClaw PATH setup\n'
        # shellcheck disable=SC2016
        printf 'export PATH="%s:$PATH"\n' "$local_bin"
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
  esac
}

version_major() {
  printf '%s\n' "${1#v}" | cut -d. -f1
}

ensure_supported_runtime() {
  command_exists node || error "${RUNTIME_REQUIREMENT_MSG} Node.js was not found on PATH."
  command_exists npm || error "${RUNTIME_REQUIREMENT_MSG} npm was not found on PATH."

  local node_version npm_version node_major npm_major
  node_version="$(node --version 2>/dev/null || true)"
  npm_version="$(npm --version 2>/dev/null || true)"
  node_major="$(version_major "$node_version")"
  npm_major="$(version_major "$npm_version")"

  [[ "$node_major" =~ ^[0-9]+$ ]] || error "Could not determine Node.js version from '${node_version}'. ${RUNTIME_REQUIREMENT_MSG}"
  [[ "$npm_major" =~ ^[0-9]+$ ]] || error "Could not determine npm version from '${npm_version}'. ${RUNTIME_REQUIREMENT_MSG}"

  if ! version_gte "${node_version#v}" "$MIN_NODE_VERSION" || ((npm_major < MIN_NPM_MAJOR)); then
    error "Unsupported runtime detected: Node.js ${node_version:-unknown}, npm ${npm_version:-unknown}. ${RUNTIME_REQUIREMENT_MSG} Upgrade Node.js and rerun the installer."
  fi

  info "Runtime OK: Node.js ${node_version}, npm ${npm_version}"
}

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
install_nodejs() {
  if command_exists node; then
    local current_version current_npm_major
    current_version="$(node --version 2>/dev/null || true)"
    current_npm_major="$(version_major "$(npm --version 2>/dev/null || echo 0)")"
    if version_gte "${current_version#v}" "$MIN_NODE_VERSION" \
      && [[ "$current_npm_major" =~ ^[0-9]+$ ]] \
      && ((current_npm_major >= MIN_NPM_MAJOR)); then
      info "Node.js found: ${current_version}"
      return
    fi
    warn "Node.js ${current_version}, npm major ${current_npm_major:-unknown} found but NemoClaw requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR} — upgrading via nvm…"
  else
    info "Node.js not found — installing via nvm…"
  fi
  # IMPORTANT: update NVM_SHA256 when changing NVM_VERSION
  local NVM_VERSION="v0.40.4"
  local NVM_SHA256="4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f"
  local nvm_tmp
  nvm_tmp="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "$nvm_tmp" \
    || {
      rm -f "$nvm_tmp"
      error "Failed to download nvm installer"
    }
  local actual_hash
  if command_exists sha256sum; then
    actual_hash="$(sha256sum "$nvm_tmp" | awk '{print $1}')"
  elif command_exists shasum; then
    actual_hash="$(shasum -a 256 "$nvm_tmp" | awk '{print $1}')"
  else
    warn "No SHA-256 tool found — skipping nvm integrity check"
    actual_hash="$NVM_SHA256" # allow execution
  fi
  if [[ "$actual_hash" != "$NVM_SHA256" ]]; then
    rm -f "$nvm_tmp"
    error "nvm installer integrity check failed\n  Expected: $NVM_SHA256\n  Actual:   $actual_hash"
  fi
  info "nvm installer integrity verified"
  spin "Installing nvm..." bash "$nvm_tmp"
  rm -f "$nvm_tmp"
  ensure_nvm_loaded --force
  spin "Installing Node.js 22..." bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install 22 --no-progress"
  ensure_nvm_loaded --force
  nvm use 22 --silent
  nvm alias default 22 2>/dev/null || true
  local installed_version
  installed_version="$(node --version)"
  info "Node.js installed via nvm: ${installed_version} (default alias)"
  # Surface the shell-reload requirement right next to the install line so the
  # user isn't left thinking the new Node is already active in their terminal.
  # install.sh runs as a subprocess; the parent shell's PATH genuinely cannot
  # be mutated from here, so we print the truth and the exact command.
  # See issue #2178.
  warn "Your current shell may still resolve \`node\` to an older version until it's reloaded."
  printf "        Open a new terminal, or run this in your existing shell:\n"
  # shellcheck disable=SC2016  # intentional: user pastes this literally; their shell expands the vars
  printf '          source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22\n'
}

# ---------------------------------------------------------------------------
# 2. Ollama
# ---------------------------------------------------------------------------
OLLAMA_MIN_VERSION="0.18.0"
# IMPORTANT: update OLLAMA_INSTALL_SHA256 when changing OLLAMA_MIN_VERSION
# Pattern: pin hash and verify, same as NVM_SHA256 above (line ~656).
OLLAMA_INSTALL_SHA256="25f64b810b947145095956533e1bdf56eacea2673c55a7e586be4515fc882c9f"

get_ollama_version() {
  # `ollama --version` outputs something like "ollama version 0.18.0"
  ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

detect_gpu() {
  # Returns 0 if a GPU is detected
  if command_exists nvidia-smi; then
    nvidia-smi &>/dev/null && return 0
  fi
  return 1
}

get_vram_mb() {
  # Returns total VRAM in MiB (NVIDIA only). Falls back to 0.
  if command_exists nvidia-smi; then
    nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
      | awk '{s += $1} END {print s+0}'
    return
  fi
  # macOS — report unified memory as VRAM
  if [[ "$(uname -s)" == "Darwin" ]] && command_exists sysctl; then
    local bytes
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    echo $((bytes / 1024 / 1024))
    return
  fi
  echo 0
}

install_or_upgrade_ollama() {
  if detect_gpu && command_exists ollama; then
    local current
    current=$(get_ollama_version)
    if [[ -n "$current" ]] && version_gte "$current" "$OLLAMA_MIN_VERSION"; then
      info "Ollama v${current} meets minimum requirement (>= v${OLLAMA_MIN_VERSION})"
    else
      info "Ollama v${current:-unknown} is below v${OLLAMA_MIN_VERSION} — upgrading…"
      (
        tmpdir="$(mktemp -d)"
        trap 'rm -rf "$tmpdir"' EXIT
        curl -fsSL https://ollama.com/install.sh -o "$tmpdir/install_ollama.sh"
        verify_downloaded_script "$tmpdir/install_ollama.sh" "Ollama" "$OLLAMA_INSTALL_SHA256"
        sh "$tmpdir/install_ollama.sh"
      )
      info "Ollama upgraded to $(get_ollama_version)"
    fi
  else
    # No ollama — only install if a GPU is present
    if detect_gpu; then
      info "GPU detected — installing Ollama…"
      (
        tmpdir="$(mktemp -d)"
        trap 'rm -rf "$tmpdir"' EXIT
        curl -fsSL https://ollama.com/install.sh -o "$tmpdir/install_ollama.sh"
        verify_downloaded_script "$tmpdir/install_ollama.sh" "Ollama" "$OLLAMA_INSTALL_SHA256"
        sh "$tmpdir/install_ollama.sh"
      )
      info "Ollama installed: v$(get_ollama_version)"
    else
      warn "No GPU detected — skipping Ollama installation."
      return
    fi
  fi

  # Pull the appropriate model based on VRAM
  local vram_mb
  vram_mb=$(get_vram_mb)
  local vram_gb=$((vram_mb / 1024))
  info "Detected ${vram_gb} GB VRAM"

  if ((vram_gb >= 120)); then
    info "Pulling nemotron-3-super:120b…"
    ollama pull nemotron-3-super:120b
  else
    info "Pulling nemotron-3-nano:30b…"
    ollama pull nemotron-3-nano:30b
  fi
}

# ===========================================================================
# Recipe §4 — Dependency Resolver (REUSE / INSTALL lanes)
# Recipe §6 — Component Details (backend selection, platform fixups, model pull)
# Recipe §7 — Verification (5 smoke tests + telemetry)
#
# These functions implement the design in NemoClaw_Installer_Recipe.docx.
# Each lane probes for an existing tool, records "REUSE" or "INSTALL" in the
# manifest, and only mutates the host when an install is actually required.
# ===========================================================================

# Keep `sudo` invocations transparent: if we're root we skip it; otherwise we
# call sudo but defer to the user for password prompts. Returns exit status
# of the underlying command.
maybe_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Detect platform — Spark vs Station vs other Linux. Sets NEMOCLAW_DETECTED_PLATFORM.
detect_platform() {
  local model="" plat=""
  if [[ -r /sys/firmware/devicetree/base/model ]]; then
    # tr -d '\0' strips the trailing NUL devicetree appends
    model="$(tr -d '\0' </sys/firmware/devicetree/base/model 2>/dev/null || true)"
  fi
  if [[ -z "$model" && -r /sys/class/dmi/id/product_name ]]; then
    model="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
  fi

  if [[ "$model" == *Spark* || "$model" == *spark* || "$model" == *DGX*Spark* ]]; then
    plat="spark"
  elif [[ "$model" == *P3830* || "$model" == *Galaxy* ]] || \
       [[ "$model" == *Station* && "$model" == *GB300* ]]; then
    plat="station"
  else
    plat="linux"
  fi

  # Allow override (CI, test, etc.) — recipe §2 prerequisites.
  NEMOCLAW_DETECTED_PLATFORM="${NEMOCLAW_PLATFORM_OVERRIDE:-$plat}"
  printf "${C_GREEN}[INFO]${C_RESET}  Platform: ${C_GREEN}${NEMOCLAW_DETECTED_PLATFORM}${C_RESET} (${model:-unknown})\n"
}

# ---------------------------------------------------------------------------
# Recipe §4 — Color-coded dependency status table (terminal-rendered).
# Pure detection: no host mutation. Called twice in main() — once as a
# preview at the start of step 1, and once after install for confirmation.
#
# Action codes:
#   REUSE   — present and >= floor                 (green)
#   UPGRADE — present but below floor              (yellow)
#   INSTALL — not present, will be installed       (red)
#   DEFAULT — chosen by default selection rule     (cyan)
#   BUNDLED — provided by NemoClaw npm package     (cyan)
#   PULL    — backgrounded model pull              (cyan)
# ---------------------------------------------------------------------------
_status_color() {
  case "$1" in
    REUSE) printf "%s" "$C_GREEN" ;;
    UPGRADE) printf "%s" "$C_YELLOW" ;;
    INSTALL) printf "%s" "$C_RED" ;;
    DEFAULT | BUNDLED | PULL) printf "%s" "$C_CYAN" ;;
    *) printf "" ;;
  esac
}

# Decide REUSE / UPGRADE / INSTALL given a detected version + minimum floor.
_decide_action() {
  local detected="$1" floor="$2"
  if [[ -z "$detected" ]]; then
    printf "INSTALL"
  elif version_gte "$detected" "$floor"; then
    printf "REUSE"
  else
    printf "UPGRADE"
  fi
}

print_dependency_table() {
  local title="${1:-Dependency status}"

  # Probe — pure functions only.
  local docker_ver node_ver npm_ver openshell_ver platform
  docker_ver="$(get_docker_version || true)"
  node_ver="$(node --version 2>/dev/null | sed 's/^v//' || true)"
  npm_ver="$(npm --version 2>/dev/null || true)"
  openshell_ver="$(get_openshell_version || true)"
  platform="${NEMOCLAW_DETECTED_PLATFORM:-unknown}"

  # Decide actions
  local docker_act node_act npm_act openshell_act backend_act
  docker_act="$(_decide_action "$docker_ver" "$MIN_DOCKER_VERSION")"
  node_act="$(_decide_action "$node_ver" "$MIN_NODE_VERSION")"
  local npm_major
  npm_major="$(version_major "${npm_ver:-0}")"
  if [[ -z "$npm_ver" ]]; then
    npm_act="INSTALL"
  elif [[ "$npm_major" =~ ^[0-9]+$ ]] && ((npm_major >= MIN_NPM_MAJOR)); then
    npm_act="REUSE"
  else
    npm_act="UPGRADE"
  fi
  openshell_act="$(_decide_action "$openshell_ver" "$MIN_OPENSHELL_VERSION")"

  # Backend probe (read-only)
  local backend_present="none"
  if _port_listening 8000 && _proc_running vllm; then
    backend_present="vLLM:8000"
    backend_act="REUSE"
  elif _proc_running sglang; then
    backend_present="SGLang"
    backend_act="REUSE"
  elif command_exists ollama && _port_listening 11434; then
    backend_present="Ollama:11434"
    backend_act="REUSE"
  else
    backend_present="none"
    backend_act="DEFAULT"
  fi

  # ── Render ──────────────────────────────────────────────────────────────
  # ASCII column widths so printf %-Ns lines up regardless of locale.
  local W1=15 W2=20 W3=20

  # Print one row with colored Action cell. Action is last → safe to colorize.
  _row() {
    local comp="$1" req="$2" det="$3" act="$4" extra="${5:-}"
    local clr label
    clr="$(_status_color "$act")"
    label="${act}${extra:+ ${extra}}"
    printf "  %-${W1}s %-${W2}s %-${W3}s ${clr}${C_BOLD}%s${C_RESET}\n" \
      "$comp" "$req" "${det:-not present}" "$label"
  }

  printf "\n  ${C_BOLD}%s${C_RESET}\n" "$title"
  printf "  ${C_DIM}%-${W1}s %-${W2}s %-${W3}s %s${C_RESET}\n" \
    "Component" "Required" "Detected" "Action"
  # Horizontal rule — light dashes via the dim style (locale-safe ASCII).
  printf "  ${C_DIM}%s${C_RESET}\n" \
    "----------------------------------------------------------------------"

  _row "Docker" ">= ${MIN_DOCKER_VERSION}" "${docker_ver}" "$docker_act"
  _row "Node.js" ">= ${MIN_NODE_VERSION}" "${node_ver:+v${node_ver}}" "$node_act"
  _row "npm" ">= ${MIN_NPM_MAJOR}.x" "${npm_ver}" "$npm_act"
  _row "OpenShell" ">= ${MIN_OPENSHELL_VERSION}" "${openshell_ver}" "$openshell_act"
  _row "OpenClaw CLI" "bundled w/ NemoClaw" "-" "BUNDLED"
  _row "Nemotron-3" "auto by VRAM" "-" "PULL" "(background)"
  _row "Backend" "vLLM > SGL > Ollama" "${backend_present}" "$backend_act" \
    "${NEMOCLAW_SELECTED_BACKEND:+-> ${NEMOCLAW_SELECTED_BACKEND}}"

  printf "  ${C_DIM}%s${C_RESET}\n" \
    "----------------------------------------------------------------------"
  printf "  ${C_DIM}Platform${C_RESET} ${C_BOLD}%s${C_RESET}    ${C_DIM}Manifest${C_RESET} ${C_DIM}%s${C_RESET}\n" \
    "$platform" "$NEMOCLAW_MANIFEST_PATH"
  printf "  ${C_DIM}Legend${C_RESET}  ${C_GREEN}${C_BOLD}REUSE${C_RESET}=ok  ${C_YELLOW}${C_BOLD}UPGRADE${C_RESET}=needs upgrade  ${C_RED}${C_BOLD}INSTALL${C_RESET}=missing  ${C_CYAN}${C_BOLD}DEFAULT/BUNDLED/PULL${C_RESET}=installer-managed\n\n"
}

# ---------------------------------------------------------------------------
# Recipe §4 — Dependency lane: Docker (>= 28.x)
# ---------------------------------------------------------------------------
get_docker_version() {
  command_exists docker || {
    printf ""
    return
  }
  docker --version 2>/dev/null \
    | sed -nE 's/.*[Vv]ersion[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1
}

resolve_docker() {
  local current
  current="$(get_docker_version || true)"
  if [[ -n "$current" ]] && version_gte "$current" "$MIN_DOCKER_VERSION"; then
    info "Docker ${current} found — REUSE (>= ${MIN_DOCKER_VERSION})"
    NEMOCLAW_DOCKER_VERSION="$current"
    NEMOCLAW_DOCKER_ACTION="reuse"
    return 0
  fi

  if [[ -n "$current" ]]; then
    warn "Docker ${current} below required ${MIN_DOCKER_VERSION} — upgrading via docker-ce repo"
  else
    info "Docker not found — installing docker-ce (>= ${MIN_DOCKER_VERSION})"
  fi

  if [[ "$(uname -s)" != "Linux" ]]; then
    warn "Skipping Docker install — not Linux"
    NEMOCLAW_DOCKER_ACTION="skipped"
    return 0
  fi

  # Docker CE official convenience installer — same approach as Spark setup,
  # but invoked here so a fresh host gets Docker before we touch anything else.
  local tmpdir
  tmpdir="$(mktemp -d)"
  _cleanup_files+=("$tmpdir/get-docker.sh")
  curl -fsSL https://get.docker.com -o "$tmpdir/get-docker.sh"
  verify_downloaded_script "$tmpdir/get-docker.sh" "Docker installer"
  spin "Installing Docker (docker-ce)" maybe_sudo sh "$tmpdir/get-docker.sh"
  rm -rf "$tmpdir"

  # Add the invoking user to the docker group so non-root commands work
  # without sudo (matches recipe §6 Spark fixup behavior).
  local real_user="${SUDO_USER:-${USER:-}}"
  if [[ -n "$real_user" && "$real_user" != "root" ]]; then
    if ! id -nG "$real_user" 2>/dev/null | grep -qw docker; then
      info "Adding ${real_user} to docker group"
      maybe_sudo usermod -aG docker "$real_user" || warn "usermod failed — re-run as sudo if needed"
    fi
  fi

  current="$(get_docker_version || true)"
  NEMOCLAW_DOCKER_VERSION="${current:-unknown}"
  NEMOCLAW_DOCKER_ACTION="install"
  ok "Docker ${NEMOCLAW_DOCKER_VERSION} installed"
}

# ---------------------------------------------------------------------------
# Recipe §4 — Dependency lane: OpenShell (>= MIN_OPENSHELL_VERSION)
# Delegates to the existing scripts/install-openshell.sh (which knows about
# the supported version window). This is a thin wrapper that decides REUSE
# vs INSTALL up-front and records it in the manifest.
# ---------------------------------------------------------------------------
get_openshell_version() {
  command_exists openshell || {
    printf ""
    return
  }
  openshell --version 2>/dev/null \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

resolve_openshell() {
  local current
  current="$(get_openshell_version || true)"
  if [[ -n "$current" ]] && version_gte "$current" "$MIN_OPENSHELL_VERSION"; then
    info "OpenShell ${current} found — REUSE (>= ${MIN_OPENSHELL_VERSION})"
    NEMOCLAW_OPENSHELL_VERSION="$current"
    NEMOCLAW_OPENSHELL_ACTION="reuse"
    return 0
  fi

  info "OpenShell ${current:-not present} — installing/upgrading via install-openshell.sh"
  local installer="${SCRIPT_DIR}/install-openshell.sh"
  if [[ ! -f "$installer" ]]; then
    # Source-checkout running outside its own scripts/ dir
    installer="${NEMOCLAW_SOURCE_ROOT:-}/scripts/install-openshell.sh"
  fi
  if [[ -f "$installer" ]]; then
    spin "Installing OpenShell" bash "$installer"
  else
    warn "install-openshell.sh not found — deferring OpenShell install to nemoclaw onboard"
  fi

  current="$(get_openshell_version || true)"
  NEMOCLAW_OPENSHELL_VERSION="${current:-unknown}"
  NEMOCLAW_OPENSHELL_ACTION="install"
}

# ---------------------------------------------------------------------------
# Recipe §6.1 — Backend selection (MRD §2.3.4)
#   Priority: vLLM:8000 → SGLang → Ollama → install Ollama default
#
# Detection is best-effort: a listening port plus a matching process name.
# We never start a service that wasn't already running — REUSE is purely
# observational. The chosen backend is recorded in ~/.nemoclaw/config.toml
# so the sandbox can be wired to it during onboarding.
# ---------------------------------------------------------------------------
_port_listening() {
  local port="$1"
  if command_exists ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
  elif command_exists netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
  else
    return 1
  fi
}

_proc_running() {
  local needle="$1"
  if command_exists pidof; then
    pidof -x "$needle" >/dev/null 2>&1 && return 0
  fi
  command_exists pgrep && pgrep -af "$needle" >/dev/null 2>&1
}

select_backend() {
  # 1) vLLM serving Nemotron-3 Super on :8000?
  if _port_listening 8000 && _proc_running vllm; then
    NEMOCLAW_SELECTED_BACKEND="vllm"
    NEMOCLAW_SELECTED_BACKEND_ENDPOINT="http://127.0.0.1:8000"
    info "Backend: REUSE vLLM at ${NEMOCLAW_SELECTED_BACKEND_ENDPOINT}"
    write_backend_config
    return 0
  fi

  # 2) SGLang on :11434 (alt) — process detection only, since the port
  #    can collide with Ollama.
  if _proc_running sglang; then
    NEMOCLAW_SELECTED_BACKEND="sglang"
    NEMOCLAW_SELECTED_BACKEND_ENDPOINT="http://127.0.0.1:11434"
    info "Backend: REUSE SGLang at ${NEMOCLAW_SELECTED_BACKEND_ENDPOINT}"
    write_backend_config
    return 0
  fi

  # 3) Ollama on :11434?
  if command_exists ollama && _port_listening 11434; then
    NEMOCLAW_SELECTED_BACKEND="ollama"
    NEMOCLAW_SELECTED_BACKEND_ENDPOINT="http://127.0.0.1:11434"
    info "Backend: REUSE Ollama at ${NEMOCLAW_SELECTED_BACKEND_ENDPOINT}"
    write_backend_config
    return 0
  fi

  # 4) Default — install Ollama and queue Nemotron-3 Super pull (backgrounded).
  if detect_gpu; then
    info "Backend: no compatible inference server found — installing Ollama (default)"
    install_or_upgrade_ollama
    NEMOCLAW_SELECTED_BACKEND="ollama"
    NEMOCLAW_SELECTED_BACKEND_ENDPOINT="http://127.0.0.1:11434"
  else
    warn "No GPU detected — backend will be configured at onboard time"
    NEMOCLAW_SELECTED_BACKEND="deferred"
    NEMOCLAW_SELECTED_BACKEND_ENDPOINT=""
  fi
  write_backend_config
}

write_backend_config() {
  local cfg_dir="${HOME}/.nemoclaw"
  mkdir -p "$cfg_dir"
  local cfg="${cfg_dir}/config.toml"
  # Idempotent rewrite of the [backend] block.
  python3 - "$cfg" "$NEMOCLAW_SELECTED_BACKEND" "$NEMOCLAW_SELECTED_BACKEND_ENDPOINT" <<'PY' || warn "config.toml write failed"
import os, sys, re
path, name, endpoint = sys.argv[1], sys.argv[2], sys.argv[3]
existing = ""
if os.path.exists(path):
    with open(path) as f:
        existing = f.read()
block = f'[backend]\nname = "{name}"\nendpoint = "{endpoint}"\n'
new = re.sub(r"\[backend\][^\[]*", "", existing, flags=re.DOTALL).strip()
out = (new + ("\n\n" if new else "") + block)
with open(path, "w") as f:
    f.write(out)
PY
}

# ---------------------------------------------------------------------------
# Recipe §6.2 — Platform-specific fixups
#   Spark:   delegate to setup-spark.sh (cgroupns=host + CoreDNS)
#   Station: HMM check + NONATS app-profile + KV-cache tier preference
# ---------------------------------------------------------------------------
apply_platform_fixups() {
  case "$NEMOCLAW_DETECTED_PLATFORM" in
    spark)
      apply_spark_fixups
      ;;
    station)
      apply_station_fixups
      ;;
    *)
      info "Platform: generic Linux — no platform-specific fixups"
      ;;
  esac
}

apply_spark_fixups() {
  local script="${SCRIPT_DIR}/setup-spark.sh"
  if [[ ! -x "$script" && -f "$script" ]]; then
    chmod +x "$script" 2>/dev/null || true
  fi
  if [[ -f "$script" ]]; then
    info "Applying DGX Spark fixups (cgroupns=host, CoreDNS pre-pull)"
    spin "DGX Spark setup" maybe_sudo bash "$script" \
      || warn "Spark fixups returned non-zero (non-fatal)"
  else
    warn "setup-spark.sh missing — skipping Spark fixups"
  fi

  # CoreDNS pre-pull avoids a 30s gateway-start hang on first run.
  if command_exists docker; then
    spin "Pre-pulling CoreDNS image for OpenShell gateway" \
      docker pull coredns/coredns:latest \
      || warn "CoreDNS pre-pull failed (non-fatal)"
  fi
}

apply_station_fixups() {
  info "Applying DGX Station GB300 fixups (HMM, app profile, KV cache)"

  # 1) HMM should already be enabled by R575+ open-kernel driver, but verify.
  if command_exists nvidia-smi; then
    if nvidia-smi -q 2>/dev/null | grep -qE 'Heterogeneous Memory.*Enabled|HMM.*Enabled'; then
      ok "HMM enabled (mixed-coherency unified VA)"
    else
      warn "HMM status not visible from nvidia-smi -q. Driver R575+ recommended."
    fi
  fi

  # 2) NVIDIA Application Profile — steer GLX away from ATS-capable iGPU on
  # mixed-coherency systems. UseNonATSGpuInMixedCoherencySystems = True ⇒
  # DeviceModalityPreference = NONATS (= 2). Layered as a system-wide profile.
  local prof_dir="/etc/nvidia/profiles"
  local prof_file="${prof_dir}/nemoclaw-station.json"
  maybe_sudo mkdir -p "$prof_dir"
  if ! maybe_sudo test -f "$prof_file" \
    || ! maybe_sudo grep -q "UseNonATSGpuInMixedCoherencySystems" "$prof_file" 2>/dev/null; then
    info "Writing NVIDIA app profile: ${prof_file}"
    maybe_sudo tee "$prof_file" >/dev/null <<'JSON'
{
  "rules": [
    {
      "pattern": { "feature": "procname", "matches": "*" },
      "profile": "NemoClawStation"
    }
  ],
  "profiles": [
    {
      "name": "NemoClawStation",
      "settings": [
        { "key": "UseNonATSGpuInMixedCoherencySystems", "value": true }
      ]
    }
  ]
}
JSON
  fi

  # 3) KV-cache tier hint — read by NemoClaw plugin to prefer HBM3e then LPDDR5
  # for KV cache on Station. Stored alongside the manifest.
  maybe_sudo mkdir -p "$NEMOCLAW_STATE_DIR"
  maybe_sudo tee "${NEMOCLAW_STATE_DIR}/kv-cache-tiers.json" >/dev/null <<'JSON'
{ "tiers": ["HBM3e", "LPDDR5"], "platform": "dgx-station-gb300" }
JSON
  ok "Station fixups applied"
}

# ---------------------------------------------------------------------------
# Recipe §4 / §6 — Backgrounded Nemotron-3 Super pull
# Installs a oneshot systemd unit so the installer returns immediately while
# `ollama pull` continues in the background. Progress is visible via
# `nemoclaw status` (which reads journalctl -u $MODEL_PULL_UNIT).
# ---------------------------------------------------------------------------
schedule_model_pull() {
  if [[ "$NEMOCLAW_SELECTED_BACKEND" != "ollama" ]]; then
    info "Skipping model pull unit — backend is ${NEMOCLAW_SELECTED_BACKEND:-deferred}"
    return 0
  fi
  if ! command_exists systemctl; then
    warn "systemd not available — running model pull synchronously instead"
    install_or_upgrade_ollama
    return 0
  fi

  # Pick the right tag based on VRAM (matches install_or_upgrade_ollama logic).
  local vram_gb model_tag
  vram_gb=$(($(get_vram_mb) / 1024))
  if ((vram_gb >= 120)); then
    model_tag="nemotron-3-super:120b"
  else
    model_tag="nemotron-3-nano:30b"
  fi
  info "Scheduling background model pull: ${model_tag} (~60 GB NVFP4)"

  local unit_path="/etc/systemd/system/${MODEL_PULL_UNIT}"
  maybe_sudo tee "$unit_path" >/dev/null <<UNIT
[Unit]
Description=NemoClaw — pull ${model_tag} (Recipe §4 backgrounded model pull)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=${HOME}
ExecStart=/usr/bin/env ollama pull ${model_tag}
SuccessExitStatus=0
TimeoutStartSec=infinity
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  maybe_sudo systemctl daemon-reload
  maybe_sudo systemctl enable --now "$MODEL_PULL_UNIT" \
    || warn "Failed to start ${MODEL_PULL_UNIT} — run 'systemctl start ${MODEL_PULL_UNIT}' manually"
  ok "Model pull running in background — track via 'nemoclaw status' or 'journalctl -u ${MODEL_PULL_UNIT}'"
}

# ---------------------------------------------------------------------------
# Recipe §4 — Manifest writer
# Pins resolved versions to /var/lib/nemoclaw/manifest.json so a later
# `nemoclaw status` (or a re-run of the installer) can prove every dep.
# ---------------------------------------------------------------------------
write_dependency_manifest() {
  maybe_sudo mkdir -p "$NEMOCLAW_STATE_DIR"

  local node_ver npm_ver docker_ver openshell_ver openclaw_ver nemoclaw_ver
  node_ver="$(node --version 2>/dev/null || echo unknown)"
  npm_ver="$(npm --version 2>/dev/null || echo unknown)"
  docker_ver="${NEMOCLAW_DOCKER_VERSION:-$(get_docker_version || echo unknown)}"
  openshell_ver="${NEMOCLAW_OPENSHELL_VERSION:-$(get_openshell_version || echo unknown)}"
  openclaw_ver="$(openclaw --version 2>/dev/null | head -1 || echo unknown)"
  nemoclaw_ver="${NEMOCLAW_VERSION:-unknown}"

  local manifest
  manifest="$(mktemp)"
  _cleanup_files+=("$manifest")
  python3 - "$manifest" <<PY
import json, os, sys, datetime
m = {
  "schema": 1,
  "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
  "platform": "${NEMOCLAW_DETECTED_PLATFORM}",
  "nemoclaw": {"version": "${nemoclaw_ver}"},
  "dependencies": {
    "docker":    {"version": "${docker_ver}",    "action": "${NEMOCLAW_DOCKER_ACTION:-unknown}",    "min": "${MIN_DOCKER_VERSION}"},
    "node":      {"version": "${node_ver}",      "action": "ensured",                              "min": "${MIN_NODE_VERSION}"},
    "npm":       {"version": "${npm_ver}",       "action": "ensured",                              "min_major": ${MIN_NPM_MAJOR}},
    "openshell": {"version": "${openshell_ver}", "action": "${NEMOCLAW_OPENSHELL_ACTION:-unknown}", "min": "${MIN_OPENSHELL_VERSION}"},
    "openclaw":  {"version": "${openclaw_ver}",  "action": "bundled"}
  },
  "backend": {
    "name":     "${NEMOCLAW_SELECTED_BACKEND}",
    "endpoint": "${NEMOCLAW_SELECTED_BACKEND_ENDPOINT}"
  },
  "model_pull_unit": "${MODEL_PULL_UNIT}"
}
with open(sys.argv[1], "w") as f:
    json.dump(m, f, indent=2, sort_keys=True)
PY
  maybe_sudo install -m 0644 "$manifest" "$NEMOCLAW_MANIFEST_PATH"
  rm -f "$manifest"
  ok "Dependency manifest written: ${NEMOCLAW_MANIFEST_PATH}"
}

# ---------------------------------------------------------------------------
# Recipe §7 — Verification (5 smoke tests + telemetry)
# These mirror the post-install checklist in the recipe doc. None of them
# fail the install on their own — they emit warnings and let the user
# inspect the install before retrying.
# ---------------------------------------------------------------------------
emit_install_event() {
  local result="$1"
  local log_dir="/var/log/nemoclaw"
  maybe_sudo mkdir -p "$log_dir" 2>/dev/null || true
  local payload
  payload=$(printf '{"event":"install.%s","ts":"%s","platform":"%s","backend":"%s"}\n' \
    "$result" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$NEMOCLAW_DETECTED_PLATFORM" "$NEMOCLAW_SELECTED_BACKEND")
  printf '%s\n' "$payload" | maybe_sudo tee -a "${log_dir}/events.log" >/dev/null 2>&1 || true
}

run_smoke_tests() {
  local pass=0 fail=0
  info "Running smoke tests (Recipe §7)"

  # 1. openshell sandbox list → nemoclaw Ready
  if command_exists openshell; then
    if openshell sandbox list 2>/dev/null | grep -qiE 'nemoclaw.*ready|ready.*nemoclaw'; then
      ok "1/5 openshell sandbox 'nemoclaw' Ready"
      pass=$((pass + 1))
    else
      warn "1/5 openshell sandbox not Ready — onboarding may still be running"
      fail=$((fail + 1))
    fi
  else
    warn "1/5 openshell not on PATH"
    fail=$((fail + 1))
  fi

  # 2. nemoclaw status → deps + backend + model
  if command_exists nemoclaw; then
    if nemoclaw status >/dev/null 2>&1; then
      ok "2/5 nemoclaw status returned 0"
      pass=$((pass + 1))
    else
      warn "2/5 nemoclaw status returned non-zero"
      fail=$((fail + 1))
    fi
  else
    warn "2/5 nemoclaw CLI not on PATH"
    fail=$((fail + 1))
  fi

  # 3. systemctl is-active nemoclaw.service (skip if no systemd / unit absent)
  if command_exists systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^nemoclaw.service'; then
    if systemctl is-active --quiet nemoclaw.service; then
      ok "3/5 nemoclaw.service active"
      pass=$((pass + 1))
    else
      warn "3/5 nemoclaw.service not active"
      fail=$((fail + 1))
    fi
  else
    info "3/5 nemoclaw.service not present (skipped)"
  fi

  # 4. nemoclaw chat hello — only if backend is up. Avoid hanging in CI.
  if command_exists nemoclaw && [[ "$NEMOCLAW_SELECTED_BACKEND" != "deferred" ]]; then
    if timeout 30s nemoclaw chat --agent repl --local 'hello' >/dev/null 2>&1; then
      ok "4/5 nemoclaw chat 'hello' returned 200"
      pass=$((pass + 1))
    else
      warn "4/5 nemoclaw chat 'hello' did not respond within 30s (model may still be downloading)"
    fi
  else
    info "4/5 chat smoke test skipped (backend=${NEMOCLAW_SELECTED_BACKEND:-deferred})"
  fi

  # 5. Model pull unit running / completed (if applicable)
  if command_exists systemctl && systemctl list-unit-files 2>/dev/null | grep -q "^${MODEL_PULL_UNIT}"; then
    local state
    state="$(systemctl show -p ActiveState --value "$MODEL_PULL_UNIT" 2>/dev/null || echo unknown)"
    case "$state" in
      active | activating)
        ok "5/5 ${MODEL_PULL_UNIT} ${state}"
        pass=$((pass + 1))
        ;;
      inactive)
        ok "5/5 ${MODEL_PULL_UNIT} completed"
        pass=$((pass + 1))
        ;;
      *)
        warn "5/5 ${MODEL_PULL_UNIT} state=${state}"
        fail=$((fail + 1))
        ;;
    esac
  else
    info "5/5 model pull unit not used"
  fi

  if ((fail > 0)); then
    emit_install_event "partial"
    warn "Smoke tests: ${pass} passed, ${fail} warned — see 'nemoclaw status' for details"
  else
    emit_install_event "success"
    ok "Smoke tests: ${pass} passed"
  fi
}

# ---------------------------------------------------------------------------
# Fix npm permissions for global installs (Linux only).
# If the npm global prefix points to a system directory (e.g. /usr or
# /usr/local) the user likely lacks write permissions and npm link will fail
# with EACCES.  Redirect the prefix to ~/.npm-global so the install succeeds
# without sudo.
# ---------------------------------------------------------------------------
fix_npm_permissions() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  if [[ -z "$npm_prefix" ]]; then
    return 0
  fi

  if [[ -w "$npm_prefix" || -w "$npm_prefix/lib" ]]; then
    return 0
  fi

  info "npm global prefix '${npm_prefix}' is not writable — configuring user-local installs"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"

  # shellcheck disable=SC2016
  local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
      printf '\n# Added by NemoClaw installer\n%s\n' "$path_line" >>"$rc"
    fi
  done

  export PATH="$HOME/.npm-global/bin:$PATH"
  ok "npm configured for user-local installs (~/.npm-global)"
}

# ---------------------------------------------------------------------------
# 3. NemoClaw
# ---------------------------------------------------------------------------
# Work around openclaw tarball missing directory entries (GH-503).
# npm's tar extractor hard-fails because the tarball is missing directory
# entries for extensions/, skills/, and dist/plugin-sdk/config/. System tar
# handles this fine. We pre-extract openclaw into node_modules BEFORE npm
# install so npm sees the dependency is already satisfied and skips it.
pre_extract_openclaw() {
  local install_dir="$1"
  local openclaw_version
  openclaw_version="$(resolve_openclaw_version "$install_dir")"

  if [[ -z "$openclaw_version" ]]; then
    warn "Could not determine openclaw version — skipping pre-extraction"
    return 1
  fi

  info "Pre-extracting openclaw@${openclaw_version} with system tar (GH-503 workaround)…"
  local tmpdir
  tmpdir="$(mktemp -d)"
  if npm pack "openclaw@${openclaw_version}" --pack-destination "$tmpdir" >/dev/null 2>&1; then
    local tgz
    tgz="$(find "$tmpdir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
    if [[ -n "$tgz" && -f "$tgz" ]]; then
      if mkdir -p "${install_dir}/node_modules/openclaw" \
        && tar xzf "$tgz" -C "${install_dir}/node_modules/openclaw" --strip-components=1; then
        info "openclaw pre-extracted successfully"
      else
        warn "Failed to extract openclaw tarball"
        rm -rf "$tmpdir"
        return 1
      fi
    else
      warn "npm pack succeeded but tarball not found"
      rm -rf "$tmpdir"
      return 1
    fi
  else
    warn "Failed to download openclaw tarball"
    rm -rf "$tmpdir"
    return 1
  fi
  rm -rf "$tmpdir"
}

resolve_openclaw_version() {
  local install_dir="$1"
  local package_json dockerfile_base resolved_version

  package_json="${install_dir}/package.json"
  dockerfile_base="${install_dir}/Dockerfile.base"

  if [[ -f "$package_json" ]]; then
    resolved_version="$(
      node -e "const v = require('${package_json}').dependencies?.openclaw; if (v) console.log(v)" \
        2>/dev/null || true
    )"
    if [[ -n "$resolved_version" ]]; then
      printf '%s\n' "$resolved_version"
      return 0
    fi
  fi

  if [[ -f "$dockerfile_base" ]]; then
    awk '
      match($0, /openclaw@[0-9][0-9.]+/) {
        print substr($0, RSTART + 9, RLENGTH - 9)
        exit
      }
      match($0, /ARG[[:space:]]+OPENCLAW_VERSION[[:space:]]*=[[:space:]]*[0-9][0-9.]+/) {
        line = substr($0, RSTART, RLENGTH)
        sub(/^[^=]+=[[:space:]]*/, "", line)
        print line
        exit
      }
    ' "$dockerfile_base"
  fi
}

is_source_checkout() {
  local repo_root="$1"
  local package_json="${repo_root}/package.json"

  [[ -f "$package_json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"nemoclaw"' "$package_json" 2>/dev/null || return 1

  if [[ "${NEMOCLAW_BOOTSTRAP_PAYLOAD:-}" == "1" ]]; then
    return 1
  fi

  if [[ -n "${NEMOCLAW_REPO_ROOT:-}" || -d "${repo_root}/.git" ]]; then
    return 0
  fi

  return 1
}

install_nemoclaw() {
  command_exists git || error "git was not found on PATH."
  local repo_root package_json
  repo_root="$(resolve_repo_root)"
  package_json="${repo_root}/package.json"
  # Tell prepare not to run npm link — the installer handles linking explicitly.
  export NEMOCLAW_INSTALLING=1

  if is_source_checkout "$repo_root"; then
    info "NemoClaw package.json found in the selected source checkout — installing from source…"
    NEMOCLAW_SOURCE_ROOT="$repo_root"
    if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
      spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$NEMOCLAW_SOURCE_ROOT" \
        || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    fi
    spin "Installing NemoClaw dependencies" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm install --ignore-scripts"
    spin "Building NemoClaw CLI modules" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm run --if-present build:cli"
    spin "Building NemoClaw plugin" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\"/nemoclaw && npm install --ignore-scripts && npm run build"
    spin "Linking NemoClaw CLI" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm link"
  else
    if [[ -f "$package_json" ]]; then
      info "Installer payload is not a persistent source checkout — installing from GitHub…"
    fi
    info "Installing NemoClaw from GitHub…"
    # Resolve the latest release tag so we never install raw main.
    local release_ref
    release_ref="$(resolve_release_tag)"
    info "Resolved install ref: ${release_ref}"
    # Clone first so we can pre-extract openclaw before npm install (GH-503).
    # npm install -g git+https://... does this internally but we can't hook
    # into its extraction pipeline, so we do it ourselves.
    local nemoclaw_src="${HOME}/.nemoclaw/source"
    rm -rf "$nemoclaw_src"
    mkdir -p "$(dirname "$nemoclaw_src")"
    NEMOCLAW_SOURCE_ROOT="$nemoclaw_src"
    spin "Cloning NemoClaw source" git clone --depth 1 --branch "$release_ref" https://github.com/NVIDIA/NemoClaw.git "$nemoclaw_src"
    # Fetch version tags into the shallow clone so `git describe --tags
    # --match "v*"` works at runtime (the shallow clone only has the
    # single ref we asked for).
    git -C "$nemoclaw_src" fetch --depth=1 origin 'refs/tags/v*:refs/tags/v*' 2>/dev/null || true
    # Also stamp .version as a fallback for environments where git is
    # unavailable or tags are pruned later.
    git -C "$nemoclaw_src" describe --tags --match 'v*' 2>/dev/null \
      | sed 's/^v//' >"$nemoclaw_src/.version" || true
    if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
      spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$nemoclaw_src" \
        || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    fi
    spin "Installing NemoClaw dependencies" bash -c "cd \"$nemoclaw_src\" && npm install --ignore-scripts"
    spin "Building NemoClaw CLI modules" bash -c "cd \"$nemoclaw_src\" && npm run --if-present build:cli"
    spin "Building NemoClaw plugin" bash -c "cd \"$nemoclaw_src\"/nemoclaw && npm install --ignore-scripts && npm run build"
    spin "Linking NemoClaw CLI" bash -c "cd \"$nemoclaw_src\" && npm link"

    # Install/upgrade the OpenShell CLI on the GitHub-clone path (curl|bash).
    # Without this, install.sh defers the openshell version gate entirely to
    # `nemoclaw onboard`, so any later skip of onboard (preflight blocking,
    # interrupted session) leaves openshell stale below blueprint's
    # min_openshell_version even though the new NemoClaw declared a higher
    # floor. The source-checkout branch intentionally skips this — a developer
    # running ./scripts/install.sh manages their own openshell. The script is
    # idempotent on the happy path. See #2272.
    spin "Installing OpenShell CLI" bash "${NEMOCLAW_SOURCE_ROOT}/scripts/install-openshell.sh"
  fi

  refresh_path
  ensure_nemoclaw_shim || true
}

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------

# Verify that a nemoclaw binary is the real NemoClaw CLI and not the broken
# placeholder npm package (npmjs.org/nemoclaw 0.1.0 — 249 bytes, no build
# artifacts).  The real CLI prints "nemoclaw v<semver>" on --version.
# Mirrors the isOpenshellCLI() pattern from resolve-openshell.js (PR #970).
is_real_nemoclaw_cli() {
  local bin_path="${1:-nemoclaw}"
  local version_output
  version_output="$("$bin_path" --version 2>/dev/null)" || return 1
  # Real CLI outputs: "nemoclaw v0.1.0" (or any semver, with optional pre-release)
  [[ "$version_output" =~ ^nemoclaw[[:space:]]+v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
}

verify_nemoclaw() {
  if command_exists nemoclaw; then
    if is_real_nemoclaw_cli "$(command -v nemoclaw)"; then
      NEMOCLAW_READY_NOW=true
      ensure_nemoclaw_shim || true
      info "Verified: nemoclaw is available at $(command -v nemoclaw)"
      return 0
    else
      warn "Found nemoclaw at $(command -v nemoclaw) but it is not the real NemoClaw CLI."
      warn "This is likely the broken placeholder npm package."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  local npm_bin
  npm_bin="$(resolve_npm_bin)" || true

  if [[ -n "$npm_bin" && -x "$npm_bin/nemoclaw" ]]; then
    if is_real_nemoclaw_cli "$npm_bin/nemoclaw"; then
      ensure_nemoclaw_shim || true
      if command_exists nemoclaw; then
        NEMOCLAW_READY_NOW=true
        info "Verified: nemoclaw is available at $(command -v nemoclaw)"
        return 0
      fi

      NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
      if [[ -x "$NEMOCLAW_SHIM_DIR/nemoclaw" ]]; then
        NEMOCLAW_RECOVERY_EXPORT_DIR="$NEMOCLAW_SHIM_DIR"
      else
        NEMOCLAW_RECOVERY_EXPORT_DIR="$npm_bin"
      fi
      warn "Found nemoclaw at $npm_bin/nemoclaw but this shell still cannot resolve it."
      warn "Onboarding will be skipped until PATH is updated."
      return 0
    else
      warn "Found nemoclaw at $npm_bin/nemoclaw but it is not the real NemoClaw CLI."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  warn "Could not locate the nemoclaw executable."
  warn "Try re-running:  curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"
  error "Installation failed: nemoclaw binary not found."
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------
run_installer_host_preflight() {
  local preflight_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/preflight.js"
  if ! command_exists node || [[ ! -f "$preflight_module" ]]; then
    return 0
  fi

  local output status
  if output="$(
    # shellcheck disable=SC2016
    node -e '
      const preflightPath = process.argv[1];
      try {
        const { assessHost, planHostRemediation } = require(preflightPath);
        const host = assessHost();
        const actions = planHostRemediation(host);
        const blockingActions = actions.filter((action) => action && action.blocking);
        const infoLines = [];
        const actionLines = [];
        if (host.runtime && host.runtime !== "unknown") {
          infoLines.push(`Detected container runtime: ${host.runtime}`);
        }
        if (host.notes && host.notes.includes("Running under WSL")) {
          infoLines.push("Running under WSL");
        }
        for (const action of actions) {
          actionLines.push(`- ${action.title}: ${action.reason}`);
          for (const command of action.commands || []) {
            actionLines.push(`  ${command}`);
          }
        }
        if (infoLines.length > 0) {
          process.stdout.write(`__INFO__\n${infoLines.join("\n")}\n`);
        }
        if (actionLines.length > 0) {
          process.stdout.write(`__ACTIONS__\n${actionLines.join("\n")}`);
        }
        process.exit(blockingActions.length > 0 ? 10 : 0);
      } catch {
        process.exit(0);
      }
    ' "$preflight_module"
  )"; then
    status=0
  else
    status=$?
  fi

  if [[ -n "$output" ]]; then
    local info_output="" action_output=""
    info_output="$(printf "%s\n" "$output" | awk 'BEGIN{mode=0} /^__INFO__$/ {mode=1; next} /^__ACTIONS__$/ {mode=0} mode {print}')"
    action_output="$(printf "%s\n" "$output" | awk 'BEGIN{mode=0} /^__ACTIONS__$/ {mode=1; next} mode {print}')"
    echo ""
    if [[ -n "$info_output" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && printf "  %s\n" "$line"
      done <<<"$info_output"
    fi
    if [[ "$status" -eq 10 ]]; then
      warn "Host preflight found issues that will prevent onboarding right now."
      if [[ -n "$action_output" ]]; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && printf "  %s\n" "$line"
        done <<<"$action_output"
      fi
    elif [[ -n "$action_output" ]]; then
      warn "Host preflight found warnings."
      while IFS= read -r line; do
        [[ -n "$line" ]] && printf "  %s\n" "$line"
      done <<<"$action_output"
    fi
  fi

  [[ "$status" -ne 10 ]]
}

run_onboard() {
  show_usage_notice
  info "Running nemoclaw onboard…"
  local -a onboard_cmd=(onboard)
  local session_file="${HOME}/.nemoclaw/onboard-session.json"
  # --fresh takes precedence over any session state. We forward --fresh to
  # `nemoclaw onboard` so the CLI clears the existing session file before
  # creating a new one — the install.sh classifier is bypassed entirely.
  if [ "${FRESH:-}" = "1" ]; then
    info "Starting a fresh onboarding session (--fresh)."
    onboard_cmd+=(--fresh)
  elif command_exists node && [[ -f "$session_file" ]]; then
    # Classify the session: "resume" (auto-attach --resume), "failed"
    # (last run reported a step failure — user must choose), "skip"
    # (complete / missing / unreadable — nothing to resume), or "corrupt".
    local session_state
    session_state="$(
      node -e '
        const fs = require("fs");
        let out = "skip";
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (!data || data.resumable === false || data.status === "complete") {
            out = "skip";
          } else if (data.status === "failed" || data.failure) {
            out = "failed";
          } else if (data.status === "in_progress") {
            out = "resume";
          } else {
            // Unknown or missing status — do not auto-resume a file we
            // cannot classify against what onboard-session.ts actually
            // writes (in_progress / failed / complete).
            out = "corrupt";
          }
        } catch {
          out = "corrupt";
        }
        process.stdout.write(out);
      ' "$session_file" 2>/dev/null || printf "corrupt"
    )"
    case "$session_state" in
      resume)
        info "Found an interrupted onboarding session — resuming it."
        onboard_cmd+=(--resume)
        ;;
      failed)
        # #2430: a previous run failed. The user's provider/inference
        # choice may be the cause, so auto-resuming would just loop.
        # Refuse in non-interactive mode (no safe default); prompt in
        # interactive mode so the user can pick resume vs. fresh.
        if [ "${NON_INTERACTIVE:-}" = "1" ]; then
          error "Previous onboarding session failed. Re-run with --fresh to discard it, or run 'nemoclaw onboard --resume' to retry the same session."
        fi
        local _prompt_stdin="/dev/tty"
        if [ -t 0 ]; then _prompt_stdin="/dev/stdin"; fi
        if [ ! -r "$_prompt_stdin" ]; then
          error "Previous onboarding session failed, and no TTY is available to prompt. Re-run with --fresh or run 'nemoclaw onboard --resume'."
        fi
        info "Previous onboarding session failed."
        local _resume_answer=""
        while :; do
          printf "  Resume the failed session, or start fresh? [R/f]: " >&2
          if ! IFS= read -r _resume_answer <"$_prompt_stdin"; then
            error "Could not read response from TTY. Re-run with --fresh or run 'nemoclaw onboard --resume'."
          fi
          case "${_resume_answer,,}" in
            "" | r | resume)
              onboard_cmd+=(--resume)
              break
              ;;
            f | fresh)
              onboard_cmd+=(--fresh)
              break
              ;;
            *) printf "  Please answer 'r' or 'f'.\n" >&2 ;;
          esac
        done
        ;;
      corrupt)
        warn "Onboarding session file is unreadable — ignoring and starting fresh."
        ;;
      skip | *) ;;
    esac
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    onboard_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      onboard_cmd+=(--yes-i-accept-third-party-software)
    fi
    nemoclaw "${onboard_cmd[@]}"
  elif [ -t 0 ]; then
    nemoclaw "${onboard_cmd[@]}"
  elif exec 3</dev/tty; then
    info "Installer stdin is piped; attaching onboarding to /dev/tty…"
    local status=0
    nemoclaw "${onboard_cmd[@]}" <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "Interactive onboarding requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
}

# 6. Post-install message (printed last — after onboarding — so PATH hints stay visible)
# ---------------------------------------------------------------------------
post_install_message() {
  if [[ "$NEMOCLAW_READY_NOW" == true ]]; then
    return 0
  fi

  if [[ -z "$NEMOCLAW_RECOVERY_EXPORT_DIR" ]]; then
    return 0
  fi

  if [[ -z "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
    NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
  fi

  echo ""
  echo "  ──────────────────────────────────────────────────"
  warn "Your current shell cannot resolve 'nemoclaw' yet."
  echo ""
  echo "  To use nemoclaw now, run:"
  echo ""
  echo "    export PATH=\"${NEMOCLAW_RECOVERY_EXPORT_DIR}:\$PATH\""
  echo "    source ${NEMOCLAW_RECOVERY_PROFILE}"
  echo ""
  echo "  Then run:"
  echo ""
  echo "    nemoclaw onboard"
  echo ""
  echo "  Or open a new terminal window after updating your shell profile."
  echo "  ──────────────────────────────────────────────────"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Parse flags
  NON_INTERACTIVE=""
  ACCEPT_THIRD_PARTY_SOFTWARE=""
  FRESH=""
  for arg in "$@"; do
    case "$arg" in
      --non-interactive) NON_INTERACTIVE=1 ;;
      --yes-i-accept-third-party-software) ACCEPT_THIRD_PARTY_SOFTWARE=1 ;;
      --fresh) FRESH=1 ;;
      --version | -v)
        local version_suffix
        version_suffix="$(installer_version_for_display)"
        printf "nemoclaw-installer%s\n" "${version_suffix# }"
        exit 0
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage
        error "Unknown option: $arg"
        ;;
    esac
  done
  # Also honor env var
  NON_INTERACTIVE="${NON_INTERACTIVE:-${NEMOCLAW_NON_INTERACTIVE:-}}"
  ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE:-${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}}"
  FRESH="${FRESH:-${NEMOCLAW_FRESH:-}}"
  export NEMOCLAW_NON_INTERACTIVE="${NON_INTERACTIVE}"
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE}"

  _INSTALL_START=$SECONDS
  print_banner
  bash "${SCRIPT_DIR}/setup-jetson.sh"

  # Recipe §1 / §6.2 — figure out which platform we're on so dependency lanes
  # and fixups can branch correctly. Done before any host mutation.
  detect_platform

  # ─── Step 1: Platform + Dependencies (Recipe §4) ───────────────────────
  step 1 "Platform & Dependencies"
  print_dependency_table "Dependency status (preview — pre-install)"
  resolve_docker
  install_nodejs
  ensure_supported_runtime
  resolve_openshell
  apply_platform_fixups

  # ─── Step 2: NemoClaw CLI (existing behavior) ─────────────────────────
  step 2 "NemoClaw CLI"
  fix_npm_permissions
  install_nemoclaw
  verify_nemoclaw

  # ─── Step 3: Backend selection (Recipe §6.1, MRD §2.3.4) ──────────────
  step 3 "Backend Selection"
  select_backend
  schedule_model_pull
  write_dependency_manifest

  # Pre-upgrade safety: back up all sandbox state before onboarding (which may
  # upgrade OpenShell). If the upgrade destroys sandbox contents, the backups
  # in ~/.nemoclaw/rebuild-backups/ let the user recover via `nemoclaw <name> rebuild`.
  # Check the registry file directly to avoid shelling out to nemoclaw (which
  # may be a stub in test environments).
  local _reg_file="${HOME}/.nemoclaw/sandboxes.json"
  if [ -f "$_reg_file" ] && command_exists nemoclaw && command_exists openshell; then
    local _has_sandboxes
    _has_sandboxes="$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(len(d.get('sandboxes', {})))
except Exception:
    print(0)
" "$_reg_file" 2>/dev/null || echo 0)"
    if [ "$_has_sandboxes" -gt 0 ]; then
      info "Backing up $_has_sandboxes sandbox(es) before upgrade…"
      nemoclaw backup-all 2>&1 || warn "Pre-upgrade backup failed (non-fatal). Continuing."
    fi
  fi

  # ─── Step 4: Onboarding (Recipe §6.3) ─────────────────────────────────
  step 4 "Onboarding"
  if command_exists nemoclaw; then
    if [[ -f "${HOME}/.nemoclaw/sandboxes.json" ]] && node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const count = Object.keys(data.sandboxes || {}).length;
        process.exit(count > 0 ? 0 : 1);
      } catch {
        process.exit(1);
      }
    ' "${HOME}/.nemoclaw/sandboxes.json"; then
      warn "Existing sandbox sessions detected. Onboarding may disrupt running agents."
      if [[ "${NEMOCLAW_SINGLE_SESSION:-}" == "1" ]]; then
        error "Aborting — NEMOCLAW_SINGLE_SESSION is set. Destroy existing sessions with 'nemoclaw <name> destroy' before reinstalling."
      fi
      warn "Consider destroying existing sessions with 'nemoclaw <name> destroy' first."
      warn "Set NEMOCLAW_SINGLE_SESSION=1 to abort the installer when sessions are active."
    fi
    if run_installer_host_preflight; then
      run_onboard
      ONBOARD_RAN=true
      # After onboard, check for stale sandboxes that need rebuilding (#1904).
      # Uses --auto so it runs non-interactively in piped/CI contexts.
      if [ "${_has_sandboxes:-0}" -gt 0 ] 2>/dev/null && command_exists nemoclaw; then
        info "Checking for sandboxes that need upgrading…"
        nemoclaw upgrade-sandboxes --auto 2>&1 || warn "Sandbox upgrade check failed (non-fatal)."
      fi
    else
      warn "Skipping onboarding until the host prerequisites above are fixed."
    fi
  else
    warn "Skipping onboarding — this shell still cannot resolve 'nemoclaw'."
  fi

  # ─── Step 5: Verification (Recipe §7) ─────────────────────────────────
  step 5 "Verification"
  print_dependency_table "Dependency status (post-install)"
  run_smoke_tests

  print_done
  post_install_message
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]] || { [[ -z "${BASH_SOURCE[0]:-}" ]] && { [[ "$0" == "bash" ]] || [[ "$0" == "-bash" ]]; }; }; then
  main "$@"
fi
