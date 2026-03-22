// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { SIDECARS, getSidecar, isSidecarProvider } from "../bin/lib/sidecar";

describe("sidecar dispatcher", () => {
  it("getSidecar returns ollama-k3s sidecar with all methods", () => {
    const sidecar = getSidecar("ollama-k3s");
    expect(sidecar).toBeTruthy();
    for (const fn of ["start", "waitForHealth", "pullModel", "hasModel", "listModels",
      "downloadModelAsync", "loadModel", "validateModel", "warmupModel", "stop",
      "isRunning", "getBaseUrl", "getProviderName", "getCredential", "containerName",
      "getApiModelId", "getPullArgs"]) {
      expect(typeof sidecar[fn]).toBe("function");
    }
  });

  it("getSidecar returns lmstudio-k3s sidecar", () => {
    const sidecar = getSidecar("lmstudio-k3s");
    expect(sidecar).toBeTruthy();
    expect(typeof sidecar.loadModel).toBe("function");
    expect(typeof sidecar.getApiModelId).toBe("function");
  });

  it("getSidecar returns null for unknown provider", () => {
    expect(getSidecar("nonexistent")).toBeNull();
    expect(getSidecar("ollama-local")).toBeNull();
  });

  it("isSidecarProvider returns true for sidecar keys", () => {
    expect(isSidecarProvider("ollama-k3s")).toBe(true);
    expect(isSidecarProvider("lmstudio-k3s")).toBe(true);
  });

  it("isSidecarProvider returns false for non-sidecar keys", () => {
    expect(isSidecarProvider("ollama-local")).toBe(false);
    expect(isSidecarProvider("cloud")).toBe(false);
    expect(isSidecarProvider("")).toBe(false);
  });
});

describe("ollama-k3s sidecar properties", () => {
  const sidecar = SIDECARS["ollama-k3s"];

  it("getProviderName returns ollama-k3s", () => {
    expect(sidecar.getProviderName()).toBe("ollama-k3s");
  });

  it("getCredential returns ollama", () => {
    expect(sidecar.getCredential()).toBe("ollama");
  });

  it("getApiModelId returns model unchanged", () => {
    expect(sidecar.getApiModelId("nemotron-3-nano:30b")).toBe("nemotron-3-nano:30b");
  });

  it("getPullArgs returns correct docker exec command", () => {
    expect(sidecar.getPullArgs("nemoclaw-ollama-default", "nemotron-3-nano:30b")).toEqual(
      ["docker", "exec", "nemoclaw-ollama-default", "ollama", "pull", "nemotron-3-nano:30b"]
    );
  });

  it("loadModel always returns true (auto-loads)", () => {
    expect(sidecar.loadModel()).toBe(true);
  });

  it("starterModels includes nemotron-3-nano:30b", () => {
    expect(sidecar.starterModels[0].model).toBe("nemotron-3-nano:30b");
  });
});

describe("lmstudio-k3s sidecar properties", () => {
  const sidecar = SIDECARS["lmstudio-k3s"];

  it("getProviderName returns lmstudio-k3s", () => {
    expect(sidecar.getProviderName()).toBe("lmstudio-k3s");
  });

  it("getApiModelId strips @quantization suffix", () => {
    expect(sidecar.getApiModelId("openreasoning-nemotron-7b@q4_k_m")).toBe("openreasoning-nemotron-7b");
  });

  it("getApiModelId returns model unchanged when no @", () => {
    expect(sidecar.getApiModelId("some-model")).toBe("some-model");
  });

  it("getPullArgs returns correct docker exec command with --yes", () => {
    expect(sidecar.getPullArgs("nemoclaw-lmstudio-default", "openreasoning-nemotron-7b@q4_k_m")).toEqual(
      ["docker", "exec", "nemoclaw-lmstudio-default", "lms", "get", "openreasoning-nemotron-7b@q4_k_m", "--yes"]
    );
  });

  it("starterModels includes openreasoning-nemotron", () => {
    expect(sidecar.starterModels[0].model).toMatch(/openreasoning-nemotron/);
  });
});
