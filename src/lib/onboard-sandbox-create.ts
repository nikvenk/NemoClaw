// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SandboxCreateWebSearchConfig {
  fetchEnabled?: boolean | null;
}

export interface SandboxCreateAgent {
  name?: string | null;
  forwardPort?: number;
  expectedVersion?: string | null;
}

export interface SandboxCreateDeps {
  step: (current: number, total: number, message: string) => void;
  validateName: (value: string, label: string) => string;
  promptValidatedSandboxName: () => Promise<string>;
  controlUiPort: number;
  dashboardPort: number;
  getCredential: (envKey: string) => string | null;
  normalizeCredentialValue: (value: string | null | undefined) => string | null;
  messagingChannels: Array<{
    name: string;
    envKey: string;
    appTokenEnvKey?: string | null;
    allowIdsMode?: string | null;
    userIdEnvKey?: string | null;
  }>;
  registry: {
    getSandbox: (sandboxName: string) => any;
    updateSandbox: (sandboxName: string, patch: Record<string, unknown>) => void;
    removeSandbox: (sandboxName: string) => void;
    registerSandbox: (entry: Record<string, unknown>) => void;
  };
  makeConflictProbe: () => any;
  isNonInteractive: () => boolean;
  promptOrDefault: (
    question: string,
    fallback?: string | null,
    defaultValue?: string | null,
  ) => Promise<string>;
  getSandboxReuseState: (sandboxName: string) => string;
  providerExistsInGateway: (name: string) => boolean;
  detectMessagingCredentialRotation: (
    sandboxName: string,
    tokenDefs: Array<{ name: string; envKey: string; token: string | null }>,
  ) => { changed: boolean; changedProviders: string[] };
  isRecreateSandbox: () => boolean;
  upsertMessagingProviders: (
    tokenDefs: Array<{ name: string; envKey: string; token: string | null }>,
  ) => string[];
  note: (message: string) => void;
  ensureDashboardForward: (sandboxName: string, chatUiUrl: string) => void;
  sandboxState: {
    backupSandboxState: (sandboxName: string) => any;
    restoreSandboxState: (sandboxName: string, backupPath: string) => any;
  };
  hashCredential: (value: string) => string | null;
  onboardSession: {
    updateSession: (updater: (current: any) => any) => void;
  };
  runOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  agentOnboard: {
    createAgentSandbox: (agent: SandboxCreateAgent) => { buildCtx: string; stagedDockerfile: string };
    getAgentPermissivePolicyPath: (agent: SandboxCreateAgent) => string | null;
    getAgentPolicyPath: (agent: SandboxCreateAgent) => string | null;
  };
  stageOptimizedSandboxBuildContext: (root: string) => { buildCtx: string; stagedDockerfile: string };
  root: string;
  webSearchBraveApiKeyEnv: string;
  buildSubprocessEnv: () => NodeJS.ProcessEnv;
  formatEnvAssignment: (name: string, value: string) => string;
  runCapture: (command: string | string[], opts?: { ignoreError?: boolean }) => string;
  sandboxBaseImage: string;
  sandboxBaseTag: string;
  pullAndResolveBaseImageDigest: () => { digest: string; ref: string } | null;
  patchStagedDockerfile: (
    dockerfilePath: string,
    model: string,
    chatUiUrl: string,
    buildMeta: string,
    provider: string,
    preferredInferenceApi: string | null,
    webSearchConfig: SandboxCreateWebSearchConfig | null,
    activeMessagingChannels: string[],
    messagingAllowedIds: Record<string, string[]>,
    discordGuilds: Record<string, { requireMention: boolean; users?: string[] }>,
    baseImageRef?: string | null,
  ) => void;
  openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  streamSandboxCreate: (
    command: string,
    env: NodeJS.ProcessEnv,
    options: { readyCheck: () => boolean },
  ) => Promise<{ status: number; output: string }>;
  run: (
    command: string | string[],
    opts?: { ignoreError?: boolean; suppressOutput?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  sleep: (seconds: number) => void;
  classifySandboxCreateFailure: (output: string) => { kind: string };
  printSandboxCreateRecoveryHints: (output: string) => void;
  agentDefs: {
    loadAgent: (name: string) => { expectedVersion?: string | null };
  };
  runFile: (
    file: string,
    args: string[],
    opts?: { ignoreError?: boolean },
  ) => { status?: number } | void;
  scriptsDir: string;
  gatewayName: string;
  discordSnowflakeRe: RegExp;
}

// eslint-disable-next-line complexity
export async function runCreateSandbox(
  gpu: unknown,
  model: string,
  provider: string,
  preferredInferenceApi: string | null = null,
  sandboxNameOverride: string | null = null,
  webSearchConfig: SandboxCreateWebSearchConfig | null = null,
  enabledChannels: string[] | null = null,
  fromDockerfile: string | null = null,
  agent: SandboxCreateAgent | null = null,
  dangerouslySkipPermissions = false,
  deps: SandboxCreateDeps,
): Promise<string> {
  deps.step(6, 8, "Creating sandbox");

  const sandboxName = deps.validateName(
    sandboxNameOverride ?? (await deps.promptValidatedSandboxName()),
    "sandbox name",
  );
  const effectivePort = agent ? agent.forwardPort : deps.controlUiPort;
  const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;

  // Check whether messaging providers will be needed — this must happen before
  // the sandbox reuse decision so we can detect stale sandboxes that were created
  // without provider attachments (security: prevents legacy raw-env-var leaks).
  const getMessagingToken = (envKey: string): string | null =>
    deps.getCredential(envKey) || deps.normalizeCredentialValue(process.env[envKey]) || null;

  // The UI toggle list can include channels the user toggled on but then
  // skipped the token prompt for. Only channels with a real token will have a
  // provider attached, so the conflict check must filter out the skipped ones
  // (otherwise we warn about phantom channels that will never poll).
  const conflictCheckChannels: string[] = Array.isArray(enabledChannels)
    ? enabledChannels.filter((name) => {
        const def = deps.messagingChannels.find((channel) => channel.name === name);
        return def ? !!getMessagingToken(def.envKey) : false;
      })
    : [];

  // Messaging channels like Telegram (getUpdates), Discord (gateway), and Slack
  // (Socket Mode) enforce one consumer per bot token. Two sandboxes sharing
  // a token silently break both bridges (see #1953). Warn before we commit.
  if (conflictCheckChannels.length > 0) {
    const { backfillMessagingChannels, findChannelConflicts } = require("./messaging-conflict");
    backfillMessagingChannels(deps.registry, deps.makeConflictProbe());
    const conflicts = findChannelConflicts(sandboxName, conflictCheckChannels, deps.registry);
    if (conflicts.length > 0) {
      for (const { channel, sandbox } of conflicts) {
        console.log(
          `  ⚠ Sandbox '${sandbox}' already has ${channel} enabled. Bot tokens only allow one sandbox to poll — continuing will break both bridges.`,
        );
      }
      if (deps.isNonInteractive()) {
        console.error(
          "  Aborting: resolve the messaging channel conflict above or run `nemoclaw <sandbox> destroy` on the other sandbox.",
        );
        process.exit(1);
      }
      const answer = (await deps.promptOrDefault("  Continue anyway? [y/N]: ", null, "n"))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("  Aborting sandbox creation.");
        process.exit(1);
      }
    }
  }

  // When enabledChannels is provided (from the toggle picker), only include
  // channels the user selected. When null (backward compat), include all.
  const enabledEnvKeys =
    enabledChannels != null
      ? new Set(
          deps.messagingChannels
            .filter((channel) => enabledChannels.includes(channel.name))
            .flatMap((channel) =>
              channel.appTokenEnvKey
                ? [channel.envKey, channel.appTokenEnvKey]
                : [channel.envKey],
            ),
        )
      : null;

  const messagingTokenDefs: Array<{ name: string; envKey: string; token: string | null }> = [
    {
      name: `${sandboxName}-discord-bridge`,
      envKey: "DISCORD_BOT_TOKEN",
      token: getMessagingToken("DISCORD_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-bridge`,
      envKey: "SLACK_BOT_TOKEN",
      token: getMessagingToken("SLACK_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-app`,
      envKey: "SLACK_APP_TOKEN",
      token: getMessagingToken("SLACK_APP_TOKEN"),
    },
    {
      name: `${sandboxName}-telegram-bridge`,
      envKey: "TELEGRAM_BOT_TOKEN",
      token: getMessagingToken("TELEGRAM_BOT_TOKEN"),
    },
  ].filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey));

  if (webSearchConfig) {
    messagingTokenDefs.push({
      name: `${sandboxName}-brave-search`,
      envKey: deps.webSearchBraveApiKeyEnv,
      token: deps.getCredential(deps.webSearchBraveApiKeyEnv),
    });
  }
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);

