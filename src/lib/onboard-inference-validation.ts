// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function replaceNamedCredential(
  envName: string,
  label: string,
  helpUrl: string | null = null,
  validator: ((value: string) => string | null) | null = null,
  deps: any,
): Promise<string> {
  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  return (async () => {
    while (true) {
      const key = deps.normalizeCredentialValue(await deps.prompt(`  ${label}: `, { secret: true }));
      if (!key) {
        console.error(`  ${label} is required.`);
        continue;
      }
      const validationError = typeof validator === "function" ? validator(key) : null;
      if (validationError) {
        console.error(validationError);
        continue;
      }
      deps.saveCredential(envName, key);
      process.env[envName] = key;
      console.log("");
      console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
      console.log("");
      return key;
    }
  })();
}

export async function promptValidationRecovery(
  label: string,
  recovery: any,
  credentialEnv: string | null = null,
  helpUrl: string | null = null,
  deps: any,
): Promise<string> {
  if (deps.isNonInteractive()) {
    process.exit(1);
  }

  if (recovery.kind === "credential" && credentialEnv) {
    console.log(
      `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
    );
    console.log("  ⚠️  Do NOT paste your API key here — use the options below:");
    const choice = (
      await deps.prompt("  Options: retry (re-enter key), back (change provider), exit [retry]: ", {
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
      API_KEY_PREFIXES.some((prefix) => choice.startsWith(prefix)) ||
      (!choice.includes(" ") && choice.length > 40) ||
      // Regex fallback: base64-safe token pattern (20+ chars, no spaces, mixed alphanum)
      /^[A-Za-z0-9_\-\.]{20,}$/.test(choice);
    const validator = credentialEnv === "NVIDIA_API_KEY" ? deps.validateNvidiaApiKeyValue : null;
    if (looksLikeToken) {
      console.log("  ⚠️  That looks like an API key — do not paste credentials here.");
      console.log("  Treating as 'retry'. You will be prompted to enter the key securely.");
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator, deps);
      return "credential";
    }
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      deps.exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator, deps);
      return "credential";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "transport") {
    console.log(deps.getTransportRecoveryMessage(recovery.failure || {}));
    const choice = (await deps.prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      deps.exitOnboardFromPrompt();
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

function parseJsonObject(body: string): any {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function hasResponsesToolCall(body: string): boolean {
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

export function shouldRequireResponsesToolCalling(provider: string): boolean {
  return (
    provider === "nvidia-prod" || provider === "gemini-api" || provider === "compatible-endpoint"
  );
}

// Google Gemini rejects requests that carry both an Authorization: Bearer
// header and a ?key= query parameter ("Multiple authentication credentials
// received"). Send the API key as ?key= only for Gemini. See issue #1960.
export function getProbeAuthMode(provider: string): "query-param" | undefined {
  return provider === "gemini-api" ? "query-param" : undefined;
}

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
export function getValidationProbeCurlArgs(opts: any = {}, deps: any): string[] {
  if (deps.isWsl(opts)) {
    return ["--connect-timeout", "20", "--max-time", "30"];
  }
  return ["--connect-timeout", "10", "--max-time", "15"];
}

function probeResponsesToolCalling(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: any = {},
  deps: any,
): any {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? deps.normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const url = useQueryParam && normalizedKey
    ? `${baseUrl}/responses?key=${encodeURIComponent(normalizedKey)}`
    : `${baseUrl}/responses`;
  const result = deps.runCurlProbe([
    "-sS",
    ...getValidationProbeCurlArgs({}, deps),
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

function probeOpenAiLikeEndpoint(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: any = {},
  deps: any,
): any {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? deps.normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const appendKey = (requestPath: string) =>
    useQueryParam && normalizedKey
      ? `${baseUrl}${requestPath}?key=${encodeURIComponent(normalizedKey)}`
      : `${baseUrl}${requestPath}`;

  const responsesProbe =
    options.requireResponsesToolCalling === true
      ? {
          name: "Responses API with tool calling",
          api: "openai-responses",
          execute: () =>
            probeResponsesToolCalling(endpointUrl, model, apiKey, { authMode: options.authMode }, deps),
        }
      : {
          name: "Responses API",
          api: "openai-responses",
          execute: () =>
            deps.runCurlProbe([
              "-sS",
              ...getValidationProbeCurlArgs({}, deps),
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
      deps.runCurlProbe([
        "-sS",
        ...getValidationProbeCurlArgs({}, deps),
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
        const streamResult = deps.runStreamingEventProbe([
          "-sS",
          ...getValidationProbeCurlArgs({}, deps),
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
  const isTimeoutOrConnFailure = (cs: number) => cs === 28 || cs === 6 || cs === 7;
  let retriedAfterTimeout = false;
  if (failures.length > 0 && isTimeoutOrConnFailure(failures[0].curlStatus)) {
    retriedAfterTimeout = true;
    const baseArgs = getValidationProbeCurlArgs({}, deps);
    const doubledArgs = baseArgs.map((arg) =>
      /^\d+$/.test(arg) ? String(Number(arg) * 2) : arg,
    );
    const retryResult = deps.runCurlProbe([
      "-sS",
      ...doubledArgs,
      "-H",
      "Content-Type: application/json",
      ...(apiKey ? ["-H", `Authorization: Bearer ${deps.normalizeCredentialValue(apiKey)}`] : []),
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
      deps.isNvcfFunctionNotFoundForAccount(failure.message) ||
      deps.isNvcfFunctionNotFoundForAccount(failure.body),
  );
  if (accountFailure) {
    return {
      ok: false,
      message: deps.nvcfFunctionNotFoundMessage(model),
      failures,
    };
  }

  const baseMessage = failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | ");
  const wslHint =
    deps.isWsl() && retriedAfterTimeout
      ? " · WSL2 detected — network verification may be slower than expected. " +
        "Run `nemoclaw onboard` with the `--skip-verify` flag if this endpoint is known to be reachable."
      : "";
  return {
    ok: false,
    message: baseMessage + wslHint,
    failures,
  };
}

function probeAnthropicEndpoint(
  endpointUrl: string,
  model: string,
  apiKey: string,
  deps: any,
): any {
  const result = deps.runCurlProbe([
    "-sS",
    ...deps.getCurlTimingArgs(),
    "-H",
    `x-api-key: ${deps.normalizeCredentialValue(apiKey)}`,
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

export async function validateOpenAiLikeSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string | null = null,
  retryMessage = "Please choose a provider/model again.",
  helpUrl: string | null = null,
  options: any = {},
  deps: any,
): Promise<any> {
  const apiKey = credentialEnv ? deps.getCredential(credentialEnv) : "";
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options, deps);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (deps.isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      deps.getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
      deps,
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

export async function validateAnthropicSelectionWithRetryMessage(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  retryMessage = "Please choose a provider/model again.",
  helpUrl: string | null = null,
  deps: any,
): Promise<any> {
  const apiKey = deps.getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey, deps);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (deps.isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      deps.getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
      deps,
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

export async function validateCustomOpenAiLikeSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  helpUrl: string | null = null,
  deps: any,
): Promise<any> {
  const apiKey = deps.getCredential(credentialEnv);
  const probe = probeOpenAiLikeEndpoint(
    endpointUrl,
    model,
    apiKey,
    {
      requireResponsesToolCalling: true,
      skipResponsesProbe: deps.shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: true,
    },
    deps,
  );
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (deps.isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    deps.getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
    deps,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}

export async function validateCustomAnthropicSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  helpUrl: string | null = null,
  deps: any,
): Promise<any> {
  const apiKey = deps.getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey, deps);
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (deps.isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    deps.getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
    deps,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}
