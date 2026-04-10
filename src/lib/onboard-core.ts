// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);
const { ROOT, SCRIPTS, redact, run, runCapture, shellQuote } = require("./runner");
const { stageOptimizedSandboxBuildContext } = require("./sandbox-build-context");
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
const policies = require("./policies");
const { ensureUsageNoticeConsent } = require("./usage-notice");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getMemoryInfo,
  planHostRemediation,
} = require("./preflight");
const agentOnboard = require("./agent-onboard");

const gatewayState = require("./gateway-state");
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
const { createOnboardCredentialHelpers } = require("./onboard-credentials");
const { createOnboardDashboardHelpers } = require("./onboard-dashboard");
const { createOnboardPolicyHelpers } = require("./onboard-policies");
const { createOnboardGatewayHelpers } = require("./onboard-gateway");
const { createOnboardImageConfigHelpers } = require("./onboard-image-config");
const { createOnboardMessagingHelpers } = require("./onboard-messaging");
const { createOnboardOpenclawHelpers } = require("./onboard-openclaw");
const { createOnboardProviderHelpers } = require("./onboard-provider");
const { createOnboardProviderValidationHelpers } = require("./onboard-provider-validation");
const { createOnboardSandboxHelpers } = require("./onboard-sandbox");
const { createOnboardSelectionHelpers } = require("./onboard-selection");
const { createOnboardFlowHelpers } = require("./onboard-flow");
const { createOnboardRuntimeHelpers } = require("./onboard-runtime");
const { createOnboardSharedHelpers } = require("./onboard-shared");
const { createOnboardWebSearchHelpers } = require("./onboard-web-search");

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN = null;
const GATEWAY_NAME = "nemoclaw";
const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";
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

const {
  cleanupTempDir,
  encodeDockerJsonArg,
  exitOnboardFromPrompt,
  getNavigationChoice,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  hydrateCredentialEnv,
  isAffirmativeAnswer,
  isNonInteractive,
  isRecreateSandbox,
  note,
  promptOrDefault,
  secureTempFile,
  skippedStepMessage,
  startRecordedStep,
  step,
} = createOnboardSharedHelpers({
  DIM,
  RESET,
  getCredential,
  getNonInteractiveFlag: () => NON_INTERACTIVE,
  getRecreateSandboxFlag: () => RECREATE_SANDBOX,
  onboardSession,
  prompt,
});

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
const { streamSandboxCreate } = sandboxCreateStream;

const {
  getBlueprintMinOpenshellVersion,
  getContainerRuntime,
  getFutureShellPathHint,
  getInstalledOpenshellVersion,
  getOpenshellBinary,
  getPortConflictServiceHints,
  getStableGatewayImageRef,
  installOpenshell,
  isOpenshellInstalled,
  openshellShellCommand,
  preflight,
  printRemediationActions,
  runCaptureOpenshell,
  runOpenshell,
  sleep,
  versionGte,
} = createOnboardRuntimeHelpers({
  GATEWAY_NAME,
  OPENCLAW_LAUNCH_AGENT_PLIST,
  ROOT,
  SCRIPTS,
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getGatewayReuseState,
  getMemoryInfo,
  getOpenshellBin: () => OPENSHELL_BIN,
  inferContainerRuntime,
  isNonInteractive,
  nim,
  planHostRemediation,
  prompt,
  registry,
  resolveOpenshell,
  run,
  runCapture,
  setOpenshellBin: (value) => {
    OPENSHELL_BIN = value;
  },
  shellQuote,
  step,
});

// URL/string utilities — delegated to src/lib/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;
const { getCurlTimingArgs, summarizeCurlFailure, summarizeProbeFailure, runCurlProbe } = httpProbe;

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
} = validation;

// validateNvidiaApiKeyValue — see validation import above

const { ensureNamedCredential, promptValidationRecovery, replaceNamedCredential } =
  createOnboardCredentialHelpers({
    exitOnboardFromPrompt,
    getCredential,
    getTransportRecoveryMessage,
    isNonInteractive,
    normalizeCredentialValue,
    prompt,
    saveCredential,
    validateNvidiaApiKeyValue,
  });

const {
  buildProviderArgs,
  isInferenceRouteReady,
  providerExistsInGateway,
  setupInference,
  upsertMessagingProviders,
  upsertProvider,
  verifyInferenceRoute,
} = createOnboardProviderHelpers({
  GATEWAY_NAME,
  LOCAL_INFERENCE_TIMEOUT_SECS,
  REMOTE_PROVIDER_CONFIG,
  classifyApplyFailure,
  compactText,
  getLocalProviderBaseUrl,
  getOllamaWarmupCommand,
  hydrateCredentialEnv,
  isNonInteractive,
  parseGatewayInference,
  promptValidationRecovery,
  registry,
  run,
  runCapture,
  runCaptureOpenshell,
  runOpenshell,
  step,
  validateLocalProvider,
  validateOllamaModel,
});

