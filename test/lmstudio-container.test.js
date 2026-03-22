// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { CONTAINER_NAME_PREFIX, LMSTUDIO_IMAGE, containerName, parseLmsList } from "../bin/lib/lmstudio-container";

describe("lmstudio-container", () => {
  it("CONTAINER_NAME_PREFIX is nemoclaw-lmstudio", () => {
    expect(CONTAINER_NAME_PREFIX).toBe("nemoclaw-lmstudio");
  });

  it("LMSTUDIO_IMAGE is lmstudio/llmster-preview", () => {
    expect(LMSTUDIO_IMAGE).toBe("lmstudio/llmster-preview");
  });

  it("containerName returns prefixed name for a sandbox", () => {
    expect(containerName("my-sandbox")).toBe("nemoclaw-lmstudio-my-sandbox");
  });

  it("containerName returns default when sandbox name is undefined", () => {
    expect(containerName(undefined)).toBe("nemoclaw-lmstudio-default");
  });

  it("containerName returns default when sandbox name is empty string", () => {
    expect(containerName("")).toBe("nemoclaw-lmstudio-default");
  });

  it("containerName returns default when sandbox name is null", () => {
    expect(containerName(null)).toBe("nemoclaw-lmstudio-default");
  });
});

describe("parseLmsList", () => {
  it("parses typical lms ls output with LLM section", () => {
    const output = [
      "LLM",
      "IDENTIFIER                          SIZE      QUANT",
      "---------------------------------------------------",
      "openreasoning-nemotron-7b           5.0 GB    q4_k_m",
      "nvidia-nemotron-3-nano-4b           2.8 GB    q4_k_m",
      "",
      "EMBEDDING",
      "IDENTIFIER                          SIZE      QUANT",
      "---------------------------------------------------",
      "nomic-embed-text-v1.5               0.3 GB    q8_0",
    ].join("\n");
    expect(parseLmsList(output)).toEqual(["openreasoning-nemotron-7b", "nvidia-nemotron-3-nano-4b"]);
  });

  it("returns empty array for empty output", () => {
    expect(parseLmsList("")).toEqual([]);
    expect(parseLmsList(null)).toEqual([]);
    expect(parseLmsList(undefined)).toEqual([]);
  });

  it("returns empty array when no LLM section exists", () => {
    expect(parseLmsList("EMBEDDING\nIDENTIFIER  SIZE\n---\nfoo  1 GB")).toEqual([]);
  });

  it("handles output with only LLM section (no EMBEDDING)", () => {
    expect(parseLmsList("LLM\nIDENTIFIER  SIZE\n---\nmy-model  1 GB")).toEqual(["my-model"]);
  });

  it("handles Windows-style line endings", () => {
    expect(parseLmsList("LLM\r\nIDENTIFIER  SIZE\r\n---\r\nmy-model  1 GB\r\n")).toEqual(["my-model"]);
  });
});
