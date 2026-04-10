// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Port allocation for multi-agent swarms.
 *
 * Each agent type declares a base port in its manifest (e.g., OpenClaw: 18789,
 * Hermes: 8642). Additional instances of the same type get base_port + index.
 * If a collision is detected against already-allocated ports, the allocator
 * falls back to the 19000-19999 dynamic range.
 */

const DYNAMIC_PORT_START = 19000;
const DYNAMIC_PORT_END = 19999;

// Reserved for the swarm bus sidecar.
export const SWARM_BUS_PORT = 19100;

/**
 * Allocate a port for an agent instance.
 *
 * @param basePort      The agent type's declared base port (from manifest).
 * @param instanceIndex Zero-based index of this instance within its type.
 * @param usedPorts     Set of ports already allocated in this sandbox.
 * @returns             An available port number.
 * @throws              If no port can be allocated (range exhausted).
 */
export function allocatePort(basePort: number, instanceIndex: number, usedPorts: Set<number>): number {
  const candidate = basePort + instanceIndex;
  if (!usedPorts.has(candidate) && candidate !== SWARM_BUS_PORT) {
    return candidate;
  }
  for (let p = DYNAMIC_PORT_START; p <= DYNAMIC_PORT_END; p++) {
    if (p === SWARM_BUS_PORT) continue;
    if (!usedPorts.has(p)) return p;
  }
  throw new Error(
    `Cannot allocate port for instance index ${instanceIndex}: ` +
      `base ${basePort} collides and dynamic range ${DYNAMIC_PORT_START}-${DYNAMIC_PORT_END} exhausted`,
  );
}

/**
 * Collect the set of ports already in use by agents in a sandbox.
 */
export function usedPortsFromInstances(instances: { port: number }[]): Set<number> {
  return new Set(instances.map((a) => a.port).filter((p) => p > 0));
}
