// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, mkdirSync } from "node:fs";

/**
 * Reject a path that is a symbolic link.
 *
 * Prevents symlink attacks where an attacker creates ~/.nemoclaw (or a
 * subdirectory) as a symlink to an attacker-controlled location before the
 * user first runs NemoClaw, causing credentials and state to be written
 * outside the intended directory.
 *
 * @throws if the path exists and is a symbolic link.
 */
function rejectSymlink(dirPath: string): void {
  try {
    const stat = lstatSync(dirPath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to use ${dirPath}: path is a symbolic link. ` +
          "This may indicate a symlink attack. Remove the symlink and retry.",
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Create a directory after verifying it is not a symlink.
 *
 * Drop-in replacement for `mkdirSync(path, { recursive: true })` that
 * checks the target path with `lstat()` before creating it.
 */
export function safeMkdirSync(dirPath: string, options?: { mode?: number }): void {
  rejectSymlink(dirPath);
  mkdirSync(dirPath, { recursive: true, ...options });
}
