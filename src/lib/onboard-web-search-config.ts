// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "./web-search";

export interface WebSearchConfigDeps {
  isNonInteractive: () => boolean;
  prompt: (question: string, options?: { secret?: boolean }) => Promise<string>;
  normalizeCredentialValue: (value: string | null | undefined) => string | null;
  getCredential: (envKey: string) => string | null;
  saveCredential: (envKey: string, value: string) => void;
  runCurlProbe: (argv: string[]) => {
    ok: boolean;
    message?: string;
  };
  classifyValidationFailure: (validation: unknown) => { kind: string };
  getTransportRecoveryMessage: (validation: unknown) => string;
  exitOnboardFromPrompt: () => never;
  note: (message: string) => void;
  braveApiKeyEnv: string;
  braveSearchHelpUrl: string;
}

function isAffirmativeAnswer(value: string): boolean {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function validateBraveSearchApiKey(apiKey: string, deps: WebSearchConfigDeps) {
  return deps.runCurlProbe([
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

async function promptBraveSearchRecovery(
  validation: unknown,
  deps: WebSearchConfigDeps,
): Promise<"retry" | "skip"> {
  const recovery = deps.classifyValidationFailure(validation);

  if (recovery.kind === "credential") {
    console.log("  Brave Search rejected that API key.");
  } else if (recovery.kind === "transport") {
    console.log(deps.getTransportRecoveryMessage(validation));
  } else {
    console.log("  Brave Search validation did not succeed.");
  }

  const answer = (await deps.prompt("  Type 'retry', 'skip', or 'exit' [retry]: "))
    .trim()
    .toLowerCase();
  if (answer === "skip") return "skip";
  if (answer === "exit" || answer === "quit") {
    deps.exitOnboardFromPrompt();
  }
  return "retry";
}

async function promptBraveSearchApiKey(deps: WebSearchConfigDeps): Promise<string> {
  console.log("");
  console.log(`  Get your Brave Search API key from: ${deps.braveSearchHelpUrl}`);
  console.log("");

  while (true) {
    const key = deps.normalizeCredentialValue(
      await deps.prompt("  Brave Search API key: ", { secret: true }),
    );
    if (!key) {
      console.error("  Brave Search API key is required.");
      continue;
    }
    return key;
  }
}

export async function ensureValidatedBraveSearchCredential(
  nonInteractive = false,
  deps: WebSearchConfigDeps,
): Promise<string | null> {
  const savedApiKey = deps.getCredential(deps.braveApiKeyEnv);
  let apiKey = savedApiKey || deps.normalizeCredentialValue(process.env[deps.braveApiKeyEnv]);
  let usingSavedKey = Boolean(savedApiKey);

  while (true) {
    if (!apiKey) {
      if (nonInteractive) {
        throw new Error(
          "Brave Search requires BRAVE_API_KEY or a saved Brave Search credential in non-interactive mode.",
        );
      }
      apiKey = await promptBraveSearchApiKey(deps);
      usingSavedKey = false;
    }

    const validation = validateBraveSearchApiKey(apiKey, deps);
    if (validation.ok) {
      deps.saveCredential(deps.braveApiKeyEnv, apiKey);
      process.env[deps.braveApiKeyEnv] = apiKey;
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
        validation.message || "Brave Search API key validation failed in non-interactive mode.",
      );
    }

    const action = await promptBraveSearchRecovery(validation, deps);
    if (action === "skip") {
      console.log("  Skipping Brave Web Search setup.");
      console.log("");
      return null;
    }

    apiKey = null;
    usingSavedKey = false;
  }
}

export async function configureWebSearch(
  existingConfig: WebSearchConfig | null = null,
  deps: WebSearchConfigDeps,
): Promise<WebSearchConfig | null> {
  if (existingConfig) {
    return { fetchEnabled: true };
  }

  if (deps.isNonInteractive()) {
    const braveApiKey = deps.normalizeCredentialValue(process.env[deps.braveApiKeyEnv]);
    if (!braveApiKey) {
      return null;
    }
    deps.note("  [non-interactive] Brave Web Search requested.");
    const validation = validateBraveSearchApiKey(braveApiKey, deps);
    if (!validation.ok) {
      console.error("  Brave Search API key validation failed.");
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }
      process.exit(1);
    }
    deps.saveCredential(deps.braveApiKeyEnv, braveApiKey);
    process.env[deps.braveApiKeyEnv] = braveApiKey;
    return { fetchEnabled: true };
  }
  const enableAnswer = await deps.prompt("  Enable Brave Web Search? [y/N]: ");
  if (!isAffirmativeAnswer(enableAnswer)) {
    return null;
  }

  const braveApiKey = await ensureValidatedBraveSearchCredential(deps.isNonInteractive(), deps);
  if (!braveApiKey) {
    return null;
  }

  console.log("  ✓ Enabled Brave Web Search");
  console.log("");
  return { fetchEnabled: true };
}
