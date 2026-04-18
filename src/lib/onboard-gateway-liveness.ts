// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface GatewayLivenessDeps {
  run: (
    command: string | string[],
    options?: { ignoreError?: boolean; suppressOutput?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
}

/**
 * Probe whether the gateway Docker container is actually running.
 * openshell CLI metadata can be stale after a manual `docker rm`, so this
 * verifies the container is live before trusting a "healthy" reuse state.
 *
 * Returns "running" | "missing" | "unknown".
 * - "running"  — container exists and State.Running is true
 * - "missing"  — container was removed or exists but is stopped (not reusable)
 * - "unknown"  — any other failure (daemon down, timeout, etc.)
 *
 * Callers should only trigger stale-metadata cleanup on "missing", not on
 * "unknown", to avoid destroying a healthy gateway when Docker is temporarily
 * unavailable.  See #2020.
 */
export function verifyGatewayContainerRunning(
  gatewayName: string,
  deps: GatewayLivenessDeps,
): "running" | "missing" | "unknown" {
  const containerName = `openshell-cluster-${gatewayName}`;
  const result = deps.run(
    `docker inspect --type container --format '{{.State.Running}}' ${containerName}`,
    { ignoreError: true, suppressOutput: true },
  );
  if (result.status === 0 && String(result.stdout || "").trim() === "true") {
    return "running";
  }
  // Container exists but is stopped (exit 0, Running !== "true")
  if (result.status === 0) {
    return "missing";
  }
  const stderr = String(result.stderr || "");
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return "missing";
  }
  return "unknown";
}
