// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const pRetry = require("p-retry");
const { ANSI_RE } = require("./ansi-utils");

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}
/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);

const { ROOT, SCRIPTS, redact, run, runCapture, runFile, shellQuote, validateName } = require("./runner");
const { stageOptimizedSandboxBuildContext } = require("./sandbox-build-context");
const { buildSubprocessEnv } = require("./subprocess-env");
const { DASHBOARD_PORT, GATEWAY_PORT, VLLM_PORT, OLLAMA_PORT, OLLAMA_PROXY_PORT } = require("./ports");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
  parseGatewayInference,
} = require("./inference-config");

const {
  getSuggestedPolicyPresets: getSuggestedPolicyPresetsWithDeps,
  LOCAL_INFERENCE_PROVIDERS,
} = require("./onboard-policy-suggestions");
const { inferContainerRuntime, isWsl, shouldPatchCoredns } = require("./platform");
const { resolveOpenshell } = require("./resolve-openshell");
const {
  prompt,
  ensureApiKey,
  getCredential,
  normalizeCredentialValue,
  saveCredential,
} = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const onboardSession = require("./onboard-session");
const { ONBOARD_STEP_META, isOnboardStepName, toVisibleStepName } = require("./onboard-fsm");
const { initializeOnboardRun } = require("./onboard-bootstrap");
const {
  getGatewayStartEnv: buildGatewayStartEnv,
  recoverGatewayRuntime: recoverGatewayRuntimeWithDeps,
  startGatewayWithOptions: startGatewayWithOptionsWithDeps,
} = require("./onboard-gateway-runtime");
const { runSetupNim: setupNimWithDeps } = require("./onboard-nim-setup");
const { runOnboardPreflight } = require("./onboard-preflight-run");
const { runCreateSandbox } = require("./onboard-sandbox-create");
const { runSetupInference } = require("./onboard-inference-provider");
const {
  arePolicyPresetsApplied: arePolicyPresetsAppliedWithDeps,
  presetsCheckboxSelector: presetsCheckboxSelectorWithDeps,
  selectPolicyTier: selectPolicyTierWithDeps,
  selectTierPresetsAndAccess: selectTierPresetsAndAccessWithDeps,
  setupPoliciesLegacy: setupPoliciesLegacyWithDeps,
  setupPoliciesWithSelection: setupPoliciesWithSelectionWithDeps,
} = require("./onboard-policy-ui");
const { MESSAGING_CHANNELS, setupMessagingChannels: setupMessagingChannelsWithDeps } = require("./onboard-messaging");
const { promptValidatedSandboxName: promptValidatedSandboxNameWithDeps } = require("./onboard-sandbox-name");
const {
  buildAuthenticatedDashboardUrl,
  ensureDashboardForward: ensureDashboardForwardWithDeps,
  fetchGatewayAuthTokenFromSandbox: fetchGatewayAuthTokenFromSandboxWithDeps,
  getDashboardAccessInfo: getDashboardAccessInfoWithDeps,
  getDashboardForwardPort,
  getDashboardForwardStartCommand: getDashboardForwardStartCommandWithDeps,
  getDashboardForwardTarget,
  getDashboardGuidanceLines,
  getWslHostAddress,
} = require("./onboard-dashboard");
const { printOnboardDashboard } = require("./onboard-dashboard-print");
const { runOnboardingEntry } = require("./onboard-entry");
const { createOnboardingOrchestratorDeps } = require("./onboard-orchestrator-deps");
const { runOnboardingOrchestrator } = require("./onboard-orchestrator");
const { createOnboardRunContext } = require("./onboard-run-context");
const {
  buildOnboardLockCommand,
  getDangerouslySkipPermissionsWarningLines,
  getOnboardBannerLines,
  getOnboardLockConflictLines,
  resolveOnboardShellState,
} = require("./onboard-shell");
const {
  getEffectiveProviderName: resolveEffectiveProviderName,
  getNonInteractiveModel: resolveNonInteractiveModel,
  getNonInteractiveProvider: resolveNonInteractiveProvider,
  getRequestedModelHint: resolveRequestedModelHint,
  getRequestedProviderHint: resolveRequestedProviderHint,
  getRequestedSandboxNameHint: resolveRequestedSandboxNameHint,
  getResumeConfigConflicts: collectRequestedResumeConfigConflicts,
  getResumeSandboxConflict: detectRequestedResumeSandboxConflict,
} = require("./onboard-requests");
const {
  installOpenshell: installOpenshellWithDeps,
  isOpenshellInstalled: detectInstalledOpenshell,
  waitForSandboxReady: waitForSandboxReadyWithDeps,
} = require("./onboard-openshell");
const {
  getContainerRuntime: resolveContainerRuntime,
  getFutureShellPathHint: resolveFutureShellPathHint,
  getPortConflictServiceHints: resolvePortConflictServiceHints,
  printRemediationActions: renderRemediationActions,
} = require("./onboard-remediation");
const policies = require("./policies");
const tiers = require("./tiers");
const { ensureUsageNoticeConsent } = require("./usage-notice");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getMemoryInfo,
  planHostRemediation,
} = require("./preflight");
const agentOnboard = require("./agent-onboard");
const agentDefs = require("./agent-defs");

const gatewayState = require("./gateway-state");
const sandboxState = require("./sandbox-state");
const validation = require("./validation");
const urlUtils = require("./url-utils");
const buildContext = require("./build-context");
const dashboard = require("./dashboard");
const httpProbe = require("./http-probe");
const modelPrompts = require("./model-prompts");
const providerModels = require("./provider-models");
const sandboxCreateStream = require("./sandbox-create-stream");
const validationRecovery = require("./validation-recovery");
const webSearch = require("./web-search");

/**
 * Create a temp file inside a directory with a cryptographically random name.
 * Uses fs.mkdtempSync (OS-level mkdtemp) to avoid predictable filenames that
 * could be exploited via symlink attacks on shared /tmp.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1093
 */
function secureTempFile(prefix, ext = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, `${prefix}${ext}`);
}

/**
 * Safely remove a mkdtemp-created directory.  Guards against accidentally
 * deleting the system temp root if a caller passes os.tmpdir() itself.
 */
