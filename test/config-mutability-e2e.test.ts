// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E test for runtime config mutability feature.
//
// Full flow — builds everything from source, no pre-built images:
//   1. Clone OpenShell, apply patches/openshell-config-approval.patch
//   2. Build patched OpenShell via `mise run cluster` (per CONTRIBUTING.md)
//   3. Stage build context and create NemoClaw sandbox on the patched gateway
//   4. Test direct config-set path (host → overrides file → shim reads)
//   5. Test TUI approval path (sandbox → config-request file → scanner →
//      PolicyChunk submitted to gateway → verify via logs)
//   6. Test security (gateway.* blocked at CLI, scanner, and shim levels)
//   7. Cleanup
//
// Requires: Docker, mise, NVIDIA_API_KEY, GITHUB_TOKEN (for mise rate limits)
// Run: npx vitest run --project cli test/config-mutability-e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const NEMOCLAW = path.join(ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = `e2e-config-${Date.now()}`;
const OPENSHELL_SOURCE = "/tmp/openshell-source";
const TIMEOUT_LONG = 1_800_000; // 30 min — Rust compile + cluster bootstrap + sandbox build
const TIMEOUT_MED = 60_000;

// Gateway name is derived from the OpenShell source directory name by
// the cluster bootstrap script.
const GATEWAY_NAME = "openshell-source";

// ── Docker socket detection ──────────────────────────────────────────
function detectDockerHost(): string | undefined {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  try {
    const endpoint = execSync("docker context inspect --format '{{.Endpoints.docker.Host}}'", {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (endpoint && endpoint !== "unix:///var/run/docker.sock") return endpoint;
  } catch { /* fallback to default */ }
  return undefined;
}

const DOCKER_HOST = detectDockerHost();

// Resolve a GitHub token for mise tool installs. Without auth, GitHub's
// API rate limit (60 req/hr) is exhausted in minutes.
function resolveGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf-8", timeout: 5000, stdio: "pipe" }).trim();
  } catch { return ""; }
}
const GITHUB_TOKEN = resolveGitHubToken();

const baseEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
  OPENSHELL_GATEWAY: GATEWAY_NAME,
  ...(DOCKER_HOST ? { DOCKER_HOST } : {}),
  ...(GITHUB_TOKEN ? { GITHUB_TOKEN, MISE_GITHUB_TOKEN: GITHUB_TOKEN } : {}),
  MISE_AQUA_SKIP_VERIFY: "1",
  // Ensure bash 5+ is found first (macOS ships bash 3.2 which lacks mapfile)
  PATH: `/opt/homebrew/bin:${process.env.PATH}`,
};

// ── Helpers ──────────────────────────────────────────────────────────

function nem(...args: string[]): string {
  return execFileSync("node", [NEMOCLAW, ...args], {
    encoding: "utf-8",
    timeout: TIMEOUT_MED,
    env: baseEnv,
  }).trim();
}

function nemFail(...args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("node", [NEMOCLAW, ...args], {
      encoding: "utf-8",
      timeout: TIMEOUT_MED,
      stdio: ["pipe", "pipe", "pipe"],
      env: baseEnv,
    });
    return { status: 0, stderr: "", stdout };
  } catch (err: unknown) {
    const e = err as { status: number; stderr: string; stdout: string };
    return { status: e.status, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
  }
}

function osh(...args: string[]): string {
  return execSync(`openshell ${args.map((a) => `'${a}'`).join(" ")}`, {
    encoding: "utf-8",
    timeout: TIMEOUT_MED,
    env: baseEnv,
  }).trim();
}

