// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";
import {
  loadMemoryConfig,
  saveMemoryConfig,
  hasMemoryInstructions,
  injectMemoryInstructions,
  removeMemoryInstructions,
  MARKER_START,
  MARKER_END,
} from "./config.js";

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
  };
});

const WORKSPACE = "/sandbox/.openclaw/workspace";

function getOrThrow(key: string): string {
  const val = store.get(key);
  if (val === undefined) throw new Error(`expected file: ${key}`);
  return val;
}
const CONFIG_PATH = `${WORKSPACE}/.nemoclaw-memory.json`;
const AGENTS_PATH = `${WORKSPACE}/AGENTS.md`;

describe("memory/config", () => {
  beforeEach(() => {
    store.clear();
  });

  // -----------------------------------------------------------------------
  // loadMemoryConfig
  // -----------------------------------------------------------------------

  describe("loadMemoryConfig()", () => {
    it("returns default mode when no config file exists", () => {
      const config = loadMemoryConfig(WORKSPACE);
      expect(config.mode).toBe("default");
      expect(config.enabledAt).toBeUndefined();
    });

    it("reads typed-index mode from config file", () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index", enabledAt: "2026-04-10" }));
      const config = loadMemoryConfig(WORKSPACE);
      expect(config.mode).toBe("typed-index");
      expect(config.enabledAt).toBe("2026-04-10");
    });

    it("falls back to default for invalid JSON", () => {
      store.set(CONFIG_PATH, "not json");
      const config = loadMemoryConfig(WORKSPACE);
      expect(config.mode).toBe("default");
    });

    it("falls back to default for unknown mode", () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "unknown" }));
      const config = loadMemoryConfig(WORKSPACE);
      expect(config.mode).toBe("default");
    });
  });

  // -----------------------------------------------------------------------
  // saveMemoryConfig
  // -----------------------------------------------------------------------

  describe("saveMemoryConfig()", () => {
    it("writes config to file", () => {
      saveMemoryConfig({ mode: "typed-index", enabledAt: "2026-04-10" }, WORKSPACE);
      const written = store.get(CONFIG_PATH);
      if (written === undefined) throw new Error("expected file");
      const parsed = JSON.parse(written);
      expect(parsed.mode).toBe("typed-index");
      expect(parsed.enabledAt).toBe("2026-04-10");
    });

    it("round-trips with loadMemoryConfig", () => {
      saveMemoryConfig({ mode: "typed-index", enabledAt: "2026-04-10" }, WORKSPACE);
      const loaded = loadMemoryConfig(WORKSPACE);
      expect(loaded.mode).toBe("typed-index");
      expect(loaded.enabledAt).toBe("2026-04-10");
    });
  });

  // -----------------------------------------------------------------------
  // hasMemoryInstructions
  // -----------------------------------------------------------------------

  describe("hasMemoryInstructions()", () => {
    it("returns false when AGENTS.md does not exist", () => {
      expect(hasMemoryInstructions(WORKSPACE)).toBe(false);
    });

    it("returns false when AGENTS.md has no markers", () => {
      store.set(AGENTS_PATH, "# My Agents\n\nSome content.\n");
      expect(hasMemoryInstructions(WORKSPACE)).toBe(false);
    });

    it("returns true when both markers are present", () => {
      store.set(AGENTS_PATH, `# My Agents\n\n${MARKER_START}\nstuff\n${MARKER_END}\n`);
      expect(hasMemoryInstructions(WORKSPACE)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // injectMemoryInstructions
  // -----------------------------------------------------------------------

  describe("injectMemoryInstructions()", () => {
    it("creates AGENTS.md if it does not exist", () => {
      injectMemoryInstructions(WORKSPACE);
      expect(store.has(AGENTS_PATH)).toBe(true);
      const content = getOrThrow(AGENTS_PATH);
      expect(content).toContain(MARKER_START);
      expect(content).toContain(MARKER_END);
      expect(content).toContain("/nemoclaw memory read");
      expect(content).toContain("/nemoclaw memory search");
    });

    it("appends to existing AGENTS.md content", () => {
      store.set(AGENTS_PATH, "# My Agents\n\nExisting content.\n");
      injectMemoryInstructions(WORKSPACE);
      const content = getOrThrow(AGENTS_PATH);
      expect(content).toContain("# My Agents");
      expect(content).toContain("Existing content.");
      expect(content).toContain(MARKER_START);
    });

    it("is idempotent — does not double-inject", () => {
      injectMemoryInstructions(WORKSPACE);
      const first = getOrThrow(AGENTS_PATH);
      injectMemoryInstructions(WORKSPACE);
      const second = getOrThrow(AGENTS_PATH);
      expect(first).toBe(second);
    });
  });

  // -----------------------------------------------------------------------
  // removeMemoryInstructions
  // -----------------------------------------------------------------------

  describe("removeMemoryInstructions()", () => {
    it("is a no-op when AGENTS.md does not exist", () => {
      removeMemoryInstructions(WORKSPACE);
      expect(store.has(AGENTS_PATH)).toBe(false);
    });

    it("is a no-op when no markers present", () => {
      const original = "# My Agents\n\nContent.\n";
      store.set(AGENTS_PATH, original);
      removeMemoryInstructions(WORKSPACE);
      expect(store.get(AGENTS_PATH)).toBe(original);
    });

    it("removes the injected block", () => {
      store.set(AGENTS_PATH, "# My Agents\n\nExisting content.\n");
      injectMemoryInstructions(WORKSPACE);
      expect(hasMemoryInstructions(WORKSPACE)).toBe(true);

      removeMemoryInstructions(WORKSPACE);
      expect(hasMemoryInstructions(WORKSPACE)).toBe(false);

      const content = getOrThrow(AGENTS_PATH);
      expect(content).toContain("# My Agents");
      expect(content).toContain("Existing content.");
      expect(content).not.toContain(MARKER_START);
    });

    it("preserves content before and after the block", () => {
      store.set(AGENTS_PATH, `# Header\n\n${MARKER_START}\ninjected\n${MARKER_END}\n\n# Footer\n`);
      removeMemoryInstructions(WORKSPACE);
      const content = getOrThrow(AGENTS_PATH);
      expect(content).toContain("# Header");
      expect(content).toContain("# Footer");
      expect(content).not.toContain("injected");
    });
  });
});
