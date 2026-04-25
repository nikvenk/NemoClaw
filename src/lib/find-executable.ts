// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { accessSync, constants } from "node:fs";
import path from "node:path";

export interface FindExecutableOptions {
  env?: NodeJS.ProcessEnv;
  checkExecutable?: (filePath: string) => boolean;
}

function defaultCheckExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(commandName: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [commandName];
  }

  if (path.extname(commandName)) {
    return [commandName];
  }

  const pathext = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return [commandName, ...pathext.map((ext) => `${commandName}${ext.toLowerCase()}`)];
}

export function findExecutable(
  commandName: string,
  opts: FindExecutableOptions = {},
): string | null {
  if (!commandName || commandName.includes("\0")) {
    return null;
  }

  const env = opts.env ?? process.env;
  const checkExecutable = opts.checkExecutable ?? defaultCheckExecutable;

  if (path.isAbsolute(commandName) || commandName.includes("/") || commandName.includes("\\")) {
    const resolved = path.resolve(commandName);
    return checkExecutable(resolved) ? resolved : null;
  }

  const rawPath = env.PATH ?? "";
  const searchDirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const dir of searchDirs) {
    for (const candidateName of candidateNames(commandName, env)) {
      const candidatePath = path.resolve(dir, candidateName);
      if (checkExecutable(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

export function hasExecutable(commandName: string, opts: FindExecutableOptions = {}): boolean {
  return findExecutable(commandName, opts) !== null;
}
