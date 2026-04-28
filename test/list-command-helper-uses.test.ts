// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = path.join(REPO_ROOT, "scripts", "list-command-helper-uses.ts");

type HelperMatch = {
  filePath: string;
  line: number;
  column: number;
  kind: "call" | "assign";
  name: string;
  expression: string;
  moduleSpecifier: string | null;
  runnerBound: boolean;
  arg0Kind: string | null;
  commandHead: string | null;
  snippet: string;
};

function makeFixture(prefix: string, files: Record<string, string>): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return rootDir;
}

function runScript(args: string[], cwd = REPO_ROOT): ReturnType<typeof spawnSync> {
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function parseJsonOutput(result: ReturnType<typeof spawnSync>): HelperMatch[] {
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout));
}

describe("list-command-helper-uses", () => {
  it("finds default-import runner helpers", () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.ts": "export default function run(cmd: readonly string[]) { return cmd; }\n",
      "src/app.ts": 'import run from "./runner";\nrun(["podman", "ps"]);\n',
    });

    const matches = parseJsonOutput(
      runScript(["--root", rootDir, "--json", path.join(rootDir, "src")]),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].moduleSpecifier).toBe("./runner");
    expect(matches[0].runnerBound).toBe(true);
    expect(matches[0].expression).toBe("run");
    expect(matches[0].commandHead).toBe("podman");
  });

  it('finds identifier calls bound from require("./runner")', () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.js": "module.exports = function run(cmd) { return cmd; };\n",
      "src/app.js": 'const run = require("./runner");\nrun(["docker", "ps"]);\n',
    });

    const matches = parseJsonOutput(
      runScript(["--root", rootDir, "--json", path.join(rootDir, "src")]),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].moduleSpecifier).toBe("./runner");
    expect(matches[0].runnerBound).toBe(true);
    expect(matches[0].expression).toBe("run");
    expect(matches[0].commandHead).toBe("docker");
  });

  it("documents grouped reporting options in help output", () => {
    const result = runScript(["--help"]);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain("--group-by-command");
    expect(String(result.stdout)).toContain("--exclude-tests");
  });
});
