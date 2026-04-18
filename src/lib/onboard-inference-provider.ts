// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export async function runSetupInference(
  sandboxName: string,
  model: string,
  provider: string,
  endpointUrl: string | null = null,
  credentialEnv: string | null = null,
  deps: any,
): Promise<{ retry?: "selection"; ok?: true }> {
  deps.step(4, 8, "Setting up inference provider");
  deps.runOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });

  if (
    provider === "nvidia-prod" ||
    provider === "nvidia-nim" ||
    provider === "openai-api" ||
    provider === "anthropic-prod" ||
    provider === "compatible-anthropic-endpoint" ||
    provider === "gemini-api" ||
    provider === "compatible-endpoint"
  ) {
    const config =
      provider === "nvidia-nim"
        ? deps.remoteProviderConfig.build
        : Object.values(deps.remoteProviderConfig).find((entry: any) => entry.providerName === provider);
    while (true) {
      const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
      const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
      const credentialValue = deps.hydrateCredentialEnv(resolvedCredentialEnv);
      const env =
        resolvedCredentialEnv && credentialValue
          ? { [resolvedCredentialEnv]: credentialValue }
          : {};
      const providerResult = deps.upsertProvider(
        provider,
        config.providerType,
        resolvedCredentialEnv,
        resolvedEndpointUrl,
        env,
      );
      if (!providerResult.ok) {
        console.error(`  ${providerResult.message}`);
        if (deps.isNonInteractive()) {
          process.exit(providerResult.status || 1);
        }
        const retry = await deps.promptValidationRecovery(
          config.label,
          deps.classifyApplyFailure(providerResult.message),
          resolvedCredentialEnv,
          config.helpUrl,
        );
        if (retry === "credential" || retry === "retry") {
          continue;
        }
        if (retry === "selection" || retry === "model") {
          return { retry: "selection" };
        }
        process.exit(providerResult.status || 1);
      }
      const args = ["inference", "set"];
      if (config.skipVerify) {
        args.push("--no-verify");
      }
      args.push("--provider", provider, "--model", model);
      const applyResult = deps.runOpenshell(args, { ignoreError: true });
      if (applyResult.status === 0) {
        break;
      }
      const message =
        deps.compactText(deps.redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      console.error(`  ${message}`);
      if (deps.isNonInteractive()) {
        process.exit(applyResult.status || 1);
      }
      const retry = await deps.promptValidationRecovery(
        config.label,
        deps.classifyApplyFailure(message),
        resolvedCredentialEnv,
        config.helpUrl,
      );
      if (retry === "credential" || retry === "retry") {
        continue;
      }
      if (retry === "selection" || retry === "model") {
        return { retry: "selection" };
      }
      process.exit(applyResult.status || 1);
    }
  } else if (provider === "vllm-local") {
    const validation = deps.validateLocalProvider(provider);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = deps.getLocalProviderBaseUrl(provider);
    const providerResult = deps.upsertProvider("vllm-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: "dummy",
    });
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    deps.runOpenshell([
      "inference",
      "set",
      "--no-verify",
      "--provider",
      "vllm-local",
      "--model",
      model,
      "--timeout",
      String(deps.localInferenceTimeoutSecs),
    ]);
  } else if (provider === "ollama-local") {
    const validation = deps.validateLocalProvider(provider);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      if (deps.processPlatform === "darwin") {
        console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      }
      process.exit(1);
    }
    const baseUrl = deps.getLocalProviderBaseUrl(provider);
    let ollamaCredential = "ollama";
    if (!deps.isWsl()) {
      deps.ensureOllamaAuthProxy();
      const proxyToken = deps.getOllamaProxyToken();
      if (!proxyToken) {
        console.error("  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.");
        process.exit(1);
      }
      ollamaCredential = proxyToken;
      deps.persistProxyToken(proxyToken);
    }
    const providerResult = deps.upsertProvider("ollama-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: ollamaCredential,
    });
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    deps.runOpenshell([
      "inference",
      "set",
      "--no-verify",
      "--provider",
      "ollama-local",
      "--model",
      model,
      "--timeout",
      String(deps.localInferenceTimeoutSecs),
    ]);
    console.log(`  Priming Ollama model: ${model}`);
    deps.run(deps.getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = deps.validateOllamaModel(model);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
  }

  deps.verifyInferenceRoute(provider, model);
  deps.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
  return { ok: true };
}
