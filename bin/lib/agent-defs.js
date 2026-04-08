// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent definition loader — reads agents/*/manifest.yaml and provides
// accessors for agent-specific configuration used during onboarding.
//
// Usage:
//   const { listAgents, loadAgent, getAgentChoices } = require("./agent-defs");
//   const agents = listAgents();     // ["openclaw", "hermes"]
//   const agent = loadAgent("hermes");
//   console.log(agent.displayName);  // "Hermes Agent"
//   console.log(agent.healthProbe);  // { url: "http://localhost:8642/health", ... }

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const { ROOT } = require("./runner");

const AGENTS_DIR = path.join(ROOT, "agents");

/** @type {Map<string, object>} */
const _cache = new Map();

/**
 * List available agent names by scanning agents/ for directories with
 * a manifest.yaml file.
 * @returns {string[]} Sorted list of agent names (e.g., ["hermes", "openclaw"])
 */
function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(AGENTS_DIR, d.name, "manifest.yaml")))
    .map((d) => d.name)
    .sort();
}

/**
 * Load and parse an agent manifest.
 * @param {string} name — Agent name (directory name under agents/)
 * @returns {object} Parsed manifest with convenience accessors
 */
function loadAgent(name) {
  if (_cache.has(name)) return _cache.get(name);

  const manifestPath = path.join(AGENTS_DIR, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Agent '${name}' not found: ${manifestPath}`);
  }

  const raw = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  const agentDir = path.join(AGENTS_DIR, name);

  const agent = {
    // Raw manifest fields
    ...raw,

    // Computed paths
    agentDir,
    manifestPath,

    /** Display name for UI prompts */
    get displayName() {
      return raw.display_name || raw.name;
    },

    /** Health probe config */
    get healthProbe() {
      return (
        raw.health_probe || { url: "http://localhost:18789/", port: 18789, timeout_seconds: 30 }
      );
    },

    /** Port to forward from the sandbox */
    get forwardPort() {
      const ports = raw.forward_ports || [];
      return ports[0] || 18789;
    },

    /** Config directory paths */
    get configPaths() {
      const cfg = raw.config || {};
      return {
        immutableDir: cfg.immutable_dir || "/sandbox/.openclaw",
        writableDir: cfg.writable_dir || "/sandbox/.openclaw-data",
        configFile: cfg.config_file || "openclaw.json",
        envFile: cfg.env_file || null,
        format: cfg.format || "json",
      };
    },

    /** State directories to symlink */
    get stateDirs() {
      return raw.state_dirs || [];
    },

    /** Whether this agent has device pairing (affects auto-pair watcher) */
    get hasDevicePairing() {
      return raw.device_pairing === true;
    },

    /** Phone-home hosts for network policy */
    get phoneHomeHosts() {
      return raw.phone_home_hosts || [];
    },

    /** Messaging platforms supported */
    get messagingPlatforms() {
      const mp = raw.messaging_platforms || {};
      return mp.supported || [];
    },

    // ── Path accessors for agent-specific artifacts ──────────

    /** Path to the agent's Dockerfile.base (if it exists in agents/<name>/) */
    get dockerfileBasePath() {
      const p = path.join(agentDir, "Dockerfile.base");
      return fs.existsSync(p) ? p : null;
    },

    /** Path to the agent's Dockerfile */
    get dockerfilePath() {
      const p = path.join(agentDir, "Dockerfile");
      return fs.existsSync(p) ? p : null;
    },

    /** Path to the agent's startup script */
    get startScriptPath() {
      const p = path.join(agentDir, "start.sh");
      return fs.existsSync(p) ? p : null;
    },

    /** Path to the agent's policy additions */
    get policyAdditionsPath() {
      const p = path.join(agentDir, "policy-additions.yaml");
      return fs.existsSync(p) ? p : null;
    },

    /** Path to the agent's plugin directory */
    get pluginDir() {
      const p = path.join(agentDir, "plugin");
      return fs.existsSync(p) ? p : null;
    },

    /**
     * For legacy (OpenClaw) agent, resolve paths from _legacy_paths.
     * Returns null for non-legacy agents.
     */
    get legacyPaths() {
      if (!raw._legacy_paths) return null;
      const lp = raw._legacy_paths;
      return {
        dockerfileBase: lp.dockerfile_base ? path.join(ROOT, lp.dockerfile_base) : null,
        dockerfile: lp.dockerfile ? path.join(ROOT, lp.dockerfile) : null,
        startScript: lp.start_script ? path.join(ROOT, lp.start_script) : null,
        policy: lp.policy ? path.join(ROOT, lp.policy) : null,
        plugin: lp.plugin ? path.join(ROOT, lp.plugin) : null,
      };
    },
  };

  _cache.set(name, agent);
  return agent;
}

/**
 * Get agent choices for interactive prompt (name, display_name, description).
 * OpenClaw is listed first as the default.
 * @returns {Array<{name: string, displayName: string, description: string}>}
 */
function getAgentChoices() {
  const agents = listAgents().map((name) => {
    const a = loadAgent(name);
    return {
      name: a.name,
      displayName: a.displayName,
      description: a.description || "",
    };
  });

  // Sort: openclaw first (default), then alphabetical
  agents.sort((a, b) => {
    if (a.name === "openclaw") return -1;
    if (b.name === "openclaw") return 1;
    return a.name.localeCompare(b.name);
  });

  return agents;
}

/**
 * Resolve the effective agent from CLI flags, env vars, or session state.
 * Priority: explicit flag > env var > session > default ("openclaw").
 * @param {{ agentFlag?: string|null, session?: object|null }} [opts]
 * @returns {string} Agent name
 */
function resolveAgentName({ agentFlag = null, session = null } = {}) {
  // 1. Explicit CLI flag
  if (agentFlag) {
    const available = listAgents();
    if (!available.includes(agentFlag)) {
      const choices = available.join(", ");
      throw new Error(`Unknown agent '${agentFlag}'. Available: ${choices}`);
    }
    return agentFlag;
  }

  // 2. Environment variable
  const envAgent = process.env.NEMOCLAW_AGENT;
  if (envAgent) {
    const available = listAgents();
    if (available.includes(envAgent)) return envAgent;
  }

  // 3. Session state (resume)
  if (session && session.agent) return session.agent;

  // 4. Default
  return "openclaw";
}

module.exports = {
  listAgents,
  loadAgent,
  getAgentChoices,
  resolveAgentName,
  AGENTS_DIR,
};
