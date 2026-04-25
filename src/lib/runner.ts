// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
const path = require("path");
const { detectDockerHost } = require("./platform.js");
const { spawnResult } = require("./process-primitives.js");
const { joinShellWords } = require("./shell-quote");
const { buildSubprocessEnv } = require("./subprocess-env.js");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

type RunnerOptions = SpawnSyncOptions & {
  ignoreError?: boolean;
  suppressOutput?: boolean;
  inheritFullEnv?: boolean;
};

type CaptureOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  ignoreError?: boolean;
  inheritFullEnv?: boolean;
};

type ArrayCaptureOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  ignoreError?: boolean;
  inheritFullEnv?: boolean;
};

type SpawnResult = SpawnSyncReturns<string | Buffer>;

const dockerHost = detectDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
}

function buildRunnerEnv(
  extraEnv: NodeJS.ProcessEnv | undefined,
  inheritFullEnv = false,
): NodeJS.ProcessEnv {
  if (inheritFullEnv) {
    return { ...process.env, ...extraEnv };
  }

  const normalizedExtraEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value !== undefined) {
      normalizedExtraEnv[key] = value;
    }
  }
  return buildSubprocessEnv(normalizedExtraEnv);
}

function logOpenshellRuntimeHint(file: string, renderedCommand = ""): void {
  if (
    file === "openshell" ||
    file?.endsWith("/openshell") ||
    (file === "bash" && /^\s*openshell\s/.test(renderedCommand))
  ) {
    console.error("  This error originated from the OpenShell runtime layer.");
    console.error("  Docs: https://github.com/NVIDIA/OpenShell");
  }
}

/**
 * Spawn a command, streaming stdout/stderr (redacted) to the terminal.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function spawnAndHandle(
  file: string,
  args: readonly string[],
  opts: RunnerOptions = {},
  stdio: RunnerOptions["stdio"],
  renderedCommand: string,
): SpawnResult {
  const result = spawnResult(file, args, {
    ...opts,
    stdio,
    cwd: opts.cwd ?? ROOT,
    env: buildRunnerEnv(opts.env, opts.inheritFullEnv),
  });
  if (!opts.suppressOutput) {
    writeRedactedResult(result, stdio);
  }
  if (result.error && !opts.ignoreError) {
    console.error(
      `  Command failed: ${redact(renderedCommand).slice(0, 80)}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(
      `  Command failed (exit ${result.status}): ${redact(renderedCommand).slice(0, 80)}`,
    );
    logOpenshellRuntimeHint(file, renderedCommand);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a command, streaming stdout/stderr (redacted) to the terminal.
 * Exits the process on failure unless opts.ignoreError is true.
 *
 * Requires an argv array and never invokes a shell.
 */
function run(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (!Array.isArray(cmd)) {
    throw new Error("run requires an argv array. Use runShell for shell commands.");
  }
  return runArrayCmd(cmd, opts);
}

/**
 * Run an explicit shell command via `bash -c`.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runShell(cmd: string, opts: RunnerOptions = {}): SpawnResult {
  const shellCmd = String(cmd);
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  return spawnAndHandle("bash", ["-c", shellCmd], opts, stdio, shellCmd);
}

/**
 * Internal: execute an argv array via spawnSync with no shell.
 * Shared by run() and kept separate for clarity.
 */
function runArrayCmd(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (cmd.length === 0) {
    throw new Error("run: argv array must not be empty");
  }

  const exe = cmd[0];
  const args = cmd.slice(1);
  const {
    ignoreError,
    suppressOutput,
    inheritFullEnv,
    env: extraEnv,
    stdio: stdioCfg,
    ...spawnOpts
  } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error("run: shell option is forbidden when passing an argv array");
  }

  const stdio = stdioCfg ?? ["ignore", "pipe", "pipe"];

  const cmdStr = cmd.join(" ");
  return spawnAndHandle(
    exe,
    args,
    {
      ...spawnOpts,
      ignoreError,
      suppressOutput,
      inheritFullEnv,
      env: extraEnv,
    },
    stdio,
    cmdStr,
  );
}

