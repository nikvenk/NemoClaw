// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  parseOnboardArgs,
  runDeprecatedOnboardAliasCommand,
  runOnboardCommand,
} from "../../dist/lib/onboard-command";

describe("onboard command", () => {
  it("parses onboard flags", () => {
    expect(
      parseOnboardArgs(
        ["--non-interactive", "--resume", "--yes-i-accept-third-party-software"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        { env: {}, error: () => {}, exit: ((code: number) => { throw new Error(String(code)); }) as never },
      ),
    ).toEqual({
      nonInteractive: true,
      resume: true,
      acceptThirdPartySoftware: true,
    });
  });

  it("accepts the env-based third-party notice acknowledgement", () => {
    expect(
      parseOnboardArgs(
        [],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
          error: () => {},
          exit: ((code: number) => {
            throw new Error(String(code));
          }) as never,
        },
      ),
    ).toEqual({
      nonInteractive: false,
      resume: false,
      acceptThirdPartySoftware: true,
    });
  });

  it("runs onboard with parsed options", async () => {
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      args: ["--resume"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      error: () => {},
      exit: ((code: number) => {
        throw new Error(String(code));
      }) as never,
    });
    expect(runOnboard).toHaveBeenCalledWith({
      nonInteractive: false,
      resume: true,
      acceptThirdPartySoftware: false,
    });
  });

  it("prints the setup-spark deprecation text before delegating", async () => {
    const lines: string[] = [];
    const runOnboard = vi.fn(async () => {});
    await runDeprecatedOnboardAliasCommand({
      kind: "setup-spark",
      args: [],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      log: (message = "") => lines.push(message),
      error: () => {},
      exit: ((code: number) => {
        throw new Error(String(code));
      }) as never,
    });
    expect(lines.join("\n")).toContain("setup-spark` is deprecated");
    expect(lines.join("\n")).toContain("Use `nemoclaw onboard` instead");
  });
});
