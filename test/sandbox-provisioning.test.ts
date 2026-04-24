// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for sandbox image provisioning.
//
// Verifies that the image-build sources (Dockerfile and Dockerfile.base)
// preserve the mutable-by-default config layout (#2227) and the gateway
// auth token externalization (#2378).
//
// These are static regression guards over the Dockerfile text — they fail
// immediately if a future refactor drops one of the baked-in provisioning
// steps, even before a full image build runs in CI.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");

describe("sandbox provisioning: unified .openclaw layout (#2227)", () => {
  const src = fs.readFileSync(DOCKERFILE_BASE, "utf-8");

  it("Dockerfile.base creates exec-approvals.json directly in .openclaw (no symlink)", () => {
    expect(src).toMatch(/touch \/sandbox\/\.openclaw\/exec-approvals\.json/);
  });

  it("Dockerfile.base creates update-check.json directly in .openclaw (no symlink)", () => {
    expect(src).toMatch(/touch \/sandbox\/\.openclaw\/update-check\.json/);
  });

  it("Dockerfile.base does not create .openclaw-data directories (old split layout removed)", () => {
    // Comments may mention .openclaw-data for context; check for actual mkdir/touch/ln usage
    expect(src).not.toMatch(/mkdir.*\.openclaw-data/);
    expect(src).not.toMatch(/touch.*\.openclaw-data/);
    expect(src).not.toMatch(/ln -s.*\.openclaw-data/);
  });

  it("Dockerfile.base sets .openclaw to sandbox:sandbox ownership (mutable by default)", () => {
    expect(src).toMatch(/chown -R sandbox:sandbox \/sandbox\/\.openclaw/);
  });
});

describe("sandbox provisioning: gateway auth token externalization (#2378)", () => {
  const src = fs.readFileSync(DOCKERFILE, "utf-8");

  it("Dockerfile clears any auto-generated gateway auth token from openclaw.json", () => {
    // The real token is generated at container startup by generate_gateway_token()
    expect(src).toMatch(/\['token'\]\s*=\s*''/);
  });

  it("Dockerfile does NOT bake a persistent auth token into openclaw.json", () => {
    // Negative guard: the old pattern of writing a real token at build time
    // must not reappear. The token is runtime-only.
    expect(src).not.toMatch(/gateway_token.*=.*secrets\./);
  });
});
