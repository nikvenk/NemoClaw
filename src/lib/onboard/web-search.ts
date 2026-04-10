// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardWebSearchHelpers(deps) {
  const {
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
  } = deps;

  function printBraveExposureWarning() {
    console.log("");
    for (const line of webSearch.getBraveExposureWarningLines()) {
      console.log(`  ${line}`);
    }
    console.log("");
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

    const answer = (await prompt("  Type 'retry', 'skip', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
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

  async function ensureValidatedBraveSearchCredential() {
    let apiKey = getCredential(webSearch.BRAVE_API_KEY_ENV);
    let usingSavedKey = Boolean(apiKey);

    while (true) {
      if (!apiKey) {
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
      printBraveExposureWarning();
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

    printBraveExposureWarning();
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

  return {
    configureWebSearch,
    ensureValidatedBraveSearchCredential,
    printBraveExposureWarning,
    promptBraveSearchApiKey,
    promptBraveSearchRecovery,
    validateBraveSearchApiKey,
  };
}
