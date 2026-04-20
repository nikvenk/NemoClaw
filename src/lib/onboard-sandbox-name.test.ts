// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { promptValidatedSandboxName } from "../../dist/lib/onboard-sandbox-name";

describe("promptValidatedSandboxName", () => {
  it("re-prompts in interactive mode until a valid non-reserved name is provided", async () => {
    const errorWriter = vi.fn();
    const answers = ["status", "9bad", "my-assistant"];
    const result = await promptValidatedSandboxName({
      promptOrDefault: async () => answers.shift() ?? "my-assistant",
      validateName: (value) => {
        if (/^[0-9]/.test(value)) {
          throw new Error("invalid sandbox name");
        }
        return value;
      },
      isNonInteractive: () => false,
      errorWriter,
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never,
    });

    expect(result).toBe("my-assistant");
    expect(errorWriter).toHaveBeenCalledWith(
      "  Reserved name: 'status' is a NemoClaw CLI command.",
    );
    expect(errorWriter).toHaveBeenCalledWith("  Names must start with a letter, not a digit.");
  });

  it("checks reserved names after validation canonicalizes the input", async () => {
    const errorWriter = vi.fn();
    const answers = ["Status", "my-assistant"];
    const result = await promptValidatedSandboxName({
      promptOrDefault: async () => answers.shift() ?? "my-assistant",
      validateName: (value) => value.toLowerCase(),
      isNonInteractive: () => false,
      errorWriter,
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never,
    });

    expect(result).toBe("my-assistant");
    expect(errorWriter).toHaveBeenCalledWith(
      "  Reserved name: 'status' is a NemoClaw CLI command.",
    );
  });

  it("exits immediately in non-interactive mode when the name is invalid", async () => {
    await expect(
      promptValidatedSandboxName({
        promptOrDefault: async () => "9bad",
        validateName: () => {
          throw new Error("invalid sandbox name");
        },
        isNonInteractive: () => true,
        errorWriter: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).rejects.toThrow("exit:1");
  });

  it("exits after too many invalid interactive attempts", async () => {
    const errorWriter = vi.fn();
    await expect(
      promptValidatedSandboxName({
        promptOrDefault: async () => "9bad",
        validateName: () => {
          throw new Error("invalid sandbox name");
        },
        isNonInteractive: () => false,
        errorWriter,
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).rejects.toThrow("exit:1");

    expect(errorWriter).toHaveBeenCalledWith("  Too many invalid attempts.");
  });
});
