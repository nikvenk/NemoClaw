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
  ANTHROPIC_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
} = require("./onboard-remote-provider-config");
const { LOCAL_INFERENCE_PROVIDERS } = require("./onboard-policy-suggestions");
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
const { verifyGatewayContainerRunning: verifyGatewayContainerRunningWithDeps } = require("./onboard-gateway-liveness");
const { streamGatewayStart: streamGatewayStartWithDeps } = require("./onboard-gateway-start-stream");
const {
  destroyGateway: destroyGatewayWithDeps,
  getContainerRuntime: getContainerRuntimeWithDeps,
  getSandboxReuseState: getSandboxReuseStateWithDeps,
  installOpenshell: installOpenshellWithDepsRuntime,
  isInferenceRouteReady: isInferenceRouteReadyWithDeps,
  isOpenshellInstalled: isOpenshellInstalledWithDepsRuntime,
  printRemediationActions: printRemediationActionsWithDeps,
  pruneKnownHostsEntries: pruneKnownHostsEntriesWithDeps,
  repairRecordedSandbox: repairRecordedSandboxWithDeps,
  sleep: sleepWithDeps,
  verifyInferenceRoute: verifyInferenceRouteWithDeps,
  waitForSandboxReady: waitForSandboxReadyWithDepsRuntime,
} = require("./onboard-runtime-helpers");
const {
  getBlueprintMaxOpenshellVersion: getBlueprintMaxOpenshellVersionWithDeps,
  getBlueprintMinOpenshellVersion: getBlueprintMinOpenshellVersionWithDeps,
  getInstalledOpenshellVersion: getInstalledOpenshellVersionWithDeps,
  getStableGatewayImageRef: getStableGatewayImageRefWithDeps,
  versionGte: versionGteWithDeps,
} = require("./onboard-openshell-version");
const { createHostGatewayApi, createInferenceRuntimeApi } = require("./onboard-step-api");
const {
  getProbeAuthMode: getProbeAuthModeWithDeps,
  getValidationProbeCurlArgs: getValidationProbeCurlArgsWithDeps,
  hasResponsesToolCall: hasResponsesToolCallWithDeps,
  promptValidationRecovery: promptValidationRecoveryWithDeps,
  shouldRequireResponsesToolCalling: shouldRequireResponsesToolCallingWithDeps,
  validateAnthropicSelectionWithRetryMessage: validateAnthropicSelectionWithRetryMessageWithDeps,
  validateCustomAnthropicSelection: validateCustomAnthropicSelectionWithDeps,
  validateCustomOpenAiLikeSelection: validateCustomOpenAiLikeSelectionWithDeps,
  validateOpenAiLikeSelection: validateOpenAiLikeSelectionWithDeps,
} = require("./onboard-inference-validation");
const {
  buildProviderArgs: buildProviderArgsWithDeps,
  detectMessagingCredentialRotation: detectMessagingCredentialRotationWithDeps,
  hashCredential: hashCredentialWithDeps,
  makeConflictProbe: makeConflictProbeWithDeps,
  providerExistsInGateway: providerExistsInGatewayWithDeps,
  upsertMessagingProviders: upsertMessagingProvidersWithDeps,
  upsertProvider: upsertProviderWithDeps,
} = require("./onboard-provider-management");
const {
  SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  getSandboxInferenceConfig: getSandboxInferenceConfigWithDeps,
  patchStagedDockerfile: patchStagedDockerfileWithDeps,
  pullAndResolveBaseImageDigest: pullAndResolveBaseImageDigestWithDeps,
} = require("./onboard-sandbox-build-config");
const {
  ensureOllamaAuthProxy: ensureOllamaAuthProxyWithDeps,
  getOllamaProxyToken: getOllamaProxyTokenWithDeps,
  persistProxyToken: persistProxyTokenWithDeps,
  startOllamaAuthProxy: startOllamaAuthProxyWithDeps,
} = require("./onboard-ollama-proxy");
const {
  buildSandboxConfigSyncScript: buildSandboxConfigSyncScriptWithDeps,
  isOpenclawReady: isOpenclawReadyWithDeps,
  setupOpenclaw: setupOpenclawWithDeps,
  writeSandboxConfigSyncFile: writeSandboxConfigSyncFileWithDeps,
} = require("./onboard-openclaw-setup");
const {
  prepareOllamaModel: prepareOllamaModelWithDeps,
  printOllamaExposureWarning: printOllamaExposureWarningWithDeps,
  promptOllamaModel: promptOllamaModelWithDeps,
} = require("./onboard-ollama-models");
const { runCreateSandbox } = require("./onboard-sandbox-create");
const {
  configureWebSearch: configureWebSearchWithDeps,
  ensureValidatedBraveSearchCredential: ensureValidatedBraveSearchCredentialWithDeps,
} = require("./onboard-web-search-config");
const { MESSAGING_CHANNELS } = require("./onboard-messaging");
const { promptValidatedSandboxName: promptValidatedSandboxNameWithDeps } = require("./onboard-sandbox-name");
const {
  buildAuthenticatedDashboardUrl,
  getDashboardForwardPort,
  getDashboardForwardTarget,
} = require("./onboard-dashboard");
const { createDashboardApi, createPolicyUiApi } = require("./onboard-ui-api");
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

