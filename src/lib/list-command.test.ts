// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runListCommand } from "./list-command";

function makeExit(): (code: number) => never {
  return ((code: number) => {
    throw new Error(`EXIT:${code}`);
  }) as (code: number) => never;
}

describe("list command", () => {
  it("prints list usage via the oclif help flag without loading inventory", async () => {
    const recoverRegistryEntries = vi.fn(async () => ({ sandboxes: [], defaultSandbox: null }));
    const lines: string[] = [];

    await runListCommand(["--help"], {
      rootDir: process.cwd(),
      recoverRegistryEntries,
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
      error: vi.fn(),
      exit: makeExit(),
    });

    expect(lines).toEqual(["  Usage: nemoclaw list [--json]", ""]);
    expect(recoverRegistryEntries).not.toHaveBeenCalled();
  });

  it("renders JSON inventory through the oclif command adapter", async () => {
    const lines: string[] = [];

    await runListCommand(["--json"], {
      rootDir: process.cwd(),
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      getActiveSessionCount: () => 1,
      log: (message = "") => lines.push(message),
      error: vi.fn(),
      exit: makeExit(),
    });

    expect(JSON.parse(lines.join("\n"))).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
        },
      ],
    });
  });

  it("converts oclif parse errors into list-specific usage output", async () => {
    const errorLines: string[] = [];

    await expect(
      runListCommand(["--bogus"], {
        rootDir: process.cwd(),
        recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
        getLiveInference: () => null,
        loadLastSession: () => null,
        log: vi.fn(),
        error: (message = "") => errorLines.push(message),
        exit: makeExit(),
      }),
    ).rejects.toThrow("EXIT:1");

    expect(errorLines).toEqual([
      "  Unknown argument(s) for list: --bogus",
      "  Usage: nemoclaw list [--json]",
      "",
    ]);
  });
});
