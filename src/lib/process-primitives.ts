// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";

export function spawnChild(command: string, args: string[], options: SpawnOptions) {
  return spawn(command, args, options);
}

export function spawnResult(
  command: string,
  args: string[],
  options: SpawnSyncOptions | SpawnSyncOptionsWithStringEncoding = {},
) {
  return spawnSync(command, args, options);
}
