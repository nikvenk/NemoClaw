// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import { homedir } from "node:os";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
  saveOnboardConfig,
  clearOnboardConfig,
  type NemoClawOnboardConfig,
  type EndpointType,
  type OllamaTuning,
} from "./config.js";

// Mock node:fs so tests don't touch the real filesystem.
// The config module uses: existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync.
const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn(),
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
    unlinkSync: (p: string) => {
      store.delete(p);
    },
  };
});

function makeConfig(overrides: Partial<NemoClawOnboardConfig> = {}): NemoClawOnboardConfig {
  return {
    endpointType: "build",
    endpointUrl: "https://api.build.nvidia.com/v1",
    ncpPartner: null,
    model: "nvidia/nemotron-3-super-120b-a12b",
    profile: "default",
    credentialEnv: "NVIDIA_API_KEY",
    onboardedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("onboard/config", () => {
  beforeEach(() => {
    store.clear();
  });

  // -------------------------------------------------------------------------
  // describeOnboardEndpoint
  // -------------------------------------------------------------------------

  describe("describeOnboardEndpoint", () => {
    it("returns managed route description for inference.local", () => {
      const config = makeConfig({ endpointUrl: "https://inference.local/v1" });
      expect(describeOnboardEndpoint(config)).toBe("Managed Inference Route (inference.local)");
    });

    it("returns type and URL for other endpoints", () => {
      const config = makeConfig({
        endpointType: "ollama",
        endpointUrl: "http://localhost:11434/v1",
      });
      expect(describeOnboardEndpoint(config)).toBe("ollama (http://localhost:11434/v1)");
    });

    it("redacts credentials from endpoint URLs", () => {
      const config = makeConfig({
        endpointType: "custom",
        endpointUrl: "https://user:secret@api.example.com/v1?token=abc123",
      });
      const result = describeOnboardEndpoint(config);
      expect(result).not.toContain("secret");
      expect(result).not.toContain("abc123");
      expect(result).toContain("api.example.com");
      expect(result).toContain("****");
    });

    it("handles non-URL endpoint strings gracefully", () => {
      const config = makeConfig({
        endpointType: "local",
        endpointUrl: "not-a-url",
      });
      expect(describeOnboardEndpoint(config)).toBe("local (not-a-url)");
    });
  });

  // -------------------------------------------------------------------------
  // describeOnboardProvider
  // -------------------------------------------------------------------------

  describe("describeOnboardProvider", () => {
    it("returns providerLabel when set", () => {
      const config = makeConfig({ providerLabel: "My Custom Provider" });
      expect(describeOnboardProvider(config)).toBe("My Custom Provider");
    });

    const endpointCases: [EndpointType, string][] = [
      ["build", "NVIDIA Endpoints"],
      ["openai", "OpenAI"],
      ["anthropic", "Anthropic"],
      ["gemini", "Google Gemini"],
      ["ollama", "Local Ollama"],
      ["vllm", "Local vLLM"],
      ["nim-local", "Local NVIDIA NIM"],
      ["ncp", "NVIDIA Cloud Partner"],
      ["custom", "Other OpenAI-compatible endpoint"],
    ];

    for (const [endpointType, expected] of endpointCases) {
      it(`returns "${expected}" for endpoint type "${endpointType}"`, () => {
        const config = makeConfig({ endpointType, providerLabel: undefined });
        expect(describeOnboardProvider(config)).toBe(expected);
      });
    }

    it("returns Unknown for unsupported endpoint types", () => {
      const config = makeConfig({
        endpointType: "build",
        providerLabel: undefined,
      });
      expect(describeOnboardProvider({ ...config, endpointType: "bogus" as EndpointType })).toBe(
        "Unknown",
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadOnboardConfig / saveOnboardConfig / clearOnboardConfig
  // -------------------------------------------------------------------------

  describe("loadOnboardConfig", () => {
    it("returns null when no config file exists", () => {
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns parsed config when file exists", () => {
      const config = makeConfig();
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      store.set(configPath, JSON.stringify(config));
      expect(loadOnboardConfig()).toEqual(config);
    });

    it("returns null when the parsed JSON root is not a valid onboard config", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      store.set(configPath, JSON.stringify({ endpointType: "bogus" }));
      expect(loadOnboardConfig()).toBeNull();
    });
  });

  describe("saveOnboardConfig", () => {
    it("writes config and can be loaded back", () => {
      const config = makeConfig({ model: "nvidia/test-model" });
      saveOnboardConfig(config);
      const loaded = loadOnboardConfig();
      expect(loaded).toEqual(config);
    });
  });

  describe("clearOnboardConfig", () => {
    it("removes existing config file", () => {
      const config = makeConfig();
      saveOnboardConfig(config);
      expect(loadOnboardConfig()).not.toBeNull();
      clearOnboardConfig();
      expect(loadOnboardConfig()).toBeNull();
    });

    it("does not throw when no config file exists", () => {
      expect(() => {
        clearOnboardConfig();
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // OllamaTuning round-trip and validation
  // -------------------------------------------------------------------------

  describe("OllamaTuning", () => {
    it("round-trips a full OllamaTuning block", () => {
      const tuning: OllamaTuning = {
        vramPercent: 80,
        numGpuLayers: -1,
        numCtx: 32768,
        numBatch: 512,
        flashAttention: true,
        kvCacheType: "q8_0",
        appliedAt: "2026-04-27T00:00:00.000Z",
        appliedFor: "gemma4:e4b",
      };
      const config = makeConfig({ ollamaTuning: tuning });
      saveOnboardConfig(config);
      const loaded = loadOnboardConfig();
      expect(loaded?.ollamaTuning).toEqual(tuning);
    });

    it("round-trips with ollamaTuning absent", () => {
      const config = makeConfig();
      saveOnboardConfig(config);
      const loaded = loadOnboardConfig();
      expect(loaded?.ollamaTuning).toBeUndefined();
    });

    it("rejects vramPercent > 100", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { vramPercent: 200, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("rejects vramPercent < 1", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { vramPercent: 0, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("rejects kvCacheType with unknown value", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { kvCacheType: "garbage", appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("rejects numCtx: 0", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { numCtx: 0, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("rejects numBatch: 0", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { numBatch: 0, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("rejects numGpuLayers < -1", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { numGpuLayers: -2, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("accepts numGpuLayers: -1 (all layers sentinel)", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = {
        ...makeConfig(),
        ollamaTuning: { numGpuLayers: -1, appliedAt: "2026-04-27T00:00:00.000Z" },
      };
      store.set(configPath, JSON.stringify(raw));
      const loaded = loadOnboardConfig();
      expect(loaded?.ollamaTuning?.numGpuLayers).toBe(-1);
    });

    it("rejects ollamaTuning missing required appliedAt", () => {
      const configPath = `${homedir()}/.nemoclaw/config.json`;
      const raw = { ...makeConfig(), ollamaTuning: { vramPercent: 80 } };
      store.set(configPath, JSON.stringify(raw));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("accepts all valid kvCacheType values", () => {
      for (const kv of ["f16", "q8_0", "q4_0"] as const) {
        const configPath = `${homedir()}/.nemoclaw/config.json`;
        const raw = {
          ...makeConfig(),
          ollamaTuning: { kvCacheType: kv, appliedAt: "2026-04-27T00:00:00.000Z" },
        };
        store.set(configPath, JSON.stringify(raw));
        const loaded = loadOnboardConfig();
        expect(loaded?.ollamaTuning?.kvCacheType).toBe(kv);
        store.clear();
      }
    });
  });
});
