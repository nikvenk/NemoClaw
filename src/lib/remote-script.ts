// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatShellToken, joinShellWords } from "./shell-quote";

export interface ShellCommandStep {
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
}

function renderShellCommandStep(step: ShellCommandStep): string {
  if (step.command && step.commandArgs && step.commandArgs.length > 0) {
    throw new Error("shell steps accept either command or commandArgs, not both");
  }
  if (step.command && step.stdoutRedirect) {
    throw new Error("shell steps with raw command strings cannot use stdoutRedirect");
  }
  if (step.commandArgs && step.commandArgs.length > 0) {
    let command = joinShellWords(step.commandArgs);
    if (step.stdoutRedirect) {
      command += ` > ${formatShellToken(step.stdoutRedirect)}`;
    }
    return command;
  }
  if (step.command) {
    return step.command;
  }
  throw new Error("shell steps require either command or commandArgs");
}

export function buildShellCommand(opts: {
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
  cwd?: string;
  sourceEnv?: boolean;
  steps?: ShellCommandStep[];
}): string {
  const hasLegacyCommand = Boolean(opts.command) || Boolean(opts.commandArgs?.length);
  if (opts.steps && opts.steps.length > 0 && hasLegacyCommand) {
    throw new Error("buildShellCommand accepts either steps or a single command definition, not both");
  }

  const steps: string[] = [];
  if (opts.cwd) {
    steps.push(`cd ${formatShellToken(opts.cwd)}`);
  }
  if (opts.sourceEnv) {
    steps.push("set -a", ". .env", "set +a");
  }
  if (opts.steps && opts.steps.length > 0) {
    steps.push(...opts.steps.map((step) => renderShellCommandStep(step)));
  } else if (hasLegacyCommand) {
    steps.push(
      renderShellCommandStep({
        command: opts.command,
        commandArgs: opts.commandArgs,
        stdoutRedirect: opts.stdoutRedirect,
      }),
    );
  } else {
    throw new Error("buildShellCommand requires either steps or a single command definition");
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
  steps?: ShellCommandStep[];
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
      steps: opts.steps,
    }),
    { tty: opts.tty, quiet: opts.quiet },
  );
}

function buildDockerExecScriptArgs(
  containerName: string,
  script: string,
  login = true,
): string[] {
  return ["docker", "exec", containerName, "sh", login ? "-lc" : "-c", script];
}

export function buildDockerExecScriptCommand(opts: {
  containerName: string;
  command?: string;
  commandArgs?: string[];
  stdoutRedirect?: string;
  cwd?: string;
  sourceEnv?: boolean;
  steps?: ShellCommandStep[];
  login?: boolean;
}): string[] {
  return buildDockerExecScriptArgs(
    opts.containerName,
    buildShellCommand({
      command: opts.command,
      commandArgs: opts.commandArgs,
      stdoutRedirect: opts.stdoutRedirect,
      cwd: opts.cwd,
      sourceEnv: opts.sourceEnv,
      steps: opts.steps,
    }),
    opts.login ?? true,
  );
}
