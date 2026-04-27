// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama auth-proxy lifecycle: token persistence, PID management,
// proxy start/stop, model pull and validation.

const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ROOT, SCRIPTS, run, runCapture, runDetachedFile, runFile } = require("./runner");
const { spawnChild } = require("./process-primitives");
const { buildEnvForSubprocess } = require("./subprocess-env");
const { OLLAMA_PORT, OLLAMA_PROXY_PORT } = require("./ports");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getOllamaModelOptions,
  startOllamaWarmup,
  validateOllamaModel,
} = require("./local-inference");
const { prompt } = require("./credentials");
const { promptManualModelId } = require("./model-prompts");
const { sleepSeconds } = require("./wait");

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");
const OLLAMA_INSTALLER_DOWNLOAD_TIMEOUT_MS = 130_000;
const OLLAMA_INSTALLER_RUN_TIMEOUT_MS = 600_000;

let ollamaProxyToken = null;

function ensureProxyStateDir() {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

function persistProxyToken(token) {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

function loadPersistedProxyToken() {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistProxyPid(pid) {
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  if (validPid === null) return;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${validPid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

function loadPersistedProxyPid() {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPersistedProxyPid() {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

function collectOllamaEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OLLAMA_") && value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function isOllamaProxyProcess(pid) {
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  if (validPid === null) return false;
  const cmdline = runCapture(["ps", "-p", String(validPid), "-o", "args="], {
    ignoreError: true,
  });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

function spawnDetachedProcess(command, args, opts = {}) {
  const child = spawnChild(command, args, {
    detached: true,
    stdio: "ignore",
    cwd: opts.cwd ?? ROOT,
    env: buildEnvForSubprocess(opts.env),
  });
  child.on?.("error", () => {});
  child.unref?.();
  return child.pid ?? null;
}

function spawnOllamaAuthProxy(token) {
  const pid = spawnDetachedProcess(process.execPath, [path.join(SCRIPTS, "ollama-auth-proxy.js")], {
    env: {
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
    },
  });
  persistProxyPid(pid);
  return pid;
}

function getOllamaClientHost() {
  return `127.0.0.1:${OLLAMA_PORT}`;
}

function getOllamaServeHostBinding(exposeToDocker) {
  return `${exposeToDocker ? "0.0.0.0" : "127.0.0.1"}:${OLLAMA_PORT}`;
}

function startDetachedOllamaServe(hostBinding) {
  spawnDetachedProcess("ollama", ["serve"], {
    env: collectOllamaEnv({ OLLAMA_HOST: hostBinding }),
  });
}

function startDetachedOllamaWarmup(model) {
  return startOllamaWarmup(model, "15m", (file, args) =>
    runDetachedFile(file, [...args], {
      env: collectOllamaEnv({ OLLAMA_HOST: getOllamaClientHost() }),
    }),
  );
}

function installOllamaViaOfficialScript() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-install-"));
  const installerPath = path.join(tempDir, "install.sh");
  try {
    const download = run(
      [
        "curl",
        "-fsSL",
        "--connect-timeout",
        "20",
        "--max-time",
        "120",
        "-o",
        installerPath,
        "https://ollama.com/install.sh",
      ],
      {
        ignoreError: true,
        timeout: OLLAMA_INSTALLER_DOWNLOAD_TIMEOUT_MS,
      },
    );
    if (download.error) {
      throw new Error(`Failed to download Ollama installer: ${download.error.message}`);
    }
    if (download.status !== 0) {
      const detail = String(download.stderr || "").trim();
      if (download.status === 28 || download.signal === "SIGTERM") {
        throw new Error("Timed out while downloading Ollama installer.");
      }
      throw new Error(
        detail
          ? `Failed to download Ollama installer: ${detail}`
          : `Failed to download Ollama installer (exit ${download.status ?? 1})`,
      );
    }

    const install = run(["sh", installerPath], {
      ignoreError: true,
      timeout: OLLAMA_INSTALLER_RUN_TIMEOUT_MS,
    });
    if (install.error) {
      throw new Error(`Failed to run Ollama installer: ${install.error.message}`);
    }
    if (install.status !== 0) {
      const detail = String(install.stderr || "").trim();
      if (install.signal === "SIGTERM") {
        throw new Error("Timed out while running Ollama installer.");
      }
      throw new Error(
        detail
          ? `Ollama installer failed: ${detail}`
          : `Ollama installer failed (exit ${install.status ?? 1})`,
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function killStaleProxy() {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid)) {
      run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = runCapture(["lsof", "-ti", `:${OLLAMA_PROXY_PORT}`], { ignoreError: true });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10))) {
          run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      sleepSeconds(1);
    }
  } catch {
    /* ignore */
  }
}

function startOllamaAuthProxy() {
  killStaleProxy();

  const proxyToken = crypto.randomBytes(24).toString("hex");
  ollamaProxyToken = proxyToken;
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(proxyToken);
  sleepSeconds(1);
  if (!isOllamaProxyProcess(pid)) {
    console.error(`  Error: Ollama auth proxy failed to start on :${OLLAMA_PROXY_PORT}`);
    console.error(`  Containers will not be able to reach Ollama without the proxy.`);
    console.error(
      `  Check if port ${OLLAMA_PROXY_PORT} is already in use: lsof -ti :${OLLAMA_PROXY_PORT}`,
    );
    return false;
  }
  return true;
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
function ensureOllamaAuthProxy() {
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid)) {
    ollamaProxyToken = token;
    return;
  }

  killStaleProxy();
  ollamaProxyToken = token;
  spawnOllamaAuthProxy(token);
  sleepSeconds(1);
}

function getOllamaProxyToken() {
  if (ollamaProxyToken) return ollamaProxyToken;
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}

async function promptOllamaModel(gpu = null) {
  const installed = getOllamaModelOptions();
  const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
  const defaultModel = getDefaultOllamaModel(gpu);
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

function printOllamaExposureWarning() {
  console.log("");
  console.log("  ⚠ Ollama is binding to 0.0.0.0 so the sandbox can reach it via Docker.");
  console.log("    This exposes the Ollama API to your local network (no auth required).");
  console.log("    On public WiFi, any device on the same network can send prompts to your GPU.");
  console.log("    See: CNVD-2025-04094, CVE-2024-37032");
  console.log("");
}

function pullOllamaModel(model) {
  const result = runFile("ollama", ["pull", model], {
    cwd: ROOT,
    env: collectOllamaEnv({ OLLAMA_HOST: getOllamaClientHost() }),
    encoding: "utf8",
    stdio: "inherit",
    timeout: 600_000,
    ignoreError: true,
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
  startDetachedOllamaWarmup(model);
  return validateOllamaModel(model);
}

module.exports = {
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  getOllamaServeHostBinding,
  installOllamaViaOfficialScript,
  persistProxyToken,
  prepareOllamaModel,
  printOllamaExposureWarning,
  promptOllamaModel,
  pullOllamaModel,
  startDetachedOllamaServe,
  startDetachedOllamaWarmup,
  startOllamaAuthProxy,
};
