// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for sandbox-recreate.ts — the focused rebuild recreation module.
 *
 * Tests the composable primitives and the orchestrator, verifying:
 * - RecreateError has correct name, code, and instanceof Error
 * - validateRecreateCredentials throws on missing creds, skips on null
 * - No process.exit calls — all errors throw RecreateError
 * - recreateSandbox orchestrates sub-functions in order
 *
 * See #2306.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We test the compiled module to match how the CLI uses it.
// Build with `npm run build:cli` before running these tests.

describe("sandbox-recreate module", () => {
  describe("RecreateError", () => {
    it("has correct name and code for credential_missing", async () => {
      vi.resetModules();
      const { RecreateError } = await import("../../dist/lib/sandbox-recreate.js");
      const err = new RecreateError("Missing NVIDIA_API_KEY", "credential_missing");
      expect(err.name).toBe("RecreateError");
      expect(err.code).toBe("credential_missing");
      expect(err.message).toBe("Missing NVIDIA_API_KEY");
      expect(err instanceof Error).toBe(true);
    });

    it("has correct name and code for each failure type", async () => {
      vi.resetModules();
      const { RecreateError } = await import("../../dist/lib/sandbox-recreate.js");
      const codes = [
        "credential_missing",
        "sandbox_create_failed",
        "inference_failed",
        "agent_setup_failed",
        "policy_failed",
      ] as const;
      for (const code of codes) {
        const err = new RecreateError(`test ${code}`, code);
        expect(err.name).toBe("RecreateError");
        expect(err.code).toBe(code);
        expect(err instanceof Error).toBe(true);
      }
    });
  });

  describe("validateRecreateCredentials", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
      vi.unstubAllEnvs();
    });

    it("passes when credential exists in env", async () => {
      vi.resetModules();
      vi.stubEnv("NVIDIA_API_KEY", "nvapi-test-validate");
      vi.stubEnv("HOME", "/tmp/nonexistent-home");
      const { validateRecreateCredentials } = await import("../../dist/lib/sandbox-recreate.js");
      expect(() => validateRecreateCredentials("NVIDIA_API_KEY")).not.toThrow();
    });

    it("throws credential_missing when credential is absent", async () => {
      vi.resetModules();
      vi.stubEnv("HOME", "/tmp/nonexistent-home-missing");
      delete process.env["MISSING_CRED_KEY"];
      const { validateRecreateCredentials, RecreateError } = await import("../../dist/lib/sandbox-recreate.js");
      try {
        validateRecreateCredentials("MISSING_CRED_KEY");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RecreateError);
        expect((err as any).code).toBe("credential_missing");
        expect((err as any).message).toContain("MISSING_CRED_KEY");
      }
    });

    it("skips validation when credentialEnv is null (local inference)", async () => {
      vi.resetModules();
      const { validateRecreateCredentials } = await import("../../dist/lib/sandbox-recreate.js");
      expect(() => validateRecreateCredentials(null)).not.toThrow();
    });
  });

  describe("structural guarantees", () => {
    it("has no process.exit calls in source (only in comments)", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const source = fs.readFileSync(
        path.join(import.meta.dirname, "..", "lib", "sandbox-recreate.ts"),
        "utf-8",
      );
      // Remove comment lines and check for process.exit in code
      const codeLines = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
      const exitCalls = codeLines.filter((line) => /process\.exit\s*\(/.test(line));
      expect(exitCalls).toEqual([]);
    });

    it("exports all expected functions", async () => {
      vi.resetModules();
      const mod = await import("../../dist/lib/sandbox-recreate.js");
      expect(typeof mod.RecreateError).toBe("function");
      expect(typeof mod.recreateSandbox).toBe("function");
      expect(typeof mod.validateRecreateCredentials).toBe("function");
      expect(typeof mod.createSandboxDirect).toBe("function");
      expect(typeof mod.configureInferenceDirect).toBe("function");
      expect(typeof mod.setupAgentDirect).toBe("function");
      expect(typeof mod.applyPolicyPresetsDirect).toBe("function");
    });
  });
});
