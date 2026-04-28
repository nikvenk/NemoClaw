// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler for the /nemoclaw slash command (chat interface).
 *
 * Supports subcommands:
 *   /nemoclaw status   - show sandbox/blueprint/inference state
 *   /nemoclaw eject    - rollback to host installation
 *   /nemoclaw shields  - show shields status (read-only)
 *   /nemoclaw config   - show sandbox config (read-only, redacted)
 *   /nemoclaw          - show help
 */

import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from "../index.js";
import { loadState } from "../blueprint/state.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";
import { slashShieldsStatus } from "./shields-status.js";
import { slashConfigShow } from "./config-show.js";

export function handleSlashCommand(
  ctx: PluginCommandContext,
  _api: OpenClawPluginApi,
): PluginCommandResult {
  const subcommand = ctx.args?.trim().split(/\s+/)[0] ?? "";

  switch (subcommand) {
    case "status":
      return slashStatus();
    case "eject":
      return slashEject();
    case "onboard":
      return slashOnboard();
    case "shields":
      return slashShieldsStatus();
    case "config":
      return slashConfigShow();
    case "ollama":
      return slashOllamaStatus();
    default:
      return slashHelp();
  }
}

function slashHelp(): PluginCommandResult {
  return {
    text: [
      "**NemoClaw**",
      "",
      "Usage: `/nemoclaw <subcommand>`",
      "",
      "Subcommands:",
      "  `status`  - Show sandbox, blueprint, and inference state",
      "  `shields` - Show shields status (up/down, timeout, policy)",
      "  `config`  - Show sandbox configuration (credentials redacted)",
      "  `ollama`  - Show Ollama VRAM tuning status (read-only)",
      "  `eject`   - Show rollback instructions",
      "  `onboard` - Show onboarding status and instructions",
      "",
      "For full management use the NemoClaw CLI:",
      "  `nemoclaw <name> shields down|up|status`",
      "  `nemoclaw <name> config get`",
      "  `nemoclaw <name> status`",
      "  `nemoclaw <name> connect`",
      "  `nemoclaw <name> logs`",
      "  `nemoclaw <name> destroy`",
      "  `nemoclaw ollama status`",
    ].join("\n"),
  };
}

function slashOllamaStatus(): PluginCommandResult {
  const config = loadOnboardConfig();
  const tuning = config?.ollamaTuning;

  if (!tuning) {
    return {
      text: [
        "**Ollama VRAM Tuning**",
        "",
        "No overrides configured — using model defaults.",
        "",
        "Run `nemoclaw ollama optimize` to auto-tune for your GPU.",
        "Run `nemoclaw ollama status` for full details.",
      ].join("\n"),
    };
  }

  const lines = ["**Ollama VRAM Tuning**", ""];
  if (tuning.vramPercent !== undefined)
    lines.push(`  VRAM cap      ${String(tuning.vramPercent)}%`);
  if (tuning.numGpuLayers !== undefined)
    lines.push(
      `  num_gpu       ${tuning.numGpuLayers === -1 ? "all layers" : String(tuning.numGpuLayers)}`,
    );
  if (tuning.numCtx !== undefined) lines.push(`  num_ctx       ${String(tuning.numCtx)}`);
  if (tuning.numBatch !== undefined) lines.push(`  num_batch     ${String(tuning.numBatch)}`);
  if (tuning.flashAttention !== undefined)
    lines.push(`  flash_attn    ${tuning.flashAttention ? "on" : "off"}`);
  if (tuning.kvCacheType !== undefined) lines.push(`  kv_cache      ${tuning.kvCacheType}`);
  lines.push(`  applied_at    ${tuning.appliedAt}`);
  if (tuning.appliedFor) lines.push(`  applied_for   ${tuning.appliedFor}`);
  lines.push("");
  lines.push("Run `nemoclaw ollama status` for full GPU budget breakdown.");

  return { text: lines.join("\n") };
}

function slashStatus(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return {
      text: "**NemoClaw**: No operations performed yet. Run `nemoclaw onboard` to get started.",
    };
  }

  const lines = [
    "**NemoClaw Status**",
    "",
    `Last action: ${state.lastAction}`,
    `Blueprint: ${state.blueprintVersion ?? "unknown"}`,
    `Run ID: ${state.lastRunId ?? "none"}`,
    `Sandbox: ${state.sandboxName ?? "none"}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.migrationSnapshot) {
    lines.push("", `Rollback snapshot: ${state.migrationSnapshot}`);
  }

  if (state.lastRebuildAt) {
    lines.push("", `Last rebuild: ${state.lastRebuildAt}`);
    if (state.lastRebuildBackupPath) {
      lines.push(`Rebuild backup: ${state.lastRebuildBackupPath}`);
    }
  }

  return { text: lines.join("\n") };
}

function slashOnboard(): PluginCommandResult {
  const config = loadOnboardConfig();
  if (config) {
    return {
      text: [
        "**NemoClaw Onboard Status**",
        "",
        `Endpoint: ${describeOnboardEndpoint(config)}`,
        `Provider: ${describeOnboardProvider(config)}`,
        config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
        `Model: ${config.model}`,
        `Credential: $${config.credentialEnv}`,
        `Profile: ${config.profile}`,
        `Onboarded: ${config.onboardedAt}`,
        "",
        "To reconfigure, run: `nemoclaw onboard`",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    text: [
      "**NemoClaw Onboarding**",
      "",
      "No configuration found. Run the onboard command to set up inference:",
      "",
      "```",
      "nemoclaw onboard",
      "```",
    ].join("\n"),
  };
}

function slashEject(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return { text: "No NemoClaw deployment found. Nothing to eject from." };
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    return {
      text: "No migration snapshot found. Manual rollback required.",
    };
  }

  return {
    text: [
      "**Eject from NemoClaw**",
      "",
      "To rollback to your host OpenClaw installation, run:",
      "",
      "```",
      "nemoclaw <name> destroy",
      "```",
      "",
      `Snapshot: ${state.migrationSnapshot ?? state.hostBackupPath ?? "none"}`,
    ].join("\n"),
  };
}
