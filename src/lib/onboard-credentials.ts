// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardCredentialHelpers(deps) {
  const {
    exitOnboardFromPrompt,
    getCredential,
    getTransportRecoveryMessage,
    isNonInteractive,
    normalizeCredentialValue,
    prompt,
    saveCredential,
    validateNvidiaApiKeyValue,
  } = deps;

  async function replaceNamedCredential(envName, label, helpUrl = null, validator = null) {
    if (helpUrl) {
      console.log("");
      console.log(`  Get your ${label} from: ${helpUrl}`);
      console.log("");
    }

    while (true) {
      const key = normalizeCredentialValue(await prompt(`  ${label}: `, { secret: true }));
      if (!key) {
        console.error(`  ${label} is required.`);
        continue;
      }
      const validationError = typeof validator === "function" ? validator(key) : null;
      if (validationError) {
        console.error(validationError);
        continue;
      }
      saveCredential(envName, key);
      process.env[envName] = key;
      console.log("");
      console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
      console.log("");
      return key;
    }
  }

  async function promptValidationRecovery(label, recovery, credentialEnv = null, helpUrl = null) {
    if (isNonInteractive()) {
      process.exit(1);
    }

    if (recovery.kind === "credential" && credentialEnv) {
      console.log(
        `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
      );
      const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: ", { secret: true }))
        .trim()
        .toLowerCase();
      if (choice === "back") {
        console.log("  Returning to provider selection.");
        console.log("");
        return "selection";
      }
      if (choice === "exit" || choice === "quit") {
        exitOnboardFromPrompt();
      }
      if (choice === "" || choice === "retry") {
        const validator = credentialEnv === "NVIDIA_API_KEY" ? validateNvidiaApiKeyValue : null;
        await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
        return "credential";
      }
      console.log("  Please choose a provider/model again.");
      console.log("");
      return "selection";
    }

    if (recovery.kind === "transport") {
      console.log(getTransportRecoveryMessage(recovery.failure || {}));
      const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
        .trim()
        .toLowerCase();
      if (choice === "back") {
        console.log("  Returning to provider selection.");
        console.log("");
        return "selection";
      }
      if (choice === "exit" || choice === "quit") {
        exitOnboardFromPrompt();
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

  async function ensureNamedCredential(envName, label, helpUrl = null) {
    let key = getCredential(envName);
    if (key) {
      process.env[envName] = key;
      return key;
    }
    return replaceNamedCredential(envName, label, helpUrl);
  }

  return {
    ensureNamedCredential,
    promptValidationRecovery,
    replaceNamedCredential,
  };
}
