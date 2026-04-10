// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { allocatePort, usedPortsFromInstances, SWARM_BUS_PORT } from "../src/lib/swarm-ports";

describe("allocatePort", () => {
  it("returns base_port + index when no collision", () => {
    expect(allocatePort(18789, 0, new Set())).toBe(18789);
    expect(allocatePort(18789, 1, new Set([18789]))).toBe(18790);
    expect(allocatePort(18789, 2, new Set([18789, 18790]))).toBe(18791);
  });

  it("returns base_port for instance 0 with empty used set", () => {
    expect(allocatePort(8642, 0, new Set())).toBe(8642);
  });

  it("different agent types get their own base ports", () => {
    const used = new Set([18789]);
    expect(allocatePort(8642, 0, used)).toBe(8642);
  });

  it("falls back to dynamic range on collision", () => {
    const used = new Set([18789, 18790]);
    // Instance index 1 would give 18790 which is used
    expect(allocatePort(18789, 1, used)).toBe(19000);
  });

  it("skips swarm bus port in dynamic range", () => {
    const used = new Set<number>();
    // Fill 19000-19099 so the next candidate is 19100 (bus port), should skip to 19101
    for (let p = 19000; p < SWARM_BUS_PORT; p++) used.add(p);
    expect(allocatePort(18789, 0, used)).toBe(18789);

    // Now test dynamic fallback skipping bus port
    used.add(18789);
    expect(allocatePort(18789, 0, used)).toBe(SWARM_BUS_PORT + 1);
  });

  it("skips swarm bus port even when base + index equals it", () => {
    // Contrived: base 19099, index 1 = 19100 = bus port
    const used = new Set<number>();
    const port = allocatePort(19099, 1, used);
    expect(port).not.toBe(SWARM_BUS_PORT);
    expect(port).toBe(19000);
  });

  it("throws when dynamic range is exhausted", () => {
    const used = new Set<number>();
    // Exhaust the whole dynamic range
    for (let p = 19000; p <= 19999; p++) used.add(p);
    // Base port also used
    used.add(18789);
    expect(() => allocatePort(18789, 0, used)).toThrow(/Cannot allocate port/);
  });
});

describe("usedPortsFromInstances", () => {
  it("extracts ports from agent instances", () => {
    const instances = [{ port: 18789 }, { port: 18790 }, { port: 8642 }];
    expect(usedPortsFromInstances(instances)).toEqual(new Set([18789, 18790, 8642]));
  });

  it("filters out zero ports (legacy entries)", () => {
    const instances = [{ port: 0 }, { port: 18789 }];
    expect(usedPortsFromInstances(instances)).toEqual(new Set([18789]));
  });

  it("returns empty set for empty list", () => {
    expect(usedPortsFromInstances([])).toEqual(new Set());
  });
});
