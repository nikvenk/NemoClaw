# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes sandbox image — Hermes Agent + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, config, startup script) on top of the
# pre-built Hermes base image. Mirrors the OpenClaw Dockerfile structure.

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest

FROM ${BASE_IMAGE}

# Harden: remove unnecessary build tools and network probes
RUN (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true) \
    && apt-get autoremove --purge -y \
    && rm -rf /var/lib/apt/lists/*

# Copy NemoClaw plugin for Hermes (Python-based)
COPY agents/hermes/plugin/ /opt/nemoclaw-hermes-plugin/

# Copy blueprint (shared infrastructure)
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Copy startup script
COPY agents/hermes/start.sh /usr/local/bin/nemoclaw-start
RUN chmod 755 /usr/local/bin/nemoclaw-start

# Build args for config that varies per deployment.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_PROVIDER_KEY=custom
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG CHAT_UI_URL=http://127.0.0.1:8642
ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=
ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=
ARG NEMOCLAW_BUILD_ID=default
# API server auth key — if empty, all requests allowed (local-only mode).
ARG NEMOCLAW_API_SERVER_KEY=
# Hermes gateway platforms to enable (comma-separated: telegram,discord,slack)
ARG NEMOCLAW_GATEWAY_PLATFORMS=

# Promote build-args to env vars for the config generation script.
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_MESSAGING_CHANNELS_B64=${NEMOCLAW_MESSAGING_CHANNELS_B64} \
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${NEMOCLAW_MESSAGING_ALLOWED_IDS_B64} \
    NEMOCLAW_API_SERVER_KEY=${NEMOCLAW_API_SERVER_KEY} \
    NEMOCLAW_GATEWAY_PLATFORMS=${NEMOCLAW_GATEWAY_PLATFORMS}

WORKDIR /sandbox
USER sandbox

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Generate Hermes config.yaml and .env from build args.
# config.yaml is immutable at runtime (Landlock read-only on /sandbox/.hermes).
# .env holds API key placeholders for OpenShell provider pipeline.
RUN python3 -c "\
import base64, json, os, secrets, yaml; \
model = os.environ['NEMOCLAW_MODEL']; \
base_url = os.environ['NEMOCLAW_INFERENCE_BASE_URL']; \
api_key = os.environ.get('NEMOCLAW_API_SERVER_KEY', ''); \
platforms_raw = os.environ.get('NEMOCLAW_GATEWAY_PLATFORMS', ''); \
msg_channels = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_MESSAGING_CHANNELS_B64', 'W10=') or 'W10=').decode('utf-8')); \
_allowed_ids = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_MESSAGING_ALLOWED_IDS_B64', 'e30=') or 'e30=').decode('utf-8')); \
config = { \
    '_config_version': 12, \
    'model': { \
        'default': model, \
        'provider': 'custom', \
        'base_url': base_url, \
    }, \
    'terminal': { \
        'backend': 'local', \
        'timeout': 180, \
    }, \
    'agent': { \
        'max_turns': 60, \
        'reasoning_effort': 'medium', \
    }, \
    'memory': { \
        'memory_enabled': True, \
        'user_profile_enabled': True, \
    }, \
    'skills': { \
        'creation_nudge_interval': 15, \
    }, \
    'display': { \
        'compact': False, \
        'tool_progress': 'all', \
    }, \
}; \
platforms_config = {}; \
_token_env = {'telegram': 'TELEGRAM_BOT_TOKEN', 'discord': 'DISCORD_BOT_TOKEN', 'slack': 'SLACK_BOT_TOKEN'}; \
for ch in msg_channels: \
    if ch in _token_env: \
        p_cfg = {'enabled': True, 'token': f'openshell:resolve:env:{_token_env[ch]}'}; \
        if ch in _allowed_ids and _allowed_ids[ch]: \
            p_cfg['allowed_users'] = ','.join(str(uid) for uid in _allowed_ids[ch]); \
        platforms_config[ch] = p_cfg; \
if platforms_config: \
    config['platforms'] = platforms_config; \
api_server_key = api_key or secrets.token_hex(32); \
config.setdefault('platforms', {})['api_server'] = { \
    'enabled': True, \
    'extra': { \
        'port': 8642, \
        'host': '127.0.0.1', \
        'key': api_server_key, \
    }, \
}; \
config_path = os.path.expanduser('~/.hermes/config.yaml'); \
with open(config_path, 'w') as f: \
    yaml.dump(config, f, default_flow_style=False, sort_keys=False); \
os.chmod(config_path, 0o600); \
env_lines = [ \
    f'API_SERVER_KEY={api_server_key}', \
    f'API_SERVER_PORT=8642', \
    f'API_SERVER_HOST=127.0.0.1', \
]; \
for ch in msg_channels: \
    if ch in _token_env: \
        env_lines.append(f'{_token_env[ch]}=openshell:resolve:env:{_token_env[ch]}'); \
env_path = os.path.expanduser('~/.hermes/.env'); \
with open(env_path, 'w') as f: \
    f.write('\\n'.join(env_lines) + '\\n'); \
os.chmod(env_path, 0o600)"

# Install NemoClaw plugin into Hermes
RUN mkdir -p /sandbox/.hermes-data/plugins/nemoclaw \
    && cp /opt/nemoclaw-hermes-plugin/* /sandbox/.hermes-data/plugins/nemoclaw/ \
    || true

# Write a default SOUL.md for the sandboxed agent
RUN printf '%s\n' \
    'You are a helpful AI assistant running inside an NVIDIA OpenShell sandbox.' \
    'Your inference is routed through NemoClaw. You have access to terminal,' \
    'file, and web tools. Be concise and helpful.' \
    > /sandbox/.hermes-data/memories/SOUL.md

# Lock .hermes via DAC: chown to root so sandbox user cannot modify config.
# Same pattern as OpenClaw — Landlock provides defense-in-depth.
# hadolint ignore=DL3002
USER root
RUN chown root:root /sandbox/.hermes \
    && rm -rf /root/.cache/pip /sandbox/.cache \
    && find /sandbox/.hermes -mindepth 1 -maxdepth 1 -exec chown -h root:root {} + \
    && chmod 755 /sandbox/.hermes \
    && chmod 444 /sandbox/.hermes/config.yaml \
    && chmod 444 /sandbox/.hermes/.env

# Pin config hash at build time for integrity verification at startup.
RUN sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env \
    > /sandbox/.hermes/.config-hash \
    && chmod 444 /sandbox/.hermes/.config-hash \
    && chown root:root /sandbox/.hermes/.config-hash

ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