  // Reconcile local registry state with the live OpenShell gateway state.
  const existing = deps.registry.getSandbox(sandboxName);
  const liveExists = Boolean(deps.runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true }));
  if (existing && !liveExists) {
    deps.registry.removeSandbox(sandboxName);
  }

  // Declared outside the liveExists block so it is accessible during
  // post-creation restore (the sandbox create path runs after the block).
  let pendingStateRestore: any = null;

  if (liveExists) {
    const existingSandboxState = deps.getSandboxReuseState(sandboxName);

    // Check whether messaging providers are missing from the gateway. Only
    // force recreation when at least one required provider doesn't exist yet —
    // this avoids destroying sandboxes already created with provider attachments.
    const needsProviderMigration =
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !deps.providerExistsInGateway(name));

    // Detect whether any messaging credential has been rotated since the
    // sandbox was created. Provider credentials are resolved once at sandbox
    // startup, so a rotated token requires a rebuild to take effect.
    const credentialRotation = hasMessagingTokens
      ? deps.detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
      : { changed: false, changedProviders: [] };

    if (!deps.isRecreateSandbox() && !needsProviderMigration && !credentialRotation.changed) {
      if (deps.isNonInteractive()) {
        if (existingSandboxState === "ready") {
          // Upsert messaging providers even on reuse so credential changes take
          // effect without requiring a full sandbox recreation.
          deps.upsertMessagingProviders(messagingTokenDefs);
          deps.note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
          deps.note(
            "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
          );
          deps.ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
        console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
        console.error(
          "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.",
        );
        process.exit(1);
      }

      if (existingSandboxState === "ready") {
        console.log(`  Sandbox '${sandboxName}' already exists.`);
        console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
        const answer = await deps.promptOrDefault("  Reuse existing sandbox? [Y/n]: ", null, "y");
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer !== "n" && normalizedAnswer !== "no") {
          deps.upsertMessagingProviders(messagingTokenDefs);
          deps.ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        const answer = await deps.promptOrDefault(
          "  Delete it and create a new one? [Y/n]: ",
          null,
          "y",
        );
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer === "n" || normalizedAnswer === "no") {
          console.log("  Aborting onboarding.");
          process.exit(1);
        }
      }
    }

    // Back up workspace state before destroying the sandbox when triggered
    // by credential rotation, so files can be restored after recreation.
    if (credentialRotation.changed && existingSandboxState === "ready") {
      const rotatedNames = credentialRotation.changedProviders.join(", ");
      console.log(`  Messaging credential(s) rotated: ${rotatedNames}`);
      console.log("  Rebuilding sandbox to propagate new credentials to the L7 proxy...");
      try {
        const backup = deps.sandboxState.backupSandboxState(sandboxName);
        if (backup.success) {
          deps.note(`  ✓ State backed up (${backup.backedUpDirs.length} directories)`);
          pendingStateRestore = backup;
        } else {
          console.error("  State backup failed — aborting rebuild to prevent data loss.");
          console.error("  Pass --recreate-sandbox to force recreation without backup.");
          deps.upsertMessagingProviders(messagingTokenDefs);
          // Update stored hashes so the next onboard doesn't re-detect rotation.
          const abortHashes: Record<string, string> = {};
          for (const { envKey, token } of messagingTokenDefs) {
            if (token) {
              const hash = deps.hashCredential(token);
              if (hash) abortHashes[envKey] = hash;
            }
          }
          if (Object.keys(abortHashes).length > 0) {
            deps.registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
          }
          deps.ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
      } catch (err: any) {
        console.error(`  State backup threw: ${err.message} — aborting rebuild.`);
        console.error("  Pass --recreate-sandbox to force recreation without backup.");
        deps.upsertMessagingProviders(messagingTokenDefs);
        const abortHashes: Record<string, string> = {};
        for (const { envKey, token } of messagingTokenDefs) {
          if (token) {
            const hash = deps.hashCredential(token);
            if (hash) abortHashes[envKey] = hash;
          }
        }
        if (Object.keys(abortHashes).length > 0) {
          deps.registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
        }
        deps.ensureDashboardForward(sandboxName, chatUiUrl);
        return sandboxName;
      }
    }

    if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (credentialRotation.changed) {
      // Message already printed above during backup.
    } else if (existingSandboxState === "ready") {
      deps.note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      deps.note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    const previousEntry = deps.registry.getSandbox(sandboxName);
    if (previousEntry?.policies?.length > 0) {
      deps.onboardSession.updateSession((current) => {
        current.policyPresets = previousEntry.policies;
        return current;
      });
    }

    deps.note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    // Destroy old sandbox
    deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    deps.registry.removeSandbox(sandboxName);
  }

  // Stage build context — use the custom Dockerfile path when provided,
  // otherwise use the optimised default that only sends what the build needs.
  let buildCtx: string;
  let stagedDockerfile: string;
  if (fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    stagedDockerfile = path.join(buildCtx, "Dockerfile");
    // Copy the entire parent directory as build context.
    try {
      fs.cpSync(path.dirname(fromResolved), buildCtx, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
        },
      });
    } catch (err: any) {
      if (err.code === "EACCES") {
        console.error(
          `  Permission denied while copying build context from: ${path.dirname(fromResolved)}`,
        );
        console.error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        console.error("  Move your Dockerfile to a dedicated directory and retry.");
        process.exit(1);
      }
      throw err;
    }
    // If the caller pointed at a file not named "Dockerfile", copy it to the
    // location openshell expects (buildCtx/Dockerfile).
    if (path.basename(fromResolved) !== "Dockerfile") {
      fs.copyFileSync(fromResolved, stagedDockerfile);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
  } else if (agent) {
    const agentBuild = deps.agentOnboard.createAgentSandbox(agent);
    buildCtx = agentBuild.buildCtx;
    stagedDockerfile = agentBuild.stagedDockerfile;
  } else {
    ({ buildCtx, stagedDockerfile } = deps.stageOptimizedSandboxBuildContext(deps.root));
  }

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const globalPermissivePath = path.join(
    deps.root,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox-permissive.yaml",
  );
  let basePolicyPath: string;
  if (dangerouslySkipPermissions) {
    // Permissive mode: use agent-specific permissive policy if available,
    // otherwise fall back to the global permissive policy.
    const agentPermissive = agent && deps.agentOnboard.getAgentPermissivePolicyPath(agent);
    basePolicyPath = agentPermissive || globalPermissivePath;
  } else {
    const defaultPolicyPath = path.join(
      deps.root,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox.yaml",
    );
    basePolicyPath = (agent && deps.agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  }
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    basePolicyPath,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  // Create OpenShell providers for messaging credentials so they flow through
  // the provider/placeholder system instead of raw env vars. The L7 proxy
  // rewrites Authorization headers (Bearer/Bot) and URL-path segments
  // (/bot{TOKEN}/) with real secrets at egress (OpenShell ≥ 0.0.20).
  const messagingProviders = deps.upsertMessagingProviders(messagingTokenDefs);
  for (const providerName of messagingProviders) {
    createArgs.push("--provider", providerName);
  }

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  if (webSearchConfig && !deps.getCredential(deps.webSearchBraveApiKeyEnv)) {
    console.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    console.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    process.exit(1);
  }
  const tokensByEnvKey = Object.fromEntries(
    messagingTokenDefs.map(({ envKey, token }) => [envKey, token]),
  ) as Record<string, string | null>;
  const activeMessagingChannels = [
    ...new Set(
      messagingTokenDefs.flatMap(({ envKey, token }) => {
        if (!token) return [];
        if (envKey === "DISCORD_BOT_TOKEN") return ["discord"];
        if (envKey === "SLACK_BOT_TOKEN") return ["slack"];
        // SLACK_APP_TOKEN alone does not enable slack; bot token is required.
        if (envKey === "SLACK_APP_TOKEN") {
          return tokensByEnvKey["SLACK_BOT_TOKEN"] ? ["slack"] : [];
        }
        if (envKey === "TELEGRAM_BOT_TOKEN") return ["telegram"];
        return [];
      }),
    ),
  ];
  // Build allowed sender IDs map from env vars set during the messaging prompt.
  // Each channel with a userIdEnvKey in MESSAGING_CHANNELS may have a
  // comma-separated list of IDs (e.g. TELEGRAM_ALLOWED_IDS="123,456").
  const messagingAllowedIds: Record<string, string[]> = {};
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  for (const channel of deps.messagingChannels) {
    const rawIds = channel.userIdEnvKey ? process.env[channel.userIdEnvKey] : null;
    if (
      enabledTokenEnvKeys.has(channel.envKey) &&
      channel.allowIdsMode === "dm" &&
      channel.userIdEnvKey &&
      rawIds
    ) {
      const ids = rawIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (ids.length > 0) messagingAllowedIds[channel.name] = ids;
    }
  }
  const discordGuilds: Record<string, { requireMention: boolean; users?: string[] }> = {};
  if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
    const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const serverId of serverIds) {
      if (!deps.discordSnowflakeRe.test(serverId)) {
        console.warn(`  Warning: Discord server ID '${serverId}' does not look like a snowflake.`);
      }
    }
    for (const userId of userIds) {
      if (!deps.discordSnowflakeRe.test(userId)) {
        console.warn(`  Warning: Discord user ID '${userId}' does not look like a snowflake.`);
      }
    }
    const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
    for (const serverId of serverIds) {
      discordGuilds[serverId] = {
        requireMention,
        ...(userIds.length > 0 ? { users: userIds } : {}),
      };
    }
  }
  // Pull the base image and resolve its digest so the Dockerfile is pinned to
  // exactly what we just fetched. This prevents stale :latest tags from
  // silently reusing a cached old image after NemoClaw upgrades (#1904).
  const resolved = deps.pullAndResolveBaseImageDigest();
  if (resolved) {
    console.log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
  } else {
    // Check if the image exists locally before falling back to unpinned :latest.
    // On a first-time install behind a firewall with no cached image, warn early
    // so the user knows the build will likely fail.
    const localCheck = deps.runCapture(
      ["docker", "image", "inspect", `${deps.sandboxBaseImage}:${deps.sandboxBaseTag}`],
      { ignoreError: true },
    );
    if (localCheck) {
      console.warn("  Warning: could not pull base image from registry; using cached :latest.");
    } else {
      console.warn(
        `  Warning: base image ${deps.sandboxBaseImage}:${deps.sandboxBaseTag} is not available locally.`,
      );
      console.warn("  The build will fail unless Docker can pull the image during build.");
      console.warn("  If offline, pull the image manually first:");
      console.warn(`    docker pull ${deps.sandboxBaseImage}:${deps.sandboxBaseTag}`);
    }
  }
  deps.patchStagedDockerfile(
    stagedDockerfile,
    model,
    chatUiUrl,
    String(Date.now()),
    provider,
    preferredInferenceApi,
    webSearchConfig,
    activeMessagingChannels,
    messagingAllowedIds,
    discordGuilds,
    resolved ? resolved.ref : null,
  );
  // Only pass non-sensitive env vars to the sandbox. Credentials flow through
  // OpenShell providers — the gateway injects them as placeholders and the L7
  // proxy rewrites Authorization headers with real secrets at egress.
  // See: crates/openshell-sandbox/src/secrets.rs (placeholder rewriting),
  //      crates/openshell-router/src/backend.rs (inference auth injection).
  //
  // Use the shared allowlist (subprocess-env.ts) instead of the old
  // blocklist. The blocklist only blocked 12 specific credential names
  // and passed EVERYTHING else — including GITHUB_TOKEN,
  // AWS_SECRET_ACCESS_KEY, SSH_AUTH_SOCK, KUBECONFIG, NPM_TOKEN, and
  // any CI/CD secrets that happened to be in the host environment.
  // The allowlist inverts the default: only known-safe env vars are
  // forwarded, everything else is dropped.
  //
  // For the sandbox specifically, we also strip KUBECONFIG and
  // SSH_AUTH_SOCK — the generic allowlist includes these for host-side
  // subprocesses (gateway start, openshell CLI) but the sandbox should
  // never have access to the host's Kubernetes cluster or SSH agent.
  const envArgs = [deps.formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
  // Pass the configured dashboard port into the sandbox so nemoclaw-start.sh
  // can unconditionally override CHAT_UI_URL even when the Docker image was
  // built with a different default. Without this, the baked-in Docker ENV
  // value takes precedence and the gateway starts on the wrong port. (#1925)
  if (process.env.NEMOCLAW_DASHBOARD_PORT) {
    envArgs.push(
      deps.formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", String(deps.dashboardPort)),
    );
  }
  if (webSearchConfig?.fetchEnabled) {
    const braveKey =
      deps.getCredential(deps.webSearchBraveApiKeyEnv) || process.env[deps.webSearchBraveApiKeyEnv];
    if (braveKey) {
      envArgs.push(deps.formatEnvAssignment(deps.webSearchBraveApiKeyEnv, braveKey));
    }
  }
  const sandboxEnv = deps.buildSubprocessEnv();
  // Remove host-infrastructure credentials that the generic allowlist
  // permits for host-side processes but that must not enter the sandbox.
  delete sandboxEnv.KUBECONFIG;
  delete sandboxEnv.SSH_AUTH_SOCK;
  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const createCommand = `${deps.openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    "env",
    ...envArgs,
    "nemoclaw-start",
  ])} 2>&1`;
  const createResult = await deps.streamSandboxCreate(createCommand, sandboxEnv, {
    readyCheck: () => {
      const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      return deps.isSandboxReady(list, sandboxName);
    },
  });

  // Clean up build context regardless of outcome
  deps.run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  if (createResult.status !== 0) {
    const failure = deps.classifySandboxCreateFailure(createResult.output);
    if (failure.kind === "sandbox_create_incomplete") {
      // The sandbox was created in the gateway but the create stream exited
      // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
      // loop — the sandbox may still reach Ready on its own.
      console.warn("");
      console.warn(
        `  Create stream exited with code ${createResult.status} after sandbox was created.`,
      );
      console.warn("  Checking whether the sandbox reaches Ready state...");
    } else {
      console.error("");
      console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
      if (createResult.output) {
        console.error("");
        console.error(createResult.output);
      }
      console.error("  Try:  openshell sandbox list        # check gateway state");
      deps.printSandboxCreateRecoveryHints(createResult.output);
      process.exit(createResult.status || 1);
    }
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (deps.isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    deps.sleep(2);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  // Wait for NemoClaw dashboard to become fully ready (web server live)
  // This prevents port forwards from connecting to a non-existent port
  // or seeing 502/503 errors during initial load.
  console.log("  Waiting for NemoClaw dashboard to become ready...");
  for (let i = 0; i < 15; i++) {
    const readyMatch = deps.runCaptureOpenshell(
      ["sandbox", "exec", sandboxName, "curl", "-sf", `http://localhost:${deps.controlUiPort}/`],
      { ignoreError: true },
    );
    if (readyMatch) {
      console.log("  ✓ Dashboard is live");
      break;
    }
    if (i === 14) {
      console.warn("  Dashboard taking longer than expected to start. Continuing...");
    } else {
      deps.sleep(2);
    }
  }

  // Release any stale forward on the dashboard port before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  deps.ensureDashboardForward(sandboxName, chatUiUrl);

  // Register only after confirmed ready — prevents phantom entries
  const effectiveAgent = agent || deps.agentDefs.loadAgent("openclaw");
  const providerCredentialHashes: Record<string, string> = {};
  for (const { envKey, token } of messagingTokenDefs) {
    if (token) {
      const hash = deps.hashCredential(token);
      if (hash) {
        providerCredentialHashes[envKey] = hash;
      }
    }
  }
  deps.registry.registerSandbox({
    name: sandboxName,
    model: model || null,
    provider: provider || null,
    gpuEnabled: !!gpu,
    agent: agent ? agent.name : null,
    agentVersion: fromDockerfile ? null : effectiveAgent.expectedVersion || null,
    dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
    providerCredentialHashes:
      Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    messagingChannels: activeMessagingChannels,
  });

  // Restore workspace state if we backed it up during credential rotation.
  if (pendingStateRestore?.success) {
    deps.note("  Restoring workspace state after credential rotation...");
    const restore = deps.sandboxState.restoreSandboxState(
      sandboxName,
      pendingStateRestore.manifest.backupPath,
    );
    if (restore.success) {
      deps.note(`  ✓ State restored (${restore.restoredDirs.length} directories)`);
    } else {
      console.error(
        `  Warning: partial restore. Manual recovery: ${pendingStateRestore.manifest.backupPath}`,
      );
    }
  }

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  console.log("  Setting up sandbox DNS proxy...");
  deps.runFile("bash", [path.join(deps.scriptsDir, "setup-dns-proxy.sh"), deps.gatewayName, sandboxName], {
    ignoreError: true,
  });

  // Check that messaging providers exist in the gateway (sandbox attachment
  // cannot be verified via CLI yet — only gateway-level existence is checked).
  for (const providerName of messagingProviders) {
    if (!deps.providerExistsInGateway(providerName)) {
      console.error(`  ⚠ Messaging provider '${providerName}' was not found in the gateway.`);
      console.error(`    The credential may not be available inside the sandbox.`);
      console.error(
        `    To fix: openshell provider create --name ${providerName} --type generic --credential <KEY>`,
      );
    }
  }

  console.log(`  ✓ Sandbox '${sandboxName}' created`);

  try {
    if (process.platform === "darwin") {
      const vmKernel = deps.runCapture("docker info --format '{{.KernelVersion}}'", {
        ignoreError: true,
      }).trim();
      if (vmKernel) {
        const parts = vmKernel.split(".");
        const major = parseInt(parts[0], 10);
        const minor = parseInt(parts[1], 10);
        if (!Number.isNaN(major) && !Number.isNaN(minor) && (major < 5 || (major === 5 && minor < 13))) {
          console.warn(
            `  ⚠ Landlock: Docker VM kernel ${vmKernel} does not support Landlock (requires ≥5.13).`,
          );
          console.warn(
            "    Sandbox filesystem restrictions will silently degrade (best_effort mode).",
          );
        }
      }
    } else if (process.platform === "linux") {
      const uname = deps.runCapture("uname -r", { ignoreError: true }).trim();
      if (uname) {
        const parts = uname.split(".");
        const major = parseInt(parts[0], 10);
        const minor = parseInt(parts[1], 10);
        if (!Number.isNaN(major) && !Number.isNaN(minor) && (major < 5 || (major === 5 && minor < 13))) {
          console.warn(`  ⚠ Landlock: Kernel ${uname} does not support Landlock (requires ≥5.13).`);
          console.warn(
            "    Sandbox filesystem restrictions will silently degrade (best_effort mode).",
          );
        }
      }
    }
  } catch {}

  return sandboxName;
}
