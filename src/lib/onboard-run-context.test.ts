// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const contextDistPath = require.resolve("../../dist/lib/onboard-run-context");
const bootstrapDistPath = require.resolve("../../dist/lib/onboard-bootstrap");
const sessionDistPath = require.resolve("../../dist/lib/onboard-session");
const originalHome = process.env.HOME;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-run-context-"));
  process.env.HOME = tmpDir;
  delete require.cache[contextDistPath];
  delete require.cache[bootstrapDistPath];
  delete require.cache[sessionDistPath];
});

afterEach(() => {
  delete require.cache[contextDistPath];
  delete require.cache[bootstrapDistPath];
  delete require.cache[sessionDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("createOnboardRunContext", () => {
  it("keeps session access and step mutations synchronized", () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");
    const { createOnboardRunContext } = require("../../dist/lib/onboard-run-context");

    const initializedRun = initializeOnboardRun({
      resume: false,
      mode: "non-interactive",
      requestedFromDockerfile: "./Dockerfile.custom",
      requestedAgent: "hermes",
    });

    expect(initializedRun.ok).toBe(true);
    if (!initializedRun.ok) {
      throw new Error("expected onboarding initialization to succeed");
    }

    const context = createOnboardRunContext(initializedRun.value);
    expect(context.fromDockerfile).toBe(path.resolve("./Dockerfile.custom"));
    expect(context.session.mode).toBe("non-interactive");
    expect(context.session.agent).toBe("hermes");

    context.startStep("preflight");
    context.completeStep("preflight");
    context.completeStep("messaging", { messagingChannels: ["telegram"] });
    context.completeStep("sandbox", { sandboxName: "alpha" });

    expect(context.session.steps.preflight.status).toBe("complete");
    expect(context.session.messagingChannels).toEqual(["telegram"]);
    expect(context.session.sandboxName).toBe("alpha");
  });
});
