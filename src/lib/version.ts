// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// runner.ts still uses CommonJS-style exports — use require here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runCapture } = require("./runner");

type PackageInfo = { version?: string };

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function isPackageInfo(value: PackageInfo | null): value is { version: string } {
  return typeof value?.version === "string";
}

export interface VersionOptions {
  /** Override the repo root directory. */
  rootDir?: string;
}

/**
 * Resolve the NemoClaw version from (in order):
 *   1. `git describe --tags --match "v*"` — works in dev / source checkouts
 *   2. `.version` file at repo root       — stamped at publish time
 *   3. `package.json` version             — hard-coded fallback
 */
export function getVersion(opts: VersionOptions = {}): string {
  // Compiled location: dist/lib/version.js → repo root is 2 levels up
  const root = opts.rootDir ?? join(__dirname, "..", "..");

  // 1. Try git (available in dev clones and CI)
  const gitDescribe = runCapture(["git", "describe", "--tags", "--match", "v*"], {
    cwd: root,
    ignoreError: true,
  });
  if (gitDescribe) return gitDescribe.replace(/^v/, "");

  // 2. Try .version file (stamped by prepublishOnly)
  const versionFile = join(root, ".version");
  if (existsSync(versionFile)) {
    const ver = readFileSync(versionFile, "utf-8").trim();
    if (ver) return ver;
  }

  // 3. Fallback to package.json
  const raw = readFileSync(join(root, "package.json"), "utf-8");
  const pkg = parseJson<PackageInfo>(raw);
  if (!isPackageInfo(pkg)) {
    throw new Error(`package.json at ${root} is missing a string version field`);
  }
  return pkg.version;
}