function cleanupTempDir(filePath, expectedPrefix) {
  const parentDir = path.dirname(filePath);
  if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith(`${expectedPrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN = null;
const GATEWAY_NAME = "nemoclaw";
const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";

/**
 * Probe whether the gateway Docker container is actually running.
 * openshell CLI metadata can be stale after a manual `docker rm`, so this
 * verifies the container is live before trusting a "healthy" reuse state.
 *
 * Returns "running" | "missing" | "unknown".
 * - "running"  — container exists and State.Running is true
 * - "missing"  — container was removed or exists but is stopped (not reusable)
 * - "unknown"  — any other failure (daemon down, timeout, etc.)
 *
 * Callers should only trigger stale-metadata cleanup on "missing", not on
 * "unknown", to avoid destroying a healthy gateway when Docker is temporarily
 * unavailable.  See #2020.
 */
function verifyGatewayContainerRunning() {
  const containerName = `openshell-cluster-${GATEWAY_NAME}`;
  const result = run(
    `docker inspect --type container --format '{{.State.Running}}' ${containerName}`,
    { ignoreError: true, suppressOutput: true },
  );
  if (result.status === 0 && String(result.stdout || "").trim() === "true") {
    return "running";
  }
  // Container exists but is stopped (exit 0, Running !== "true")
  if (result.status === 0) {
    return "missing";
  }
  const stderr = (result.stderr || "").toString();
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return "missing";
  }
  return "unknown";
}
const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_API_KEY",
    endpointUrl: BUILD_ENDPOINT_URL,
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
    skipVerify: true,
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: OPENAI_ENDPOINT_URL,
    helpUrl: "https://platform.openai.com/api-keys",
    modelMode: "curated",
    defaultModel: "gpt-5.4",
    skipVerify: true,
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-prod",
    providerType: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpointUrl: ANTHROPIC_ENDPOINT_URL,
    helpUrl: "https://console.anthropic.com/settings/keys",
    modelMode: "curated",
    defaultModel: "claude-sonnet-4-6",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    providerType: "anthropic",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    providerType: "openai",
    credentialEnv: "GEMINI_API_KEY",
    endpointUrl: GEMINI_ENDPOINT_URL,
    helpUrl: "https://aistudio.google.com/app/apikey",
    modelMode: "curated",
    defaultModel: "gemini-2.5-flash",
    skipVerify: true,
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
};

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;

function isNonInteractive() {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox() {
  return RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
}

function note(message) {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

// ── Helpers ──────────────────────────────────────────────────────

// Gateway state functions — delegated to src/lib/gateway-state.ts
const {
  isSandboxReady,
  hasStaleGateway,
  isSelectedGateway,
  isGatewayHealthy,
  getGatewayReuseState,
  getSandboxStateFromOutputs,
} = gatewayState;

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
function pruneKnownHostsEntries(contents) {
  return contents
    .split("\n")
    .filter((l) => {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const hostField = trimmed.split(/\s+/)[0];
      return !hostField.split(",").some((h) => h.startsWith("openshell-"));
    })
    .join("\n");
}

function getSandboxReuseState(sandboxName) {
  if (!sandboxName) return "missing";
  const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function repairRecordedSandbox(sandboxName) {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

const { streamSandboxCreate } = sandboxCreateStream;

/** Spawn `openshell gateway start` and stream its output with progress heartbeats. */
function streamGatewayStart(command, env = process.env) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let settled = false;
  let resolvePromise;
  let lastPrintedLine = "";
  let currentPhase = "cluster";
  let lastHeartbeatBucket = -1;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  function getDisplayWidth() {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line) {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line) {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      console.log(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase) {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    const phaseLine =
      nextPhase === "install"
        ? "  Installing OpenShell components..."
        : nextPhase === "pod"
          ? "  Starting OpenShell gateway pod..."
          : nextPhase === "health"
            ? "  Waiting for gateway health..."
            : "  Starting gateway cluster...";
    printProgressLine(phaseLine);
  }

  function classifyLine(line) {
    if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
    if (
      /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
    ) {
      return "pod";
    }
    if (/Gateway .* ready\.?$/i.test(line)) return "health";
    return null;
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    const nextPhase = classifyLine(line);
    if (nextPhase) setPhase(nextPhase);
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    clearInterval(heartbeatTimer);
    resolvePromise(result);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  printProgressLine("  Starting gateway cluster...");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 10);
    if (bucket === lastHeartbeatBucket) return;
    if (Date.now() - lastOutputAt < 3000 && elapsed < 10) return;
    const heartbeatLine =
      currentPhase === "install"
        ? `  Still installing OpenShell components... (${elapsed}s elapsed)`
        : currentPhase === "pod"
          ? `  Still starting OpenShell gateway pod... (${elapsed}s elapsed)`
          : currentPhase === "health"
            ? `  Still waiting for gateway health... (${elapsed}s elapsed)`
            : `  Still starting gateway cluster... (${elapsed}s elapsed)`;
    printProgressLine(heartbeatLine);
    lastHeartbeatBucket = bucket;
  }, 5000);
  heartbeatTimer.unref?.();

  // Hard timeout to prevent indefinite hangs if the openshell process
  // never exits (e.g. Docker daemon unresponsive, k3s restart loop). (#1830)
  // On timeout, send SIGTERM and let the `close` event resolve the promise
  // so the child has actually exited before the caller proceeds to retry.
  const GATEWAY_START_TIMEOUT = envInt("NEMOCLAW_GATEWAY_START_TIMEOUT", 600) * 1000;
  let killedByTimeout = false;
  const killTimer = setTimeout(() => {
    killedByTimeout = true;
    lines.push("[NemoClaw] Gateway start timed out — killing process.");
    child.kill("SIGTERM");
    // If SIGTERM is ignored, force-kill after 10s.
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000).unref?.();
  }, GATEWAY_START_TIMEOUT);
  killTimer.unref?.();

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      clearTimeout(killTimer);
      const detail = error?.message || String(error);
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n") });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const exitCode = killedByTimeout ? 1 : (code ?? 1);
      finish({ status: exitCode, output: lines.join("\n") });
    });
  });
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  const output = String(versionOutput ?? runCapture("openshell -V", { ignoreError: true })).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) return null;
  return match[1];
}

/**
 * Compare two semver-like x.y.z strings. Returns true iff `left >= right`.
 * Non-numeric or missing components are treated as 0.
 */
function versionGte(left = "0.0.0", right = "0.0.0") {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Read a semver field from nemoclaw-blueprint/blueprint.yaml. Returns null if
 * the blueprint or field is missing or unparseable — callers must treat null
 * as "no constraint configured" so a malformed install does not become a hard
 * onboard blocker. See #1317.
 */
function getBlueprintVersionField(field, rootDir = ROOT) {
  try {
    // Lazy require: yaml is already a dependency via the policy helpers but
    // pulling it at module load would slow down `nemoclaw --help` for users
    // who never reach the preflight path.
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const value = parsed && parsed[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function getBlueprintMinOpenshellVersion(rootDir = ROOT) {
  return getBlueprintVersionField("min_openshell_version", rootDir);
}

function getBlueprintMaxOpenshellVersion(rootDir = ROOT) {
  return getBlueprintVersionField("max_openshell_version", rootDir);
}

// ── Base image digest resolution ────────────────────────────────
// Pulls the sandbox-base image from GHCR and inspects it to get the
// actual repo digest. This avoids the registry mismatch that broke
// e2e tests in #1937 — the digest always comes from the same registry
// we're pinning to. See #1904.

const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const SANDBOX_BASE_TAG = "latest";

/**
 * Pull sandbox-base:latest from GHCR and resolve its repo digest.
 * Returns { digest, ref } on success, or null when the pull or
 * inspect fails (offline, GHCR outage, local-only build).
 */
function pullAndResolveBaseImageDigest() {
  const imageWithTag = `${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`;
  try {
    run(["docker", "pull", imageWithTag], { suppressOutput: true });
  } catch {
    // Pull failed — caller should fall back to unpin :latest
    return null;
  }

  let inspectOutput;
  try {
    inspectOutput = runCapture(
      ["docker", "inspect", "--format", "{{json .RepoDigests}}", imageWithTag],
      { ignoreError: false },
    );
  } catch {
    return null;
  }

  // RepoDigests is a JSON array like ["ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc..."].
  // Filter to the entry matching our registry — index ordering is not guaranteed.
  let repoDigests;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    return null;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => entry.startsWith(`${SANDBOX_BASE_IMAGE}@sha256:`))
    : null;
  if (!repoDigest) return null;

  const digest = repoDigest.slice(repoDigest.indexOf("@") + 1);
  const ref = `${SANDBOX_BASE_IMAGE}@${digest}`;
  return { digest, ref };
}

function getStableGatewayImageRef(versionOutput = null) {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function getOpenshellBinary() {
  if (OPENSHELL_BIN) return OPENSHELL_BIN;
  const resolved = resolveOpenshell();
  if (!resolved) {
    console.error("  openshell CLI not found.");
    console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
    process.exit(1);
  }
  OPENSHELL_BIN = resolved;
  return OPENSHELL_BIN;
}

function openshellShellCommand(args, options = {}) {
  const openshellBinary = options.openshellBinary || getOpenshellBinary();
  return [shellQuote(openshellBinary), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function runOpenshell(args, opts = {}) {
  return run(openshellShellCommand(args), opts);
}

function runCaptureOpenshell(args, opts = {}) {
  return runCapture(openshellShellCommand(args), opts);
}

// URL/string utilities — delegated to src/lib/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;

function hydrateCredentialEnv(envName) {
  if (!envName) return null;
  const value = getCredential(envName);
  if (value) {
    process.env[envName] = value;
  }
  return value || null;
}

const {
  getCurlTimingArgs,
  summarizeCurlFailure,
  summarizeProbeFailure,
  runCurlProbe,
  runStreamingEventProbe,
} = httpProbe;

function getNavigationChoice(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt() {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

const { getTransportRecoveryMessage, getProbeRecovery } = validationRecovery;

// Validation functions — delegated to src/lib/validation.ts
const {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  isNvcfFunctionNotFoundForAccount,
  nvcfFunctionNotFoundMessage,
  shouldSkipResponsesProbe,
  shouldForceCompletionsApi,
} = validation;

// validateNvidiaApiKeyValue — see validation import above

async function replaceNamedCredential(envName, label, helpUrl = null, validator = null) {
  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  while (true) {
    const key = normalizeCredentialValue(await prompt(`  ${label}: `, { secret: true }));
    if (!key) {
      console.error(`  ${label} is required.`);
      continue;
    }
    const validationError = typeof validator === "function" ? validator(key) : null;
    if (validationError) {
      console.error(validationError);
      continue;
    }
    saveCredential(envName, key);
    process.env[envName] = key;
    console.log("");
    console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
    console.log("");
    return key;
  }
}

async function promptValidationRecovery(label, recovery, credentialEnv = null, helpUrl = null) {
  if (isNonInteractive()) {
    process.exit(1);
  }

  if (recovery.kind === "credential" && credentialEnv) {
    console.log(
      `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
    );
    console.log("  ⚠️  Do NOT paste your API key here — use the options below:");
    const choice = (
      await prompt("  Options: retry (re-enter key), back (change provider), exit [retry]: ", {
        secret: true,
      })
    )
      .trim()
      .toLowerCase();
    // Guard against the user accidentally pasting an API key at this prompt.
    // Tokens don't contain spaces; human sentences do — the no-space + length check
    // avoids false-positives on long typed sentences.
    const API_KEY_PREFIXES = ["nvapi-", "ghp_", "gcm-", "sk-", "gpt-", "gemini-", "nvcf-"];
    const looksLikeToken =
      API_KEY_PREFIXES.some((p) => choice.startsWith(p)) ||
      (!choice.includes(" ") && choice.length > 40) ||
      // Regex fallback: base64-safe token pattern (20+ chars, no spaces, mixed alphanum)
      /^[A-Za-z0-9_\-\.]{20,}$/.test(choice);
    const validator = credentialEnv === "NVIDIA_API_KEY" ? validateNvidiaApiKeyValue : null;
    if (looksLikeToken) {
      console.log("  ⚠️  That looks like an API key — do not paste credentials here.");
      console.log("  Treating as 'retry'. You will be prompted to enter the key securely.");
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
      return "credential";
    }
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
      return "credential";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "transport") {
    console.log(getTransportRecoveryMessage(recovery.failure || {}));
    const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      console.log("");
      return "retry";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "model") {
    console.log(`  Please enter a different ${label} model name.`);
    console.log("");
    return "model";
  }

  console.log("  Please choose a provider/model again.");
  console.log("");
  return "selection";
}

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 * @param {"create"|"update"} action - Whether to create or update.
 * @param {string} name - Provider name.
 * @param {string} type - Provider type (e.g. "openai", "anthropic", "generic").
 * @param {string} credentialEnv - Credential environment variable name.
 * @param {string|null} baseUrl - Optional base URL for API-compatible endpoints.
 * @returns {string[]} Argument array for runOpenshell().
 */