function verifyGatewayContainerRunning() {
  return verifyGatewayContainerRunningWithDeps(GATEWAY_NAME, { run });
}
const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

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
  return pruneKnownHostsEntriesWithDeps(contents);
}

function getSandboxReuseState(sandboxName) {
  return getSandboxReuseStateWithDeps(sandboxName, { runCaptureOpenshell });
}

function repairRecordedSandbox(sandboxName) {
  return repairRecordedSandboxWithDeps(sandboxName, {
    note,
    dashboardPort: DASHBOARD_PORT,
    runOpenshell,
    removeSandbox: (name) => {
      registry.removeSandbox(name);
    },
  });
}

const { streamSandboxCreate } = sandboxCreateStream;

/** Spawn `openshell gateway start` and stream its output with progress heartbeats. */
function streamGatewayStart(command, env = process.env) {
  return streamGatewayStartWithDeps(command, env, {
    spawn,
    root: ROOT,
    envInt,
  });
}


function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  return getInstalledOpenshellVersionWithDeps(versionOutput, { runCapture });
}

function versionGte(left = "0.0.0", right = "0.0.0") {
  return versionGteWithDeps(left, right);
}

function getBlueprintMinOpenshellVersion(rootDir = ROOT) {
  return getBlueprintMinOpenshellVersionWithDeps(rootDir);
}

function getBlueprintMaxOpenshellVersion(rootDir = ROOT) {
  return getBlueprintMaxOpenshellVersionWithDeps(rootDir);
}

// ── Base image digest resolution ────────────────────────────────
// Pulls the sandbox-base image from GHCR and inspects it to get the
// actual repo digest. This avoids the registry mismatch that broke
// e2e tests in #1937 — the digest always comes from the same registry
// we're pinning to. See #1904.

function pullAndResolveBaseImageDigest() {
  return pullAndResolveBaseImageDigestWithDeps({
    run,
    runCapture,
  });
}

function getStableGatewayImageRef(versionOutput = null) {
  return getStableGatewayImageRefWithDeps(versionOutput, { runCapture });
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

function getInferenceValidationDeps() {
  return {
    isNonInteractive,
    prompt,
    normalizeCredentialValue,
    saveCredential,
    validateNvidiaApiKeyValue,
    getTransportRecoveryMessage,
    exitOnboardFromPrompt,
    runCurlProbe,
    runStreamingEventProbe,
    getCurlTimingArgs,
    isWsl,
    getCredential,
    getProbeRecovery,
    isNvcfFunctionNotFoundForAccount,
    nvcfFunctionNotFoundMessage,
    shouldForceCompletionsApi,
  };
}

async function promptValidationRecovery(label, recovery, credentialEnv = null, helpUrl = null) {
  return promptValidationRecoveryWithDeps(
    label,
    recovery,
    credentialEnv,
    helpUrl,
    getInferenceValidationDeps(),
  );
}

function getProviderManagementDeps() {
  return {
    runOpenshell,
    compactText,
    redact,
    registry,
    runCaptureOpenshell,
  };
}

function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
  return buildProviderArgsWithDeps(action, name, type, credentialEnv, baseUrl);
}

function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
  return upsertProviderWithDeps(name, type, credentialEnv, baseUrl, env, getProviderManagementDeps());
}

function upsertMessagingProviders(tokenDefs) {
  return upsertMessagingProvidersWithDeps(tokenDefs, getProviderManagementDeps());
}

function providerExistsInGateway(name) {
  return providerExistsInGatewayWithDeps(name, getProviderManagementDeps());
}

function hashCredential(value) {
  return hashCredentialWithDeps(value);
}

function detectMessagingCredentialRotation(sandboxName, tokenDefs) {
  return detectMessagingCredentialRotationWithDeps(sandboxName, tokenDefs, getProviderManagementDeps());
}

function makeConflictProbe() {
  return makeConflictProbeWithDeps(getProviderManagementDeps());
}

function verifyInferenceRoute(_provider, _model) {
  return verifyInferenceRouteWithDeps(_provider, _model, runCaptureOpenshell);
}

function isInferenceRouteReady(provider, model) {
  return isInferenceRouteReadyWithDeps(provider, model, runCaptureOpenshell);
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
  return buildSandboxConfigSyncScriptWithDeps(selectionConfig);
}

