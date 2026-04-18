// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export interface OllamaModelDeps {
  getOllamaModelOptions: () => string[];
  getBootstrapOllamaModelOptions: (gpu?: unknown) => string[];
  getDefaultOllamaModel: (gpu?: unknown) => string;
  prompt: (question: string, options?: { secret?: boolean }) => Promise<string>;
  promptManualModelId: (question: string, providerLabel: string) => Promise<string>;
  shellQuote: (value: string) => string;
  root: string;
  getOllamaWarmupCommand: (model: string) => string;
  run: (
    command: string | string[],
    options?: { ignoreError?: boolean; suppressOutput?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  validateOllamaModel: (model: string) => { ok: boolean; message?: string };
}

export async function promptOllamaModel(gpu: unknown = null, deps: OllamaModelDeps): Promise<string> {
  const installed = deps.getOllamaModelOptions();
  const options = installed.length > 0 ? installed : deps.getBootstrapOllamaModelOptions(gpu);
  const defaultModel = deps.getDefaultOllamaModel(gpu);
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

  const choice = await deps.prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index]!;
  }
  return deps.promptManualModelId("  Ollama model id: ", "Ollama");
}

export function printOllamaExposureWarning(): void {
  console.log("");
  console.log("  ⚠ Ollama is binding to 0.0.0.0 so the sandbox can reach it via Docker.");
  console.log("    This exposes the Ollama API to your local network (no auth required).");
  console.log("    On public WiFi, any device on the same network can send prompts to your GPU.");
  console.log("    See: CNVD-2025-04094, CVE-2024-37032");
  console.log("");
}

function pullOllamaModel(model: string, deps: OllamaModelDeps): boolean {
  const result = spawnSync("bash", ["-c", `ollama pull ${deps.shellQuote(model)}`], {
    cwd: deps.root,
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

export function prepareOllamaModel(
  model: string,
  installedModels: string[] = [],
  deps: OllamaModelDeps,
): { ok: boolean; message?: string } {
  const alreadyInstalled = installedModels.includes(model);
  if (!alreadyInstalled) {
    console.log(`  Pulling Ollama model: ${model}`);
    if (!pullOllamaModel(model, deps)) {
      return {
        ok: false,
        message:
          `Failed to pull Ollama model '${model}'. ` +
          "Check the model name and that Ollama can access the registry, then try another model.",
      };
    }
  }

  console.log(`  Loading Ollama model: ${model}`);
  deps.run(deps.getOllamaWarmupCommand(model), { ignoreError: true });
  return deps.validateOllamaModel(model);
}
