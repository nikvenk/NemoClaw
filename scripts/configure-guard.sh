#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# nemoclaw-configure-guard — shell function baked into .bashrc/.profile at
# Docker build time. Intercepts sandbox-side commands that would fail under
# Landlock read-only enforcement and shows actionable guidance instead of
# a cryptic Permission denied.
#
# Installed by the Dockerfile (not at runtime) because OpenShell ≥0.0.32
# applies Landlock BEFORE the container entrypoint starts, making
# /sandbox/.bashrc read-only by the time nemoclaw-start.sh runs.

# nemoclaw-configure-guard begin
openclaw() {
  case "$1" in
    configure)
      echo "Error: 'openclaw configure' cannot modify config inside the sandbox." >&2
      echo "The sandbox config is read-only (Landlock enforced) for security." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      echo "" >&2
      echo "This rebuilds the sandbox with your updated settings." >&2
      return 1
      ;;
    config)
      case "$2" in
        set | unset)
          echo "Error: 'openclaw config $2' cannot modify config inside the sandbox." >&2
          echo "The sandbox config is read-only (Landlock enforced) for security." >&2
          echo "" >&2
          echo "To change your configuration, exit the sandbox and run:" >&2
          echo "  nemoclaw onboard --resume" >&2
          echo "" >&2
          echo "This rebuilds the sandbox with your updated settings." >&2
          return 1
          ;;
      esac
      ;;
    channels)
      case "$2" in
        list | "" | -h | --help) ;;
        *)
          echo "Error: 'openclaw channels $2' cannot modify channels inside the sandbox." >&2
          echo "The sandbox config is read-only (Landlock enforced) for security." >&2
          echo "" >&2
          echo "To add or remove messaging channels, exit the sandbox and run:" >&2
          echo "  nemoclaw <sandbox> channels add <telegram|discord|slack>" >&2
          echo "  nemoclaw <sandbox> channels remove <telegram|discord|slack>" >&2
          echo "" >&2
          echo "These stage the change and rebuild the sandbox to apply it." >&2
          return 1
          ;;
      esac
      ;;
    agent)
      # Block --local inside sandbox — it bypasses gateway protections and can
      # crash the container's main process, bricking the sandbox. Ref: #1632, #2016
      local _arg
      for _arg in "$@"; do
        if [ "$_arg" = "--local" ]; then
          echo "Error: 'openclaw agent --local' is not supported inside NemoClaw sandboxes." >&2
          echo "The --local flag bypasses the gateway's security protections (secret scanning," >&2
          echo "network policy, inference auth) and can crash the sandbox." >&2
          echo "" >&2
          echo "Instead, run without --local to use the gateway's managed inference route:" >&2
          echo "  openclaw agent --agent main -m \"hello\"" >&2
          return 1
        fi
      done
      ;;
  esac
  command openclaw "$@"
}
# nemoclaw-configure-guard end