function isOpenclawReady(sandboxName) {
  return isOpenclawReadyWithDeps(sandboxName, { fetchGatewayAuthTokenFromSandbox });
}

function writeSandboxConfigSyncFile(script) {
  return writeSandboxConfigSyncFileWithDeps(script, { secureTempFile });
}

function getWebSearchConfigDeps() {
  return {
    isNonInteractive,
    prompt,
    normalizeCredentialValue,
    getCredential,
    saveCredential,
    runCurlProbe,
    classifyValidationFailure,
    getTransportRecoveryMessage,
    exitOnboardFromPrompt,
    note,
    braveApiKeyEnv: webSearch.BRAVE_API_KEY_ENV,
    braveSearchHelpUrl: BRAVE_SEARCH_HELP_URL,
  };
}

async function ensureValidatedBraveSearchCredential(nonInteractive = isNonInteractive()) {
  return ensureValidatedBraveSearchCredentialWithDeps(nonInteractive, getWebSearchConfigDeps());
}

async function configureWebSearch(existingConfig = null) {
  return configureWebSearchWithDeps(existingConfig, getWebSearchConfigDeps());
}

function getSandboxBuildConfigDeps() {
  return {
    sandboxBaseImage: SANDBOX_BASE_IMAGE,
  };
}

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  return getSandboxInferenceConfigWithDeps(model, provider, preferredInferenceApi);
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
  return patchStagedDockerfileWithDeps(
    dockerfilePath,
    model,
    chatUiUrl,
    buildId,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    messagingChannels,
    messagingAllowedIds,
    discordGuilds,
    baseImageRef,
    getSandboxBuildConfigDeps(),
  );
}

function hasResponsesToolCall(body) {
  return hasResponsesToolCallWithDeps(body);
}

function shouldRequireResponsesToolCalling(provider) {
  return shouldRequireResponsesToolCallingWithDeps(provider);
}

function getProbeAuthMode(provider) {
  return getProbeAuthModeWithDeps(provider);
}

function getValidationProbeCurlArgs(opts) {
  return getValidationProbeCurlArgsWithDeps(opts, getInferenceValidationDeps());
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
  return validateOpenAiLikeSelectionWithDeps(
    label,
    endpointUrl,
    model,
    credentialEnv,
    retryMessage,
    helpUrl,
    options,
    getInferenceValidationDeps(),
  );
}

async function validateAnthropicSelectionWithRetryMessage(
  label,
  endpointUrl,
  model,
  credentialEnv,
  retryMessage = "Please choose a provider/model again.",
  helpUrl = null,
) {
  return validateAnthropicSelectionWithRetryMessageWithDeps(
    label,
    endpointUrl,
    model,
    credentialEnv,
    retryMessage,
    helpUrl,
    getInferenceValidationDeps(),
  );
}

async function validateCustomOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  return validateCustomOpenAiLikeSelectionWithDeps(
    label,
    endpointUrl,
    model,
    credentialEnv,
    helpUrl,
    getInferenceValidationDeps(),
  );
}

async function validateCustomAnthropicSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  return validateCustomAnthropicSelectionWithDeps(
    label,
    endpointUrl,
    model,
    credentialEnv,
    helpUrl,
    getInferenceValidationDeps(),
  );
}


