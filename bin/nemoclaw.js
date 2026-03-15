#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, "scripts");
const CREDS_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");

// Auto-detect Colima Docker socket
if (!process.env.DOCKER_HOST) {
  const colimaSocket = path.join(process.env.HOME || "/tmp", ".colima/default/docker.sock");
  if (fs.existsSync(colimaSocket)) {
    process.env.DOCKER_HOST = `unix://${colimaSocket}`;
  }
}

function run(cmd, opts = {}) {
  const result = spawnSync("bash", ["-c", cmd], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
}

// ── Credential management ─────────────────────────────────────────

function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCredential(key, value) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const creds = loadCredentials();
  creds[key] = value;
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function getCredential(key) {
  // env var takes priority, then saved creds
  if (process.env[key]) return process.env[key];
  const creds = loadCredentials();
  return creds[key] || null;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureApiKey() {
  let key = getCredential("NVIDIA_API_KEY");
  if (key) {
    process.env.NVIDIA_API_KEY = key;
    return;
  }

  console.log("");
  console.log("  ┌───────────────────────────────────────────────┐");
  console.log("  │  NVIDIA API Key required                      │");
  console.log("  │                                               │");
  console.log("  │  1. Go to https://build.nvidia.com            │");
  console.log("  │  2. Sign in with your NVIDIA account          │");
  console.log("  │  3. Click any model -> 'Get API Key'          │");
  console.log("  │  4. Paste the key below (starts with nvapi-)  │");
  console.log("  └───────────────────────────────────────────────┘");
  console.log("");

  key = await prompt("  NVIDIA API Key: ");

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    process.exit(1);
  }

  saveCredential("NVIDIA_API_KEY", key);
  process.env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

function isRepoPrivate(repo) {
  try {
    const json = execSync(`gh api repos/${repo} --jq .private 2>/dev/null`, { encoding: "utf-8" }).trim();
    return json === "true";
  } catch {
    // If gh CLI isn't available or API fails, assume public
    return false;
  }
}

async function ensureGithubToken() {
  let token = getCredential("GITHUB_TOKEN");
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  // Try gh CLI
  try {
    token = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return;
    }
  } catch {}

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)   │");
  console.log("  │                                                  │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)    │");
  console.log("  │  Option B: Paste a PAT with read:packages scope  │");
  console.log("  └──────────────────────────────────────────────────┘");
  console.log("");

  token = await prompt("  GitHub Token: ");

  if (!token) {
    console.error("  Token required for deploy (repo is private).");
    process.exit(1);
  }

  saveCredential("GITHUB_TOKEN", token);
  process.env.GITHUB_TOKEN = token;
  console.log("");
  console.log("  Token saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

// ── Commands ──────────────────────────────────────────────────────

async function setup() {
  await ensureApiKey();
  run(`bash "${SCRIPTS}/setup.sh"`);
}

async function deploy(instanceName) {
  if (!instanceName) {
    console.error("  Usage: nemoclaw deploy <instance-name>");
    console.error("");
    console.error("  Examples:");
    console.error("    nemoclaw deploy my-gpu-box");
    console.error("    nemoclaw deploy nemoclaw-prod");
    console.error("    nemoclaw deploy nemoclaw-test");
    process.exit(1);
  }
  await ensureApiKey();
  if (isRepoPrivate("NVIDIA/OpenShell")) {
    await ensureGithubToken();
  }
  const name = instanceName;
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execSync("which brev", { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execSync("brev ls 2>&1", { encoding: "utf-8" });
    exists = out.includes(name);
  } catch {}

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${name} --gpu "${gpu}"`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  console.log("  Syncing NemoClaw to VM...");
  run(`ssh ${name} 'mkdir -p /home/ubuntu/nemoclaw'`);
  run(`scp -r -o StrictHostKeyChecking=no "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/.jensenclaw" ${name}:/home/ubuntu/nemoclaw/`);

  // Write credentials to a .env file on the VM (avoids shell quoting issues)
  const envLines = [`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`];
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) envLines.push(`GITHUB_TOKEN=${ghToken}`);
  const tgToken = getCredential("TELEGRAM_BOT_TOKEN");
  if (tgToken) envLines.push(`TELEGRAM_BOT_TOKEN=${tgToken}`);
  const envTmp = path.join(require("os").tmpdir(), `nemoclaw-env-${Date.now()}`);
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  run(`scp -o StrictHostKeyChecking=no "${envTmp}" ${name}:/home/ubuntu/nemoclaw/.env`);
  fs.unlinkSync(envTmp);

  console.log("  Running setup...");
  run(`ssh -t ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`);

  if (tgToken) {
    console.log("  Starting services...");
    run(`ssh ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  run(`ssh -t ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`);
}

async function start() {
  await ensureApiKey();
  run(`bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
}

function status() {
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function term(instanceName) {
  if (!instanceName) {
    // Local — run openshell term directly
    run("openshell term");
  } else {
    // Remote — SSH into Brev instance and run it there
    run(`ssh -t ${instanceName} 'openshell term'`);
  }
}

function connect(instanceName) {
  if (!instanceName) {
    run("openshell sandbox connect nemoclaw");
  } else {
    run(`ssh -t ${instanceName} 'NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY || ""}" openshell sandbox connect nemoclaw'`);
  }
}

function help() {
  console.log(`
  nemoclaw — NemoClaw CLI

  Usage:
    nemoclaw setup                 Set up locally (gateway, providers, sandbox)
    nemoclaw deploy <name>         Deploy to a Brev VM and start services
    nemoclaw connect [name]        Connect to sandbox (local or remote Brev)
    nemoclaw term [name]           Monitor network egress (local or remote Brev)
    nemoclaw start                 Start services (Telegram, tunnel)
    nemoclaw stop                  Stop all services
    nemoclaw status                Show service status

  Credentials are prompted on first use, then saved securely
  in ~/.nemoclaw/credentials.json (mode 600).

  Quick start:
    npm install -g nemoclaw
    nemoclaw setup
`);
}

// ── Dispatch ──────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  switch (cmd) {
    case "setup":   await setup(); break;
    case "deploy":  await deploy(args[0]); break;
    case "connect": connect(args[0]); break;
    case "term":    term(args[0]); break;
    case "start":   await start(); break;
    case "stop":    stop(); break;
    case "status":  status(); break;
    case "--help":
    case "-h":
    case "help":
    case undefined: help(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
})();
