// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused sandbox recreation for the rebuild path.
 *
 * Replaces the fragile pattern of calling onboard() with a process.exit
 * interceptor.  All functions throw RecreateError on failure instead of
 * calling process.exit.  No session file manipulation, no lock management,
 * no preflight/consent/gateway setup — those are already running when
 * rebuild invokes this module.
 *
 * See #2306.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// @ts-nocheck — onboard.ts uses module.exports (CJS runtime), not TS export;
// TypeScript cannot infer the shape.  This file is integration-tested via
// sandbox-recreate.test.ts and the E2E rebuild tests.

const credentials = require("./credentials");
const { resolveProviderCredential, getCredential, normalizeCredentialValue } = credentials;
const onboard = require("./onboard");
const {
  buildSandboxConfigSyncScript,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  isSandboxReady,
  upsertProvider,
  getSuggestedPolicyPresets,
  runCaptureOpenshell,
  isInferenceRouteReady,
  providerExistsInGateway,
  hashCredential,
  formatEnvAssignment,
  pullAndResolveBaseImageDigest,
  SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  ensureOllamaAuthProxy,
  MESSAGING_CHANNELS,
  classifySandboxCreateFailure,
} = onboard;
const onboardProviders = require("./onboard-providers");
const {
  REMOTE_PROVIDER_CONFIG,
  buildProviderArgs,
  getSandboxInferenceConfig,
} = onboardProviders;
const registry = require("./registry");
const policies = require("./policies");
const shields = require("./shields");
const agentDefs = require("./agent-defs");
const agentOnboard = require("./agent-onboard");
const runner = require("./runner");
const { run, runCapture, runFile } = runner;
const { streamSandboxCreate } = require("./sandbox-create-stream");
const { resolveOpenshell } = require("./resolve-openshell");
const { ROOT, SCRIPTS } = require("./paths");
const { buildSubprocessEnv } = require("./subprocess-env");
const { stageOptimizedSandboxBuildContext } = require("./sandbox-build-context");
const webSearch = require("./web-search");
const { getProviderSelectionConfig } = require("./inference-config");

// ── Types ────────────────────────────────────────────────────────

export interface RecreateParams {
  sandboxName: string;
  provider: string;
  model: string;
  credentialEnv: string | null;
  endpointUrl: string | null;
  preferredInferenceApi: string | null;
  agent: string | null;
  fromDockerfile: string | null;
  webSearchConfig: { fetchEnabled: boolean } | null;
  messagingChannels: string[];
  policyPresets: string[];
  dangerouslySkipPermissions: boolean;
}

export interface RecreateResult {
  sandboxName: string;
  appliedPresets: string[];
}

export type RecreateErrorCode =
  | "credential_missing"
  | "sandbox_create_failed"
  | "inference_failed"
  | "agent_setup_failed"
  | "policy_failed";

export class RecreateError extends Error {
  code: RecreateErrorCode;
  constructor(message: string, code: RecreateErrorCode) {
    super(message);
    this.name = "RecreateError";
    this.code = code;
  }
}

// ── Internal helpers ─────────────────────────────────────────────

const GATEWAY_NAME = "nemoclaw";
const CONTROL_UI_PORT = 18789;

function getOpenshellBinary(): string {
  return resolveOpenshell() || "openshell";
}

function openshellArgv(args: string[], opts: { openshellBinary?: string } = {}): string[] {
  return [opts.openshellBinary || getOpenshellBinary(), ...args];
}

function runOpenshell(args: string[], opts: any = {}) {
  return run(openshellArgv(args, opts), opts);
}

function runCaptureOpenshellLocal(args: string[], opts: any = {}) {
  return runCapture(openshellArgv(args, opts), opts);
}

function openshellShellCommand(args: string[]): string {
  return [getOpenshellBinary(), ...args].map((a) => (/[^A-Za-z0-9_\-./:=]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
}

function sleep(seconds: number): void {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100, end - Date.now()));
    } catch {
      const remaining = end - Date.now();
      if (remaining > 0) {
        require("child_process").spawnSync("sleep", [String(remaining / 1000)]);
      }
    }
  }
}