function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
      : ["provider", "update", name, "--credential", credentialEnv];
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

/**
 * Create or update an OpenShell provider in the gateway.
 *
 * Checks whether the provider already exists via `openshell provider get`;
 * uses `create` for new providers and `update` for existing ones.
 * @param {string} name - Provider name (e.g. "discord-bridge", "inference").
 * @param {string} type - Provider type ("openai", "anthropic", "generic").
 * @param {string} credentialEnv - Environment variable name for the credential.
 * @param {string|null} baseUrl - Optional base URL for the provider endpoint.
 * @param {Record<string, string>} [env={}] - Environment variables for the openshell command.
 * @returns {{ ok: boolean, status?: number, message?: string }}
 */
function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
  const exists = providerExistsInGateway(name);
  const action = exists ? "update" : "create";
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl);
  const runOpts = { ignoreError: true, env, stdio: ["ignore", "pipe", "pipe"] };
  const result = runOpenshell(args, runOpts);
  if (result.status !== 0) {
    const output =
      compactText(redact(`${result.stderr || ""}`)) ||
      compactText(redact(`${result.stdout || ""}`)) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  return { ok: true };
}

/**
 * Upsert all messaging providers that have tokens configured.
 * Returns the list of provider names that were successfully created/updated.
 * Exits the process if any upsert fails.
 * @param {Array<{name: string, envKey: string, token: string|null}>} tokenDefs
 * @returns {string[]} Provider names that were upserted.
 */
function upsertMessagingProviders(tokenDefs) {
  const providers = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token });
    if (!result.ok) {
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    providers.push(name);
  }
  return providers;
}

/**
 * Check whether an OpenShell provider exists in the gateway.
 *
 * Queries the gateway-level provider registry via `openshell provider get`.
 * Does NOT verify that the provider is attached to a specific sandbox —
 * OpenShell CLI does not currently expose a sandbox-scoped provider query.
 * @param {string} name - Provider name to look up (e.g. "discord-bridge").
 * @returns {boolean} True if the provider exists in the gateway.
 */
function providerExistsInGateway(name) {
  const result = runOpenshell(["provider", "get", name], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * Compute a SHA-256 hash of a credential value for change detection.
 * Stored in the sandbox registry so we can detect rotation on reuse
 * without needing to read the credential back from OpenShell.
 * @param {string} value - Credential value to hash.
 * @returns {string|null} Hex-encoded SHA-256 hash, or null if value is falsy.
 */
function hashCredential(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim()).digest("hex");
}

/**
 * Detect whether any messaging provider credential has been rotated since
 * the sandbox was created, by comparing SHA-256 hashes of the current
 * token values against hashes stored in the sandbox registry.
 *
 * Returns `changed: false` for legacy sandboxes that have no stored hashes
 * (conservative — avoids unnecessary rebuilds after upgrade).
 *
 * @param {string} sandboxName - Name of the sandbox to check.
 * @param {Array<{name: string, envKey: string, token: string|null}>} tokenDefs
 * @returns {{ changed: boolean, changedProviders: string[] }}
 */
function detectMessagingCredentialRotation(sandboxName, tokenDefs) {
  const sb = registry.getSandbox(sandboxName);
  const storedHashes = sb?.providerCredentialHashes || {};
  const changedProviders = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const storedHash = storedHashes[envKey];
    if (!storedHash) continue;
    if (storedHash !== hashCredential(token)) {
      changedProviders.push(name);
    }
  }
  return { changed: changedProviders.length > 0, changedProviders };
}

// Tri-state probe factory for messaging-conflict backfill. An upfront liveness
// check is necessary because `openshell provider get` exits non-zero for both
// "provider not attached" and "gateway unreachable"; without the liveness
// gate, a transient gateway failure would be recorded as "no providers" and
// permanently suppress future backfill retries.
function makeConflictProbe() {
  let gatewayAlive = null;
  const isGatewayAlive = () => {
    if (gatewayAlive === null) {
      const result = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      // runCaptureOpenshell returns stdout/stderr as a single string; treat
      // any non-empty output as a sign openshell answered. Empty output with
      // ignoreError typically means the binary failed to produce anything.
      gatewayAlive = typeof result === "string" && result.length > 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name) => {
      if (!isGatewayAlive()) return "error";
      return providerExistsInGateway(name) ? "present" : "absent";
    },
  };
}

