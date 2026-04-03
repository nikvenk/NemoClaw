// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Safe config file I/O with EACCES error handling (#692, #606, #719).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Custom error for config permission problems. Carries the path and
 * a user-facing remediation message so callers can display it cleanly.
 */
export class ConfigPermissionError extends Error {
  code = "EACCES";
  configPath: string;
  remediation: string;

  constructor(message: string, configPath: string, cause?: Error) {
    const remediation = buildRemediation();
    super(`${message}\n\n${remediation}`);
    this.name = "ConfigPermissionError";
    this.configPath = configPath;
    this.remediation = remediation;
    if (cause) this.cause = cause;
  }
}

function buildRemediation(): string {
  const home = process.env.HOME || os.homedir();
  const nemoclawDir = path.join(home, ".nemoclaw");
  return [
    "  To fix, run one of:",
    "",
    `    sudo chown -R $(whoami) ${nemoclawDir}`,
    `    # or, if the directory was created by another user:`,
    `    sudo rm -rf ${nemoclawDir} && nemoclaw onboard`,
    "",
    "  This usually happens when NemoClaw was first run with sudo",
    "  or the config directory was created by a different user.",
  ].join("\n");
}

/**
 * Ensure a directory exists with mode 0o700. On EACCES, throws
 * ConfigPermissionError with remediation hints.
 */
export function ensureConfigDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Enforce 0o700 even if the directory already existed at a weaker mode.
    // Only tighten permissions — never loosen a more restrictive mode.
    const stat = fs.statSync(dir);
    if ((stat.mode & 0o777) !== 0o700 && (stat.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new ConfigPermissionError(`Cannot create config directory: ${dir}`, dir, err as Error);
    }
    throw err;
  }

  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new ConfigPermissionError(
        `Config directory exists but is not writable: ${dir}`,
        dir,
        err as Error,
      );
    }
    throw err;
  }
}

/**
 * Write a JSON config file atomically with mode 0o600.
 * Uses write-to-temp + rename to avoid partial writes on crash.
 */
export function writeConfigFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureConfigDir(dir);

  const content = JSON.stringify(data, null, 2);
  const tmpFile = filePath + ".tmp." + process.pid;

  try {
    fs.writeFileSync(tmpFile, content, { mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best effort cleanup */
    }
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new ConfigPermissionError(
        `Cannot write config file: ${filePath}`,
        filePath,
        err as Error,
      );
    }
    throw err;
  }
}

/**
 * Read and parse a JSON config file. Returns defaultValue on missing
 * or corrupt files. On EACCES, throws ConfigPermissionError.
 */
export function readConfigFile<T>(filePath: string, defaultValue: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      throw new ConfigPermissionError(
        `Cannot read config file: ${filePath}`,
        filePath,
        err as Error,
      );
    }
    // ENOENT (missing file) or corrupt JSON — return default
    if (code === "ENOENT") return defaultValue;
    // Corrupt JSON or other non-permission error — return default
  }
  return defaultValue;
}
