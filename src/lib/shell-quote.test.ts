// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildShellAssignment } from "../../dist/lib/shell-quote";

describe("buildShellAssignment", () => {
  it("renders safe environment variable assignments", () => {
    expect(buildShellAssignment("NEMOCLAW_SANDBOX_NAME", "alpha")).toBe(
      "NEMOCLAW_SANDBOX_NAME=alpha",
    );
  });

  it("rejects invalid assignment names", () => {
    expect(() => buildShellAssignment("1INVALID", "alpha")).toThrow(
      /Invalid shell assignment name/,
    );
    expect(() => buildShellAssignment("BAD-NAME", "alpha")).toThrow(
      /Invalid shell assignment name/,
    );
  });
});
