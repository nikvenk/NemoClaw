// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createOnboardSharedHelpers } = require("../dist/lib/onboard/shared.js");
const { createOnboardCredentialHelpers } = require("../dist/lib/onboard/credentials.js");
const {
  createOnboardProviderValidationHelpers,
} = require("../dist/lib/onboard/provider-validation.js");
const { createOnboardProviderHelpers } = require("../dist/lib/onboard/provider.js");
const { createOnboardImageConfigHelpers } = require("../dist/lib/onboard/image-config.js");
const { createOnboardOpenclawHelpers } = require("../dist/lib/onboard/openclaw.js");
const { createOnboardMessagingHelpers } = require("../dist/lib/onboard/messaging.js");
const { createOnboardPolicyHelpers } = require("../dist/lib/onboard/policies.js");
const { createOnboardDashboardHelpers } = require("../dist/lib/onboard/dashboard.js");
const { createOnboardGatewayHelpers } = require("../dist/lib/onboard/gateway.js");
const { createOnboardRuntimeHelpers } = require("../dist/lib/onboard/runtime.js");
const { createOnboardSandboxHelpers } = require("../dist/lib/onboard/sandbox.js");
const { createOnboardSelectionHelpers } = require("../dist/lib/onboard/selection.js");
const { createOnboardFlowHelpers } = require("../dist/lib/onboard/flow.js");
const onboardIndex = require("../dist/lib/onboard/index.js");