function verifyInferenceRoute(_provider, _model) {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

function isInferenceRouteReady(provider, model) {
  const live = parseGatewayInference(
    runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
  );
  return Boolean(live && live.provider === provider && live.model === model);
}

function sandboxExistsInGateway(sandboxName) {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName) {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

function buildSandboxConfigSyncScript(selectionConfig) {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

function isOpenclawReady(sandboxName) {
  return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
}

function writeSandboxConfigSyncFile(script) {
  const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

function encodeDockerJsonArg(value) {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

function isAffirmativeAnswer(value) {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function validateBraveSearchApiKey(apiKey) {
  return runCurlProbe([
    "-sS",
    "--compressed",
    "-H",
    "Accept: application/json",
    "-H",
    "Accept-Encoding: gzip",
    "-H",
    `X-Subscription-Token: ${apiKey}`,
    "--get",
    "--data-urlencode",
    "q=ping",
    "--data-urlencode",
    "count=1",
    "https://api.search.brave.com/res/v1/web/search",
  ]);
}

async function promptBraveSearchRecovery(validation) {
  const recovery = classifyValidationFailure(validation);

  if (recovery.kind === "credential") {
    console.log("  Brave Search rejected that API key.");
  } else if (recovery.kind === "transport") {
    console.log(getTransportRecoveryMessage(validation));
  } else {
    console.log("  Brave Search validation did not succeed.");
  }

  const answer = (await prompt("  Type 'retry', 'skip', or 'exit' [retry]: ")).trim().toLowerCase();
  if (answer === "skip") return "skip";
  if (answer === "exit" || answer === "quit") {
    exitOnboardFromPrompt();
  }
  return "retry";
}

async function promptBraveSearchApiKey() {
  console.log("");
  console.log(`  Get your Brave Search API key from: ${BRAVE_SEARCH_HELP_URL}`);
  console.log("");

  while (true) {
    const key = normalizeCredentialValue(
      await prompt("  Brave Search API key: ", { secret: true }),
    );
    if (!key) {
      console.error("  Brave Search API key is required.");
      continue;
    }
    return key;
  }
}

async function ensureValidatedBraveSearchCredential(nonInteractive = isNonInteractive()) {
  const savedApiKey = getCredential(webSearch.BRAVE_API_KEY_ENV);
  let apiKey = savedApiKey || normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]);
  let usingSavedKey = Boolean(savedApiKey);

  while (true) {
    if (!apiKey) {
      if (nonInteractive) {
        throw new Error(
          "Brave Search requires BRAVE_API_KEY or a saved Brave Search credential in non-interactive mode.",
        );
      }
      apiKey = await promptBraveSearchApiKey();
      usingSavedKey = false;
    }

    const validation = validateBraveSearchApiKey(apiKey);
    if (validation.ok) {
      saveCredential(webSearch.BRAVE_API_KEY_ENV, apiKey);
      process.env[webSearch.BRAVE_API_KEY_ENV] = apiKey;
      return apiKey;
    }

    const prefix = usingSavedKey
      ? "  Saved Brave Search API key validation failed."
      : "  Brave Search API key validation failed.";
    console.error(prefix);
    if (validation.message) {
      console.error(`  ${validation.message}`);
    }

    if (nonInteractive) {
      throw new Error(
        validation.message ||
          "Brave Search API key validation failed in non-interactive mode.",
      );
    }

    const action = await promptBraveSearchRecovery(validation);
    if (action === "skip") {
      console.log("  Skipping Brave Web Search setup.");
      console.log("");
      return null;
    }

    apiKey = null;
    usingSavedKey = false;
  }
}

async function configureWebSearch(existingConfig = null) {
  if (existingConfig) {
    return { fetchEnabled: true };
  }

  if (isNonInteractive()) {
    const braveApiKey = normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]);
    if (!braveApiKey) {
      return null;
    }
    note("  [non-interactive] Brave Web Search requested.");
    const validation = validateBraveSearchApiKey(braveApiKey);
    if (!validation.ok) {
      console.error("  Brave Search API key validation failed.");
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }
      process.exit(1);
    }
    saveCredential(webSearch.BRAVE_API_KEY_ENV, braveApiKey);
    process.env[webSearch.BRAVE_API_KEY_ENV] = braveApiKey;
    return { fetchEnabled: true };
  }
  const enableAnswer = await prompt("  Enable Brave Web Search? [y/N]: ");
  if (!isAffirmativeAnswer(enableAnswer)) {
    return null;
  }

  const braveApiKey = await ensureValidatedBraveSearchCredential();
  if (!braveApiKey) {
    return null;
  }

  console.log("  ✓ Enabled Brave Web Search");
  console.log("");
  return { fetchEnabled: true };
}

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  let providerKey;
  let primaryModelRef;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

function patchStagedDockerfile(
  dockerfilePath,
  model,
  chatUiUrl,
  buildId = String(Date.now()),
  provider = null,
  preferredInferenceApi = null,
  webSearchConfig = null,
  messagingChannels = [],
  messagingAllowedIds = {},
  discordGuilds = {},
  baseImageRef = null,
) {
  const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
    getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  // Pin the base image to a specific digest when available (#1904).
  // The ref must come from pullAndResolveBaseImageDigest() — never from
  // blueprint.yaml, whose digest belongs to a different registry.
  // Only rewrite when the current value already points at our sandbox-base
  // image — custom --from Dockerfiles may use a different base.
  if (baseImageRef) {
    dockerfile = dockerfile.replace(/^ARG BASE_IMAGE=(.*)$/m, (line, currentValue) => {
      const trimmed = String(currentValue).trim();
      if (trimmed.startsWith(`${SANDBOX_BASE_IMAGE}:`) || trimmed.startsWith(`${SANDBOX_BASE_IMAGE}@`)) {
        return `ARG BASE_IMAGE=${baseImageRef}`;
      }
      return line;
    });
  }
  dockerfile = dockerfile.replace(/^ARG NEMOCLAW_MODEL=.*$/m, `ARG NEMOCLAW_MODEL=${model}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${providerKey}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${primaryModelRef}`,
  );
  dockerfile = dockerfile.replace(/^ARG CHAT_UI_URL=.*$/m, `ARG CHAT_UI_URL=${chatUiUrl}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${inferenceBaseUrl}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${inferenceApi}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeDockerJsonArg(inferenceCompat)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${buildId}`,
  );
  // Honor NEMOCLAW_CONTEXT_WINDOW / NEMOCLAW_MAX_TOKENS / NEMOCLAW_REASONING
  // so the user can tune model metadata without editing the Dockerfile.
  const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
  const contextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
  if (contextWindow && POSITIVE_INT_RE.test(contextWindow)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_CONTEXT_WINDOW=.*$/m,
      `ARG NEMOCLAW_CONTEXT_WINDOW=${contextWindow}`,
    );
  }
  const maxTokens = process.env.NEMOCLAW_MAX_TOKENS;
  if (maxTokens && POSITIVE_INT_RE.test(maxTokens)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MAX_TOKENS=.*$/m,
      `ARG NEMOCLAW_MAX_TOKENS=${maxTokens}`,
    );
  }
  const reasoning = process.env.NEMOCLAW_REASONING;
  if (reasoning === "true" || reasoning === "false") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING=.*$/m,
      `ARG NEMOCLAW_REASONING=${reasoning}`,
    );
  }
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const PROXY_HOST_RE = /^[A-Za-z0-9._:-]+$/;
  const PROXY_PORT_RE = /^[0-9]{1,5}$/;
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && PROXY_HOST_RE.test(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${proxyHostEnv}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && PROXY_PORT_RE.test(proxyPortEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_PORT=.*$/m,
      `ARG NEMOCLAW_PROXY_PORT=${proxyPortEnv}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_SEARCH_ENABLED=.*$/m,
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${webSearchConfig ? "1" : "0"}`,
  );
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1`,
  );
  if (messagingChannels.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_CHANNELS_B64=${encodeDockerJsonArg(messagingChannels)}`,
    );
  }
  if (Object.keys(messagingAllowedIds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${encodeDockerJsonArg(messagingAllowedIds)}`,
    );
  }
  if (Object.keys(discordGuilds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_DISCORD_GUILDS_B64=.*$/m,
      `ARG NEMOCLAW_DISCORD_GUILDS_B64=${encodeDockerJsonArg(discordGuilds)}`,
    );
  }
  fs.writeFileSync(dockerfilePath, dockerfile);
}

function parseJsonObject(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hasResponsesToolCall(body) {
  const parsed = parseJsonObject(body);
  if (!parsed || !Array.isArray(parsed.output)) return false;

  const stack = [...parsed.output];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "tool_call") return true;
    if (Array.isArray(item.content)) {
      stack.push(...item.content);
    }
  }

  return false;
}

function shouldRequireResponsesToolCalling(provider) {
  return (
    provider === "nvidia-prod" || provider === "gemini-api" || provider === "compatible-endpoint"
  );
}

// Google Gemini rejects requests that carry both an Authorization: Bearer
// header and a ?key= query parameter ("Multiple authentication credentials
// received"). Send the API key as ?key= only for Gemini. See issue #1960.
function getProbeAuthMode(provider) {
  return provider === "gemini-api" ? "query-param" : undefined;
}

// shouldSkipResponsesProbe and isNvcfFunctionNotFoundForAccount /
// nvcfFunctionNotFoundMessage — see validation import above. They live in
// src/lib/validation.ts so they can be unit-tested independently.

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
function getValidationProbeCurlArgs(opts) {
  if (isWsl(opts)) {
    return ["--connect-timeout", "20", "--max-time", "30"];
  }
  return ["--connect-timeout", "10", "--max-time", "15"];
}

function probeResponsesToolCalling(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const url = useQueryParam && normalizedKey
    ? `${baseUrl}/responses?key=${encodeURIComponent(normalizedKey)}`
    : `${baseUrl}/responses`;
  const result = runCurlProbe([
    "-sS",
    ...getValidationProbeCurlArgs(),
    "-H",
    "Content-Type: application/json",
    ...authHeader,
    "-d",
    JSON.stringify({
      model,
      input: "Call the emit_ok function with value OK. Do not answer with plain text.",
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "emit_ok",
          description: "Returns the probe value for validation.",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    }),
    url,
  ]);

  if (!result.ok) {
    return result;
  }
  if (hasResponsesToolCall(result.body)) {
    return result;
  }
  return {
    ok: false,
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    body: result.body,
    stderr: result.stderr,
    message: `HTTP ${result.httpStatus}: Responses API did not return a tool call`,
  };
}

function probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const appendKey = (path) =>
    useQueryParam && normalizedKey ? `${baseUrl}${path}?key=${encodeURIComponent(normalizedKey)}` : `${baseUrl}${path}`;

  const responsesProbe =
    options.requireResponsesToolCalling === true
      ? {
          name: "Responses API with tool calling",
          api: "openai-responses",
          execute: () => probeResponsesToolCalling(endpointUrl, model, apiKey, { authMode: options.authMode }),
        }
      : {
          name: "Responses API",
          api: "openai-responses",
          execute: () =>
            runCurlProbe([
              "-sS",
              ...getValidationProbeCurlArgs(),
              "-H",
              "Content-Type: application/json",
              ...authHeader,
              "-d",
              JSON.stringify({
                model,
                input: "Reply with exactly: OK",
              }),
              appendKey("/responses"),
            ]),
        };

  const chatCompletionsProbe = {
    name: "Chat Completions API",
    api: "openai-completions",
    execute: () =>
      runCurlProbe([
        "-sS",
        ...getValidationProbeCurlArgs(),
        "-H",
        "Content-Type: application/json",
        ...authHeader,
        "-d",
        JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
        appendKey("/chat/completions"),
      ]),
  };

  // NVIDIA Build does not expose /v1/responses; probing it always returns
  // "404 page not found" and only adds noise to error messages. Skip it
  // entirely for that provider. See issue #1601.
  const probes = options.skipResponsesProbe
    ? [chatCompletionsProbe]
    : [responsesProbe, chatCompletionsProbe];

  const failures = [];
  for (const probe of probes) {
    const result = probe.execute();
    if (result.ok) {
      // Streaming event validation — catch backends like SGLang that return
      // valid non-streaming responses but emit incomplete SSE events in
      // streaming mode. Only run for /responses probes on custom endpoints
      // where probeStreaming was requested.
      if (probe.api === "openai-responses" && options.probeStreaming === true) {
        const streamResult = runStreamingEventProbe([
          "-sS",
          ...getValidationProbeCurlArgs(),
          "-H",
          "Content-Type: application/json",
          ...authHeader,
          "-d",
          JSON.stringify({
            model,
            input: "Reply with exactly: OK",
            stream: true,
          }),
          appendKey("/responses"),
        ]);
        if (!streamResult.ok && streamResult.missingEvents.length > 0) {
          // Backend responds but lacks required streaming events — fall back
          // to /chat/completions silently.
          console.log(`  ℹ ${streamResult.message}`);
          failures.push({
            name: probe.name + " (streaming)",
            httpStatus: 0,
            curlStatus: 0,
            message: streamResult.message,
            body: "",
          });
          continue;
        }
        if (!streamResult.ok) {
          // Transport or execution failure — surface as a hard error instead
          // of silently switching APIs.
          return {
            ok: false,
            message: `${probe.name} (streaming): ${streamResult.message}`,
            failures: [
              {
                name: probe.name + " (streaming)",
                httpStatus: 0,
                curlStatus: 0,
                message: streamResult.message,
                body: "",
              },
            ],
          };
        }
      }
      return { ok: true, api: probe.api, label: probe.name };
    }
    // Preserve the raw response body alongside the summarized message so the
    // NVCF "Function not found for account" detector below can fall back to
    // the raw body if summarizeProbeError ever stops surfacing the marker
    // through `message`.
    failures.push({
      name: probe.name,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      message: result.message,
      body: result.body,
    });
  }

  // Single retry with doubled timeouts on timeout/connection failure.
  // WSL2's virtualized network stack can cause the initial probe to time out
  // before the TLS handshake completes. See issue #987.
  const isTimeoutOrConnFailure = (cs) => cs === 28 || cs === 6 || cs === 7;
  let retriedAfterTimeout = false;
  if (failures.length > 0 && isTimeoutOrConnFailure(failures[0].curlStatus)) {
    retriedAfterTimeout = true;
    const baseArgs = getValidationProbeCurlArgs();
    const doubledArgs = baseArgs.map((arg) =>
      /^\d+$/.test(arg) ? String(Number(arg) * 2) : arg,
    );
    const retryResult = runCurlProbe([
      "-sS",
      ...doubledArgs,
      "-H",
      "Content-Type: application/json",
      ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
      "-d",
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
      `${String(endpointUrl).replace(/\/+$/, "")}/chat/completions`,
    ]);
    if (retryResult.ok) {
      return { ok: true, api: "openai-completions", label: "Chat Completions API" };
    }
  }

  // Detect the NVCF "Function not found for account" error and reframe it
  // with an actionable next step instead of dumping the raw NVCF body.
  // See issue #1601 (Bug 2).
  const accountFailure = failures.find(
    (failure) =>
      isNvcfFunctionNotFoundForAccount(failure.message) ||
      isNvcfFunctionNotFoundForAccount(failure.body),
  );
  if (accountFailure) {
    return {
      ok: false,
      message: nvcfFunctionNotFoundMessage(model),
      failures,
    };
  }

  const baseMessage = failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | ");
  const wslHint =
    isWsl() && retriedAfterTimeout
      ? " · WSL2 detected \u2014 network verification may be slower than expected. " +
        "Run `nemoclaw onboard` with the `--skip-verify` flag if this endpoint is known to be reachable."
      : "";
  return {
    ok: false,
    message: baseMessage + wslHint,
    failures,
  };
}

function probeAnthropicEndpoint(endpointUrl, model, apiKey) {
  const result = runCurlProbe([
    "-sS",
    ...getCurlTimingArgs(),
    "-H",
    `x-api-key: ${normalizeCredentialValue(apiKey)}`,
    "-H",
    "anthropic-version: 2023-06-01",
    "-H",
    "content-type: application/json",
    "-d",
    JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
    `${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`,
  ]);
  if (result.ok) {
    return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
  }
  return {
    ok: false,
    message: result.message,
    failures: [
      {
        name: "Anthropic Messages API",
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
      },
    ],
  };
}

async function validateOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv = null,
  retryMessage = "Please choose a provider/model again.",
  helpUrl = null,
  options = {},
) {
  const apiKey = credentialEnv ? getCredential(credentialEnv) : "";
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log(`  ${retryMessage}`);
      console.log("");
    }
    return { ok: false, retry };
  }
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return { ok: true, api: probe.api };
}

async function validateAnthropicSelectionWithRetryMessage(
  label,
  endpointUrl,
  model,
  credentialEnv,
  retryMessage = "Please choose a provider/model again.",
  helpUrl = null,
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log(`  ${retryMessage}`);
      console.log("");
    }
    return { ok: false, retry };
  }
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return { ok: true, api: probe.api };
}

async function validateCustomOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, {
    requireResponsesToolCalling: true,
    skipResponsesProbe: shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
    probeStreaming: true,
  });
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}

async function validateCustomAnthropicSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}

const { promptManualModelId, promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

// ---------------------------------------------------------------------------
// Ollama auth proxy — keeps Ollama on localhost, exposes a token-gated proxy
// on 0.0.0.0 so containers can reach it without exposing Ollama to the network.
// Token is persisted to ~/.nemoclaw/ollama-proxy-token so the proxy can be
// restarted after a host reboot without re-running onboard.
// ---------------------------------------------------------------------------

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");

let ollamaProxyToken: string | null = null;

function ensureProxyStateDir(): void {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

function persistProxyToken(token: string): void {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

function loadPersistedProxyToken(): string | null {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistProxyPid(pid: number | null | undefined): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${pid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

function loadPersistedProxyPid(): number | null {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPersistedProxyPid(): void {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

function isOllamaProxyProcess(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

function spawnOllamaAuthProxy(token: string): number | null {
  const child = spawn(process.execPath, [path.join(SCRIPTS, "ollama-auth-proxy.js")], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
    },
  });
  child.unref();
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

function killStaleProxy(): void {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid)) {
      run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = runCapture(["lsof", "-ti", `:${OLLAMA_PROXY_PORT}`], { ignoreError: true });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10))) {
          run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      sleep(1);
    }
  } catch {
    /* ignore */
  }
}

function startOllamaAuthProxy(): void {
  const crypto = require("crypto");
  killStaleProxy();

  ollamaProxyToken = crypto.randomBytes(24).toString("hex");
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(ollamaProxyToken);
  sleep(1);
  if (!isOllamaProxyProcess(pid)) {
    console.error(`  Warning: Ollama auth proxy did not start on :${OLLAMA_PROXY_PORT}`);
  }
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
function ensureOllamaAuthProxy(): void {
  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid)) {
    ollamaProxyToken = token;
    return;
  }

  // Proxy not running — restart it with the persisted token.
  killStaleProxy();
  ollamaProxyToken = token;
  spawnOllamaAuthProxy(token);
  sleep(1);
}

function getOllamaProxyToken(): string | null {
  if (ollamaProxyToken) return ollamaProxyToken;
  // Fall back to persisted token (resume / reconnect scenario)
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}

async function promptOllamaModel(gpu = null) {
  const installed = getOllamaModelOptions();
  const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
  const defaultModel = getDefaultOllamaModel(gpu);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log(installed.length > 0 ? "  Ollama models:" : "  Ollama starter models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  if (installed.length === 0) {
    console.log("");
    console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
  }
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }
  return promptManualModelId("  Ollama model id: ", "Ollama");
}

function printOllamaExposureWarning() {
  console.log("");
  console.log("  ⚠ Ollama is binding to 0.0.0.0 so the sandbox can reach it via Docker.");
  console.log("    This exposes the Ollama API to your local network (no auth required).");
  console.log("    On public WiFi, any device on the same network can send prompts to your GPU.");
  console.log("    See: CNVD-2025-04094, CVE-2024-37032");
  console.log("");
}

function pullOllamaModel(model) {
  const result = spawnSync("bash", ["-c", `ollama pull ${shellQuote(model)}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env },
  });
  if (result.signal === "SIGTERM") {
    console.error(
      `  Model pull timed out after 10 minutes. Try a smaller model or check your network connection.`,
    );
    return false;
  }
  return result.status === 0;
}

