// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { CONTAINER_NAME_PREFIX, OLLAMA_IMAGE, containerName } from "../bin/lib/ollama-container";

describe("ollama-container", () => {
  it("CONTAINER_NAME_PREFIX is nemoclaw-ollama", () => {
    expect(CONTAINER_NAME_PREFIX).toBe("nemoclaw-ollama");
  });

  it("OLLAMA_IMAGE is ollama/ollama", () => {
    expect(OLLAMA_IMAGE).toBe("ollama/ollama");
  });

  it("containerName returns prefixed name for a sandbox", () => {
    expect(containerName("my-sandbox")).toBe("nemoclaw-ollama-my-sandbox");
  });

  it("containerName returns default when sandbox name is undefined", () => {
    expect(containerName(undefined)).toBe("nemoclaw-ollama-default");
  });

  it("containerName returns default when sandbox name is empty string", () => {
    expect(containerName("")).toBe("nemoclaw-ollama-default");
  });

  it("containerName returns default when sandbox name is null", () => {
    expect(containerName(null)).toBe("nemoclaw-ollama-default");
  });
});
