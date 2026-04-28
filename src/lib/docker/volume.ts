// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function dockerListVolumesByPrefix(
  prefix: string,
  opts: DockerCaptureOptions = {},
): string[] {
  const output = dockerCapture(["volume", "ls", "-q", "--filter", `name=${prefix}`], {
    ignoreError: true,
    ...opts,
  });
  return splitNonEmptyLines(output).filter((name) => name.startsWith(prefix));
}

export function dockerRemoveVolumes(names: readonly string[], opts: DockerRunOptions = {}) {
  if (names.length === 0) return null;
  return dockerRun(["volume", "rm", ...names], opts);
}

export function dockerRemoveVolumesByPrefix(
  prefix: string,
  opts: DockerRunOptions = {},
): string[] {
  const names = dockerListVolumesByPrefix(prefix);
  if (names.length === 0) return names;
  dockerRemoveVolumes(names, opts);
  return names;
}
