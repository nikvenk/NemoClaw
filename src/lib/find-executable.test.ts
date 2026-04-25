// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { findExecutable, hasExecutable } from "./find-executable";

describe("findExecutable", () => {
  it("returns an absolute path for PATH hits", () => {
    const expected = path.resolve("bin/openshell");
    const result = findExecutable("openshell", {
      env: { PATH: `bin${path.delimiter}/usr/bin` },
      checkExecutable: (filePath) => filePath === expected,
    });

    expect(result).toBe(expected);
  });

  it("returns null when the command is not present", () => {
    const result = findExecutable("openshell", {
      env: { PATH: `/nope${path.delimiter}/still-nope` },
      checkExecutable: () => false,
    });

    expect(result).toBeNull();
  });

  it("handles explicit paths without PATH lookup", () => {
    const expected = path.resolve("./tools/openshell");
    const result = findExecutable("./tools/openshell", {
      env: { PATH: "/usr/bin" },
      checkExecutable: (filePath) => filePath === expected,
    });

    expect(result).toBe(expected);
  });

  it("exposes boolean existence via hasExecutable", () => {
    const expected = path.resolve("bin/cloudflared");
    expect(
      hasExecutable("cloudflared", {
        env: { PATH: `bin${path.delimiter}/usr/bin` },
        checkExecutable: (filePath) => filePath === expected,
      }),
    ).toBe(true);
  });
});
