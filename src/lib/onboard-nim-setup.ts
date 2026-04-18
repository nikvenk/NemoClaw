// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export async function runSetupNim(gpu: any, deps: any): Promise<any> {
  deps.step(3, 8, "Configuring inference (NIM)");

  let model = null;
  let provider = deps.remoteProviderConfig.build.providerName;
  let nimContainer = null;
  let endpointUrl = deps.remoteProviderConfig.build.endpointUrl;
  let credentialEnv = deps.remoteProviderConfig.build.credentialEnv;
  let preferredInferenceApi = null;

  const hasOllama = !!deps.runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!deps.runCapture(
    `curl -sf http://127.0.0.1:${deps.ollamaPort}/api/tags 2>/dev/null`,
    {
      ignoreError: true,
    },
  );
  const vllmRunning = !!deps.runCapture(
    `curl -sf http://127.0.0.1:${deps.vllmPort}/v1/models 2>/dev/null`,
    {
      ignoreError: true,
    },
  );
  const requestedProvider = deps.isNonInteractive() ? deps.getNonInteractiveProvider() : null;
  const requestedModel = deps.isNonInteractive()
    ? deps.getNonInteractiveModel(requestedProvider || "build")
    : null;
  const options: Array<{ key: string; label: string }> = [];
  options.push({ key: "build", label: "NVIDIA Endpoints" });
  options.push({ key: "openai", label: "OpenAI" });
  options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
  options.push({ key: "anthropic", label: "Anthropic" });
  options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
  options.push({ key: "gemini", label: "Google Gemini" });
  if (hasOllama || ollamaRunning) {
    options.push({
      key: "ollama",
      label:
        `Local Ollama (localhost:${deps.ollamaPort})${ollamaRunning ? " — running" : ""}` +
        (ollamaRunning ? " (suggested)" : ""),
    });
  }
  if (deps.experimental && gpu && gpu.nimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }
  if (deps.experimental && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Local vLLM [experimental] — running",
    });
  }
  if (!hasOllama && deps.processPlatform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
  }

  if (options.length > 1) {
    selectionLoop: while (true) {
      let selected: { key: string; label: string } | undefined;

      if (deps.isNonInteractive()) {
        const providerKey = requestedProvider || "build";
        selected = options.find((option) => option.key === providerKey);
        if (!selected) {
          console.error(
            `  Requested provider '${providerKey}' is not available in this environment.`,
          );
          process.exit(1);
        }
        deps.note(`  [non-interactive] Provider: ${selected.key}`);
      } else {
        const suggestions = [];
        if (vllmRunning) suggestions.push("vLLM");
        if (ollamaRunning) suggestions.push("Ollama");
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

        const envProviderHint = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
        const envProviderIdx = envProviderHint
          ? options.findIndex((option) => option.key.toLowerCase() === envProviderHint)
          : -1;
        const defaultIdx =
          (envProviderIdx >= 0 ? envProviderIdx : options.findIndex((option) => option.key === "build")) + 1;
        const choice = await deps.prompt(`  Choose [${defaultIdx}]: `);
        const idx = parseInt(choice || String(defaultIdx), 10) - 1;
        selected = options[idx] || options[defaultIdx - 1];
      }

      if (selected && deps.remoteProviderConfig[selected.key]) {
        const remoteConfig = deps.remoteProviderConfig[selected.key];
        provider = remoteConfig.providerName;
        credentialEnv = remoteConfig.credentialEnv;
        endpointUrl = remoteConfig.endpointUrl;
        preferredInferenceApi = null;

        if (selected.key === "custom") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = deps.isNonInteractive()
            ? _envUrl
            :
                (await deps.prompt(
                  _envUrl
                    ? `  OpenAI-compatible base URL [${_envUrl}]: `
                    : "  OpenAI-compatible base URL (e.g., https://openrouter.ai): ",
                )) || _envUrl;
          const navigation = deps.getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            deps.exitOnboardFromPrompt();
          }
          endpointUrl = deps.normalizeProviderBaseUrl(endpointInput, "openai");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other OpenAI-compatible endpoint.");
            if (deps.isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
        } else if (selected.key === "anthropicCompatible") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = deps.isNonInteractive()
            ? _envUrl
            :
                (await deps.prompt(
                  _envUrl
                    ? `  Anthropic-compatible base URL [${_envUrl}]: `
                    : "  Anthropic-compatible base URL (e.g., https://proxy.example.com): ",
                )) || _envUrl;
          const navigation = deps.getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            deps.exitOnboardFromPrompt();
          }
          endpointUrl = deps.normalizeProviderBaseUrl(endpointInput, "anthropic");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other Anthropic-compatible endpoint.");
            if (deps.isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
        }

        if (selected.key === "build") {
          const _nvProviderKey = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_nvProviderKey && !process.env.NVIDIA_API_KEY) {
            process.env.NVIDIA_API_KEY = _nvProviderKey;
          }
          if (deps.isNonInteractive()) {
            if (!process.env.NVIDIA_API_KEY) {
              console.error(
                "  NVIDIA_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
              );
              process.exit(1);
            }
            const keyError = deps.validateNvidiaApiKeyValue(process.env.NVIDIA_API_KEY);
            if (keyError) {
              console.error(keyError);
              console.error(`  Get a key from ${deps.remoteProviderConfig.build.helpUrl}`);
              process.exit(1);
            }
          } else {
            await deps.ensureApiKey();
          }
          const _envModel = (process.env.NEMOCLAW_MODEL || "").trim();
          model =
            requestedModel ||
            (deps.isNonInteractive()
              ? deps.defaultCloudModel
              : await deps.promptCloudModel({ defaultModelId: _envModel || undefined })) ||
            deps.defaultCloudModel;
          if (model === deps.backToSelection) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
        } else {
          const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_providerKeyHint && !process.env[credentialEnv]) {
            process.env[credentialEnv] = _providerKeyHint;
          }

          if (deps.isNonInteractive()) {
            if (!process.env[credentialEnv]) {
              console.error(
                `  ${credentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for ${remoteConfig.label} in non-interactive mode.`,
              );
              process.exit(1);
            }
          } else {
            await deps.ensureNamedCredential(
              credentialEnv,
              remoteConfig.label + " API key",
              remoteConfig.helpUrl,
            );
          }
          const _envModelRemote = (process.env.NEMOCLAW_MODEL || "").trim();
          const defaultModel = requestedModel || _envModelRemote || remoteConfig.defaultModel;
          let modelValidator = null;
          if (selected.key === "openai" || selected.key === "gemini") {
            const modelAuthMode = deps.getProbeAuthMode(provider);
            modelValidator = (candidate: string) =>
              deps.validateOpenAiLikeModel(
                remoteConfig.label,
                endpointUrl,
                candidate,
                deps.getCredential(credentialEnv),
                ...(modelAuthMode ? [{ authMode: modelAuthMode }] : []),
              );
          } else if (selected.key === "anthropic") {
            modelValidator = (candidate: string) =>
              deps.validateAnthropicModel(
                endpointUrl || deps.anthropicEndpointUrl,
                candidate,
                deps.getCredential(credentialEnv),
              );
          }
          while (true) {
            if (deps.isNonInteractive()) {
              model = defaultModel;
            } else if (remoteConfig.modelMode === "curated") {
              model = await deps.promptRemoteModel(
                remoteConfig.label,
                selected.key,
                defaultModel,
                modelValidator,
              );
            } else {
              model = await deps.promptInputModel(remoteConfig.label, defaultModel, modelValidator);
            }
            if (model === deps.backToSelection) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }

            if (selected.key === "custom") {
              const validation = await deps.validateCustomOpenAiLikeSelection(
                remoteConfig.label,
                endpointUrl,
                model,
                credentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "")
                  .trim()
                  .toLowerCase();
                if (
                  explicitApi &&
                  explicitApi !== "openai-completions" &&
                  explicitApi !== "chat-completions"
                ) {
                  preferredInferenceApi = validation.api;
                } else {
                  if (validation.api !== "openai-completions") {
                    console.log(
                      "  ℹ Using chat completions API (compatible endpoints may not support the Responses API developer role)",
                    );
                  }
                  preferredInferenceApi = "openai-completions";
                }
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else if (selected.key === "anthropicCompatible") {
              const validation = await deps.validateCustomAnthropicSelection(
                remoteConfig.label,
                endpointUrl || deps.anthropicEndpointUrl,
                model,
                credentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                preferredInferenceApi = validation.api;
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else {
              const retryMessage = "Please choose a provider/model again.";
              if (selected.key === "anthropic") {
                const validation = await deps.validateAnthropicSelectionWithRetryMessage(
                  remoteConfig.label,
                  endpointUrl || deps.anthropicEndpointUrl,
                  model,
                  credentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              } else {
                const validation = await deps.validateOpenAiLikeSelection(
                  remoteConfig.label,
                  endpointUrl,
                  model,
                  credentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                  {
                    requireResponsesToolCalling: deps.shouldRequireResponsesToolCalling(provider),
                    skipResponsesProbe: deps.shouldSkipResponsesProbe(provider),
                    authMode: deps.getProbeAuthMode(provider),
                  },
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              }
              continue selectionLoop;
            }
          }
        }

        if (selected.key === "build") {
          while (true) {
            const validation = await deps.validateOpenAiLikeSelection(
              remoteConfig.label,
              endpointUrl,
              model,
              credentialEnv,
              "Please choose a provider/model again.",
              remoteConfig.helpUrl,
              {
                requireResponsesToolCalling: deps.shouldRequireResponsesToolCalling(provider),
                skipResponsesProbe: deps.shouldSkipResponsesProbe(provider),
                authMode: deps.getProbeAuthMode(provider),
              },
            );
            if (validation.ok) {
              preferredInferenceApi = validation.api;
              break;
            }
            if (validation.retry === "credential" || validation.retry === "retry") {
              continue;
            }
            continue selectionLoop;
          }
        }

        console.log(`  Using ${remoteConfig.label} with model: ${model}`);
        break;
      } else if (selected && selected.key === "nim-local") {
        const models = deps.nim.listModels().filter((entry: any) => entry.minGpuMemoryMB <= gpu.totalMemoryMB);
        if (models.length === 0) {
          console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
        } else {
          let sel;
          if (deps.isNonInteractive()) {
            if (requestedModel) {
              sel = models.find((entry: any) => entry.name === requestedModel);
              if (!sel) {
                console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
                process.exit(1);
              }
            } else {
              sel = models[0];
            }
            deps.note(`  [non-interactive] NIM model: ${sel.name}`);
          } else {
            console.log("");
            console.log("  Models that fit your GPU:");
            models.forEach((entry: any, index: number) => {
              console.log(`    ${index + 1}) ${entry.name} (min ${entry.minGpuMemoryMB} MB)`);
            });
            console.log("");

            const modelChoice = await deps.prompt(`  Choose model [1]: `);
            const midx = parseInt(modelChoice || "1", 10) - 1;
            sel = models[midx] || models[0];
          }
          model = sel.name;

          console.log(`  Pulling NIM image for ${model}...`);
          deps.nim.pullNimImage(model);

          console.log("  Starting NIM container...");
          nimContainer = deps.nim.startNimContainerByName(
            deps.nim.containerName(deps.gatewayName),
            model,
          );

          console.log("  Waiting for NIM to become healthy...");
          if (!deps.nim.waitForNimHealth()) {
            console.error("  NIM failed to start. Falling back to cloud API.");
            model = null;
            nimContainer = null;
          } else {
            provider = "vllm-local";
            credentialEnv = "OPENAI_API_KEY";
            endpointUrl = deps.getLocalProviderBaseUrl(provider);
            const validation = await deps.validateOpenAiLikeSelection(
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
              continue selectionLoop;
            }
            if (!validation.ok) {
              continue selectionLoop;
            }
            preferredInferenceApi = validation.api;
            if (preferredInferenceApi !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
              );
            }
            preferredInferenceApi = "openai-completions";
          }
        }
        break;
      } else if (selected && selected.key === "ollama") {
        if (!ollamaRunning) {
          console.log("  Starting Ollama...");
          if (deps.isWsl()) {
            deps.run(`ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
          } else {
            deps.run(
              `OLLAMA_HOST=127.0.0.1:${deps.ollamaPort} ollama serve > /dev/null 2>&1 &`,
              { ignoreError: true },
            );
          }
          deps.sleep(2);
          if (!deps.isWsl()) deps.printOllamaExposureWarning();
        }
        if (deps.isWsl()) {
          console.log(`  ✓ Using Ollama on localhost:${deps.ollamaPort}`);
        } else {
          deps.startOllamaAuthProxy();
          console.log(
            `  ✓ Using Ollama on localhost:${deps.ollamaPort} (proxy on :${deps.ollamaProxyPort})`,
          );
        }
        provider = "ollama-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = deps.getLocalProviderBaseUrl(provider);
        while (true) {
          const installedModels = deps.getOllamaModelOptions();
          if (deps.isNonInteractive()) {
            model = requestedModel || deps.getDefaultOllamaModel(gpu);
          } else {
            model = await deps.promptOllamaModel(gpu);
          }
          if (model === deps.backToSelection) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          const probe = deps.prepareOllamaModel(model, installedModels);
          if (!probe.ok) {
            console.error(`  ${probe.message}`);
            if (deps.isNonInteractive()) {
              process.exit(1);
            }
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            continue;
          }
          const validation = await deps.validateOpenAiLikeSelection(
            "Local Ollama",
            deps.getLocalProviderValidationBaseUrl(provider),
            model,
            null,
            "Choose a different Ollama model or select Other.",
          );
          if (validation.retry === "selection" || validation.retry === "back") {
            continue selectionLoop;
          }
          if (!validation.ok) {
            continue;
          }
          if (validation.api !== "openai-completions") {
            console.log(
              "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
            );
          }
          preferredInferenceApi = "openai-completions";
          break;
        }
        break;
      } else if (selected && selected.key === "install-ollama") {
        console.log("  Installing Ollama via Homebrew...");
        deps.run("brew install ollama", { ignoreError: true });
        console.log("  Starting Ollama...");
        deps.run(`OLLAMA_HOST=127.0.0.1:${deps.ollamaPort} ollama serve > /dev/null 2>&1 &`, {
          ignoreError: true,
        });
        deps.sleep(2);
        deps.startOllamaAuthProxy();
        console.log(
          `  ✓ Using Ollama on localhost:${deps.ollamaPort} (proxy on :${deps.ollamaProxyPort})`,
        );
        provider = "ollama-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = deps.getLocalProviderBaseUrl(provider);
        while (true) {
          const installedModels = deps.getOllamaModelOptions();
          if (deps.isNonInteractive()) {
            model = requestedModel || deps.getDefaultOllamaModel(gpu);
          } else {
            model = await deps.promptOllamaModel(gpu);
          }
          if (model === deps.backToSelection) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          const probe = deps.prepareOllamaModel(model, installedModels);
          if (!probe.ok) {
            console.error(`  ${probe.message}`);
            if (deps.isNonInteractive()) {
              process.exit(1);
            }
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            continue;
          }
          const validation = await deps.validateOpenAiLikeSelection(
            "Local Ollama",
            deps.getLocalProviderValidationBaseUrl(provider),
            model,
            null,
            "Choose a different Ollama model or select Other.",
          );
          if (validation.retry === "selection" || validation.retry === "back") {
            continue selectionLoop;
          }
          if (!validation.ok) {
            continue;
          }
          if (validation.api !== "openai-completions") {
            console.log(
              "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
            );
          }
          preferredInferenceApi = "openai-completions";
          break;
        }
        break;
      } else if (selected && selected.key === "vllm") {
        console.log(`  ✓ Using existing vLLM on localhost:${deps.vllmPort}`);
        provider = "vllm-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = deps.getLocalProviderBaseUrl(provider);
        const vllmModelsRaw = deps.runCapture(
          `curl -sf http://127.0.0.1:${deps.vllmPort}/v1/models 2>/dev/null`,
          {
            ignoreError: true,
          },
        );
        try {
          const vllmModels = JSON.parse(vllmModelsRaw);
          if (vllmModels.data && vllmModels.data.length > 0) {
            model = vllmModels.data[0].id;
            if (!deps.isSafeModelId(model)) {
              console.error(`  Detected model ID contains invalid characters: ${model}`);
              process.exit(1);
            }
            console.log(`  Detected model: ${model}`);
          } else {
            console.error("  Could not detect model from vLLM. Please specify manually.");
            process.exit(1);
          }
        } catch {
          console.error(
            `  Could not query vLLM models endpoint. Is vLLM running on localhost:${deps.vllmPort}?`,
          );
          process.exit(1);
        }
        const validation = await deps.validateOpenAiLikeSelection(
          "Local vLLM",
          deps.getLocalProviderValidationBaseUrl(provider),
          model,
          credentialEnv,
        );
        if (
          validation.retry === "selection" ||
          validation.retry === "back" ||
          validation.retry === "model"
        ) {
          continue selectionLoop;
        }
        if (!validation.ok) {
          continue selectionLoop;
        }
        preferredInferenceApi = validation.api;
        if (preferredInferenceApi !== "openai-completions") {
          console.log(
            "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
          );
        }
        preferredInferenceApi = "openai-completions";
        break;
      }
    }
  }

  return { model, provider, endpointUrl, credentialEnv, preferredInferenceApi, nimContainer };
}
