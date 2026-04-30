#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw interactive configurator — collects provider, API key, model,
# and Telegram settings, then runs nemoclaw onboard non-interactively.
# Run this after SSH-ing into a Brev instance set up with brev-setup-openai-telegram.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

header() { printf "\n${BOLD}${CYAN}%s${RESET}\n" "$1"; }
prompt() { printf "${GREEN}▶${RESET} $1"; }
note()   { printf "  ${YELLOW}%s${RESET}\n" "$1"; }

clear
printf "${BOLD}
  ╔══════════════════════════════════════════════════════════════╗
  ║          NemoClaw Configuration Wizard                       ║
  ╚══════════════════════════════════════════════════════════════╝${RESET}
"

# ── Step 1: Provider ──────────────────────────────────────────────────────────
header "Step 1 of 4 — Choose your inference provider"
echo ""
echo "  1) NVIDIA Endpoints  (Nemotron, GLM, GPT-OSS — cloud)"
echo "  2) OpenAI            (GPT-4o, GPT-4o-mini, etc.)"
echo "  3) Anthropic         (Claude Sonnet, Claude Haiku, etc.)"
echo "  4) Google Gemini     (Gemini 2.5 Pro, Gemini Flash, etc.)"
echo "  5) Other OpenAI-compatible endpoint  (vLLM, OpenRouter, etc.)"
echo ""
prompt "Enter number [1]: "
read -r PROVIDER_NUM
PROVIDER_NUM="${PROVIDER_NUM:-1}"

case "$PROVIDER_NUM" in
  1) PROVIDER="cloud"
     DEFAULT_MODEL="nvidia/nemotron-3-super-120b-a12b"
     KEY_NAME="NVIDIA_API_KEY"
     KEY_HINT="nvapi-... from build.nvidia.com/settings/api-keys" ;;
  2) PROVIDER="openai"
     DEFAULT_MODEL="gpt-4o"
     KEY_NAME="OPENAI_API_KEY"
     KEY_HINT="sk-... from platform.openai.com" ;;
  3) PROVIDER="anthropic"
     DEFAULT_MODEL="claude-sonnet-4-6"
     KEY_NAME="ANTHROPIC_API_KEY"
     KEY_HINT="sk-ant-... from console.anthropic.com" ;;
  4) PROVIDER="gemini"
     DEFAULT_MODEL="gemini-2.5-pro"
     KEY_NAME="GEMINI_API_KEY"
     KEY_HINT="From aistudio.google.com/app/apikey" ;;
  5) PROVIDER="compatible-endpoint"
     DEFAULT_MODEL=""
     KEY_NAME="COMPATIBLE_API_KEY"
     KEY_HINT="API key for your endpoint (leave blank if none required)" ;;
  *) echo "Invalid choice. Defaulting to NVIDIA Endpoints."
     PROVIDER="cloud"; DEFAULT_MODEL="nvidia/nemotron-3-super-120b-a12b"
     KEY_NAME="NVIDIA_API_KEY"; KEY_HINT="nvapi-... from build.nvidia.com" ;;
esac

# ── Step 2: API key (and endpoint URL for compatible) ─────────────────────────
header "Step 2 of 4 — API key"
note "$KEY_HINT"
echo ""

if [[ "$PROVIDER" == "compatible-endpoint" ]]; then
  prompt "Endpoint URL (e.g. http://172.17.0.1:8000/v1): "
  read -r NEMOCLAW_ENDPOINT_URL
  [[ -n "$NEMOCLAW_ENDPOINT_URL" ]] || { echo "Endpoint URL is required."; exit 1; }
  export NEMOCLAW_ENDPOINT_URL
fi

prompt "Enter your ${KEY_NAME} (input hidden): "
read -rs API_KEY_VALUE
echo ""

if [[ -z "$API_KEY_VALUE" && "$PROVIDER" != "compatible-endpoint" ]]; then
  echo "API key is required. Exiting."
  exit 1
fi

# ── Step 3: Model ─────────────────────────────────────────────────────────────
header "Step 3 of 4 — Model"
echo ""
prompt "Model ID [${DEFAULT_MODEL}]: "
read -r NEMOCLAW_MODEL
NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-$DEFAULT_MODEL}"
[[ -n "$NEMOCLAW_MODEL" ]] || { echo "Model ID is required. Exiting."; exit 1; }

# ── Step 4: Telegram ──────────────────────────────────────────────────────────
header "Step 4 of 4 — Telegram (optional)"
note "Get a bot token from @BotFather on Telegram. Leave blank to skip."
echo ""
prompt "Telegram bot token (leave blank to skip): "
read -rs TELEGRAM_BOT_TOKEN
echo ""

TELEGRAM_ALLOWED_IDS=""
if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
  note "Allowed user IDs restrict who can DM the bot. Leave blank to allow anyone."
  prompt "Allowed Telegram user IDs, comma-separated (leave blank for none): "
  read -r TELEGRAM_ALLOWED_IDS
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
printf "${BOLD}  ┌──────────────────────────────────────────────┐${RESET}\n"
printf "${BOLD}  │  Configuration Summary                       │${RESET}\n"
printf "${BOLD}  ├──────────────────────────────────────────────┤${RESET}\n"
printf "  │  Provider  : %-31s│\n" "$PROVIDER"
printf "  │  Model     : %-31s│\n" "$NEMOCLAW_MODEL"
[[ "$PROVIDER" == "compatible-endpoint" ]] && \
  printf "  │  Endpoint  : %-31s│\n" "${NEMOCLAW_ENDPOINT_URL:-}"
printf "  │  API key   : %-31s│\n" "${KEY_NAME} (set)"
if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
  printf "  │  Telegram  : %-31s│\n" "enabled"
  [[ -n "$TELEGRAM_ALLOWED_IDS" ]] && \
    printf "  │  Allowed   : %-31s│\n" "$TELEGRAM_ALLOWED_IDS"
else
  printf "  │  Telegram  : %-31s│\n" "disabled"
fi
printf "${BOLD}  └──────────────────────────────────────────────┘${RESET}\n"
echo ""
prompt "Start NemoClaw onboarding with these settings? [Y/n]: "
read -r CONFIRM
CONFIRM="${CONFIRM:-Y}"
if [[ "$CONFIRM" != "Y" && "$CONFIRM" != "y" ]]; then
  echo "Cancelled. Run nemoclaw-configure again to retry."
  exit 0
fi

# ── Export credentials and run non-interactive onboard ────────────────────────
echo ""
echo "Starting onboarding..."

export NEMOCLAW_PROVIDER="$PROVIDER"
export NEMOCLAW_MODEL
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
export TELEGRAM_ALLOWED_IDS="${TELEGRAM_ALLOWED_IDS:-}"

# Set the correct provider-specific credential env var and unset others
# to prevent onboard from trying to validate keys for the wrong provider.
unset NVIDIA_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY COMPATIBLE_API_KEY 2>/dev/null || true
case "$PROVIDER" in
  cloud)               export NVIDIA_API_KEY="$API_KEY_VALUE" ;;
  openai)              export OPENAI_API_KEY="$API_KEY_VALUE" ;;
  anthropic)           export ANTHROPIC_API_KEY="$API_KEY_VALUE" ;;
  gemini)              export GEMINI_API_KEY="$API_KEY_VALUE" ;;
  compatible-endpoint) export COMPATIBLE_API_KEY="${API_KEY_VALUE:-dummy}" ;;
esac

nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
