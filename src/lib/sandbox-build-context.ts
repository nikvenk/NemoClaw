// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

function createBuildContextDir(tmpDir = os.tmpdir()) {
  return fs.mkdtempSync(path.join(tmpDir, "nemoclaw-build-"));
}

function stageLegacySandboxBuildContext(rootDir, tmpDir = os.tmpdir()) {
  const buildCtx = createBuildContextDir(tmpDir);
  fs.copyFileSync(path.join(rootDir, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
  fs.cpSync(path.join(rootDir, "nemoclaw"), path.join(buildCtx, "nemoclaw"), { recursive: true });
  fs.cpSync(path.join(rootDir, "nemoclaw-blueprint"), path.join(buildCtx, "nemoclaw-blueprint"), {
    recursive: true,
  });
  fs.cpSync(path.join(rootDir, "scripts"), path.join(buildCtx, "scripts"), { recursive: true });
  fs.rmSync(path.join(buildCtx, "nemoclaw", "node_modules"), { recursive: true, force: true });
  return {
    buildCtx,
    stagedDockerfile: path.join(buildCtx, "Dockerfile"),
  };
}

function stageOptimizedSandboxBuildContext(rootDir, tmpDir = os.tmpdir()) {
  const buildCtx = createBuildContextDir(tmpDir);
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  const sourceNemoclawDir = path.join(rootDir, "nemoclaw");
  const stagedNemoclawDir = path.join(buildCtx, "nemoclaw");
  const sourceBlueprintDir = path.join(rootDir, "nemoclaw-blueprint");
  const stagedBlueprintDir = path.join(buildCtx, "nemoclaw-blueprint");
  const stagedScriptsDir = path.join(buildCtx, "scripts");

  fs.copyFileSync(path.join(rootDir, "Dockerfile"), stagedDockerfile);

  fs.mkdirSync(stagedNemoclawDir, { recursive: true });
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "openclaw.plugin.json",
  ]) {
    fs.copyFileSync(path.join(sourceNemoclawDir, file), path.join(stagedNemoclawDir, file));
  }
  fs.cpSync(path.join(sourceNemoclawDir, "src"), path.join(stagedNemoclawDir, "src"), {
    recursive: true,
  });

  fs.mkdirSync(stagedBlueprintDir, { recursive: true });
  fs.copyFileSync(
    path.join(sourceBlueprintDir, "blueprint.yaml"),
    path.join(stagedBlueprintDir, "blueprint.yaml"),
  );
  fs.cpSync(path.join(sourceBlueprintDir, "policies"), path.join(stagedBlueprintDir, "policies"), {
    recursive: true,
  });

  // Derive the scripts to stage directly from the Dockerfile so this function
  // never drifts out of sync with it.  Every `COPY scripts/<src> <dest>` line
  // (excluding multi-stage `--from=` copies) is extracted and the source path
  // is copied into the build context at the same relative location.
  const dockerfileContent = fs.readFileSync(stagedDockerfile, "utf8");
  const copyPattern = /^COPY(?:\s+--\w+[^\s]*)*\s+(scripts\/\S+)\s+\S/gm;
  let match;
  while ((match = copyPattern.exec(dockerfileContent)) !== null) {
    // Skip --from=<stage> copies — those are inter-stage, not host → context.
    if (/--from=/i.test(match[0])) continue;
    const relSrc = match[1]; // e.g. "scripts/nemoclaw-start.sh"
    const srcPath = path.join(rootDir, relSrc);
    const destPath = path.join(buildCtx, relSrc);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }

  return { buildCtx, stagedDockerfile };
}

function collectBuildContextStats(dir) {
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(entryPath).size;
      }
    }
  }

  walk(dir);
  return { fileCount, totalBytes };
}

export {
  collectBuildContextStats,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
};