const {
  configureWebSearch,
  ensureValidatedBraveSearchCredential,
  printBraveExposureWarning,
  promptBraveSearchApiKey,
  promptBraveSearchRecovery,
  validateBraveSearchApiKey,
} = createOnboardWebSearchHelpers({
  BRAVE_SEARCH_HELP_URL,
  classifyValidationFailure,
  exitOnboardFromPrompt,
  getCredential,
  getTransportRecoveryMessage,
  isAffirmativeAnswer,
  isNonInteractive,
  normalizeCredentialValue,
  note,
  prompt,
  runCurlProbe,
  saveCredential,
  webSearch,
});

const { getSandboxInferenceConfig, patchStagedDockerfile } = createOnboardImageConfigHelpers({
  encodeDockerJsonArg,
  getCredential,
  webSearch,
});

const {
  getValidationProbeCurlArgs,
  hasResponsesToolCall,
  parseJsonObject,
  probeAnthropicEndpoint,
  probeOpenAiLikeEndpoint,
  probeResponsesToolCalling,
  shouldRequireResponsesToolCalling,
  validateAnthropicSelectionWithRetryMessage,
  validateCustomAnthropicSelection,
  validateCustomOpenAiLikeSelection,
  validateOpenAiLikeSelection,
} = createOnboardProviderValidationHelpers({
  getCredential,
  getCurlTimingArgs,
  getProbeRecovery,
  isNonInteractive,
  isNvcfFunctionNotFoundForAccount,
  normalizeCredentialValue,
  nvcfFunctionNotFoundMessage,
  promptValidationRecovery,
  runCurlProbe,
});

// shouldSkipResponsesProbe and isNvcfFunctionNotFoundForAccount /
// nvcfFunctionNotFoundMessage — see validation import above. They live in
// src/lib/validation.ts so they can be unit-tested independently.

