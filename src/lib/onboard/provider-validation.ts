// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardProviderValidationHelpers(deps) {
  const {
    getCredential,
    getCurlTimingArgs,
    getProbeRecovery,
    isNonInteractive,
    isNvcfFunctionNotFoundForAccount,
    normalizeCredentialValue,
    nvcfFunctionNotFoundMessage,
    promptValidationRecovery,
    runCurlProbe,
  } = deps;

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

  // Per-validation-probe curl timing. Tighter than the default 60s in
  // getCurlTimingArgs() because validation must not hang the wizard for a
  // minute on a misbehaving model. See issue #1601 (Bug 3).
  function getValidationProbeCurlArgs() {
    return ["--connect-timeout", "10", "--max-time", "15"];
  }

  function probeResponsesToolCalling(endpointUrl, model, apiKey) {
    const result = runCurlProbe([
      "-sS",
      ...getValidationProbeCurlArgs(),
      "-H",
      "Content-Type: application/json",
      ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
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
      `${String(endpointUrl).replace(/\/+$/, "")}/responses`,
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
    const responsesProbe =
      options.requireResponsesToolCalling === true
        ? {
            name: "Responses API with tool calling",
            api: "openai-responses",
            execute: () => probeResponsesToolCalling(endpointUrl, model, apiKey),
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
                ...(apiKey
                  ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`]
                  : []),
                "-d",
                JSON.stringify({
                  model,
                  input: "Reply with exactly: OK",
                }),
                `${String(endpointUrl).replace(/\/+$/, "")}/responses`,
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
          ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
          "-d",
          JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
          }),
          `${String(endpointUrl).replace(/\/+$/, "")}/chat/completions`,
        ]),
    };

    const probes = options.skipResponsesProbe
      ? [chatCompletionsProbe]
      : [responsesProbe, chatCompletionsProbe];

    const failures = [];
    for (const probe of probes) {
      const result = probe.execute();
      if (result.ok) {
        return { ok: true, api: probe.api, label: probe.name };
      }
      failures.push({
        name: probe.name,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
        body: result.body,
      });
    }

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

    return {
      ok: false,
      message: failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | "),
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

  return {
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
  };
}
