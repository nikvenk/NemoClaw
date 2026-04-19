// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getSandboxStateFromOutputs } from "./gateway-state";
import { parseGatewayInference } from "./inference-config";
import {
  installOpenshell as installOpenshellWithDeps,
  isOpenshellInstalled as detectInstalledOpenshell,
  waitForSandboxReady as waitForSandboxReadyWithDeps,
} from "./onboard-openshell";
import {
  getContainerRuntime as getContainerRuntimeWithDeps,
  printRemediationActions as printRemediationActionsWithDeps,
} from "./onboard-remediation";
import { inferContainerRuntime } from "./platform";
import { resolveOpenshell } from "./resolve-openshell";

export interface SandboxRuntimeDeps {
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  runOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => { status: number };
  note?: (message: string) => void;
  dashboardPort?: number;
  removeSandbox?: (sandboxName: string) => void;
}

export interface GatewayDestroyDeps {
  runOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => { status: number };
  clearRegistryAll: () => void;
  run: (command: string | string[], opts?: { ignoreError?: boolean }) => unknown;
}

export interface InstallOpenshellDeps {
  scriptPath: string;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  getFutureShellPathHint: (binDir: string, pathValue: string) => string | null;
  errorWriter?: (message?: string) => void;
}

export function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
export function pruneKnownHostsEntries(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const hostField = trimmed.split(/\s+/)[0];
      return !hostField.split(",").some((host) => host.startsWith("openshell-"));
    })
    .join("\n");
}

export function getSandboxReuseState(
  sandboxName: string | null,
  deps: SandboxRuntimeDeps,
): string {
  if (!sandboxName) return "missing";
  const getOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

export function repairRecordedSandbox(sandboxName: string | null, deps: SandboxRuntimeDeps): void {
  if (!sandboxName) return;
  deps.note?.(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  deps.runOpenshell(["forward", "stop", String(deps.dashboardPort ?? 0)], { ignoreError: true });
  deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  deps.removeSandbox?.(sandboxName);
}

export function destroyGateway(gatewayName: string, deps: GatewayDestroyDeps): void {
  const destroyResult = deps.runOpenshell(["gateway", "destroy", "-g", gatewayName], {
    ignoreError: true,
  });
  // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
  if (destroyResult.status === 0) {
    deps.clearRegistryAll();
  }
  // openshell gateway destroy doesn't remove Docker volumes, which leaves
  // corrupted cluster state that breaks the next gateway start. Clean them up.
  deps.run(
    `docker volume ls -q --filter "name=openshell-cluster-${gatewayName}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${gatewayName}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

export function installOpenshell(deps: InstallOpenshellDeps): {
  installed: boolean;
  localBin: string | null;
  futureShellPathHint: string | null;
  updatedPathValue: string | null;
  openshellBinary: string | null;
} {
  return installOpenshellWithDeps({
    scriptPath: deps.scriptPath,
    rootDir: deps.rootDir,
    env: deps.env,
    spawnSync,
    existsSync: fs.existsSync,
    resolveOpenshell,
    getFutureShellPathHint: deps.getFutureShellPathHint,
    errorWriter: deps.errorWriter,
  });
}

export function isOpenshellInstalled(): boolean {
  return detectInstalledOpenshell(resolveOpenshell);
}

export function getContainerRuntime(
  runCapture: (command: string, options?: { ignoreError?: boolean }) => string,
): string {
  return getContainerRuntimeWithDeps({ runCapture, inferContainerRuntime });
}

export function printRemediationActions(
  actions: unknown,
  errorWriter: (message?: string) => void = console.error,
): void {
  return printRemediationActionsWithDeps(actions as never, errorWriter);
}

export function waitForSandboxReady(
  sandboxName: string,
  deps: { runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string },
  attempts = 10,
  delaySeconds = 2,
): boolean {
  return waitForSandboxReadyWithDeps(
    sandboxName,
    {
      runCaptureOpenshell: deps.runCaptureOpenshell,
      sleep,
    },
    attempts,
    delaySeconds,
  );
}

export function verifyInferenceRoute(
  _provider: string,
  _model: string,
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string,
): void {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

export function isInferenceRouteReady(
  provider: string,
  model: string,
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string,
): boolean {
  const live = parseGatewayInference(
    runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
  );
  return Boolean(live && live.provider === provider && live.model === model);
}
