// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  acceptThirdPartySoftware: boolean;
}

export interface RunOnboardCommandDeps {
  args: string[];
  noticeAcceptFlag: string;
  noticeAcceptEnv: string;
  env: NodeJS.ProcessEnv;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

const ONBOARD_BASE_ARGS = ["--non-interactive", "--resume"];

export function parseOnboardArgs(
  args: string[],
  noticeAcceptFlag: string,
  noticeAcceptEnv: string,
  deps: Pick<RunOnboardCommandDeps, "env" | "error" | "exit">,
): OnboardCommandOptions {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const allowedArgs = new Set([...ONBOARD_BASE_ARGS, noticeAcceptFlag]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    error(
      `  Usage: nemoclaw onboard [--non-interactive] [--resume] [${noticeAcceptFlag}]`,
    );
    exit(1);
  }

  return {
    nonInteractive: args.includes("--non-interactive"),
    resume: args.includes("--resume"),
    acceptThirdPartySoftware:
      args.includes(noticeAcceptFlag) || String(deps.env[noticeAcceptEnv] || "") === "1",
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const options = parseOnboardArgs(deps.args, deps.noticeAcceptFlag, deps.noticeAcceptEnv, deps);
  await deps.runOnboard(options);
}

export interface RunAliasCommandDeps extends RunOnboardCommandDeps {
  kind: "setup" | "setup-spark";
}

export async function runDeprecatedOnboardAliasCommand(
  deps: RunAliasCommandDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  log("");
  if (deps.kind === "setup") {
    log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  } else {
    log("  ⚠  `nemoclaw setup-spark` is deprecated.");
    log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
    log("  Use `nemoclaw onboard` instead.");
  }
  log("");
  await runOnboardCommand(deps);
}
