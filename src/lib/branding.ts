// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Central agent branding — maps the active agent to CLI name, display name,
 * and product name so every user-visible string can stay agent-neutral.
 *
 * Both `nemoclaw` and `nemohermes` are thin alias launchers that set
 * `NEMOCLAW_AGENT` before requiring the compiled CLI.  This module reads
 * that env var (and argv) once at startup and exports frozen constants
 * consumed by the rest of the CLI.
 */

interface AgentBranding {
  /** Binary name shown in usage strings, e.g. "nemoclaw" or "nemohermes". */
  cli: string;
  /** Title-case display name, e.g. "NemoClaw" or "NemoHermes". */
  display: string;
  /** The agent product name shown in messages, e.g. "OpenClaw" or "Hermes". */
  product: string;
}

const AGENT_BRANDING: Record<string, AgentBranding> = {
  openclaw: { cli: "nemoclaw", display: "NemoClaw", product: "OpenClaw" },
  hermes: { cli: "nemohermes", display: "NemoHermes", product: "Hermes" },
};

const DEFAULT_AGENT = "openclaw";

const agentName = process.env.NEMOCLAW_AGENT || DEFAULT_AGENT;
const branding = AGENT_BRANDING[agentName] ?? AGENT_BRANDING[DEFAULT_AGENT];

/** CLI binary name for usage strings — "nemoclaw" or "nemohermes". */
export const CLI_NAME: string = branding.cli;

/** Title-case display name for headers — "NemoClaw" or "NemoHermes". */
export const CLI_DISPLAY_NAME: string = branding.display;

/** Agent product name for user-facing messages — "OpenClaw" or "Hermes". */
export const AGENT_PRODUCT_NAME: string = branding.product;
