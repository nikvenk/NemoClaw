// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export function createOnboardSelectionHelpers(deps) {
  const {
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
  } = deps;

  async function promptOllamaModel(gpu = null) {
    const installed = getOllamaModelOptions(runCapture);
    const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
    const defaultModel = getDefaultOllamaModel(runCapture, gpu);
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
        "  Model pull timed out after 10 minutes. Try a smaller model or check your network connection.",
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
    return validateOllamaModel(model, runCapture);
  }

  function getNonInteractiveProvider() {
    const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
    if (!providerKey) return null;
    const aliases = {
      cloud: "build",
      nim: "nim-local",
      vllm: "vllm",
      anthropiccompatible: "anthropicCompatible",
    };
    const normalized = aliases[providerKey] || providerKey;
    const validProviders = new Set([
      "build",
      "openai",
      "anthropic",
      "anthropicCompatible",
      "gemini",
      "ollama",
      "custom",
      "nim-local",
      "vllm",
    ]);
    if (!validProviders.has(normalized)) {
      console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
      console.error(
        "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm",
      );
      process.exit(1);
    }

    return normalized;
  }

  function getNonInteractiveModel(providerKey) {
    const model = (process.env.NEMOCLAW_MODEL || "").trim();
    if (!model) return null;
    if (!isSafeModelId(model)) {
      console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
      console.error(
        "  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      );
      process.exit(1);
    }
    return model;
  }

  function detectSelectionEnvironment() {
    const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
    const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", {
      ignoreError: true,
    });
    const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", {
      ignoreError: true,
    });
    const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
    const requestedModel = isNonInteractive()
      ? getNonInteractiveModel(requestedProvider || "build")
      : null;
    return { hasOllama, ollamaRunning, requestedModel, requestedProvider, vllmRunning };
  }

  function buildSelectionOptions(gpu, env) {
    const options = [
      { key: "build", label: "NVIDIA Endpoints" },
      { key: "openai", label: "OpenAI" },
      { key: "custom", label: "Other OpenAI-compatible endpoint" },
      { key: "anthropic", label: "Anthropic" },
      { key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" },
      { key: "gemini", label: "Google Gemini" },
    ];
    if (env.hasOllama || env.ollamaRunning) {
      options.push({
        key: "ollama",
        label:
          `Local Ollama (localhost:11434)${env.ollamaRunning ? " — running" : ""}` +
          (env.ollamaRunning ? " (suggested)" : ""),
      });
    }
    if (EXPERIMENTAL && gpu && gpu.nimCapable) {
      options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
    }
    if (EXPERIMENTAL && env.vllmRunning) {
      options.push({ key: "vllm", label: "Local vLLM [experimental] — running" });
    }
    if (!env.hasOllama && process.platform === "darwin") {
      options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
    }
    return options;
  }

  async function chooseSelectionOption(options, env) {
    if (isNonInteractive()) {
      const providerKey = env.requestedProvider || "build";
      const selected = options.find((option) => option.key === providerKey);
      if (!selected) {
        console.error(
          `  Requested provider '${providerKey}' is not available in this environment.`,
        );
        process.exit(1);
      }
      note(`  [non-interactive] Provider: ${selected.key}`);
      return selected;
    }

    const suggestions = [];
    if (env.vllmRunning) suggestions.push("vLLM");
    if (env.ollamaRunning) suggestions.push("Ollama");
    if (suggestions.length > 0) {
      console.log(
        `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
      );
      console.log("");
    }

    console.log("");
    console.log("  Inference options:");
    options.forEach((option, index) => {
      console.log(`    ${index + 1}) ${option.label}`);
    });
    console.log("");

    const defaultIdx = options.findIndex((option) => option.key === "build") + 1;
    const choice = await prompt(`  Choose [${defaultIdx}]: `);
    const idx = parseInt(choice || String(defaultIdx), 10) - 1;
    return options[idx] || options[defaultIdx - 1];
  }

  function createSelectionState() {
    return {
      credentialEnv: REMOTE_PROVIDER_CONFIG.build.credentialEnv,
      endpointUrl: REMOTE_PROVIDER_CONFIG.build.endpointUrl,
      model: null,
      nimContainer: null,
      preferredInferenceApi: null,
      provider: REMOTE_PROVIDER_CONFIG.build.providerName,
    };
  }

  function continueSelection() {
    return { action: "continue" };
  }

  function completeSelection(state) {
    return { action: "complete", state };
  }

  function normalizeProviderSuccessMessage(label, preferredInferenceApi, requirement) {
    if (preferredInferenceApi !== "openai-completions") {
      console.log(`  ℹ Using chat completions API (${requirement})`);
    }
    return {
      api: "openai-completions",
      label,
    };
  }

  async function promptCompatibleEndpoint(selectedKey) {
    const isAnthropicCompatible = selectedKey === "anthropicCompatible";
    const endpointInput = isNonInteractive()
      ? (process.env.NEMOCLAW_ENDPOINT_URL || "").trim()
      : await prompt(
          isAnthropicCompatible
            ? "  Anthropic-compatible base URL (e.g., https://proxy.example.com): "
            : "  OpenAI-compatible base URL (e.g., https://openrouter.ai): ",
        );
    const navigation = getNavigationChoice(endpointInput);
    if (navigation === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return { action: "continue" };
    }
    if (navigation === "exit") {
      exitOnboardFromPrompt();
    }
    const endpointUrl = normalizeProviderBaseUrl(
      endpointInput,
      isAnthropicCompatible ? "anthropic" : "openai",
    );
    if (!endpointUrl) {
      console.error(
        isAnthropicCompatible
          ? "  Endpoint URL is required for Other Anthropic-compatible endpoint."
          : "  Endpoint URL is required for Other OpenAI-compatible endpoint.",
      );
      if (isNonInteractive()) {
        process.exit(1);
      }
      console.log("");
      return { action: "continue" };
    }
    return { action: "resolved", endpointUrl };
  }

  async function ensureRemoteCredential(remoteConfig, credentialEnv) {
    if (remoteConfig.key === "build") {
      if (isNonInteractive()) {
        if (!process.env.NVIDIA_API_KEY) {
          console.error(
            "  NVIDIA_API_KEY is required for NVIDIA Endpoints in non-interactive mode.",
          );
          process.exit(1);
        }
        const keyError = validateNvidiaApiKeyValue(process.env.NVIDIA_API_KEY);
        if (keyError) {
          console.error(keyError);
          console.error(`  Get a key from ${REMOTE_PROVIDER_CONFIG.build.helpUrl}`);
          process.exit(1);
        }
      } else {
        await ensureApiKey();
      }
      return;
    }

    if (isNonInteractive()) {
      if (!process.env[credentialEnv]) {
        console.error(
          `  ${credentialEnv} is required for ${remoteConfig.label} in non-interactive mode.`,
        );
        process.exit(1);
      }
      return;
    }

    await ensureNamedCredential(
      credentialEnv,
      `${remoteConfig.label} API key`,
      remoteConfig.helpUrl,
    );
  }

  function getRemoteModelValidator(selection, endpointUrl, credentialEnv) {
    if (selection.key === "openai" || selection.key === "gemini") {
      return (candidate) =>
        validateOpenAiLikeModel(
          selection.label,
          endpointUrl,
          candidate,
          getCredential(credentialEnv),
        );
    }
    if (selection.key === "anthropic") {
      return (candidate) =>
        validateAnthropicModel(
          endpointUrl || ANTHROPIC_ENDPOINT_URL,
          candidate,
          getCredential(credentialEnv),
        );
    }
    return null;
  }

  async function promptRemoteModelSelection(selection, defaultModel, modelValidator) {
    if (isNonInteractive()) {
      return defaultModel;
    }
    if (selection.modelMode === "curated") {
      return promptRemoteModel(selection.label, selection.key, defaultModel, modelValidator);
    }
    return promptInputModel(selection.label, defaultModel, modelValidator);
  }

  async function validateRemoteModelSelection(selection, endpointUrl, model, credentialEnv) {
    const retryMessage = "Please choose a provider/model again.";
    if (selection.key === "custom") {
      return validateCustomOpenAiLikeSelection(
        selection.label,
        endpointUrl,
        model,
        credentialEnv,
        selection.helpUrl,
      );
    }
    if (selection.key === "anthropicCompatible") {
      return validateCustomAnthropicSelection(
        selection.label,
        endpointUrl || ANTHROPIC_ENDPOINT_URL,
        model,
        credentialEnv,
        selection.helpUrl,
      );
    }
    if (selection.key === "anthropic") {
      return validateAnthropicSelectionWithRetryMessage(
        selection.label,
        endpointUrl || ANTHROPIC_ENDPOINT_URL,
        model,
        credentialEnv,
        retryMessage,
        selection.helpUrl,
      );
    }
    return validateOpenAiLikeSelection(
      selection.label,
      endpointUrl,
      model,
      credentialEnv,
      retryMessage,
      selection.helpUrl,
      {
        requireResponsesToolCalling: shouldRequireResponsesToolCalling(selection.providerName),
        skipResponsesProbe: shouldSkipResponsesProbe(selection.providerName),
      },
    );
  }

  async function validateBuildSelection(selection, endpointUrl, model, credentialEnv) {
    while (true) {
      const validation = await validateOpenAiLikeSelection(
        selection.label,
        endpointUrl,
        model,
        credentialEnv,
        "Please choose a provider/model again.",
        selection.helpUrl,
        {
          requireResponsesToolCalling: shouldRequireResponsesToolCalling(selection.providerName),
          skipResponsesProbe: shouldSkipResponsesProbe(selection.providerName),
        },
      );
      if (validation.ok) {
        return { action: "ok", preferredInferenceApi: validation.api };
      }
      if (validation.retry === "credential" || validation.retry === "retry") {
        continue;
      }
      return continueSelection();
    }
  }

  async function resolveRemoteEndpoint(selected) {
    if (selected.key !== "custom" && selected.key !== "anthropicCompatible") {
      return { action: "resolved", endpointUrl: selected.endpointUrl };
    }
    return promptCompatibleEndpoint(selected.key);
  }

  async function resolveBuildSelection(selection, env, state) {
    await ensureRemoteCredential(selection, selection.credentialEnv);
    const model =
      env.requestedModel ||
      (isNonInteractive() ? DEFAULT_CLOUD_MODEL : await promptCloudModel()) ||
      DEFAULT_CLOUD_MODEL;
    if (model === BACK_TO_SELECTION) {
      console.log("  Returning to provider selection.");
      console.log("");
      return continueSelection();
    }
    const validation = await validateBuildSelection(
      selection,
      selection.endpointUrl,
      model,
      selection.credentialEnv,
    );
    if (validation.action === "continue") {
      return validation;
    }
    const nextState = {
      ...state,
      credentialEnv: selection.credentialEnv,
      endpointUrl: selection.endpointUrl,
      model,
      preferredInferenceApi: validation.preferredInferenceApi,
      provider: selection.providerName,
    };
    console.log(`  Using ${selection.label} with model: ${model}`);
    return completeSelection(nextState);
  }

  async function resolveGenericRemoteSelection(selection, env, state) {
    const endpointResolution = await resolveRemoteEndpoint(selection);
    if (endpointResolution.action !== "resolved") {
      return endpointResolution;
    }
    const endpointUrl = endpointResolution.endpointUrl;
    await ensureRemoteCredential(selection, selection.credentialEnv);
    const defaultModel = env.requestedModel || selection.defaultModel;
    const modelValidator = getRemoteModelValidator(selection, endpointUrl, selection.credentialEnv);

    while (true) {
      const model = await promptRemoteModelSelection(selection, defaultModel, modelValidator);
      if (model === BACK_TO_SELECTION) {
        console.log("  Returning to provider selection.");
        console.log("");
        return continueSelection();
      }
      const validation = await validateRemoteModelSelection(
        selection,
        endpointUrl,
        model,
        selection.credentialEnv,
      );
      if (validation.ok) {
        const nextState = {
          ...state,
          credentialEnv: selection.credentialEnv,
          endpointUrl,
          model,
          preferredInferenceApi: validation.api,
          provider: selection.providerName,
        };
        console.log(`  Using ${selection.label} with model: ${model}`);
        return completeSelection(nextState);
      }
      if (
        validation.retry === "credential" ||
        validation.retry === "retry" ||
        validation.retry === "model"
      ) {
        continue;
      }
      return continueSelection();
    }
  }

  async function handleRemoteSelection(selected, env, state) {
    const selection = { ...REMOTE_PROVIDER_CONFIG[selected.key], key: selected.key };
    if (selected.key === "build") {
      return resolveBuildSelection(selection, env, state);
    }
    return resolveGenericRemoteSelection(selection, env, state);
  }

  async function chooseNimModel(models, requestedModel) {
    if (isNonInteractive()) {
      if (requestedModel) {
        const selectedModel = models.find((entry) => entry.name === requestedModel);
        if (!selectedModel) {
          console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
          process.exit(1);
        }
        note(`  [non-interactive] NIM model: ${selectedModel.name}`);
        return selectedModel;
      }
      note(`  [non-interactive] NIM model: ${models[0].name}`);
      return models[0];
    }

    console.log("");
    console.log("  Models that fit your GPU:");
    models.forEach((model, index) => {
      console.log(`    ${index + 1}) ${model.name} (min ${model.minGpuMemoryMB} MB)`);
    });
    console.log("");
    const modelChoice = await prompt("  Choose model [1]: ");
    const modelIndex = parseInt(modelChoice || "1", 10) - 1;
    return models[modelIndex] || models[0];
  }

  async function handleNimLocalSelection(gpu, env, state) {
    const models = nim.listModels().filter((model) => model.minGpuMemoryMB <= gpu.totalMemoryMB);
    if (models.length === 0) {
      console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
      return completeSelection(state);
    }

    const selectedModel = await chooseNimModel(models, env.requestedModel);
    let model = selectedModel.name;
    let nimContainer = null;

    console.log(`  Pulling NIM image for ${model}...`);
    nim.pullNimImage(model);

    console.log("  Starting NIM container...");
    nimContainer = nim.startNimContainerByName(nim.containerName(GATEWAY_NAME), model);

    console.log("  Waiting for NIM to become healthy...");
    if (!nim.waitForNimHealth()) {
      console.error("  NIM failed to start. Falling back to cloud API.");
      return completeSelection({ ...state, model: null, nimContainer: null });
    }

    const provider = "vllm-local";
    const credentialEnv = "OPENAI_API_KEY";
    const endpointUrl = getLocalProviderBaseUrl(provider);
    const validation = await validateOpenAiLikeSelection(
      "Local NVIDIA NIM",
      endpointUrl,
      model,
      credentialEnv,
    );
    if (
      validation.retry === "selection" ||
      validation.retry === "back" ||
      validation.retry === "model"
    ) {
      return continueSelection();
    }
    if (!validation.ok) {
      return continueSelection();
    }

    const normalized = normalizeProviderSuccessMessage(
      "Local NVIDIA NIM",
      validation.api,
      "tool-call-parser requires /v1/chat/completions",
    );
    return completeSelection({
      ...state,
      credentialEnv,
      endpointUrl,
      model,
      nimContainer,
      preferredInferenceApi: normalized.api,
      provider,
    });
  }

  function startOllamaServer(installViaBrew = false) {
    if (installViaBrew) {
      console.log("  Installing Ollama via Homebrew...");
      run("brew install ollama", { ignoreError: true });
    }
    console.log("  Starting Ollama...");
    const ollamaEnv = isWsl() || installViaBrew ? "" : "OLLAMA_HOST=0.0.0.0:11434 ";
    const command = installViaBrew
      ? "OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &"
      : `${ollamaEnv}ollama serve > /dev/null 2>&1 &`;
    run(command, { ignoreError: true });
    sleep(2);
  }

  async function resolveOllamaModelSelection(gpu, requestedModel) {
    const installedModels = getOllamaModelOptions(runCapture);
    const model = isNonInteractive()
      ? requestedModel || getDefaultOllamaModel(runCapture, gpu)
      : await promptOllamaModel(gpu);
    return { installedModels, model };
  }

  async function handleOllamaSelection(gpu, env, state, installViaBrew = false) {
    if (!env.ollamaRunning || installViaBrew) {
      startOllamaServer(installViaBrew);
    }
    console.log("  ✓ Using Ollama on localhost:11434");
    const provider = "ollama-local";
    const credentialEnv = "OPENAI_API_KEY";
    const endpointUrl = getLocalProviderBaseUrl(provider);

    while (true) {
      const { installedModels, model } = await resolveOllamaModelSelection(gpu, env.requestedModel);
      if (model === BACK_TO_SELECTION) {
        console.log("  Returning to provider selection.");
        console.log("");
        return continueSelection();
      }
      const probe = prepareOllamaModel(model, installedModels);
      if (!probe.ok) {
        console.error(`  ${probe.message}`);
        if (isNonInteractive()) {
          process.exit(1);
        }
        console.log("  Choose a different Ollama model or select Other.");
        console.log("");
        continue;
      }
      const validation = await validateOpenAiLikeSelection(
        "Local Ollama",
        getLocalProviderValidationBaseUrl(provider),
        model,
        null,
        "Choose a different Ollama model or select Other.",
      );
      if (validation.retry === "selection" || validation.retry === "back") {
        return continueSelection();
      }
      if (!validation.ok) {
        continue;
      }
      const normalized = normalizeProviderSuccessMessage(
        "Local Ollama",
        validation.api,
        "Ollama tool calls require /v1/chat/completions",
      );
      return completeSelection({
        ...state,
        credentialEnv,
        endpointUrl,
        model,
        preferredInferenceApi: normalized.api,
        provider,
      });
    }
  }

  function resolveVllmModelId() {
    const vllmModelsRaw = runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", {
      ignoreError: true,
    });
    try {
      const vllmModels = JSON.parse(vllmModelsRaw);
      if (vllmModels.data && vllmModels.data.length > 0) {
        const model = vllmModels.data[0].id;
        if (!isSafeModelId(model)) {
          console.error(`  Detected model ID contains invalid characters: ${model}`);
          process.exit(1);
        }
        console.log(`  Detected model: ${model}`);
        return model;
      }
      console.error("  Could not detect model from vLLM. Please specify manually.");
      process.exit(1);
    } catch {
      console.error("  Could not query vLLM models endpoint. Is vLLM running on localhost:8000?");
      process.exit(1);
    }
  }

  async function handleVllmSelection(state) {
    console.log("  ✓ Using existing vLLM on localhost:8000");
    const provider = "vllm-local";
    const credentialEnv = "OPENAI_API_KEY";
    const endpointUrl = getLocalProviderBaseUrl(provider);
    const model = resolveVllmModelId();
    const validation = await validateOpenAiLikeSelection(
      "Local vLLM",
      getLocalProviderValidationBaseUrl(provider),
      model,
      credentialEnv,
    );
    if (
      validation.retry === "selection" ||
      validation.retry === "back" ||
      validation.retry === "model"
    ) {
      return continueSelection();
    }
    if (!validation.ok) {
      return continueSelection();
    }
    const normalized = normalizeProviderSuccessMessage(
      "Local vLLM",
      validation.api,
      "tool-call-parser requires /v1/chat/completions",
    );
    return completeSelection({
      ...state,
      credentialEnv,
      endpointUrl,
      model,
      preferredInferenceApi: normalized.api,
      provider,
    });
  }

  async function handleSelectionOption(selected, env, gpu, state) {
    if (REMOTE_PROVIDER_CONFIG[selected.key]) {
      return handleRemoteSelection(selected, env, state);
    }
    if (selected.key === "nim-local") {
      return handleNimLocalSelection(gpu, env, state);
    }
    if (selected.key === "ollama") {
      return handleOllamaSelection(gpu, env, state);
    }
    if (selected.key === "install-ollama") {
      return handleOllamaSelection(gpu, env, state, true);
    }
    if (selected.key === "vllm") {
      return handleVllmSelection(state);
    }
    return continueSelection();
  }

  async function setupNim(gpu) {
    step(3, 8, "Configuring inference (NIM)");

    const env = detectSelectionEnvironment();
    const options = buildSelectionOptions(gpu, env);
    let state = createSelectionState();

    if (options.length > 1) {
      while (true) {
        const selected = await chooseSelectionOption(options, env);
        const outcome = await handleSelectionOption(selected, env, gpu, state);
        if (outcome.action === "continue") {
          continue;
        }
        state = outcome.state;
        break;
      }
    }

    return {
      model: state.model,
      provider: state.provider,
      endpointUrl: state.endpointUrl,
      credentialEnv: state.credentialEnv,
      preferredInferenceApi: state.preferredInferenceApi,
      nimContainer: state.nimContainer,
    };
  }

  return {
    getNonInteractiveModel,
    getNonInteractiveProvider,
    prepareOllamaModel,
    promptOllamaModel,
    pullOllamaModel,
    setupNim,
  };
}
