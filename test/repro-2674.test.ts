// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for issue #2674:
 *   `nemoclaw onboard` hangs at "[3/8] Configuring inference (NIM)" when a
 *   local Ollama or vLLM port is half-open or has a stalled listener.  The
 *   detection probes shelled out to `curl -sf <localhost-url>` with no
 *   timeout, so spawnSync waited forever.  Ensure the probes always pass
 *   --connect-timeout/--max-time so a misbehaving local listener cannot
 *   block onboarding.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const onboardSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
  "utf-8",
);

describe("Issue #2674: local inference detection must not hang", () => {
  it("declares bounded curl args for the local-probe block", () => {
    const block = onboardSrc.match(
      /localProbeCurlArgs\s*=\s*\[\s*"--connect-timeout"\s*,\s*"\d+"\s*,\s*"--max-time"\s*,\s*"\d+"\s*\]/,
    );
    expect(block, "expected localProbeCurlArgs with --connect-timeout/--max-time").not.toBeNull();
  });

  it("applies the bounded args to the Ollama detection probe", () => {
    expect(onboardSrc).toMatch(
      /runCapture\(\s*\[\s*"curl"\s*,\s*"-sf"\s*,\s*\.\.\.localProbeCurlArgs\s*,\s*`http:\/\/127\.0\.0\.1:\$\{OLLAMA_PORT\}\/api\/tags`/,
    );
  });

  it("applies the bounded args to the vLLM detection probe", () => {
    expect(onboardSrc).toMatch(
      /runCapture\(\s*\[\s*"curl"\s*,\s*"-sf"\s*,\s*\.\.\.localProbeCurlArgs\s*,\s*`http:\/\/127\.0\.0\.1:\$\{VLLM_PORT\}\/v1\/models`/,
    );
  });
});