describe("onboard dist helper coverage", () => {
  const originalExit = process.exit;

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_PROVIDER;
    delete process.env.NEMOCLAW_MODEL;
    delete process.env.NEMOCLAW_POLICY_MODE;
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.BRAVE_API_KEY;
    delete process.env.NVIDIA_API_KEY;
  });

  it("covers shared and credential helpers", async () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "  My-Assistant  ";
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "model-a";

    const markStepStarted = vi.fn();
    const updateSession = vi.fn((updater) =>
      updater({ sandboxName: null, provider: null, model: null }),
    );
    const shared = createOnboardSharedHelpers({
      DIM: "",
      RESET: "",
      getCredential: vi.fn(),
      getNonInteractiveFlag: () => true,
      getRecreateSandboxFlag: () => false,
      onboardSession: { markStepStarted, updateSession },
      prompt: vi.fn(),
    });

    expect(shared.getRequestedSandboxNameHint()).toBe("my-assistant");
    expect(shared.getRequestedProviderHint(true)).toBe("build");
    expect(shared.getResumeSandboxConflict({ sandboxName: "other" })).toEqual({
      requestedSandboxName: "my-assistant",
      recordedSandboxName: "other",
    });
    shared.startRecordedStep("sandbox", {
      sandboxName: "sandbox-a",
      provider: "provider-a",
      model: "model-a",
    });
    expect(markStepStarted).toHaveBeenCalledWith("sandbox");

    const prompt = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("nvapi-test-key");
    const saveCredential = vi.fn();
    const credentials = createOnboardCredentialHelpers({
      exitOnboardFromPrompt: vi.fn(),
      getCredential: vi.fn(() => null),
      getTransportRecoveryMessage: vi.fn(() => "transport"),
      isNonInteractive: () => false,
      normalizeCredentialValue: (value) => String(value).trim(),
      prompt,
      saveCredential,
      validateNvidiaApiKeyValue: vi.fn(() => null),
    });
    await expect(
      credentials.promptValidationRecovery("NVIDIA", { kind: "credential" }, "NVIDIA_API_KEY"),
    ).resolves.toBe("credential");
    expect(saveCredential).toHaveBeenCalledWith("NVIDIA_API_KEY", "nvapi-test-key");
  });

  it("covers provider validation and provider helpers", () => {
    const runCurlProbe = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        httpStatus: 404,
        curlStatus: 0,
        message: "missing",
        body: "account missing",
      })
      .mockReturnValueOnce({
        ok: false,
        httpStatus: 404,
        curlStatus: 0,
        message: "missing",
        body: "account missing",
      });
    const validationHelpers = createOnboardProviderValidationHelpers({
      getCredential: vi.fn(),
      getCurlTimingArgs: vi.fn(() => ["--connect-timeout", "10", "--max-time", "60"]),
      getProbeRecovery: vi.fn(),
      isNonInteractive: () => false,
      isNvcfFunctionNotFoundForAccount: vi.fn((value) => String(value).includes("account missing")),
      normalizeCredentialValue: (value) => value,
      nvcfFunctionNotFoundMessage: vi.fn((model) => `missing ${model}`),
      promptValidationRecovery: vi.fn(),
      runCurlProbe,
    });
    expect(
      validationHelpers.hasResponsesToolCall(JSON.stringify({ output: [{ type: "tool_call" }] })),
    ).toBe(true);
    expect(
      validationHelpers.probeOpenAiLikeEndpoint("https://example.test/v1", "model-a", "key"),
    ).toEqual(expect.objectContaining({ ok: false, message: "missing model-a" }));

    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "AlreadyExists" })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });
    const providerHelpers = createOnboardProviderHelpers({
      GATEWAY_NAME: "nemoclaw",
      LOCAL_INFERENCE_TIMEOUT_SECS: 180,
      REMOTE_PROVIDER_CONFIG: {},
      classifyApplyFailure: vi.fn(),
      compactText: (value) => String(value).trim(),
      getLocalProviderBaseUrl: vi.fn(),
      getOllamaWarmupCommand: vi.fn(),
      hydrateCredentialEnv: vi.fn(() => "saved-key"),
      isNonInteractive: () => false,
      parseGatewayInference: vi.fn(() => ({ provider: "provider-a", model: "model-a" })),
      promptValidationRecovery: vi.fn(),
      registry: { updateSandbox: vi.fn() },
      run: vi.fn(),
      runCapture: vi.fn(),
      runCaptureOpenshell: vi.fn(() => "Gateway inference configured"),
      runOpenshell,
      step: vi.fn(),
      validateLocalProvider: vi.fn(),
      validateOllamaModel: vi.fn(),
    });
    expect(
      providerHelpers.upsertProvider("provider-a", "openai", "OPENAI_API_KEY", "https://base"),
    ).toEqual({ ok: true });
    expect(providerHelpers.providerExistsInGateway("provider-a")).toBe(true);
  });

  it("covers image-config and openclaw helpers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-dist-image-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=",
        "ARG NEMOCLAW_PROVIDER_KEY=",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=",
        "ARG NEMOCLAW_INFERENCE_API=",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=",
        "ARG NEMOCLAW_BUILD_ID=",
        "ARG NEMOCLAW_PROXY_HOST=",
        "ARG NEMOCLAW_PROXY_PORT=",
        "ARG NEMOCLAW_WEB_CONFIG_B64=",
        "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
      ].join("\n"),
    );
    const imageHelpers = createOnboardImageConfigHelpers({
      encodeDockerJsonArg: (value) => Buffer.from(JSON.stringify(value ?? {})).toString("base64"),
      getCredential: vi.fn(() => "brave-key"),
      webSearch: {
        BRAVE_API_KEY_ENV: "BRAVE_API_KEY",
        buildWebSearchDockerConfig: vi.fn(() => "ZW5hYmxlZA=="),
      },
    });
    imageHelpers.patchStagedDockerfile(dockerfilePath, "model-a", "http://127.0.0.1:18789");
    expect(fs.readFileSync(dockerfilePath, "utf-8")).toContain("ARG NEMOCLAW_MODEL=model-a");

    const run = vi.fn();
    const cleanupTempDir = vi.fn();
    const openclawHelpers = createOnboardOpenclawHelpers({
      buildSandboxConfigSyncScript: vi.fn(() => "echo ok"),
      cleanupTempDir,
      getProviderSelectionConfig: vi.fn(() => ({ model: "model-a" })),
      openshellShellCommand: vi.fn(() => "openshell sandbox connect sandbox-a"),
      run,
      shellQuote: (value) => `'${value}'`,
      step: vi.fn(),
      writeSandboxConfigSyncFile: vi.fn(() => "/tmp/script.sh"),
    });
    await openclawHelpers.setupOpenclaw("sandbox-a", "model-a", "nvidia-prod");
    expect(run).toHaveBeenCalled();
    expect(cleanupTempDir).toHaveBeenCalled();
  });

  it("covers messaging, policies, and dashboard helpers", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    const messaging = createOnboardMessagingHelpers({
      getCredential: vi.fn(() => null),
      isNonInteractive: () => true,
      normalizeCredentialValue: (value) => value?.trim() || "",
      note: vi.fn(),
      prompt: vi.fn(),
      saveCredential: vi.fn(),
      step: vi.fn(),
    });
    await expect(messaging.setupMessagingChannels()).resolves.toEqual(["telegram"]);

    process.env.NEMOCLAW_POLICY_MODE = "skip";
    const policies = createOnboardPolicyHelpers({
      USE_COLOR: false,
      getCredential: vi.fn(() => null),
      isNonInteractive: () => true,
      note: vi.fn(),
      parsePolicyPresetEnv: vi.fn(() => []),
      policies: {
        applyPreset: vi.fn(),
        getAppliedPresets: vi.fn(() => ["npm"]),
        listPresets: vi.fn(() => [{ name: "npm", description: "npm" }]),
      },
      prompt: vi.fn(),
      sleep: vi.fn(),
      step: vi.fn(),
      waitForSandboxReady: vi.fn(() => true),
    });
    await expect(policies.setupPoliciesWithSelection("sandbox-a")).resolves.toEqual([]);
    expect(policies.arePolicyPresetsApplied("sandbox-a", ["npm"])).toBe(true);

    const dashboard = createOnboardDashboardHelpers({
      agentOnboard: { printDashboardUi: vi.fn() },
      buildControlUiUrls: vi.fn(() => ["http://localhost:18789/#token=abc"]),
      controlUiPort: 18789,
      nim: {
        nimStatus: vi.fn(() => ({ running: false })),
        nimStatusByName: vi.fn(() => ({ running: false })),
      },
      note: vi.fn(),
      resolveDashboardForwardTarget: vi.fn(() => "127.0.0.1:18789"),
      runOpenshell: vi.fn(() => ({ status: 0 })),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-dashboard-"));
    const nested = path.join(tmpDir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    const cfg = path.join(nested, "openclaw.json");
    fs.writeFileSync(cfg, "{}\n");
    expect(dashboard.findOpenclawJsonPath(tmpDir)).toBe(cfg);
    dashboard.ensureDashboardForward("sandbox-a");
  });

  it("covers runtime, gateway, sandbox, and selection helpers", async () => {
    const runtime = createOnboardRuntimeHelpers({
      GATEWAY_NAME: "nemoclaw",
      OPENCLAW_LAUNCH_AGENT_PLIST: "plist",
      ROOT: process.cwd(),
      SCRIPTS: process.cwd(),
      assessHost: vi.fn(() => ({ dockerReachable: true, runtime: "docker", notes: [] })),
      checkPortAvailable: vi.fn(async () => ({ ok: true })),
      ensureSwap: vi.fn(),
      getGatewayReuseState: vi.fn(() => "healthy"),
      getMemoryInfo: vi.fn(() => null),
      getOpenshellBin: vi.fn(() => null),
      inferContainerRuntime: vi.fn(() => "docker"),
      isNonInteractive: () => false,
      nim: { detectGpu: vi.fn(() => null) },
      planHostRemediation: vi.fn(),
      prompt: vi.fn(),
      registry: { clearAll: vi.fn() },
      resolveOpenshell: vi.fn(() => "/resolved/openshell"),
      run: vi.fn(),
      runCapture: vi.fn((command) =>
        String(command).includes("--version") || String(command).includes("-V")
          ? "openshell 0.0.25"
          : "docker info",
      ),
      setOpenshellBin: vi.fn(),
      shellQuote: (value) => `'${value}'`,
      step: vi.fn(),
    });
    await expect(runtime.preflight()).resolves.toBeNull();
    expect(runtime.getStableGatewayImageRef("openshell 0.0.25")).toContain(":0.0.25");

    const gateway = createOnboardGatewayHelpers({
      GATEWAY_NAME: "nemoclaw",
      ROOT: process.cwd(),
      SCRIPTS: process.cwd(),
      compactText: vi.fn((value) => value),
      envInt: vi.fn((_, fallback) => fallback),
      getContainerRuntime: vi.fn(() => "docker"),
      getInstalledOpenshellVersion: vi.fn(() => "0.0.25"),
      hasStaleGateway: vi.fn(() => false),
      isGatewayHealthy: vi.fn(() => true),
      isSelectedGateway: vi.fn(() => true),
      openshellShellCommand: vi.fn(() => "openshell gateway start"),
      redact: vi.fn((value) => value),
      registry: { clearAll: vi.fn() },
      run: vi.fn(),
      runCaptureOpenshell: vi.fn(() => "Connected"),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      shouldPatchCoredns: vi.fn(() => false),
      sleep: vi.fn(),
      step: vi.fn(),
    });
    await expect(
      gateway.startGatewayWithOptions(null, { exitOnFailure: false }),
    ).resolves.toBeUndefined();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-sandbox-"));
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM scratch\n");
    const sandbox = createOnboardSandboxHelpers({
      CONTROL_UI_PORT: 18789,
      DISCORD_SNOWFLAKE_RE: /^[0-9]{17,19}$/,
      GATEWAY_NAME: "nemoclaw",
      ROOT: process.cwd(),
      SCRIPTS: process.cwd(),
      MESSAGING_CHANNELS: [],
      REMOTE_PROVIDER_CONFIG: {},
      agentOnboard: {},
      classifySandboxCreateFailure: vi.fn(() => ({ kind: "other" })),
      ensureDashboardForward: vi.fn(),
      fetchGatewayAuthTokenFromSandbox: vi.fn(() => null),
      formatEnvAssignment: (name, value) => `${name}=${value}`,
      getCredential: vi.fn(() => null),
      getSandboxStateFromOutputs: vi.fn(() => "missing"),
      isNonInteractive: () => false,
      isRecreateSandbox: () => false,
      isSandboxReady: vi.fn(() => true),
      normalizeCredentialValue: (value) => value,
      note: vi.fn(),
      openshellShellCommand: vi.fn(() => "openshell sandbox create"),
      patchStagedDockerfile: vi.fn(),
      printSandboxCreateRecoveryHints: vi.fn(),
      promptOrDefault: vi.fn(async () => "sandbox-a"),
      providerExistsInGateway: vi.fn(() => true),
      registry: { getSandbox: vi.fn(() => null), registerSandbox: vi.fn(), removeSandbox: vi.fn() },
      run: vi.fn(),
      runCapture: vi.fn(() => "ok"),
      runCaptureOpenshell: vi.fn(() => "Ready"),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      secureTempFile: vi.fn(() => path.join(tmpDir, "sync.sh")),
      shellQuote: (value) => `'${value}'`,
      sleep: vi.fn(),
      stageOptimizedSandboxBuildContext: vi.fn(() => ({
        buildCtx: tmpDir,
        stagedDockerfile: path.join(tmpDir, "Dockerfile"),
      })),
      step: vi.fn(),
      streamSandboxCreate: vi.fn(async () => ({ status: 0, output: "" })),
      upsertMessagingProviders: vi.fn(() => []),
      webSearch: { BRAVE_API_KEY_ENV: "BRAVE_API_KEY" },
    });
    await expect(sandbox.createSandbox(null, "model-a", "provider-a")).resolves.toBe("sandbox-a");

    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "model-a";
    process.env.NVIDIA_API_KEY = "nvapi-key";
    const selection = createOnboardSelectionHelpers({
      ANTHROPIC_ENDPOINT_URL: "https://api.anthropic.com",
      BACK_TO_SELECTION: "__BACK__",
      DEFAULT_CLOUD_MODEL: "model-a",
      EXPERIMENTAL: false,
      GATEWAY_NAME: "nemoclaw",
      REMOTE_PROVIDER_CONFIG: {
        build: {
          label: "NVIDIA Endpoints",
          providerName: "nvidia-prod",
          providerType: "nvidia",
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "https://build.example/v1",
          helpUrl: "https://build.example/key",
          modelMode: "catalog",
          defaultModel: "model-a",
          skipVerify: true,
        },
      },
      ROOT: process.cwd(),
      ensureApiKey: vi.fn(),
      ensureNamedCredential: vi.fn(),
      exitOnboardFromPrompt: vi.fn(),
      getBootstrapOllamaModelOptions: vi.fn(() => []),
      getCredential: vi.fn(() => "nvapi-key"),
      getDefaultOllamaModel: vi.fn(() => "llama3"),
      getLocalProviderBaseUrl: vi.fn(() => "http://localhost"),
      getLocalProviderValidationBaseUrl: vi.fn(() => "http://localhost"),
      getNavigationChoice: vi.fn(),
      getOllamaModelOptions: vi.fn(() => []),
      getOllamaWarmupCommand: vi.fn(() => "ollama run llama3"),
      isNonInteractive: () => true,
      isSafeModelId: vi.fn(() => true),
      isWsl: vi.fn(() => false),
      nim: { detectGpu: vi.fn(), listModels: vi.fn(() => []) },
      normalizeProviderBaseUrl: vi.fn((value) => value),
      note: vi.fn(),
      prompt: vi.fn(),
      promptCloudModel: vi.fn(),
      promptInputModel: vi.fn(),
      promptManualModelId: vi.fn(),
      promptRemoteModel: vi.fn(),
      run: vi.fn(),
      runCapture: vi.fn(() => ""),
      shellQuote: (value) => value,
      shouldRequireResponsesToolCalling: vi.fn(() => false),
      shouldSkipResponsesProbe: vi.fn(() => false),
      sleep: vi.fn(),
      step: vi.fn(),
      validateAnthropicModel: vi.fn(),
      validateAnthropicSelectionWithRetryMessage: vi.fn(),
      validateCustomAnthropicSelection: vi.fn(),
      validateCustomOpenAiLikeSelection: vi.fn(),
      validateNvidiaApiKeyValue: vi.fn(() => null),
      validateOllamaModel: vi.fn(() => ({ ok: true })),
      validateOpenAiLikeModel: vi.fn(),
      validateOpenAiLikeSelection: vi.fn(async () => ({ ok: true, api: "openai-completions" })),
    });
    await expect(selection.setupNim(null)).resolves.toEqual(
      expect.objectContaining({ provider: "nvidia-prod", model: "model-a" }),
    );
  });

  it("covers the flow helper happy path and public facade", async () => {
    let session = { steps: {}, metadata: {}, policyPresets: null };
    const completeSession = vi.fn();
    const flow = createOnboardFlowHelpers({
      GATEWAY_NAME: "nemoclaw",
      agentOnboard: { resolveAgent: vi.fn(() => null), handleAgentSetup: vi.fn() },
      arePolicyPresetsApplied: vi.fn(() => false),
      buildSandboxConfigSyncScript: vi.fn(),
      cleanupTempDir: vi.fn(),
      configureWebSearch: vi.fn(async () => null),
      createSandbox: vi.fn(async () => "sandbox-a"),
      ensureUsageNoticeConsent: vi.fn(async () => true),
      ensureValidatedBraveSearchCredential: vi.fn(),
      getGatewayReuseState: vi.fn(() => "healthy"),
      getOpenshellBinary: vi.fn(() => "/usr/bin/openshell"),
      getResumeConfigConflicts: vi.fn(() => []),
      getSandboxReuseState: vi.fn(() => "missing"),
      hydrateCredentialEnv: vi.fn(),
      isInferenceRouteReady: vi.fn(() => false),
      isNonInteractive: vi.fn(() => false),
      isOpenclawReady: vi.fn(() => false),
      nim: { detectGpu: vi.fn(() => null) },
      note: vi.fn(),
      onboardSession: {
        acquireOnboardLock: vi.fn(() => ({ acquired: true, lockFile: "/tmp/lock" })),
        createSession: vi.fn((value) => ({ ...value, steps: {}, metadata: value.metadata || {} })),
        loadSession: vi.fn(() => session),
        markStepComplete: vi.fn((name, updates = {}) => {
          session.steps[name] = { status: "complete" };
          Object.assign(session, updates);
        }),
        markStepFailed: vi.fn(),
        markStepStarted: vi.fn(),
        releaseOnboardLock: vi.fn(),
        saveSession: vi.fn((value) => {
          session = value;
          return value;
        }),
        updateSession: vi.fn((updater) => {
          session = updater(session) || session;
          return session;
        }),
        completeSession,
      },
      openshellShellCommand: vi.fn(),
      preflight: vi.fn(async () => null),
      printDashboard: vi.fn(),
      registry: { updateSandbox: vi.fn(), removeSandbox: vi.fn() },
      repairRecordedSandbox: vi.fn(),
      runCaptureOpenshell: vi.fn(() => "output"),
      setNonInteractiveFlag: vi.fn(),
      setRecreateSandboxFlag: vi.fn(),
      setupInference: vi.fn(async () => ({ ok: true })),
      setupMessagingChannels: vi.fn(async () => ["telegram"]),
      setupNim: vi.fn(async () => ({
        model: "model-a",
        provider: "provider-a",
        endpointUrl: "https://example.test",
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "openai-completions",
        nimContainer: null,
      })),
      setupOpenclaw: vi.fn(async () => {}),
      setupPoliciesWithSelection: vi.fn(async () => ["npm"]),
      skippedStepMessage: vi.fn(),
      startGateway: vi.fn(async () => {}),
      startRecordedStep: vi.fn(),
      step: vi.fn(),
      writeSandboxConfigSyncFile: vi.fn(),
    });

    await expect(flow.onboard({})).resolves.toBeUndefined();
    expect(completeSession).toHaveBeenCalledWith({
      sandboxName: "sandbox-a",
      provider: "provider-a",
      model: "model-a",
    });
    expect(typeof onboardIndex.onboard).toBe("function");
  });
});
