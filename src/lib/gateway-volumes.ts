// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Docker volume discovery helpers for the OpenShell gateway.
 *
 * `docker volume ls --filter name=...` performs substring matching, so callers
 * must still filter by the exact expected prefix after parsing the output.
 */

export type GatewayVolumeCapture = (
  command: readonly string[],
  opts?: { ignoreError?: boolean },
) => string | null | undefined;

export function getGatewayDockerVolumePrefix(gatewayName: string): string {
  return `openshell-cluster-${gatewayName}`;
}

export function listGatewayDockerVolumes(
  gatewayName: string,
  runCaptureImpl: GatewayVolumeCapture,
): string[] {
  const prefix = getGatewayDockerVolumePrefix(gatewayName);
  return String(
    runCaptureImpl(
      ["docker", "volume", "ls", "-q", "--filter", `name=${prefix}`],
      { ignoreError: true },
    ) || "",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}
