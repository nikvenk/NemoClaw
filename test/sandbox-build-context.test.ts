// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectBuildContextStats,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../dist/lib/sandbox-build-context";

describe("sandbox build context staging", () => {
  it("staged build context includes every file referenced by COPY scripts/ in the Dockerfile", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const dockerfilePath = path.join(repoRoot, "Dockerfile");
    const dockerfileContent = fs.readFileSync(dockerfilePath, "utf8");

    // Extract source paths from every "COPY scripts/<path>" line in the Dockerfile.
    // Skips multi-source COPY forms and inter-stage --from= copies.
    const copyPattern = /^COPY(?:\s+--\w+[^\s]*)*\s+(scripts\/\S+)\s+\S/gm;
    const scriptSources: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = copyPattern.exec(dockerfileContent)) !== null) {
      // Skip --from=<stage> copies — those are inter-stage, not host → context.
      if (/--from=/i.test(match[0])) continue;
      scriptSources.push(match[1]);
    }

    expect(scriptSources.length, "expected at least one COPY scripts/ line in Dockerfile").toBeGreaterThan(0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-scripts-"));
    try {
      const { buildCtx } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      for (const src of scriptSources) {
        expect(
          fs.existsSync(path.join(buildCtx, src)),
          `"${src}" is referenced by a COPY in the Dockerfile but is missing from the staged build context — update stageOptimizedSandboxBuildContext in src/lib/sandbox-build-context.ts`,
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging excludes blueprint .venv and extra scripts while preserving required files", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-opt-"));

    try {
      const { buildCtx } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", "blueprint.yaml"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(buildCtx, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging is smaller than the legacy build context", { timeout: 30_000 }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-compare-"));

    try {
      const legacy = stageLegacySandboxBuildContext(repoRoot, tmpDir);
      const optimized = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      const legacyStats = collectBuildContextStats(legacy.buildCtx);
      const optimizedStats = collectBuildContextStats(optimized.buildCtx);

      expect(optimizedStats.fileCount).toBeLessThan(legacyStats.fileCount);
      expect(optimizedStats.totalBytes).toBeLessThan(legacyStats.totalBytes);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