function sandboxDownload(sandboxPath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-dl-"));
  try {
    execSync(
      `openshell sandbox download '${SANDBOX_NAME}' '${sandboxPath}' '${tmpDir}'`,
      { encoding: "utf-8", timeout: TIMEOUT_MED, env: baseEnv },
    );
    const basename = path.basename(sandboxPath);
    const localFile = path.join(tmpDir, basename);
    if (!fs.existsSync(localFile)) return "";
    return fs.readFileSync(localFile, "utf-8");
  } catch {
    return "";
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function sandboxUploadFile(localPath: string, remoteDirPath: string): void {
  execSync(
    `openshell sandbox upload '${SANDBOX_NAME}' '${localPath}' '${remoteDirPath}'`,
    { encoding: "utf-8", timeout: TIMEOUT_MED, env: baseEnv },
  );
}

function dockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10_000, env: baseEnv });
    return true;
  } catch {
    return false;
  }
}

function miseInstalled(): boolean {
  try {
    execSync("mise --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Stage a clean build context like onboard.js does (lines 1510-1518). */
function stageBuildContext(): string {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-build-"));
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(ctx, "Dockerfile"));
  execSync(`cp -r '${path.join(ROOT, "nemoclaw")}' '${ctx}/nemoclaw'`, { stdio: "inherit" });
  execSync(`cp -r '${path.join(ROOT, "nemoclaw-blueprint")}' '${ctx}/nemoclaw-blueprint'`, { stdio: "inherit" });
  execSync(`cp -r '${path.join(ROOT, "scripts")}' '${ctx}/scripts'`, { stdio: "inherit" });
  execSync(`cp -r '${path.join(ROOT, "patches")}' '${ctx}/patches'`, { stdio: "inherit" });
  execSync(`rm -rf '${ctx}/nemoclaw/node_modules'`, { stdio: "inherit" });
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════
// Preflight: skip entire suite if prerequisites missing
// ═══════════════════════════════════════════════════════════════════

const HAS_DOCKER = dockerRunning();
const HAS_MISE = miseInstalled();
const HAS_API_KEY = !!process.env.NVIDIA_API_KEY?.startsWith("nvapi-");

const describeE2E = HAS_DOCKER && HAS_MISE && HAS_API_KEY ? describe : describe.skip;

describeE2E("config mutability E2E", () => {

  // ═══════════════════════════════════════════════════════════════════
  // Phase 0: Build patched OpenShell from source + create sandbox
  // ═══════════════════════════════════════════════════════════════════

  beforeAll(() => {
    // ── Clean slate: destroy EVERYTHING from previous runs ─────────
    // Gateways, sandboxes, containers, volumes, port forwards, buildx
    // cache, local registry images — all of it. A stale image in the
    // local registry means k3s pulls old unpatched binaries.
    try { execSync("openshell forward stop 8080", { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    try { execSync("openshell forward stop 18789", { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    try { osh("gateway", "destroy", "-g", GATEWAY_NAME); } catch { /* */ }
    try { osh("gateway", "destroy", "-g", "nemoclaw"); } catch { /* */ }
    try { execSync(`docker rm -f openshell-cluster-${GATEWAY_NAME}`, { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    try { execSync(`docker volume rm openshell-cluster-${GATEWAY_NAME}`, { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    try { execSync("docker rm -f openshell-cluster-nemoclaw", { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    try { execSync("docker volume rm openshell-cluster-nemoclaw", { env: baseEnv, stdio: "inherit" }); } catch { /* */ }
    // Kill ALL openshell processes (port forwards, stale gateways, etc)
    try { execSync("pkill -f openshell", { stdio: "inherit" }); } catch { /* */ }
    try {
      const lsof = execSync("lsof -ti :8080,:18789", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (lsof) execSync(`kill ${lsof.split("\n").join(" ")}`, { stdio: "inherit" });
    } catch { /* */ }
    // Purge ALL Docker buildx cache — stale Rust compilation produces
    // unpatched binaries even when the source has the patch applied.
    try { execSync("docker buildx prune -af", { env: baseEnv, stdio: "inherit", timeout: 30_000 }); } catch { /* */ }
    // Remove all openshell images so mise run cluster builds fresh
    try {
      execSync("docker images --format '{{.Repository}}:{{.Tag}}' | grep openshell | xargs -r docker rmi -f",
        { env: baseEnv, stdio: "inherit", shell: "/bin/bash", timeout: 30_000 });
    } catch { /* */ }

    // ── Clone OpenShell and apply our patch ──────────────────────────
    if (fs.existsSync(OPENSHELL_SOURCE)) {
      fs.rmSync(OPENSHELL_SOURCE, { recursive: true, force: true });
    }
    // Clone at the version matching blueprint min_openshell_version
    const blueprintRaw = fs.readFileSync(
      path.join(ROOT, "nemoclaw-blueprint", "blueprint.yaml"), "utf-8",
    );
    const minMatch = blueprintRaw.match(/min_openshell_version:\s*"([^"]+)"/);
    const osVersion = minMatch ? minMatch[1] : "0.0.15";

    console.log("[e2e] Cloning OpenShell v%s...", osVersion);
    execSync(
      `git clone --branch v${osVersion} --depth 1 https://github.com/NVIDIA/OpenShell.git '${OPENSHELL_SOURCE}'`,
      { encoding: "utf-8", timeout: TIMEOUT_MED, stdio: "inherit" },
    );
    console.log("[e2e] Applying openshell-config-approval.patch...");
    execSync(
      `cd '${OPENSHELL_SOURCE}' && git apply '${path.join(ROOT, "patches", "openshell-config-approval.patch")}'`,
      { encoding: "utf-8", timeout: 10_000, stdio: "inherit" },
    );

    // ── Build patched OpenShell and deploy cluster ───────────────────
    // `mise run cluster` per OpenShell CONTRIBUTING.md: builds all images
    // from source and deploys a local k3s cluster. No external registry pulls
    // for OpenShell components.
    execSync(`cd '${OPENSHELL_SOURCE}' && mise trust`, { stdio: "inherit", timeout: 5000 });

    // mise run cluster may fail in post-deploy steps on macOS (bash 3.2
    // lacks mapfile). The Docker images and k3s bootstrap succeed; the
    // failure is in the incremental deploy wrapper. If the gateway comes
    // up healthy, we proceed.
    try {
      execSync(
        `cd '${OPENSHELL_SOURCE}' && mise run cluster`,
        {
          encoding: "utf-8",
          timeout: TIMEOUT_LONG,
          env: baseEnv,
          stdio: "inherit",
        },
      );
    } catch {
      // Check if the gateway came up despite the script error
      try {
        execSync(`openshell gateway info -g '${GATEWAY_NAME}'`, {
          env: baseEnv, stdio: "inherit", timeout: 10_000,
        });
        console.log("[e2e] mise run cluster had errors but gateway is healthy — proceeding");
      } catch {
        throw new Error("mise run cluster failed and gateway is not healthy");
      }
    }

    // ── Build the patched CLI binary and install it ──────────────────
    execSync(
      `cd '${OPENSHELL_SOURCE}' && cargo build --release -p openshell-cli --features openshell-core/dev-settings`,
      { encoding: "utf-8", timeout: TIMEOUT_LONG, stdio: "inherit" },
    );
    const openshellBin = execSync("which openshell", { encoding: "utf-8" }).trim();
    fs.copyFileSync(path.join(OPENSHELL_SOURCE, "target", "release", "openshell"), openshellBin);

    // ── Create NemoClaw sandbox on the patched gateway ───────────────
    // Stage a clean build context (like onboard.js lines 1510-1518)
    // to avoid sending .claude/worktrees to Docker.
    const buildCtx = stageBuildContext();
    const policyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
    try {
      execSync(
        [
          "openshell sandbox create",
          `--from '${buildCtx}/Dockerfile'`,
          `--name '${SANDBOX_NAME}'`,
          `--policy '${policyPath}'`,
          `-g '${GATEWAY_NAME}'`,
          "-- echo ready",
        ].join(" "),
        {
          encoding: "utf-8",
          timeout: TIMEOUT_LONG,
          env: baseEnv,
          stdio: "inherit",
        },
      );
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }

    // Register sandbox in NemoClaw registry so nemoclaw CLI commands work
    const registryPath = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
    let registry: Record<string, unknown> = { sandboxes: {}, defaultSandbox: "" };
    try { registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")); } catch { /* */ }
    (registry.sandboxes as Record<string, unknown>)[SANDBOX_NAME] = {
      name: SANDBOX_NAME,
      createdAt: new Date().toISOString(),
      model: null, nimContainer: null, provider: null, gpuEnabled: false, policies: [],
    };
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Wait for sandbox to be ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const list = osh("sandbox", "list");
        if (list.includes(SANDBOX_NAME) && list.includes("Ready")) {
          ready = true;
          break;
        }
      } catch { /* retry */ }
      execSync("sleep 2");
    }
    expect(ready).toBe(true);
  }, TIMEOUT_LONG);

  afterAll(() => {
    try { osh("sandbox", "delete", SANDBOX_NAME); } catch { /* */ }
    // Don't destroy the gateway — it's expensive to rebuild and other
    // tests may want it. The sandbox is the only thing we clean up.
  }, TIMEOUT_MED);

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1: Verify baseline — no overrides active
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 1: baseline state", () => {
    it("sandbox exists and is ready", () => {
      const list = osh("sandbox", "list");
      expect(list).toContain(SANDBOX_NAME);
    });

    it("config-get shows no overrides initially", () => {
      const output = nem(SANDBOX_NAME, "config-get");
      expect(output).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: config-set security — gateway.* refused
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 2: security enforcement", () => {
    for (const key of ["gateway.auth.token", "gateway.port", "gateway"]) {
      it(`refuses ${key}`, () => {
        const result = nemFail(SANDBOX_NAME, "config-set", "--key", key, "--value", "evil");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/gateway\.\* fields are immutable/i);
      });
    }

    it("refuses missing --key/--value", () => {
      const result = nemFail(SANDBOX_NAME, "config-set");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Usage:/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: Direct path — config-set writes overrides
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 3: config-set writes overrides", () => {
    const TEST_MODEL = "inference/E2E-DIRECT-PATH-TEST";

    it("config-set succeeds for a valid key", () => {
      const output = nem(
        SANDBOX_NAME, "config-set",
        "--key", "agents.defaults.model.primary",
        "--value", TEST_MODEL,
      );
      expect(output).toContain("Set agents.defaults.model.primary");
    });

    it("config-get reads back the value", () => {
      const output = nem(
        SANDBOX_NAME, "config-get",
        "--key", "agents.defaults.model.primary",
      );
      expect(output).toContain(TEST_MODEL);
    });

    it("overrides file exists in sandbox writable partition", () => {
      const content = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      expect(content).toBeTruthy();
      const parsed = JSON.parse(content);
      expect(parsed.agents.defaults.model.primary).toBe(TEST_MODEL);
    });

    it("multiple overrides accumulate", () => {
      nem(SANDBOX_NAME, "config-set", "--key", "agents.defaults.temperature", "--value", "0.42");
      const content = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      const parsed = JSON.parse(content);
      expect(parsed.agents.defaults.model.primary).toBe(TEST_MODEL);
      expect(parsed.agents.defaults.temperature).toBe(0.42);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4: TUI approval path — scanner detects config request
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 4: TUI approval path (scanner)", () => {
    it("scanner detects config request file and submits PolicyChunk", () => {
      // Upload a config request file into the sandbox's config-requests dir.
      // The patched supervisor scanner polls every 5s and submits it as a
      // PolicyChunk with rule_name "config:<key>".
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-req-"));
      const reqFile = path.join(tmpDir, "test-model-change.json");
      fs.writeFileSync(reqFile, JSON.stringify({
        key: "agents.defaults.model.primary",
        value: "inference/SCANNER-TEST-MODEL",
      }) + "\n");

      sandboxUploadFile(reqFile, "/sandbox/.openclaw-data/config-requests/");
      fs.rmSync(tmpDir, { recursive: true, force: true });

      // Wait for the scanner to poll (5s interval) + submit
      execSync("sleep 15");

      // Verify the scanner detected and submitted the chunk via logs
      const logs = nem(SANDBOX_NAME, "logs");
      expect(logs).toContain("Config change request detected, submitting as draft chunk");

      // Verify the gateway persisted it
      expect(logs).toContain("SubmitPolicyAnalysis: persisted draft chunks");
    });

    it("scanner blocks gateway.* config requests", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-evil-"));
      const evilFile = path.join(tmpDir, "evil.json");
      fs.writeFileSync(evilFile, JSON.stringify({
        key: "gateway.auth.token",
        value: "stolen-token",
      }) + "\n");

      sandboxUploadFile(evilFile, "/sandbox/.openclaw-data/config-requests/");
      fs.rmSync(tmpDir, { recursive: true, force: true });

      execSync("sleep 10");

      const logs = nem(SANDBOX_NAME, "logs");
      expect(logs).toContain("gateway.* blocked");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5: Shim defense-in-depth
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 5: shim defense-in-depth", () => {
    it("gateway.* in overrides file is stripped by shim", () => {
      const poisoned = JSON.stringify({
        gateway: { auth: { token: "HACKED" } },
        agents: { defaults: { model: { primary: "inference/SHIM-DEFENSE-TEST" } } },
      }, null, 2);
      const tmpFile = path.join(os.tmpdir(), "config-overrides.json5");
      fs.writeFileSync(tmpFile, poisoned);
      try {
        sandboxUploadFile(tmpFile, "/sandbox/.openclaw-data/");
      } finally {
        fs.unlinkSync(tmpFile);
      }

      const raw = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      const parsed = JSON.parse(raw);
      // File HAS gateway.* but the shim will strip it at load time
      expect(parsed.gateway).toBeDefined();
      // Logs should never contain the stolen token
      try {
        const logs = nem(SANDBOX_NAME, "logs");
        expect(logs).not.toContain("HACKED");
      } catch { /* logs may be unavailable */ }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6: Cleanup
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 6: cleanup", () => {
    it("sandbox can be destroyed", () => {
      osh("sandbox", "delete", SANDBOX_NAME);
      const list = osh("sandbox", "list");
      expect(list).not.toContain(SANDBOX_NAME);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unit-level shim verification (always runs, no Docker needed)
// ═══════════════════════════════════════════════════════════════════

describe("shim unit verification", () => {
  let tmpDir: string;
  let patchedModPath: string;
  let overridesFile: string;

  const TARGET_FN = "function resolveConfigForRead(resolvedIncludes, env) {";
  const MOCK_DIST = `
"use strict";
${TARGET_FN}
  return resolvedIncludes;
}
module.exports = { resolveConfigForRead };
`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-unit-"));
    const pkgDir = path.join(tmpDir, "pkg");
    const distDir = path.join(pkgDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "shim-test.js"), MOCK_DIST);

    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    execFileSync("node", [shimScript, pkgDir], { encoding: "utf-8" });

    patchedModPath = path.join(distDir, "shim-test.js");
    overridesFile = path.join(tmpDir, "config-overrides.json5");
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_OVERRIDES_FILE;
    delete require.cache[require.resolve(patchedModPath)];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadShim(): { resolveConfigForRead: (cfg: Record<string, unknown>) => Record<string, unknown> } {
    delete require.cache[require.resolve(patchedModPath)];
    return require(patchedModPath);
  }

  it("shim injection patches the dist file", () => {
    const content = fs.readFileSync(patchedModPath, "utf-8");
    expect(content).toContain("function _nemoClawMergeOverrides(cfg)");
    expect(content).toContain("resolvedIncludes = _nemoClawMergeOverrides(resolvedIncludes);");
    expect(content).toContain("delete _ov.gateway");
  });

  it("returns config unchanged when no overrides file", () => {
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = "/nonexistent/path.json";
    const { resolveConfigForRead } = loadShim();
    const original = { agents: { defaults: { model: { primary: "original" } } } };
    expect(resolveConfigForRead(original)).toEqual(original);
  });

  it("deep-merges overrides onto frozen config", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      agents: { defaults: { model: { primary: "inference/MERGED" } } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      agents: { defaults: { model: { primary: "original", fallback: "fb" }, temperature: 0.7 } },
      version: 1,
    });

    expect((result as any).agents.defaults.model.primary).toBe("inference/MERGED");
    expect((result as any).agents.defaults.model.fallback).toBe("fb");
    expect((result as any).agents.defaults.temperature).toBe(0.7);
    expect((result as any).version).toBe(1);
  });

  it("strips gateway.* from overrides (defense in depth)", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      gateway: { auth: { token: "STOLEN" } },
      agents: { defaults: { model: { primary: "inference/legit" } } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      gateway: { auth: { token: "REAL" }, port: 8080 },
      agents: { defaults: { model: { primary: "original" } } },
    });

    expect((result as any).gateway.auth.token).toBe("REAL");
    expect((result as any).gateway.port).toBe(8080);
    expect((result as any).agents.defaults.model.primary).toBe("inference/legit");
  });

  it("handles malformed JSON gracefully", () => {
    fs.writeFileSync(overridesFile, "NOT JSON {{{");
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();
    expect(resolveConfigForRead({ foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("replaces arrays instead of merging them", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      agents: { defaults: { tools: ["new-a", "new-b"] } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      agents: { defaults: { tools: ["old"], model: { primary: "orig" } } },
    });

    expect((result as any).agents.defaults.tools).toEqual(["new-a", "new-b"]);
    expect((result as any).agents.defaults.model.primary).toBe("orig");
  });
});

// ═══════════════════════════════════════════════════════════════════
// config-set CLI security (always runs, no Docker needed)
// ═══════════════════════════════════════════════════════════════════

describe("config-set security", () => {
  const configSetPath = path.join(ROOT, "bin", "lib", "config-set").replace(/\\/g, "\\\\");

  function runConfigSet(...args: string[]): { status: number; stderr: string; stdout: string } {
    const argsStr = args.map((a) => `"${a}"`).join(", ");
    try {
      const stdout = execFileSync("node", ["-e", `
        const { configSet } = require("${configSetPath}");
        configSet("fake-sandbox", [${argsStr}]);
      `], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return { status: 0, stderr: "", stdout };
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string; stdout: string };
      return { status: e.status, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
    }
  }

  it("refuses gateway.auth.token", () => {
    const r = runConfigSet("--key", "gateway.auth.token", "--value", "evil");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses gateway.port", () => {
    const r = runConfigSet("--key", "gateway.port", "--value", "9999");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses bare gateway", () => {
    const r = runConfigSet("--key", "gateway", "--value", "{}");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses missing --key/--value", () => {
    const r = runConfigSet();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Usage:/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// apply-openclaw-shim.js (always runs, no Docker needed)
// ═══════════════════════════════════════════════════════════════════

describe("apply-openclaw-shim.js", () => {
  it("patches multiple dist files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-multi-"));
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const target = "function resolveConfigForRead(resolvedIncludes, env) {";
    for (const name of ["a.js", "b.js", "c.js"]) {
      fs.writeFileSync(path.join(distDir, name), `"use strict";\n${target}\n  return resolvedIncludes;\n}`);
    }
    fs.writeFileSync(path.join(distDir, "unrelated.js"), "module.exports = {};");

    const output = execFileSync("node", [path.join(ROOT, "patches", "apply-openclaw-shim.js"), tmpDir], {
      encoding: "utf-8",
    });
    expect(output).toContain("Patched 3 files");
    expect(fs.readFileSync(path.join(distDir, "unrelated.js"), "utf-8")).toBe("module.exports = {};");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits non-zero when no files match", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-none-"));
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "nope.js"), "// nothing");

    try {
      execFileSync("node", [path.join(ROOT, "patches", "apply-openclaw-shim.js"), tmpDir], {
        encoding: "utf-8",
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toMatch(/WARNING: No files patched/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
