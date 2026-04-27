// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDockerExecScriptCommand, buildShellCommand } from "../../dist/lib/remote-script";

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

describe("buildDockerExecScriptCommand", () => {
  it("uses a login shell by default", () => {
    expect(
      buildDockerExecScriptCommand({
        containerName: "demo",
        commandArgs: ["echo", "hello"],
      }),
    ).toEqual(["docker", "exec", "demo", "sh", "-lc", "echo hello"]);
  });

  it("supports plain shell execution when login is disabled", () => {
    expect(
      buildDockerExecScriptCommand({
        containerName: "demo",
        commandArgs: ["echo", "hello"],
        login: false,
      }),
    ).toEqual(["docker", "exec", "demo", "sh", "-c", "echo hello"]);
  });
});