function cleanupTempDir(filePath: string, prefix: string): void {
  try {
    const dir = path.dirname(filePath);
    if (dir.includes(prefix)) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch { /* best effort */ }
}

function waitForSandboxReady(sandboxName: string, maxAttempts = 30): boolean {
  for (let i = 0; i < maxAttempts; i++) {
    const list = runCaptureOpenshellLocal(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      return true;
    }
    sleep(2);
  }
  return false;
}

function getDashboardForwardPort(chatUiUrl: string): number {
  try {
    const url = new URL(chatUiUrl);
    return parseInt(url.port, 10) || CONTROL_UI_PORT;
  } catch {
    return CONTROL_UI_PORT;
  }
}

function removeSandboxImage(sandboxName: string): void {
  const sbEntry = registry.getSandbox(sandboxName);
  if (sbEntry?.imageTag) {
    run(["docker", "rmi", sbEntry.imageTag], { ignoreError: true, suppressOutput: true });
  }
}

// ── Composable primitives ────────────────────────────────────────

export function validateRecreateCredentials(credentialEnv: string | null): void {
  if (!credentialEnv) return;
  const value = resolveProviderCredential(credentialEnv);
  if (!value) {
    throw new RecreateError(
      `Provider credential ${credentialEnv} not found in environment or ~/.nemoclaw/credentials.json`,
      "credential_missing",
    );
  }
}

export async function createSandboxDirect(params: {
  sandboxName: string;
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  webSearchConfig: { fetchEnabled: boolean } | null;
  messagingChannels: string[];
  fromDockerfile: string | null;
  agent: string | null;
  dangerouslySkipPermissions: boolean;
}): Promise<string> {
  const {
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    messagingChannels,
    fromDockerfile,
    dangerouslySkipPermissions,
  } = params;

  const agentDef = params.agent
    ? agentDefs.loadAgent(params.agent)
    : agentDefs.loadAgent("openclaw");

  const effectivePort = agentDef.forwardPort || CONTROL_UI_PORT;
  const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;
  const effectiveDashboardPort = getDashboardForwardPort(chatUiUrl);

  // Stage build context
  let buildCtx: string;
  let stagedDockerfile: string;

  try {
    if (fromDockerfile) {
      const fromResolved = path.resolve(fromDockerfile);
      if (!fs.existsSync(fromResolved)) {
        throw new RecreateError(`Custom Dockerfile not found: ${fromResolved}`, "sandbox_create_failed");
      }
      buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-"));
      stagedDockerfile = path.join(buildCtx, "Dockerfile");
      fs.cpSync(path.dirname(fromResolved), buildCtx, {
        recursive: true,
        filter: (src: string) => {
          const base = path.basename(src);
          return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
        },
      });
      if (path.basename(fromResolved) !== "Dockerfile") {
        fs.copyFileSync(fromResolved, stagedDockerfile);
      }
    } else if (agentDef.name !== "openclaw") {
      const agentBuild = agentOnboard.createAgentSandbox(agentDef);
      buildCtx = agentBuild.buildCtx;
      stagedDockerfile = agentBuild.stagedDockerfile;
    } else {
      ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
    }
  } catch (err) {
    if (err instanceof RecreateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new RecreateError(`Failed to stage build context: ${msg}`, "sandbox_create_failed");
  }

  const cleanupBuildCtx = (): boolean => {
    try {
      if (buildCtx !== ROOT) {
        fs.rmSync(buildCtx, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
    }
  };

  try {
    // Resolve base policy path
    const globalPermissivePath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml");
    let basePolicyPath: string;
    if (dangerouslySkipPermissions) {
      const agentPermissive = agentDef.name !== "openclaw" && agentOnboard.getAgentPermissivePolicyPath
        ? agentOnboard.getAgentPermissivePolicyPath(agentDef)
        : null;
      basePolicyPath = agentPermissive || globalPermissivePath;
    } else {
      const defaultPolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
      basePolicyPath = (agentDef.name !== "openclaw" && agentOnboard.getAgentPolicyPath
        ? agentOnboard.getAgentPolicyPath(agentDef)
        : null) || defaultPolicyPath;
    }

    const createArgs = ["--from", `${buildCtx}/Dockerfile`, "--name", sandboxName, "--policy", basePolicyPath];

    // Messaging providers
    const getMessagingToken = (envKey: string): string | null =>
      getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

    const enabledEnvKeys = messagingChannels.length > 0
      ? new Set(
          MESSAGING_CHANNELS.filter((c: any) => messagingChannels.includes(c.name)).flatMap((c: any) =>
            c.appTokenEnvKey ? [c.envKey, c.appTokenEnvKey] : [c.envKey],
          ),
        )
      : null;

    const disabledChannels = registry.getDisabledChannels(sandboxName);
    const disabledEnvKeys = new Set(
      MESSAGING_CHANNELS.filter((c: any) => disabledChannels.includes(c.name)).flatMap((c: any) =>
        c.appTokenEnvKey ? [c.envKey, c.appTokenEnvKey] : [c.envKey],
      ),
    );

    const messagingTokenDefs = [
      { name: `${sandboxName}-discord-bridge`, envKey: "DISCORD_BOT_TOKEN", token: getMessagingToken("DISCORD_BOT_TOKEN") },
      { name: `${sandboxName}-slack-bridge`, envKey: "SLACK_BOT_TOKEN", token: getMessagingToken("SLACK_BOT_TOKEN") },
      { name: `${sandboxName}-slack-app`, envKey: "SLACK_APP_TOKEN", token: getMessagingToken("SLACK_APP_TOKEN") },
      { name: `${sandboxName}-telegram-bridge`, envKey: "TELEGRAM_BOT_TOKEN", token: getMessagingToken("TELEGRAM_BOT_TOKEN") },
    ]
      .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
      .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

    if (webSearchConfig) {
      messagingTokenDefs.push({
        name: `${sandboxName}-brave-search`,
        envKey: webSearch.BRAVE_API_KEY_ENV,
        token: getCredential(webSearch.BRAVE_API_KEY_ENV),
      });
    }

    // Upsert messaging providers into gateway (uses onboard wrapper which injects runOpenshell)
    const messagingProviders: string[] = [];
    for (const { name, envKey, token } of messagingTokenDefs) {
      if (!token) continue;
      const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token });
      if (result.ok) {
        messagingProviders.push(name);
        createArgs.push("--provider", name);
      }
      // Non-fatal for messaging providers — rebuild should not fail over messaging
    }

    // Compute active messaging channels
    const tokensByEnvKey = Object.fromEntries(
      messagingTokenDefs.map(({ envKey, token }) => [envKey, token]),
    );
    const activeMessagingChannels = [
      ...new Set(
        messagingTokenDefs
          .filter(({ token }) => !!token)
          .flatMap(({ envKey }) => {
            if (envKey === "DISCORD_BOT_TOKEN") return ["discord"];
            if (envKey === "SLACK_BOT_TOKEN") return ["slack"];
            if (envKey === "SLACK_APP_TOKEN") return tokensByEnvKey["SLACK_BOT_TOKEN"] ? ["slack"] : [];
            if (envKey === "TELEGRAM_BOT_TOKEN") return ["telegram"];
            return [];
          }),
      ),
    ];

    // Pull base image and resolve digest.
    // pullAndResolveBaseImageDigest() internally calls run(["docker","pull"]) which
    // may call process.exit(1) if docker is missing.  We wrap in a safe fallback
    // so the rebuild path throws RecreateError instead of exiting.
    let resolved: { digest: string; ref: string } | null = null;
    try {
      const imageWithTag = `${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`;
      const pullResult = run(["docker", "pull", imageWithTag], { ignoreError: true, suppressOutput: true });
      if (pullResult.status === 0) {
        const inspectOutput = runCapture(
          ["docker", "inspect", "--format", "{{json .RepoDigests}}", imageWithTag],
          { ignoreError: true },
        );
        try {
          const repoDigests = JSON.parse(inspectOutput || "[]");
          const repoDigest = Array.isArray(repoDigests)
            ? repoDigests.find((entry: string) => entry.startsWith(`${SANDBOX_BASE_IMAGE}@sha256:`))
            : null;
          if (repoDigest) {
            const digest = repoDigest.split("@")[1];
            resolved = { digest, ref: `${SANDBOX_BASE_IMAGE}@${digest}` };
          }
        } catch { /* JSON parse failed — skip pinning */ }
      }
    } catch { /* docker pull failed — continue without pinning */ }
    if (resolved) {
      console.log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
    }

    const buildId = String(Date.now());

    // Build messaging config for Dockerfile patch
    const messagingAllowedIds: Record<string, string[]> = {};
    const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
    for (const ch of MESSAGING_CHANNELS) {
      if (enabledTokenEnvKeys.has(ch.envKey) && ch.allowIdsMode === "dm" && ch.userIdEnvKey && process.env[ch.userIdEnvKey]) {
        const ids = String(process.env[ch.userIdEnvKey]).split(",").map((s: string) => s.trim()).filter(Boolean);
        if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
      }
    }
    const discordGuilds: Record<string, { requireMention: boolean; users?: string[] }> = {};
    if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
      const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
      for (const serverId of serverIds) {
        discordGuilds[serverId] = { requireMention, ...(userIds.length > 0 ? { users: userIds } : {}) };
      }
    }

    patchStagedDockerfile(
      stagedDockerfile, model, chatUiUrl, buildId, provider, preferredInferenceApi,
      webSearchConfig, activeMessagingChannels, messagingAllowedIds, discordGuilds,
      resolved ? resolved.ref : null,
    );

    // Build env args for sandbox
    const envArgs = [
      formatEnvAssignment("CHAT_UI_URL", chatUiUrl),
      formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort),
    ];
    if (webSearchConfig?.fetchEnabled) {
      const braveKey = getCredential(webSearch.BRAVE_API_KEY_ENV) || process.env[webSearch.BRAVE_API_KEY_ENV];
      if (braveKey) envArgs.push(formatEnvAssignment(webSearch.BRAVE_API_KEY_ENV, braveKey));
    }
    if (tokensByEnvKey["SLACK_BOT_TOKEN"]) {
      envArgs.push(formatEnvAssignment("SLACK_BOT_TOKEN", tokensByEnvKey["SLACK_BOT_TOKEN"]));
      if (tokensByEnvKey["SLACK_APP_TOKEN"]) {
        envArgs.push(formatEnvAssignment("SLACK_APP_TOKEN", tokensByEnvKey["SLACK_APP_TOKEN"]));
      }
    }

    const sandboxEnv = buildSubprocessEnv();
    delete sandboxEnv.KUBECONFIG;
    delete sandboxEnv.SSH_AUTH_SOCK;

    const createCommand = `${openshellShellCommand([
      "sandbox", "create", ...createArgs, "--", "env", ...envArgs, "nemoclaw-start",
    ])} 2>&1`;

    const createResult = await streamSandboxCreate(createCommand, sandboxEnv, {
      readyCheck: () => {
        const list = runCaptureOpenshellLocal(["sandbox", "list"], { ignoreError: true });
        return isSandboxReady(list, sandboxName);
      },
    });

    if (createResult.status !== 0) {
      const failure = classifySandboxCreateFailure(createResult.output);
      if (failure.kind !== "sandbox_create_incomplete") {
        throw new RecreateError(
          `Sandbox creation failed (exit ${createResult.status}): ${createResult.output?.slice(0, 500) || "unknown error"}`,
          "sandbox_create_failed",
        );
      }
      console.warn(`  Create stream exited with code ${createResult.status} after sandbox was created.`);
      console.warn("  Checking whether the sandbox reaches Ready state...");
    }

    // Wait for sandbox ready
    if (!waitForSandboxReady(sandboxName)) {
      // Try to clean up the orphaned sandbox
      runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
      throw new RecreateError(
        `Sandbox '${sandboxName}' was created but did not become ready within 60s`,
        "sandbox_create_failed",
      );
    }

    // Dashboard forward
    try {
      runOpenshell(["forward", "start", sandboxName, String(effectivePort), String(effectiveDashboardPort)], { ignoreError: true });
    } catch { /* non-fatal */ }

    // DNS proxy
    try {
      runFile("bash", [path.join(SCRIPTS, "setup-dns-proxy.sh"), GATEWAY_NAME, sandboxName], { ignoreError: true });
    } catch { /* non-fatal */ }

    // Register sandbox
    const providerCredentialHashes: Record<string, string> = {};
    for (const { envKey, token } of messagingTokenDefs) {
      const hash = token ? hashCredential(token) : null;
      if (hash) providerCredentialHashes[envKey] = hash;
    }
    registry.registerSandbox({
      name: sandboxName,
      model: model || null,
      provider: provider || null,
      gpuEnabled: false,
      agent: params.agent || null,
      agentVersion: fromDockerfile ? null : agentDef.expectedVersion || null,
      imageTag: `openshell/sandbox-from:${buildId}`,
      dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
      providerCredentialHashes: Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
      messagingChannels: activeMessagingChannels,
      disabledChannels: disabledChannels.length > 0 ? [...disabledChannels] : undefined,
    });

    console.log(`  ✓ Sandbox '${sandboxName}' created`);
    return sandboxName;
  } catch (err) {
    if (err instanceof RecreateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new RecreateError(`Sandbox creation failed: ${msg}`, "sandbox_create_failed");
  } finally {
    cleanupBuildCtx();
  }
}

export function configureInferenceDirect(params: {
  sandboxName: string;
  provider: string;
  model: string;
  credentialEnv: string | null;
  endpointUrl: string | null;
}): void {
  const { sandboxName, provider, model, credentialEnv, endpointUrl } = params;

  // Select gateway
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  // Find the provider config
  const config = provider === "nvidia-nim"
    ? REMOTE_PROVIDER_CONFIG.build
    : Object.values(REMOTE_PROVIDER_CONFIG).find((entry: any) => entry.providerName === provider);

  if (!config) {
    // Local inference providers (ollama-local, vllm-local) don't need gateway upsert
    if (provider === "ollama-local" || provider === "vllm-local") {
      return; // Local providers are configured at sandbox creation time
    }
    throw new RecreateError(`Unsupported provider configuration: ${provider}`, "inference_failed");
  }

  const resolvedCredentialEnv = credentialEnv || config.credentialEnv;
  const resolvedEndpointUrl = endpointUrl || config.endpointUrl;
  const credentialValue = resolvedCredentialEnv ? resolveProviderCredential(resolvedCredentialEnv) : null;
  const env = resolvedCredentialEnv && credentialValue ? { [resolvedCredentialEnv]: credentialValue } : {};

  // Upsert provider (uses the onboard.ts wrapper which injects runOpenshell)
  const providerResult = upsertProvider(
    provider,
    config.providerType,
    resolvedCredentialEnv,
    resolvedEndpointUrl,
    env,
  );
  if (!providerResult.ok) {
    throw new RecreateError(
      `Failed to configure inference provider '${provider}': ${providerResult.message}`,
      "inference_failed",
    );
  }

  // Set inference route
  const args = ["inference", "set"];
  if (config.skipVerify) {
    args.push("--no-verify");
  }
  args.push("--provider", provider, "--model", model);
  const applyResult = runOpenshell(args, { ignoreError: true });
  if (applyResult.status !== 0) {
    const message = `${applyResult.stderr || ""} ${applyResult.stdout || ""}`.trim() ||
      `Failed to set inference route for '${provider}'.`;
    throw new RecreateError(message, "inference_failed");
  }
}

export function setupAgentDirect(params: {
  sandboxName: string;
  model: string;
  provider: string;
  agent: string | null;
}): void {
  const { sandboxName, model, provider, agent } = params;
  const agentDef = agent ? agentDefs.loadAgent(agent) : agentDefs.loadAgent("openclaw");

  try {
    // Build and apply config sync script (same as setupOpenclaw)
    const selectionConfig = getProviderSelectionConfig(provider, model);

    if (selectionConfig) {
      const sandboxConfig = {
        ...selectionConfig,
        onboardedAt: new Date().toISOString(),
      };
      const script = buildSandboxConfigSyncScript(sandboxConfig);
      const scriptFile = writeSandboxConfigSyncFile(script);
      try {
        const scriptContent = fs.readFileSync(scriptFile, "utf-8");
        run(openshellArgv(["sandbox", "connect", sandboxName]), {
          stdio: ["pipe", "ignore", "inherit"],
          input: scriptContent,
        });
      } finally {
        cleanupTempDir(scriptFile, "nemoclaw-sync");
      }
    }
  } catch (err) {
    if (err instanceof RecreateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new RecreateError(`Agent setup failed: ${msg}`, "agent_setup_failed");
  }
}

export function applyPolicyPresetsDirect(params: {
  sandboxName: string;
  presets: string[];
  webSearchConfig: { fetchEnabled: boolean } | null;
  messagingChannels: string[];
  provider: string;
  dangerouslySkipPermissions: boolean;
}): string[] {
  const { sandboxName, presets, webSearchConfig, messagingChannels, provider, dangerouslySkipPermissions } = params;

  if (dangerouslySkipPermissions) {
    if (!waitForSandboxReady(sandboxName)) {
      throw new RecreateError(`Sandbox '${sandboxName}' not ready for policy application`, "policy_failed");
    }
    shields.shieldsDownPermanent(sandboxName);
    return [];
  }

  if (!waitForSandboxReady(sandboxName)) {
    throw new RecreateError(`Sandbox '${sandboxName}' not ready for policy application`, "policy_failed");
  }

  const presetsToApply = presets.length > 0
    ? presets
    : getSuggestedPolicyPresets({
        enabledChannels: messagingChannels.length > 0 ? messagingChannels : null,
        webSearchConfig,
        provider,
      });

  const applied: string[] = [];
  const failed: string[] = [];
  for (const presetName of presetsToApply) {
    try {
      const ok = policies.applyPreset(sandboxName, presetName);
      if (ok) {
        applied.push(presetName);
      } else {
        failed.push(presetName);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: failed to apply preset '${presetName}': ${msg}`);
      failed.push(presetName);
    }
  }

  if (applied.length === 0 && presetsToApply.length > 0) {
    throw new RecreateError(
      `All policy presets failed to apply: ${failed.join(", ")}`,
      "policy_failed",
    );
  }

  return applied;
}

// ── Orchestrator ─────────────────────────────────────────────────

export async function recreateSandbox(params: RecreateParams): Promise<RecreateResult> {
  // 1. Validate credentials
  validateRecreateCredentials(params.credentialEnv);

  // 2. Create sandbox
  const sandboxName = await createSandboxDirect({
    sandboxName: params.sandboxName,
    model: params.model,
    provider: params.provider,
    preferredInferenceApi: params.preferredInferenceApi,
    webSearchConfig: params.webSearchConfig,
    messagingChannels: params.messagingChannels,
    fromDockerfile: params.fromDockerfile,
    agent: params.agent,
    dangerouslySkipPermissions: params.dangerouslySkipPermissions,
  });

  // 3. Configure inference
  configureInferenceDirect({
    sandboxName,
    provider: params.provider,
    model: params.model,
    credentialEnv: params.credentialEnv,
    endpointUrl: params.endpointUrl,
  });

  // 4. Setup agent
  setupAgentDirect({
    sandboxName,
    model: params.model,
    provider: params.provider,
    agent: params.agent,
  });

  // 5. Apply policy presets
  const appliedPresets = applyPolicyPresetsDirect({
    sandboxName,
    presets: params.policyPresets,
    webSearchConfig: params.webSearchConfig,
    messagingChannels: params.messagingChannels,
    provider: params.provider,
    dangerouslySkipPermissions: params.dangerouslySkipPermissions,
  });

  return { sandboxName, appliedPresets };
}

module.exports = {
  RecreateError,
  recreateSandbox,
  validateRecreateCredentials,
  createSandboxDirect,
  configureInferenceDirect,
  setupAgentDirect,
  applyPolicyPresetsDirect,
};
