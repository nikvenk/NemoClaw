// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runOnboard(spec: {
  opts: Record<string, unknown>;
  envOverrides?: Record<string, string | undefined>;
}): RunResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-name-"));
  const scriptPath = path.join(tmpDir, "run.js");
  const optsLiteral = JSON.stringify(spec.opts);

  const script = String.raw`
const onboard = require(${onboardPath});
onboard.onboard(${optsLiteral}).catch((error) => {
  console.error("UNEXPECTED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
});
`;
  fs.writeFileSync(scriptPath, script);

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: tmpDir,
    ...(spec.envOverrides ?? {}),
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete env[key];
    }
  }

  const out = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    timeout: 15000,
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    exitCode: typeof out.status === "number" ? out.status : -1,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

describe("onboard --name guards", () => {
  it("rejects --from without --name in a non-TTY context even without --non-interactive", () => {
    // The issue's test plan asks for `nemoclaw onboard --from <Dockerfile>`
    // in a non-TTY context (e.g. CI scripts, piped stdin) to error cleanly
    // rather than block on a prompt that can never be answered. spawnSync
    // naturally provides a non-TTY stdin/stdout, so this exercises that
    // branch without --non-interactive.
    const out = runOnboard({
      opts: {
        fromDockerfile: "/tmp/Custom.Dockerfile",
        acceptThirdPartySoftware: true,
      },
      envOverrides: {
        NEMOCLAW_SANDBOX_NAME: undefined,
        NEMOCLAW_FROM_DOCKERFILE: undefined,
        NEMOCLAW_NON_INTERACTIVE: undefined,
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("--from <Dockerfile> requires --name");
    expect(out.stderr).not.toContain("UNEXPECTED:");
  });

  it("rejects --non-interactive --from when NEMOCLAW_SANDBOX_NAME is whitespace-only", () => {
    // A whitespace-only env var would normalise to empty in the prompt path
    // and silently fall back to the 'my-assistant' default — exactly the
    // failure mode the issue calls out. The guard must reject this too.
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        fromDockerfile: "/tmp/Custom.Dockerfile",
        acceptThirdPartySoftware: true,
      },
      envOverrides: { NEMOCLAW_SANDBOX_NAME: "   " },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("--from <Dockerfile> requires --name");
  });

  it("rejects --non-interactive --from without --name or NEMOCLAW_SANDBOX_NAME", () => {
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        fromDockerfile: "/tmp/Custom.Dockerfile",
        acceptThirdPartySoftware: true,
      },
      envOverrides: {
        NEMOCLAW_SANDBOX_NAME: undefined,
        NEMOCLAW_FROM_DOCKERFILE: undefined,
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "--from <Dockerfile> requires --name <sandbox>",
    );
    expect(out.stderr).not.toContain("UNEXPECTED:");
  });

  it("accepts --non-interactive --from with NEMOCLAW_SANDBOX_NAME set (passes the name guard)", () => {
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        fromDockerfile: "/tmp/Custom.Dockerfile",
        acceptThirdPartySoftware: true,
      },
      envOverrides: {
        NEMOCLAW_SANDBOX_NAME: "second-assistant",
      },
    });
    // The guard passed; later checks (preflight/Docker) will exit later, but
    // the stderr must not contain the --name requirement message.
    expect(out.stderr).not.toContain("--from <Dockerfile> requires --name");
  });

  it("accepts --non-interactive --from with --name (passes the name guard)", () => {
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        fromDockerfile: "/tmp/Custom.Dockerfile",
        sandboxName: "second-assistant",
        acceptThirdPartySoftware: true,
      },
      envOverrides: { NEMOCLAW_SANDBOX_NAME: undefined },
    });
    expect(out.stderr).not.toContain("--from <Dockerfile> requires --name");
  });

  it("rejects --name when the value is a reserved CLI command", () => {
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        sandboxName: "status",
        acceptThirdPartySoftware: true,
      },
      envOverrides: { NEMOCLAW_SANDBOX_NAME: undefined },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Reserved name: 'status' is a NemoClaw CLI command.");
    expect(out.stderr).toContain("(passed via --name)");
  });

  it("rejects NEMOCLAW_SANDBOX_NAME with a reserved value when seeded into a no-TTY run", () => {
    // Without a TTY, the env var is the only way to supply a name. The
    // reserved-name guard must apply to that path too — otherwise a
    // sandbox named 'status' would be created and break CLI routing.
    const out = runOnboard({
      opts: { acceptThirdPartySoftware: true },
      envOverrides: {
        NEMOCLAW_SANDBOX_NAME: "status",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Reserved name: 'status' is a NemoClaw CLI command.");
    expect(out.stderr).toContain("(passed via NEMOCLAW_SANDBOX_NAME)");
  });

  it("rejects --name when the value fails sandbox-name validation", () => {
    const out = runOnboard({
      opts: {
        nonInteractive: true,
        sandboxName: "Bad Name",
        acceptThirdPartySoftware: true,
      },
      envOverrides: { NEMOCLAW_SANDBOX_NAME: undefined },
    });
    expect(out.exitCode).toBe(1);
    // validateName error wording starts with "Invalid sandbox name"; assert the
    // process exits with the validator's complaint, not a downstream crash.
    expect(out.stderr).not.toContain("UNEXPECTED:");
    expect(out.stderr.toLowerCase()).toContain("sandbox name");
  });
});
