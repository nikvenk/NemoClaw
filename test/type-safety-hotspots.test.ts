// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeTypeSafetyHotspots, renderTextReport } from "../scripts/type-safety-hotspots";

const tempDirs: string[] = [];

function makeProject(files: Record<string, string>): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-type-hotspots-"));
  tempDirs.push(rootDir);

  fs.writeFileSync(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }

  return rootDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("type-safety hotspots tool", () => {
  it("detects leading @ts-nocheck without false positives from string literals", () => {
    const rootDir = makeProject({
      "src/disabled.ts": `// @ts-nocheck
export function disabled(value) {
  return value?.flag;
}
`,
      "src/stringy.ts": `export const banner = "// @ts-nocheck";
`,
    });

    const report = analyzeTypeSafetyHotspots({
      rootDir,
      projectPaths: ["tsconfig.json"],
    });

    const disabled = report.files.find((file) => file.filePath === "src/disabled.ts");
    const stringy = report.files.find((file) => file.filePath === "src/stringy.ts");

    expect(disabled?.noCheck).toBe(true);
    expect(stringy?.noCheck).toBe(false);
    expect(disabled?.score).toBeGreaterThan(0);
  });

  it("ranks shared parse-boundary helpers as high-value typing targets", () => {
    const rootDir = makeProject({
      "src/config.ts": `export function normalizeConfig(raw: string) {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const metadata = ((parsed.metadata as Record<string, unknown>) || {}) as Record<string, unknown>;
  const labels = Array.isArray(parsed.labels)
    ? (parsed.labels as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  return {
    name: (parsed.name as string) || "default",
    enabled: parsed.enabled === true,
    owner: (metadata.owner as string) || null,
    labels,
  };
}
`,
      "src/use-a.ts": `import { normalizeConfig } from "./config";

export const configA = normalizeConfig("{}");
`,
      "src/use-b.ts": `import { normalizeConfig } from "./config";

export const configB = normalizeConfig("{}");
`,
      "src/other.ts": `export function identity(value: string): string {
  return value;
}
`,
    });

    const report = analyzeTypeSafetyHotspots({
      rootDir,
      projectPaths: ["tsconfig.json"],
    });

    const configFile = report.files.find((file) => file.filePath === "src/config.ts");
    const normalizeConfig = report.functions.find((fn) => fn.displayName === "normalizeConfig");
    const textReport = renderTextReport(report, {
      topFiles: 1,
      topFunctions: 1,
      minScore: 1,
    });

    expect(report.files[0]?.filePath).toBe("src/config.ts");
    expect(configFile?.fanIn).toBe(2);
    expect(configFile?.parserBoundaryCount).toBe(1);
    expect(configFile?.recordStringUnknownCount).toBeGreaterThanOrEqual(2);
    expect(normalizeConfig?.parserBoundaryCount).toBe(1);
    expect(normalizeConfig?.score).toBeGreaterThan(0);
    expect(report.themes.map((theme) => theme.id)).toContain("parse-boundaries");
    expect(textReport).toContain("src/config.ts");
    expect(textReport).toContain("normalizeConfig");
  });
});
