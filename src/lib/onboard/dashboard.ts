// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createOnboardDashboardHelpers(deps) {
  const {
    agentOnboard,
    buildControlUiUrls,
    controlUiPort,
    nim,
    note,
    resolveDashboardForwardTarget,
    runOpenshell,
  } = deps;

  function ensureDashboardForward(sandboxName, chatUiUrl = `http://127.0.0.1:${controlUiPort}`) {
    const forwardTarget = resolveDashboardForwardTarget(chatUiUrl);
    const portToStop = String(new URL(chatUiUrl).port || controlUiPort);
    runOpenshell(["forward", "stop", portToStop], { ignoreError: true });
    runOpenshell(["forward", "start", "--background", forwardTarget, sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  function findOpenclawJsonPath(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = findOpenclawJsonPath(p);
        if (found) return found;
      } else if (e.name === "openclaw.json") {
        return p;
      }
    }
    return null;
  }

  function fetchGatewayAuthTokenFromSandbox(sandboxName) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
    try {
      const destDir = `${tmpDir}${path.sep}`;
      const result = runOpenshell(
        ["sandbox", "download", sandboxName, "/sandbox/.openclaw/openclaw.json", destDir],
        { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
      );
      if (result.status !== 0) return null;
      const jsonPath = findOpenclawJsonPath(tmpDir);
      if (!jsonPath) return null;
      const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
      return null;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  function printDashboard(sandboxName, model, provider, nimContainer = null, agent = null) {
    const nimStat = nimContainer ? nim.nimStatusByName(nimContainer) : nim.nimStatus(sandboxName);
    const nimLabel = nimStat.running ? "running" : "not running";

    let providerLabel = provider;
    if (provider === "nvidia-prod" || provider === "nvidia-nim") providerLabel = "NVIDIA Endpoints";
    else if (provider === "openai-api") providerLabel = "OpenAI";
    else if (provider === "anthropic-prod") providerLabel = "Anthropic";
    else if (provider === "compatible-anthropic-endpoint")
      providerLabel = "Other Anthropic-compatible endpoint";
    else if (provider === "gemini-api") providerLabel = "Google Gemini";
    else if (provider === "compatible-endpoint") providerLabel = "Other OpenAI-compatible endpoint";
    else if (provider === "vllm-local") providerLabel = "Local vLLM";
    else if (provider === "ollama-local") providerLabel = "Local Ollama";

    const token = fetchGatewayAuthTokenFromSandbox(sandboxName);

    console.log("");
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
    console.log(`  Model        ${model} (${providerLabel})`);
    console.log(`  NIM          ${nimLabel}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  Run:         nemoclaw ${sandboxName} connect`);
    console.log(`  Status:      nemoclaw ${sandboxName} status`);
    console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
    console.log("");
    if (agent) {
      agentOnboard.printDashboardUi(sandboxName, token, agent, { note, buildControlUiUrls });
    } else if (token) {
      console.log("  OpenClaw UI (tokenized URL; treat it like a password)");
      console.log(`  Port ${controlUiPort} must be forwarded before opening this URL.`);
      for (const url of buildControlUiUrls(token)) {
        console.log(`  ${url}`);
      }
    } else {
      note("  Could not read gateway token from the sandbox (download failed).");
      console.log("  OpenClaw UI");
      console.log(`  Port ${controlUiPort} must be forwarded before opening this URL.`);
      for (const url of buildControlUiUrls()) {
        console.log(`  ${url}`);
      }
      console.log(
        `  Token:       nemoclaw ${sandboxName} connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json`,
      );
      console.log(
        `               append  #token=<token>  to the URL, or see /tmp/gateway.log inside the sandbox.`,
      );
    }
    console.log(`  ${"─".repeat(50)}`);
    console.log("");
  }

  return {
    ensureDashboardForward,
    fetchGatewayAuthTokenFromSandbox,
    findOpenclawJsonPath,
    printDashboard,
  };
}