function prepareOllamaModel(model, installedModels = []) {
  const alreadyInstalled = installedModels.includes(model);
  if (!alreadyInstalled) {
    console.log(`  Pulling Ollama model: ${model}`);
    if (!pullOllamaModel(model)) {
      return {
        ok: false,
        message:
          `Failed to pull Ollama model '${model}'. ` +
          "Check the model name and that Ollama can access the registry, then try another model.",
      };
    }
  }

  console.log(`  Loading Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  return validateOllamaModel(model);
}

function getRequestedSandboxNameHint() {
  return resolveRequestedSandboxNameHint(process.env);
}

function getResumeSandboxConflict(session) {
  return detectRequestedResumeSandboxConflict(session, process.env);
}

function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
  return resolveRequestedProviderHint(nonInteractive, {
    env: process.env,
    error: console.error,
    exit: (code) => process.exit(code),
  });
}

function getRequestedModelHint(nonInteractive = isNonInteractive()) {
  return resolveRequestedModelHint(nonInteractive, {
    env: process.env,
    error: console.error,
    exit: (code) => process.exit(code),
    isSafeModelId,
  });
}

function getEffectiveProviderName(providerKey) {
  return resolveEffectiveProviderName(providerKey, REMOTE_PROVIDER_CONFIG);
}

function getResumeConfigConflicts(session, opts = {}) {
  return collectRequestedResumeConfigConflicts(session, {
    nonInteractive: opts.nonInteractive ?? isNonInteractive(),
    fromDockerfile: opts.fromDockerfile || null,
    agent: opts.agent || null,
    env: process.env,
    error: console.error,
    exit: (code) => process.exit(code),
    isSafeModelId,
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
  });
}

function getContainerRuntime() {
  return resolveContainerRuntime({ runCapture, inferContainerRuntime });
}

function printRemediationActions(actions) {
  return renderRemediationActions(actions, console.error);
}

function isOpenshellInstalled() {
  return detectInstalledOpenshell(resolveOpenshell);
}

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  return resolveFutureShellPathHint(binDir, pathValue);
}

function getPortConflictServiceHints(platform = process.platform) {
  return resolvePortConflictServiceHints(platform, OPENCLAW_LAUNCH_AGENT_PLIST);
}

function installOpenshell() {
  const result = installOpenshellWithDeps({
    scriptPath: path.join(SCRIPTS, "install-openshell.sh"),
    rootDir: ROOT,
    env: process.env,
    spawnSync,
    existsSync: fs.existsSync,
    resolveOpenshell,
    getFutureShellPathHint,
    errorWriter: console.error,
  });
  if (result.updatedPathValue) {
    process.env.PATH = result.updatedPathValue;
  }
  OPENSHELL_BIN = result.openshellBinary;
  return {
    installed: result.installed,
    localBin: result.localBin,
    futureShellPathHint: result.futureShellPathHint,
  };
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

function destroyGateway() {
  const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
  if (destroyResult.status === 0) {
    registry.clearAll();
  }
  // openshell gateway destroy doesn't remove Docker volumes, which leaves
  // corrupted cluster state that breaks the next gateway start. Clean them up.
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

async function ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential(envName, label, helpUrl);
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  return waitForSandboxReadyWithDeps(
    sandboxName,
    {
      runCaptureOpenshell,
      sleep,
    },
    attempts,
    delaySeconds,
  );
}

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

function getNonInteractiveProvider() {
  return resolveNonInteractiveProvider({
    env: process.env,
    error: console.error,
    exit: (code) => process.exit(code),
  });
}

function getNonInteractiveModel(providerKey) {
  return resolveNonInteractiveModel(providerKey, {
    env: process.env,
    error: console.error,
    exit: (code) => process.exit(code),
    isSafeModelId,
  });
}

// ── Step 1: Preflight ────────────────────────────────────────────

// eslint-disable-next-line complexity
async function preflight() {
  return runOnboardPreflight({
    step,
    assessHost,
    planHostRemediation,
    printRemediationActions,
    isOpenshellInstalled,
    installOpenshell,
    getInstalledOpenshellVersion,
    runCaptureOpenshell,
    getBlueprintMinOpenshellVersion,
    getBlueprintMaxOpenshellVersion,
    versionGte,
    getGatewayReuseState,
    verifyGatewayContainerRunning,
    runOpenshell,
    destroyGateway,
    clearRegistryAll: () => {
      registry.clearAll();
    },
    run,
    runCapture,
    checkPortAvailable,
    sleep,
    getPortConflictServiceHints,
    getMemoryInfo,
    ensureSwap,
    isNonInteractive,
    prompt,
    nimDetectGpu: () => nim.detectGpu(),
    processPlatform: process.platform,
    gatewayName: GATEWAY_NAME,
    dashboardPort: DASHBOARD_PORT,
    gatewayPort: GATEWAY_PORT,
  });
}

// ── Step 2: Gateway ──────────────────────────────────────────────

/** Start the OpenShell gateway with retry logic and post-start health polling. */
async function startGatewayWithOptions(_gpu, { exitOnFailure = true } = {}) {
  return startGatewayWithOptionsWithDeps(
    _gpu,
    {
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
      scriptsDir: SCRIPTS,
      processEnv: process.env,
      processArch: process.arch,
      showHeader: () => {
        step(2, 8, "Starting OpenShell gateway");
      },
      log: console.log,
      error: console.error,
      exit: (code) => process.exit(code),
      openshellShellCommand: (args) => openshellShellCommand(args),
      streamGatewayStart,
      runCaptureOpenshell,
      runOpenshell,
      isGatewayHealthy,
      hasStaleGateway,
      redact,
      compactText,
      envInt,
      sleep,
      getInstalledOpenshellVersion: () => getInstalledOpenshellVersion(),
      getContainerRuntime,
      shouldPatchCoredns,
      run,
      destroyGateway,
      pruneKnownHostsEntries,
    },
    { exitOnFailure },
  );
}

async function startGateway(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true });
}

async function startGatewayForRecovery(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: false });
}

function getGatewayStartEnv() {
  return buildGatewayStartEnv(getInstalledOpenshellVersion());
}

async function recoverGatewayRuntime() {
  return recoverGatewayRuntimeWithDeps({
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    processEnv: process.env,
    runCaptureOpenshell,
    runOpenshell,
    isSelectedGateway,
    getGatewayStartEnv,
    envInt,
    sleep,
    redact,
    compactText,
    getContainerRuntime,
    shouldPatchCoredns,
    run,
    scriptsDir: SCRIPTS,
    error: console.error,
  });
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function promptValidatedSandboxName() {
  return promptValidatedSandboxNameWithDeps({
    promptOrDefault,
    validateName,
    isNonInteractive,
    errorWriter: console.error,
    exit: (code) => process.exit(code),
  });
}

// ── Step 5: Sandbox ──────────────────────────────────────────────

function getCreateSandboxDeps() {
  return {
    step,
    validateName,
    promptValidatedSandboxName,
    controlUiPort: CONTROL_UI_PORT,
    dashboardPort: DASHBOARD_PORT,
    getCredential,
    normalizeCredentialValue,
    messagingChannels: MESSAGING_CHANNELS,
    registry,
    makeConflictProbe,
    isNonInteractive,
    promptOrDefault,
    getSandboxReuseState,
    providerExistsInGateway,
    detectMessagingCredentialRotation,
    isRecreateSandbox,
    upsertMessagingProviders,
    note,
    ensureDashboardForward,
    sandboxState,
    hashCredential,
    onboardSession,
    runOpenshell,
    agentOnboard,
    stageOptimizedSandboxBuildContext,
    root: ROOT,
    webSearchBraveApiKeyEnv: webSearch.BRAVE_API_KEY_ENV,
    buildSubprocessEnv,
    formatEnvAssignment,
    runCapture,
    sandboxBaseImage: SANDBOX_BASE_IMAGE,
    sandboxBaseTag: SANDBOX_BASE_TAG,
    pullAndResolveBaseImageDigest,
    patchStagedDockerfile,
    openshellShellCommand,
    streamSandboxCreate,
    run,
    runCaptureOpenshell,
    isSandboxReady,
    sleep,
    classifySandboxCreateFailure,
    printSandboxCreateRecoveryHints,
    agentDefs,
    runFile,
    scriptsDir: SCRIPTS,
    gatewayName: GATEWAY_NAME,
    discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
  };
}

// eslint-disable-next-line complexity
async function createSandbox(
  gpu,
  model,
  provider,
  preferredInferenceApi = null,
  sandboxNameOverride = null,
  webSearchConfig = null,
  enabledChannels = null,
  fromDockerfile = null,
  agent = null,
  dangerouslySkipPermissions = false,
) {
  return runCreateSandbox(
    gpu,
    model,
    provider,
    preferredInferenceApi,
    sandboxNameOverride,
    webSearchConfig,
    enabledChannels,
    fromDockerfile,
    agent,
    dangerouslySkipPermissions,
    getCreateSandboxDeps(),
  );
}


// ── Step 3: Inference selection ──────────────────────────────────

// eslint-disable-next-line complexity
async function setupNim(gpu) {
  return setupNimWithDeps(gpu, {
    step,
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    runCapture,
    ollamaPort: OLLAMA_PORT,
    vllmPort: VLLM_PORT,
    ollamaProxyPort: OLLAMA_PROXY_PORT,
    experimental: EXPERIMENTAL,
    isNonInteractive,
    getNonInteractiveProvider,
    getNonInteractiveModel,
    note,
    prompt,
    getNavigationChoice,
    exitOnboardFromPrompt,
    normalizeProviderBaseUrl,
    validateNvidiaApiKeyValue,
    ensureApiKey,
    defaultCloudModel: DEFAULT_CLOUD_MODEL,
    promptCloudModel,
    ensureNamedCredential,
    getProbeAuthMode,
    validateOpenAiLikeModel,
    getCredential,
    validateAnthropicModel,
    anthropicEndpointUrl: ANTHROPIC_ENDPOINT_URL,
    promptRemoteModel,
    promptInputModel,
    backToSelection: BACK_TO_SELECTION,
    validateCustomOpenAiLikeSelection,
    validateCustomAnthropicSelection,
    validateAnthropicSelectionWithRetryMessage,
    validateOpenAiLikeSelection,
    shouldRequireResponsesToolCalling,
    shouldSkipResponsesProbe,
    nim,
    gatewayName: GATEWAY_NAME,
    getLocalProviderBaseUrl,
    getLocalProviderValidationBaseUrl,
    processPlatform: process.platform,
    validateLocalProvider,
    isWsl,
    run,
    sleep,
    printOllamaExposureWarning,
    startOllamaAuthProxy,
    getOllamaModelOptions,
    getDefaultOllamaModel,
    promptOllamaModel,
    prepareOllamaModel,
    isSafeModelId,
  });
}

// ── Step 4: Inference provider ───────────────────────────────────

// eslint-disable-next-line complexity
async function setupInference(
  sandboxName,
  model,
  provider,
  endpointUrl = null,
  credentialEnv = null,
) {
  return runSetupInference(sandboxName, model, provider, endpointUrl, credentialEnv, {
    step,
    runOpenshell,
    gatewayName: GATEWAY_NAME,
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    hydrateCredentialEnv,
    upsertProvider,
    isNonInteractive,
    promptValidationRecovery,
    classifyApplyFailure,
    compactText,
    redact,
    validateLocalProvider,
    getLocalProviderBaseUrl,
    localInferenceTimeoutSecs: LOCAL_INFERENCE_TIMEOUT_SECS,
    ensureOllamaAuthProxy,
    getOllamaProxyToken,
    persistProxyToken,
    isWsl,
    getOllamaWarmupCommand,
    validateOllamaModel,
    verifyInferenceRoute,
    updateSandbox: (name, patch) => {
      registry.updateSandbox(name, patch);
    },
    processPlatform: process.platform,
    run,
  });
}

// ── Step 6: Messaging channels ───────────────────────────────────

const {
  TELEGRAM_NETWORK_CURL_CODES,
  checkTelegramReachability: checkTelegramReachabilityWithDeps,
} = require("./onboard-telegram");

async function checkTelegramReachability(token: string) {
  return checkTelegramReachabilityWithDeps(token, {
    runCurlProbe,
    isNonInteractive,
    promptOrDefault,
    log: console.log,
    error: console.error,
    exit: (code) => process.exit(code),
  });
}

async function setupMessagingChannels() {
  return setupMessagingChannelsWithDeps({
    step,
    isNonInteractive,
    note,
    getCredential,
    normalizeCredentialValue,
    prompt,
    promptOrDefault,
    saveCredential,
    checkTelegramReachability,
    env: process.env,
    input: process.stdin,
    output: process.stderr,
  });
}

function getSuggestedPolicyPresets({ enabledChannels = null, webSearchConfig = null, provider = null } = {}) {
  return getSuggestedPolicyPresetsWithDeps({
    enabledChannels,
    webSearchConfig,
    provider,
    getCredential,
    env: process.env,
    isInteractiveTty: process.stdout.isTTY,
    isNonInteractive: isNonInteractive(),
    note: console.log,
  });
}

// ── Step 7: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName, model, provider) {
  step(7, 8, "Setting up OpenClaw inside sandbox");

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      run(
        `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

// ── Step 7: Policy presets ───────────────────────────────────────

function getPolicyUiDeps() {
  return {
    step,
    prompt,
    note,
    sleep,
    isNonInteractive,
    parsePolicyPresetEnv,
    waitForSandboxReady,
    localInferenceProviders: LOCAL_INFERENCE_PROVIDERS,
    useColor: USE_COLOR,
    policies,
    tiers,
    updateSandbox: (name, patch) => {
      registry.updateSandbox(name, patch);
    },
  };
}

// eslint-disable-next-line complexity
async function _setupPolicies(sandboxName, options = {}) {
  return setupPoliciesLegacyWithDeps(
    sandboxName,
    {
      ...options,
      getSuggestedPolicyPresets,
    },
    getPolicyUiDeps(),
  );
}

function arePolicyPresetsApplied(sandboxName, selectedPresets = []) {
  return arePolicyPresetsAppliedWithDeps(sandboxName, selectedPresets, getPolicyUiDeps());
}

async function selectPolicyTier() {
  return selectPolicyTierWithDeps(getPolicyUiDeps());
}

async function selectTierPresetsAndAccess(tierName, allPresets, extraSelected = []) {
  return selectTierPresetsAndAccessWithDeps(
    tierName,
    allPresets,
    extraSelected,
    getPolicyUiDeps(),
  );
}

async function presetsCheckboxSelector(allPresets, initialSelected) {
  return presetsCheckboxSelectorWithDeps(allPresets, initialSelected, getPolicyUiDeps());
}

// eslint-disable-next-line complexity
async function setupPoliciesWithSelection(sandboxName, options = {}) {
  return setupPoliciesWithSelectionWithDeps(sandboxName, options, getPolicyUiDeps());
}


// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = DASHBOARD_PORT;

// Dashboard helpers — delegated to src/lib/dashboard.ts
// isLoopbackHostname — see urlUtils import above
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;

function ensureDashboardForward(
  sandboxName,
  chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
) {
  return ensureDashboardForwardWithDeps(sandboxName, {
    chatUiUrl,
    runOpenshell,
    warningWriter: console.warn,
  });
}

function fetchGatewayAuthTokenFromSandbox(sandboxName) {
  return fetchGatewayAuthTokenFromSandboxWithDeps(sandboxName, { runOpenshell });
}

function getDashboardForwardStartCommand(sandboxName, options = {}) {
  return getDashboardForwardStartCommandWithDeps(sandboxName, {
    ...options,
    openshellShellCommand,
  });
}

function getDashboardAccessInfo(sandboxName, options = {}) {
  return getDashboardAccessInfoWithDeps(sandboxName, {
    ...options,
    fetchToken: (name) => fetchGatewayAuthTokenFromSandbox(name),
    runCapture: options.runCapture || runCapture,
  });
}

function printDashboard(sandboxName, model, provider, nimContainer = null, agent = null) {
  return printOnboardDashboard(sandboxName, model, provider, nimContainer, agent, {
    getNimStatus: (targetSandboxName, targetNimContainer) =>
      targetNimContainer ? nim.nimStatusByName(targetNimContainer) : nim.nimStatus(targetSandboxName),
    fetchGatewayAuthTokenFromSandbox,
    getDashboardAccessInfo: (targetSandboxName, options) =>
      getDashboardAccessInfo(targetSandboxName, options),
    getDashboardGuidanceLines,
    note,
    log: console.log,
    printAgentDashboardUi: agentOnboard.printDashboardUi,
    buildControlUiUrls,
    getWslHostAddress,
    buildAuthenticatedDashboardUrl,
  });
}

const TOTAL_ONBOARD_STEPS = 8;

function skippedStepMessage(stepName, detail, reason = "resume") {
  const visibleStepName = isOnboardStepName(stepName) ? toVisibleStepName(stepName) : null;
  const stepInfo = visibleStepName ? ONBOARD_STEP_META[visibleStepName] : null;
  if (stepInfo) {
    step(stepInfo.number, TOTAL_ONBOARD_STEPS, stepInfo.title);
  }
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function onboard(opts = {}) {
  return runOnboardingEntry(opts, {
    env: process.env,
    resolveShellState: resolveOnboardShellState,
    applyShellState: (shellState) => {
      NON_INTERACTIVE = shellState.nonInteractive;
      RECREATE_SANDBOX = shellState.recreateSandbox;
    },
    getDangerouslySkipPermissionsWarningLines,
    ensureUsageNoticeConsent,
    validateRequestedProviderHint: () => {
      getRequestedProviderHint();
    },
    acquireOnboardLock: (command) => onboardSession.acquireOnboardLock(command),
    buildOnboardLockCommand,
    getOnboardLockConflictLines,
    releaseOnboardLock: () => {
      onboardSession.releaseOnboardLock();
    },
    clearGatewayEnv: () => {
      delete process.env.OPENSHELL_GATEWAY;
    },
    initializeOnboardRun,
    getResumeConflicts: (session, shellState, requestedAgent) =>
      getResumeConfigConflicts(session, {
        nonInteractive: shellState.nonInteractive,
        fromDockerfile: shellState.requestedFromDockerfile,
        agent: requestedAgent,
      }),
    createOnboardRunContext,
    getOnboardBannerLines,
    buildOrchestratorDeps: (runContext, shellState, requestedAgent) =>
      createOnboardingOrchestratorDeps(runContext, {
        resume: shellState.resume,
        dangerouslySkipPermissions: shellState.dangerouslySkipPermissions,
        requestedAgent,
        gatewayName: GATEWAY_NAME,
        dashboardPort: DASHBOARD_PORT,
        resolveAgent: agentOnboard.resolveAgent,
        note,
        log: console.log,
        skippedStepMessage,
        step,
        preflight,
        detectGpu: () => nim.detectGpu(),
        runCaptureOpenshell,
        getGatewayReuseState,
        verifyGatewayContainerRunning,
        runOpenshell,
        destroyGateway,
        clearRegistryAll: () => {
          registry.clearAll();
        },
        startGateway,
        setupNim,
        setupInference,
        isInferenceRouteReady,
        hydrateCredentialEnv,
        getOpenshellBinary,
        updateSandbox: (name, patch) => {
          registry.updateSandbox(name, patch);
        },
        setupMessagingChannels,
        configureWebSearch,
        ensureValidatedBraveSearchCredential,
        getSandboxReuseState,
        removeSandbox: (name) => {
          registry.removeSandbox(name);
        },
        repairRecordedSandbox,
        createSandbox,
        handleAgentSetup: agentOnboard.handleAgentSetup,
        openshellShellCommand,
        buildSandboxConfigSyncScript,
        writeSandboxConfigSyncFile,
        cleanupTempDir,
        isOpenclawReady,
        setupOpenclaw,
        waitForSandboxReady,
        applyPermissivePolicy: (name) => {
          policies.applyPermissivePolicy(name);
        },
        arePolicyPresetsApplied,
        setupPoliciesWithSelection,
      }),
    runOnboardingOrchestrator,
    printDashboard,
    note,
    log: console.log,
    error: console.error,
    exit: (code) => process.exit(code),
    onceProcessExit: (handler) => {
      process.once("exit", handler);
    },
  });
}

module.exports = {
  buildProviderArgs,
  buildSandboxConfigSyncScript,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  configureWebSearch,
  createSandbox,
  ensureValidatedBraveSearchCredential,
  formatEnvAssignment,
  getFutureShellPathHint,
  getGatewayStartEnv,
  getGatewayReuseState,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getBlueprintMaxOpenshellVersion,
  pullAndResolveBaseImageDigest,
  SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  versionGte,
  getRequestedModelHint,
  getRequestedProviderHint,
  getStableGatewayImageRef,
  getResumeConfigConflicts,
  isGatewayHealthy,
  hasStaleGateway,
  getRequestedSandboxNameHint,
  getResumeSandboxConflict,
  getSandboxReuseState,
  getSandboxStateFromOutputs,
  getPortConflictServiceHints,
  classifyValidationFailure,
  isSandboxReady,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  onboard,
  onboardSession,
  printSandboxCreateRecoveryHints,
  providerExistsInGateway,
  parsePolicyPresetEnv,
  pruneStaleSandboxEntry,
  repairRecordedSandbox,
  recoverGatewayRuntime,
  resolveDashboardForwardTarget,
  startGateway,
  buildAuthenticatedDashboardUrl,
  getDashboardAccessInfo,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardGuidanceLines,
  startGatewayForRecovery,
  runCaptureOpenshell,
  setupInference,
  setupMessagingChannels,
  setupNim,
  isInferenceRouteReady,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  LOCAL_INFERENCE_PROVIDERS,
  presetsCheckboxSelector,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  upsertProvider,
  hashCredential,
  detectMessagingCredentialRotation,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
};
