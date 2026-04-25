// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { buildRecoveryScript } from "../../dist/lib/agent-runtime";
import type { AgentDefinition } from "./agent-defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  const gatewayArgv =
    overrides.gatewayArgv ?? overrides.gateway_argv ?? ["test-agent", "gateway", "run"];
  const gatewayCommand = overrides.gateway_command ?? gatewayArgv.join(" ");

  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: gatewayCommand,
    gateway_argv: gatewayArgv,
    gatewayArgv,
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/" },
    configPaths: {
      immutableDir: "/tmp/agent/immutable",
      writableDir: "/tmp/agent/writable",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    stateDirs: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const minimalAgent = makeAgent();

describe("buildRecoveryScript", () => {
  it("returns null for null agent (OpenClaw inline script handles it)", () => {
    expect(buildRecoveryScript(null, 18789)).toBeNull();
  });

  it("embeds the port in the gateway launch command (#1925)", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("--port 19000");
  });

  it("embeds the default port when called with default value", () => {
    const script = buildRecoveryScript(minimalAgent, 18789);
    expect(script).toContain("--port 18789");
  });

  it("launches the default gateway command through the validated agent binary", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("command -v test-agent");
    expect(script).toContain("%{http_code}");
    expect(script).toContain('nohup "$AGENT_BIN" gateway run --port 19000');
  });

  it("launches the default gateway argv when no raw gateway_command is present", () => {
    const agent = makeAgent({ gateway_command: undefined, gateway_argv: undefined, gatewayArgv: ["test-agent", "gateway", "run"] });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain('nohup "$AGENT_BIN" gateway run --port 19000');
  });

  it("validates and launches custom gateway argv explicitly", () => {
    const agent = makeAgent({
      gateway_command: undefined,
      gateway_argv: ["custom-launch", "--mode", "recovery"],
      gatewayArgv: ["custom-launch", "--mode", "recovery"],
    });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain("GATEWAY_CMD_BIN=custom-launch");
    expect(script).toContain('command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1');
    expect(script).toContain("nohup custom-launch --mode recovery --port 19000");
  });
});
