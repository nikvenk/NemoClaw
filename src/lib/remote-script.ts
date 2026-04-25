// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatShellToken, joinShellWords } from "./shell-quote";

export function buildShellCommand(opts: {
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
  cwd?: string;
  sourceEnv?: boolean;
}): string {
  if (opts.command && opts.commandArgs && opts.commandArgs.length > 0) {
    throw new Error("buildShellCommand accepts either command or commandArgs, not both");
  }

  const steps: string[] = [];
  if (opts.cwd) {
    steps.push(`cd ${formatShellToken(opts.cwd)}`);
  }
  if (opts.sourceEnv) {
    steps.push("set -a", ". .env", "set +a");
  }
  if (opts.commandArgs && opts.commandArgs.length > 0) {
    let command = joinShellWords(opts.commandArgs);
    if (opts.stdoutRedirect) {
      command += ` > ${formatShellToken(opts.stdoutRedirect)}`;
    }
    steps.push(command);
  }
  if (opts.command) {
    steps.push(opts.command);
  }
  if (!opts.command && (!opts.commandArgs || opts.commandArgs.length === 0)) {
    throw new Error("buildShellCommand requires either command or commandArgs");
  }
  return steps.join(" && ");
}

function buildSshScriptArgs(
  sshArgs: string[],
  host: string,
  remoteCommand: string,
  opts: { tty?: boolean; quiet?: boolean } = {},
): string[] {
  return [
    "ssh",
    ...(opts.tty ? ["-t"] : []),
    ...(opts.quiet ? ["-q"] : []),
    ...sshArgs,
    host,
    remoteCommand,
  ];
}

export function buildSshScriptCommand(opts: {
  sshArgs: string[];
  host: string;
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
  cwd?: string;
  sourceEnv?: boolean;
  tty?: boolean;
  quiet?: boolean;
}): string[] {
  return buildSshScriptArgs(
    opts.sshArgs,
    opts.host,
    buildShellCommand({
      command: opts.command,
      commandArgs: opts.commandArgs,
      stdoutRedirect: opts.stdoutRedirect,
      cwd: opts.cwd,
      sourceEnv: opts.sourceEnv,
    }),
    { tty: opts.tty, quiet: opts.quiet },
  );
}

function buildDockerExecScriptArgs(containerName: string, script: string): string[] {
  return ["docker", "exec", containerName, "sh", "-lc", script];
}

export function buildDockerExecScriptCommand(opts: {
  containerName: string;
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
  cwd?: string;
  sourceEnv?: boolean;
}): string[] {
  return buildDockerExecScriptArgs(
    opts.containerName,
    buildShellCommand({
      command: opts.command,
      commandArgs: opts.commandArgs,
      stdoutRedirect: opts.stdoutRedirect,
      cwd: opts.cwd,
      sourceEnv: opts.sourceEnv,
    }),
  );
}
