// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildShellCommand } from "../../dist/lib/remote-script";

describe("buildShellCommand", () => {
  it("supports multi-step shell scripts without mixing raw and argv command fields", () => {
    expect(
      buildShellCommand({
        steps: [
          { commandArgs: ["mkdir", "-p", "/tmp/demo"] },
          { commandArgs: ["cat"], stdoutRedirect: "/tmp/demo/file.txt" },
        ],
      }),
    ).toBe("mkdir -p /tmp/demo && cat > /tmp/demo/file.txt");
  });

  it("rejects mixing steps with the legacy single-command API", () => {
    expect(() =>
      buildShellCommand({
        steps: [{ commandArgs: ["echo", "hello"] }],
        commandArgs: ["printf", "{}"],
      }),
    ).toThrow(/either steps or a single command definition/);
  });

  it("rejects stdout redirects on raw shell step strings", () => {
    expect(() =>
      buildShellCommand({
        steps: [{ command: "echo hello", stdoutRedirect: "/tmp/out" }],
      }),
    ).toThrow(/cannot use stdoutRedirect/);
  });
});
