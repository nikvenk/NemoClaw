// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentChoices, loadAgent, resolveAgentName } from "../../dist/lib/agent-defs";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_AGENT;
});

describe("agent definitions", () => {
  it("loads computed OpenClaw manifest properties", () => {
    const openclaw = loadAgent("openclaw");

    expect(openclaw.name).toBe("openclaw");
    expect(openclaw.displayName).toBe("OpenClaw");
    expect(openclaw.healthProbe.port).toBe(18789);
    expect(openclaw.forwardPort).toBe(18789);
    expect(openclaw.configPaths).toEqual({
      immutableDir: "/sandbox/.openclaw",
      writableDir: "/sandbox/.openclaw-data",
      configFile: "openclaw.json",
      envFile: null,
      format: "json",
    });
    expect(openclaw.messagingPlatforms).toEqual(["telegram", "discord", "slack"]);
    expect(openclaw.legacyPaths?.startScript).toContain("scripts/nemoclaw-start.sh");
  });

  it("loads Hermes manifest properties without falling back to OpenClaw defaults", () => {
    const hermes = loadAgent("hermes");

    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.hasDevicePairing).toBe(false);
    expect(hermes.configPaths).toEqual({
      immutableDir: "/sandbox/.hermes",
      writableDir: "/sandbox/.hermes-data",
      configFile: "config.yaml",
      envFile: ".env",
      format: "yaml",
    });
    expect(hermes.healthProbe.url).toBe("http://localhost:8642/health");
    expect(hermes.messagingPlatforms).toEqual(["telegram", "discord", "slack"]);
  });

  it("orders OpenClaw first in interactive choices", () => {
    const choices = getAgentChoices();
    expect(choices[0]?.name).toBe("openclaw");
    expect(choices.map((choice) => choice.name)).toContain("hermes");
  });

  it("falls back to openclaw when session references an unknown agent", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveAgentName({ session: { agent: "missing-agent" } })).toBe("openclaw");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("session references unknown agent 'missing-agent'"),
    );
  });
});