/**
 * Run an interactive argv command (stdin inherited) while capturing/redacting stdout/stderr.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractive(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (!Array.isArray(cmd)) {
    throw new Error("runInteractive requires an argv array. Use runInteractiveShell for shell commands.");
  }
  const stdio = opts.stdio ?? ["inherit", "pipe", "pipe"];
  return runArrayCmd(cmd, { ...opts, stdio });
}

/**
 * Run an explicit interactive shell command via `bash -c`.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractiveShell(cmd: string, opts: RunnerOptions = {}): SpawnResult {
  const stdio = opts.stdio ?? ["inherit", "pipe", "pipe"];
  const shellCmd = String(cmd);
  return spawnAndHandle("bash", ["-c", shellCmd], opts, stdio, shellCmd);
}

/**
 * Run a program directly with argv-style arguments, bypassing shell parsing.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runFile(
  file: string,
  args: readonly (string | number | boolean)[] = [],
  opts: RunnerOptions = {},
): SpawnResult {
  if (opts.shell) {
    throw new Error("runFile does not allow opts.shell=true");
  }
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  const normalizedArgs = args.map((arg) => String(arg));
  const rendered = joinShellWords([file, ...normalizedArgs]);
  return spawnAndHandle(file, normalizedArgs, { ...opts, shell: false }, stdio, rendered);
}

/**
 * Run a command and return its stdout as a trimmed string.
 * Throws a redacted error on failure, or returns '' when opts.ignoreError is true.
 *
 * Requires an argv array and never invokes a shell.
 */
function runCapture(cmd: readonly string[], opts: ArrayCaptureOptions = {}): string {
  if (!Array.isArray(cmd)) {
    throw new Error("runCapture requires an argv array. Use runCaptureShell for shell commands.");
  }
  return runArrayCapture(cmd, opts);
}

/**
 * Run an explicit shell command and return its stdout as a trimmed string.
 * Throws a redacted error on failure, or returns '' when opts.ignoreError is true.
 */
function runCaptureShell(cmd: string, opts: CaptureOptions = {}): string {
  const shellCmd = String(cmd);
  const { ignoreError, inheritFullEnv, env: extraEnv, stdio: _stdio, ...spawnOpts } = opts;
  if (spawnOpts.shell) {
    throw new Error("runCaptureShell does not allow opts.shell=true");
  }

  try {
    const result = spawnResult("bash", ["-c", shellCmd], {
      ...spawnOpts,
      cwd: spawnOpts.cwd ?? ROOT,
      env: buildRunnerEnv(extraEnv, inheritFullEnv),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const shellError = new Error(`Command failed with status ${result.status}`) as Error & {
        cmd?: string;
        output?: string[];
      };
      shellError.cmd = shellCmd;
      shellError.output = [String(result.stdout || ""), String(result.stderr || "")].filter(
        Boolean,
      );
      throw shellError;
    }
    return String(result.stdout || "").trim();
  } catch (err) {
    if (ignoreError) return "";
    throw redactError(err);
  }
}

/**
 * Internal: capture stdout from an argv array via spawnSync with no shell.
 * Shared by runCapture() and kept separate for clarity.
 */
function runArrayCapture(cmd: readonly string[], opts: ArrayCaptureOptions = {}): string {
  if (cmd.length === 0) {
    throw new Error("runCapture: argv array must not be empty");
  }

  const exe = cmd[0];
  const args = cmd.slice(1);
  const {
    ignoreError,
    inheritFullEnv,
    env: extraEnv,
    stdio: _stdio,
    ...spawnOpts
  } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error("runCapture: shell option is forbidden when passing an argv array");
  }

  try {
    const result = spawnAndHandle(
      exe,
      args,
      {
        ...spawnOpts,
        ignoreError: true,
        suppressOutput: true,
        inheritFullEnv,
        env: extraEnv,
        encoding: "utf-8",
      },
      ["pipe", "pipe", "pipe"],
      cmd.join(" "),
    );

    // Check result.error first — spawnSync sets this (with status === null) when
    // the executable is missing (ENOENT), the call times out, or the spawn fails.
    if (result.error) {
      if (ignoreError) return "";
      throw result.error;
    }
    if (result.status !== 0) {
      if (ignoreError) return "";
      throw new Error(`Command failed with status ${result.status}`);
    }

    const stdout = result.stdout || "";
    return (typeof stdout === "string" ? stdout : stdout.toString("utf-8")).trim();
  } catch (err) {
    if (ignoreError) return "";
    throw redactError(err);
  }
}

// Unified redaction — see redact.ts (#2381).
const { redact, redactError, writeRedactedResult } = require("./redact.js");

/**
 * Shell-quote a value for safe interpolation into bash -c strings.
 * Wraps in single quotes and escapes embedded single quotes.
 */
/**
 * Validate a name (sandbox, instance, container) against RFC 1123 label rules.
 * Rejects shell metacharacters, path traversal, and empty/overlength names.
 */
function validateName(name: string, label = "name"): string {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required`);
  }
  if (name.length > 63) {
    throw new Error(`${label} too long (max 63 chars): '${name.slice(0, 20)}...'`);
  }
  if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid ${label}: '${name}'. Must start with a letter and contain only lowercase alphanumerics with optional internal hyphens.`,
    );
  }
  return name;
}

export {
  ROOT,
  SCRIPTS,
  redact,
  run,
  runShell,
  runCapture,
  runCaptureShell,
  runFile,
  runInteractive,
  runInteractiveShell,
  validateName,
};
