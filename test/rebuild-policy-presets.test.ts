// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sessionDistPath = require.resolve("../dist/lib/onboard-session");
const policiesDistPath = require.resolve("../dist/lib/policies");
const registryDistPath = require.resolve("../dist/lib/registry");
const originalHome = process.env.HOME;
let session: any;
let policies: any;
let registry: any;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-presets-"));
  process.env.HOME = tmpDir;
  delete require.cache[sessionDistPath];
  delete require.cache[policiesDistPath];
  delete require.cache[registryDistPath];
  session = require("../dist/lib/onboard-session");
  policies = require("../dist/lib/policies");
  registry = require("../dist/lib/registry");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  delete require.cache[sessionDistPath];
  delete require.cache[policiesDistPath];
  delete require.cache[registryDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

/**
 * These tests verify the preset-merge logic that sandboxRebuild() performs
 * before deleting the sandbox. The merge step reads applied presets from
 * the registry (via policies.getAppliedPresets) and merges them into the
 * onboard session so the resume path replays the full set.
 *
 * We exercise the merge inline rather than calling sandboxRebuild() directly,
 * because the function orchestrates sandbox lifecycle operations (openshell
 * calls, backup/restore) that require a live environment. The logic under
 * test is the session-update block added in the fix for #1952.
 */
describe("rebuild preserves policy presets added after onboard", () => {
  it("merges applied presets into session presets with deduplication", () => {
    // Simulate: onboard saved ["web-search"], user later ran `policy-add telegram`
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    // Registry has both the original and the manually added preset
    const appliedPresets = ["web-search", "telegram"];

    // --- This is the merge logic from sandboxRebuild() ---
    if (appliedPresets.length > 0) {
      session.updateSession((s) => {
        const sessionPresets = Array.isArray(s.policyPresets) ? s.policyPresets : [];
        s.policyPresets = [...new Set([...sessionPresets, ...appliedPresets])];
        return s;
      });
    }

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search", "telegram"]);
  });

  it("handles session with no prior policyPresets", () => {
    session.saveSession(session.createSession());
    // No policyPresets set in session (undefined/null)

    const appliedPresets = ["slack", "discord"];

    if (appliedPresets.length > 0) {
      session.updateSession((s) => {
        const sessionPresets = Array.isArray(s.policyPresets) ? s.policyPresets : [];
        s.policyPresets = [...new Set([...sessionPresets, ...appliedPresets])];
        return s;
      });
    }

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["slack", "discord"]);
  });

  it("skips update when no presets are applied", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    const appliedPresets = [];

    // The merge block is guarded by appliedPresets.length > 0
    if (appliedPresets.length > 0) {
      session.updateSession((s) => {
        const sessionPresets = Array.isArray(s.policyPresets) ? s.policyPresets : [];
        s.policyPresets = [...new Set([...sessionPresets, ...appliedPresets])];
        return s;
      });
    }

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search"]);
  });

  it("continues with session presets when getAppliedPresets throws (degraded sandbox)", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    // Simulate getAppliedPresets throwing (degraded sandbox)
    const getAppliedPresets = () => {
      throw new Error("sandbox not responding");
    };

    // --- This is the try/catch from sandboxRebuild() ---
    try {
      const appliedPresets = getAppliedPresets();
      if (appliedPresets.length > 0) {
        session.updateSession((s) => {
          const sessionPresets = Array.isArray(s.policyPresets) ? s.policyPresets : [];
          s.policyPresets = [...new Set([...sessionPresets, ...appliedPresets])];
          return s;
        });
      }
    } catch {
      // Fall back to whatever the session already has
    }

    // Session presets should be unchanged
    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search"]);
  });

  it("does not duplicate presets that exist in both session and applied", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search", "npm"];
      return s;
    });

    // Applied has overlap: web-search already in session, telegram is new
    const appliedPresets = ["web-search", "npm", "telegram"];

    if (appliedPresets.length > 0) {
      session.updateSession((s) => {
        const sessionPresets = Array.isArray(s.policyPresets) ? s.policyPresets : [];
        s.policyPresets = [...new Set([...sessionPresets, ...appliedPresets])];
        return s;
      });
    }

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search", "npm", "telegram"]);
  });
});