const { promptManualModelId, promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

function getOllamaProxyDeps() {
  return {
    runCapture,
    run,
    spawn,
    sleep,
    scriptsDir: SCRIPTS,
    ollamaProxyPort: OLLAMA_PROXY_PORT,
    ollamaPort: OLLAMA_PORT,
  };
}

function persistProxyToken(token: string): void {
  return persistProxyTokenWithDeps(token);
}

function startOllamaAuthProxy(): void {
  return startOllamaAuthProxyWithDeps(getOllamaProxyDeps());
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
function ensureOllamaAuthProxy(): void {
  return ensureOllamaAuthProxyWithDeps(getOllamaProxyDeps());
}

function getOllamaProxyToken(): string | null {
  return getOllamaProxyTokenWithDeps();
}


function getOllamaModelDeps() {
  return {
    getOllamaModelOptions,
    getBootstrapOllamaModelOptions,
    getDefaultOllamaModel,
    prompt,
    promptManualModelId,
    shellQuote,
    root: ROOT,
    getOllamaWarmupCommand,
    run,
    validateOllamaModel,
  };
}

async function promptOllamaModel(gpu = null) {
  return promptOllamaModelWithDeps(gpu, getOllamaModelDeps());
}

function printOllamaExposureWarning() {
  return printOllamaExposureWarningWithDeps();
}

function prepareOllamaModel(model, installedModels = []) {
  return prepareOllamaModelWithDeps(model, installedModels, getOllamaModelDeps());
}


// ── Step 1: Preflight ────────────────────────────────────────────

const hostGatewayApi = createHostGatewayApi({
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
  scriptsDir: SCRIPTS,
  processEnv: process.env,
  processArch: process.arch,
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  exit: (code) => process.exit(code),
  openshellShellCommand,
  streamGatewayStart,
  isGatewayHealthy,
  hasStaleGateway,
  redact,
  compactText,
  envInt,
  getContainerRuntime,
  shouldPatchCoredns,
  pruneKnownHostsEntries,
  isSelectedGateway,
});

const {
  preflight,
  startGatewayWithOptions,
  startGateway,
  startGatewayForRecovery,
  getGatewayStartEnv,
  recoverGatewayRuntime,
} = hostGatewayApi;

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  return resolveFutureShellPathHint(binDir, pathValue);
}

function getPortConflictServiceHints(platform = process.platform, launchAgentPlist = OPENCLAW_LAUNCH_AGENT_PLIST) {
  return resolvePortConflictServiceHints(platform, launchAgentPlist);
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

function getRequestedSandboxNameHint(env = process.env) {
  return resolveRequestedSandboxNameHint(env);
}

function getResumeSandboxConflict(session, env = process.env) {
  return detectRequestedResumeSandboxConflict(session, env);
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

function sleep(seconds) {
  return sleepWithDeps(seconds);
}

function destroyGateway() {
  return destroyGatewayWithDeps(GATEWAY_NAME, {
    runOpenshell,
    clearRegistryAll: () => {
      registry.clearAll();
    },
    run,
  });
}

function installOpenshell() {
  const result = installOpenshellWithDepsRuntime({
    scriptPath: path.join(SCRIPTS, "install-openshell.sh"),
    rootDir: ROOT,
    env: process.env,
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

function isOpenshellInstalled() {
  return isOpenshellInstalledWithDepsRuntime();
}

function getContainerRuntime() {
  return getContainerRuntimeWithDeps(runCapture);
}

function printRemediationActions(actions) {
  return printRemediationActionsWithDeps(actions, console.error);
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
  return waitForSandboxReadyWithDepsRuntime(
    sandboxName,
    {
      runCaptureOpenshell,
    },
    attempts,
    delaySeconds,
  );
}

// ── Step 3: Inference selection ──────────────────────────────────

const { TELEGRAM_NETWORK_CURL_CODES } = require("./onboard-telegram");

const inferenceRuntimeApi = createInferenceRuntimeApi({
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
  runOpenshell,
  hydrateCredentialEnv,
  upsertProvider,
  promptValidationRecovery,
  classifyApplyFailure,
  compactText,
  redact,
  localInferenceTimeoutSecs: LOCAL_INFERENCE_TIMEOUT_SECS,
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  persistProxyToken,
  getOllamaWarmupCommand,
  validateOllamaModel,
  verifyInferenceRoute,
  updateSandbox: (name, patch) => {
    registry.updateSandbox(name, patch);
  },
  runCurlProbe,
  promptOrDefault,
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  exit: (code) => process.exit(code),
  normalizeCredentialValue,
  saveCredential,
  env: process.env,
  stdin: process.stdin,
  stderr: process.stderr,
  isInteractiveTty: process.stdout.isTTY,
  noteLog: (...args) => console.log(...args),
  getProviderSelectionConfig,
  writeSandboxConfigSyncFile,
  openshellShellCommand,
  shellQuote,
  cleanupTempDir,
  fetchGatewayAuthTokenFromSandbox: (sandboxName) => fetchGatewayAuthTokenFromSandbox(sandboxName),
  secureTempFile,
});

const {
  setupNim,
  setupInference,
  checkTelegramReachability,
  setupMessagingChannels,
  getSuggestedPolicyPresets,
  setupOpenclaw,
} = inferenceRuntimeApi;

// ── Step 7: Policy presets ───────────────────────────────────────

const policyUiApi = createPolicyUiApi({
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
  getSuggestedPolicyPresets,
});

const {
  setupPoliciesLegacy: _setupPolicies,
  arePolicyPresetsApplied,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  presetsCheckboxSelector,
  setupPoliciesWithSelection,
} = policyUiApi;

// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = DASHBOARD_PORT;

// Dashboard helpers — delegated to src/lib/dashboard.ts
// isLoopbackHostname — see urlUtils import above
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;

const dashboardApi = createDashboardApi({
  controlUiPort: CONTROL_UI_PORT,
  runOpenshell,
  warningWriter: console.warn,
  openshellShellCommand,
  runCapture,
  nimStatusByName: (containerName) => nim.nimStatusByName(containerName),
  nimStatus: (sandboxName) => nim.nimStatus(sandboxName),
  note,
  log: console.log,
  printAgentDashboardUi: agentOnboard.printDashboardUi,
  buildControlUiUrls,
});

const {
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  getDashboardForwardStartCommand,
  getDashboardAccessInfo,
  printDashboard,
} = dashboardApi;

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
