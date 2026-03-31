// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral Brev E2E test suite.
 *
 * Creates a fresh Brev instance, bootstraps it, runs E2E tests remotely,
 * then tears it down. Intended to be run from CI via:
 *
 *   npx vitest run --project e2e-brev
 *
 * Required env vars:
 *   BREV_API_TOKEN   — Brev refresh token for headless auth
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Optional env vars:
 *   TEST_SUITE       — which test to run: full (default), credential-sanitization, all
 *   BREV_CPU         — CPU spec (default: 4x16)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BREV_CPU = process.env.BREV_CPU || "4x16";
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");

let remoteDir;
let instanceCreated = false;

// --- helpers ----------------------------------------------------------------

function brev(...args) {
  return execFileSync("brev", args, {
    encoding: "utf-8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Run a command on the remote instance via brev exec.
 * This avoids the need for SSH config / brev.pem on the CI runner.
 */
function remoteExec(cmd, { timeout = 120_000 } = {}) {
  return execFileSync("brev", ["exec", INSTANCE_NAME, cmd], {
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function shellEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with secrets passed as inline exports. */
function remoteExecWithSecrets(cmd, { timeout = 600_000 } = {}) {
  const secretPreamble = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ].join(" && ");

  return execFileSync("brev", ["exec", INSTANCE_NAME, `${secretPreamble} && ${cmd}`], {
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function waitForInstance(maxAttempts = 180, intervalMs = 5_000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const result = remoteExec("echo ok", { timeout: 15_000 });
      if (result.includes("ok")) return;
    } catch (err) {
      if (i % 10 === 0 || i === 1) {
        console.log(`[attempt ${i}/${maxAttempts}] Waiting for instance...`);
        try {
          const lsOut = brev("ls");
          console.log(`[brev ls] ${lsOut.split("\n").slice(0, 4).join(" | ")}`);
        } catch { /* ignore */ }
      }
      if (i === maxAttempts) throw new Error(`Instance not ready after ${maxAttempts} attempts`, { cause: err });
      execSync(`sleep ${intervalMs / 1000}`);
    }
  }
}

function runRemoteTest(scriptPath) {
  const cmd = [
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    `bash ${scriptPath}`,
  ].join(" && ");

  return remoteExecWithSecrets(cmd, { timeout: 600_000 });
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["BREV_API_TOKEN", "NVIDIA_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);

describe.runIf(hasRequiredVars)("Brev E2E", () => {
  beforeAll(() => {

    // Authenticate with Brev
    mkdirSync(path.join(homedir(), ".brev"), { recursive: true });
    writeFileSync(
      path.join(homedir(), ".brev", "onboarding_step.json"),
      '{"step":1,"hasRunBrevShell":true,"hasRunBrevOpen":true}',
    );
    brev("login", "--token", process.env.BREV_API_TOKEN);

    // Switch to CI org (the refresh token may default to a different org)
    const BREV_ORG = process.env.BREV_ORG || "Nemoclaw CI/CD";
    brev("org", "set", BREV_ORG);

    // Create instance
    brev("create", INSTANCE_NAME, "--cpu", BREV_CPU, "--detached");
    instanceCreated = true;

    // Wait for instance to be reachable via brev exec
    waitForInstance();

    // Sync code via brev exec + tar (rsync needs SSH config, brev exec does not)
    const remoteHome = remoteExec("echo $HOME");
    remoteDir = `${remoteHome}/nemoclaw`;
    remoteExec(`mkdir -p ${remoteDir}`);

    // Create tarball locally, pipe to remote via brev exec
    console.log("[setup] Syncing code to remote instance...");
    execSync(
      `tar -czf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=.venv -C "${REPO_DIR}" . | brev exec ${INSTANCE_NAME} "tar -xzf - -C ${remoteDir}"`,
      { encoding: "utf-8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
    );

    // Bootstrap VM
    console.log("[setup] Running bootstrap...");
    remoteExecWithSecrets(`cd ${remoteDir} && bash scripts/brev-setup.sh`, { timeout: 900_000 });
  }, 1_200_000); // 20 min — instance creation + bootstrap can be slow

  afterAll(() => {
    if (!instanceCreated) return;
    if (process.env.KEEP_ALIVE === "true") {
      console.log(`\n  Instance "${INSTANCE_NAME}" kept alive for debugging.`);
      console.log(`  To connect: brev shell ${INSTANCE_NAME}`);
      console.log(`  To delete:  brev delete ${INSTANCE_NAME}\n`);
      return;
    }
    try {
      brev("delete", INSTANCE_NAME);
    } catch {
      // Best-effort cleanup — instance may already be gone
    }
  });

  it.runIf(TEST_SUITE === "full" || TEST_SUITE === "all")(
    "full E2E suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-full-e2e.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );

  it.runIf(TEST_SUITE === "credential-sanitization" || TEST_SUITE === "all")(
    "credential sanitization suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-credential-sanitization.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );
});
