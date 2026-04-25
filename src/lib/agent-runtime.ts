// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.ts when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

import * as registry from "./registry";
import { DASHBOARD_PORT } from "./ports";
import * as onboardSession from "./onboard-session";
import { loadAgent, type AgentDefinition } from "./agent-defs";
import { buildShellAssignment, formatShellToken, joinShellWords } from "./shell-quote";

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Returns the loaded agent definition for non-OpenClaw agents, or null.
 */
export function getSessionAgent(sandboxName?: string): AgentDefinition | null {
  try {
    if (sandboxName) {
      const sb = registry.getSandbox(sandboxName);
      if (sb?.agent && sb.agent !== "openclaw") {
        return loadAgent(sb.agent);
      }
      if (sb?.agent === "openclaw" || (sb && !sb.agent)) {
        return null;
      }
    }
    const session = onboardSession.loadSession();
    const name = session?.agent || "openclaw";
    if (name === "openclaw") return null;
    return loadAgent(name);
  } catch {
    return null;
  }
}

/**
 * Get the health probe URL for the agent.
 * Returns the agent's configured probe URL, or the OpenClaw default.
 */
export function getHealthProbeUrl(agent: AgentDefinition | null): string {
  if (!agent) return `http://127.0.0.1:${DASHBOARD_PORT}/health`;
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/health`;
}

/**
 * Build the recovery shell script for a non-OpenClaw agent.
 * Returns the script string, or null if agent is null (use existing inline
 * OpenClaw script instead).
 */
export function buildRecoveryScript(agent: AgentDefinition | null, port: number): string | null {
  if (!agent) return null;

  const probeUrl = getHealthProbeUrl(agent);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const binaryName = binaryPath.split("/").pop() ?? "openclaw";
  const defaultGatewayArgv = [binaryName, "gateway", "run"];
  const configuredGatewayArgv = agent.gatewayArgv;
  const usesValidatedBinary =
    configuredGatewayArgv.length === defaultGatewayArgv.length &&
    configuredGatewayArgv.every((value, index) => value === defaultGatewayArgv[index]);
  const customGatewayExecutable = configuredGatewayArgv[0] ?? binaryName;
  const validationSteps = usesValidatedBinary
    ? [
        `${buildShellAssignment("AGENT_BIN", binaryPath)}; if [ ! -x "$AGENT_BIN" ]; then AGENT_BIN="$(command -v ${formatShellToken(binaryName)})"; fi;`,
        'if [ -z "$AGENT_BIN" ]; then echo AGENT_MISSING; exit 1; fi;',
      ]
    : [
        `${buildShellAssignment("GATEWAY_CMD_BIN", customGatewayExecutable)};`,
        'case "$GATEWAY_CMD_BIN" in */*) [ -x "$GATEWAY_CMD_BIN" ] || { echo AGENT_MISSING; exit 1; } ;; *) command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1 || { echo AGENT_MISSING; exit 1; } ;; esac;',
      ];
  const launchCommand = usesValidatedBinary
    ? `nohup "$AGENT_BIN" ${joinShellWords(configuredGatewayArgv.slice(1))} --port ${port} > /tmp/gateway.log 2>&1 &`
    : `nohup ${joinShellWords(configuredGatewayArgv)} --port ${port} > /tmp/gateway.log 2>&1 &`;
  const isHermes = agent.name === "hermes";
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes-data; " : "";

  return [
    "[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null;",
    hermesHome,
    `HEALTH_CODE="$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${formatShellToken(probeUrl)} 2>/dev/null || echo 000)"; if [ "$HEALTH_CODE" = "200" ] || [ "$HEALTH_CODE" = "401" ]; then echo ALREADY_RUNNING; exit 0; fi;`,
    "rm -f /tmp/gateway.log;",
    "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
    ...validationSteps,
    launchCommand,
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
  ].join(" ");
}

/**
 * Get the display name for the current agent.
 */
export function getAgentDisplayName(agent: AgentDefinition | null): string {
  return agent ? agent.displayName : "OpenClaw";
}

/**
 * Get the gateway command for the current agent.
 */
export function getGatewayCommand(agent: AgentDefinition | null): string {
  return agent ? joinShellWords(agent.gatewayArgv) : "openclaw gateway run";
}