const { promptManualModelId, promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

const {
  destroyGateway,
  getGatewayStartEnv,
  pruneKnownHostsEntries,
  recoverGatewayRuntime,
  startGateway,
  startGatewayForRecovery,
  startGatewayWithOptions,
  streamGatewayStart,
} = createOnboardGatewayHelpers({
  GATEWAY_NAME,
  ROOT,
  SCRIPTS,
  compactText,
  envInt,
  getContainerRuntime,
  getInstalledOpenshellVersion,
  hasStaleGateway,
  isGatewayHealthy,
  isSelectedGateway,
  openshellShellCommand,
  redact,
  registry,
  run,
  runCaptureOpenshell,
  runOpenshell,
  shouldPatchCoredns,
  sleep,
  step,
});

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

const {
  getNonInteractiveModel,
  getNonInteractiveProvider,
  prepareOllamaModel,
  promptOllamaModel,
  pullOllamaModel,
  setupNim,
} = createOnboardSelectionHelpers({
  ANTHROPIC_ENDPOINT_URL,
  BACK_TO_SELECTION,
  DEFAULT_CLOUD_MODEL,
  EXPERIMENTAL,
  GATEWAY_NAME,
  REMOTE_PROVIDER_CONFIG,
  ROOT,
  ensureApiKey,
  ensureNamedCredential,
  exitOnboardFromPrompt,
  getBootstrapOllamaModelOptions,
  getCredential,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getNavigationChoice,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  isNonInteractive,
  isSafeModelId,
  isWsl,
  nim,
  normalizeProviderBaseUrl,
  note,
  prompt,
  promptCloudModel,
  promptInputModel,
  promptManualModelId,
  promptRemoteModel,
  run,
  runCapture,
  shellQuote,
  shouldRequireResponsesToolCalling,
  shouldSkipResponsesProbe,
  sleep,
  step,
  validateAnthropicModel,
  validateAnthropicSelectionWithRetryMessage,
  validateCustomAnthropicSelection,
  validateCustomOpenAiLikeSelection,
  validateNvidiaApiKeyValue,
  validateOllamaModel,
  validateOpenAiLikeModel,
  validateOpenAiLikeSelection,
});

// ── Step 1: Preflight ────────────────────────────────────────────

// eslint-disable-next-line complexity
// ── Step 2: Gateway ──────────────────────────────────────────────

// ── Step 3: Inference selection ──────────────────────────────────

// eslint-disable-next-line complexity
// ── Step 4: Inference provider ───────────────────────────────────

// ── Step 6: Messaging channels ───────────────────────────────────

const { MESSAGING_CHANNELS, setupMessagingChannels } = createOnboardMessagingHelpers({
  getCredential,
  isNonInteractive,
  normalizeCredentialValue,
  note,
  prompt,
  saveCredential,
  step,
});

// ── Step 7: OpenClaw ─────────────────────────────────────────────

// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = 18789;

// Dashboard helpers — delegated to src/lib/dashboard.ts
// isLoopbackHostname — see urlUtils import above
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;
const {
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  findOpenclawJsonPath,
  printDashboard,
} = createOnboardDashboardHelpers({
  agentOnboard,
  buildControlUiUrls,
  controlUiPort: CONTROL_UI_PORT,
  nim,
  note,
  resolveDashboardForwardTarget,
  runOpenshell,
});

const {
  buildSandboxConfigSyncScript,
  createSandbox,
  getSandboxReuseState,
  isOpenclawReady,
  pruneStaleSandboxEntry,
  promptValidatedSandboxName,
  repairRecordedSandbox,
  waitForSandboxReady,
  writeSandboxConfigSyncFile,
} = createOnboardSandboxHelpers({
  CONTROL_UI_PORT,
  DISCORD_SNOWFLAKE_RE,
  GATEWAY_NAME,
  ROOT,
  SCRIPTS,
  MESSAGING_CHANNELS,
  REMOTE_PROVIDER_CONFIG,
  agentOnboard,
  classifySandboxCreateFailure,
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  formatEnvAssignment,
  getCredential,
  getSandboxStateFromOutputs,
  isNonInteractive,
  isRecreateSandbox,
  isSandboxReady,
  normalizeCredentialValue,
  note,
  openshellShellCommand,
  patchStagedDockerfile,
  printSandboxCreateRecoveryHints,
  promptOrDefault,
  providerExistsInGateway,
  registry,
  run,
  runCapture,
  runCaptureOpenshell,
  runOpenshell,
  secureTempFile,
  shellQuote,
  sleep,
  stageOptimizedSandboxBuildContext,
  step,
  streamSandboxCreate,
  upsertMessagingProviders,
  webSearch,
});

const { setupOpenclaw } = createOnboardOpenclawHelpers({
  buildSandboxConfigSyncScript,
  cleanupTempDir,
  getProviderSelectionConfig,
  openshellShellCommand,
  run,
  shellQuote,
  step,
  writeSandboxConfigSyncFile,
});

const {
  _setupPolicies,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  presetsCheckboxSelector,
  setupPoliciesWithSelection,
} = createOnboardPolicyHelpers({
  USE_COLOR,
  getCredential,
  isNonInteractive,
  note,
  parsePolicyPresetEnv,
  policies,
  prompt,
  sleep,
  step,
  waitForSandboxReady,
});

// ── Main ─────────────────────────────────────────────────────────

// eslint-disable-next-line complexity
const { onboard } = createOnboardFlowHelpers({
  GATEWAY_NAME,
  agentOnboard,
  arePolicyPresetsApplied,
  buildSandboxConfigSyncScript,
  cleanupTempDir,
  configureWebSearch,
  createSandbox,
  ensureUsageNoticeConsent,
  ensureValidatedBraveSearchCredential,
  getGatewayReuseState,
  getOpenshellBinary,
  getResumeConfigConflicts,
  getSandboxReuseState,
  hydrateCredentialEnv,
  isInferenceRouteReady,
  isNonInteractive,
  isOpenclawReady,
  nim,
  note,
  onboardSession,
  openshellShellCommand,
  preflight,
  printDashboard,
  registry,
  repairRecordedSandbox,
  runCaptureOpenshell,
  setNonInteractiveFlag: (value) => {
    NON_INTERACTIVE = value;
  },
  setRecreateSandboxFlag: (value) => {
    RECREATE_SANDBOX = value;
  },
  setupInference,
  setupMessagingChannels,
  setupNim,
  setupOpenclaw,
  setupPoliciesWithSelection,
  skippedStepMessage,
  startGateway,
  startRecordedStep,
  step,
  writeSandboxConfigSyncFile,
});

module.exports = {
  buildProviderArgs,
  buildSandboxConfigSyncScript,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  createSandbox,
  formatEnvAssignment,
  getFutureShellPathHint,
  getGatewayStartEnv,
  getGatewayReuseState,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
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
  startGatewayForRecovery,
  runCaptureOpenshell,
  setupInference,
  setupMessagingChannels,
  setupNim,
  isInferenceRouteReady,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  presetsCheckboxSelector,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  upsertProvider,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
};
