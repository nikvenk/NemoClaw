// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observe swarm conversation in real time from the host.
 *
 * Polls the swarm bus `/messages` endpoint inside the sandbox and renders
 * each message in a chat-log format. With `--follow`, stays open and
 * prints new messages as they arrive (like `docker logs -f`).
 */

const { runCapture, shellQuote } = require("./runner");
const { resolveOpenshell } = require("./resolve-openshell");

// ── ANSI color helpers (respect NO_COLOR) ──────────────────────────
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc =
  _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const NVIDIA_GREEN = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const BOLD = _useColor ? "\x1b[1m" : "";
const DIM = _useColor ? "\x1b[2m" : "";
const RST = _useColor ? "\x1b[0m" : "";
const CYAN = _useColor ? "\x1b[36m" : "";
const MAGENTA = _useColor ? "\x1b[35m" : "";
const YELLOW = _useColor ? "\x1b[33m" : "";

// Assign a stable color per instanceId so each agent is visually distinct.
const AGENT_COLORS = [NVIDIA_GREEN, CYAN, MAGENTA, YELLOW];
const _colorMap = new Map<string, string>();
let _nextColor = 0;

function agentColor(instanceId: string): string {
  if (!_useColor) return "";
  let c = _colorMap.get(instanceId);
  if (!c) {
    c = AGENT_COLORS[_nextColor % AGENT_COLORS.length];
    _colorMap.set(instanceId, c);
    _nextColor++;
  }
  return c;
}

// ── Sandbox exec ───────────────────────────────────────────────────

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN || resolveOpenshell();
  if (!binary) return "openshell";
  return shellQuote(binary);
}

function sandboxExecCapture(sandboxName: string, cmd: string): string {
  const openshell = getOpenshellCommand();
  const encoded = Buffer.from(cmd).toString("base64");
  return runCapture(
    `printf '%s' ${shellQuote(encoded)} | base64 -d | ${openshell} sandbox exec --name ${shellQuote(sandboxName)} -- bash`,
    { ignoreError: true },
  );
}

// ── Types ──────────────────────────────────────────────────────────

interface BusMessage {
  timestamp: string;
  from: string;
  to: string | null;
  content: string;
  platform?: string;
}

export interface ObserveOptions {
  sandboxName: string;
  follow: boolean;
  since?: string;
  last?: number;
}

// ── Fetch messages from bus ────────────────────────────────────────

function fetchMessages(sandboxName: string, since?: string): BusMessage[] {
  const sinceParam = since ? `?since=${encodeURIComponent(since)}` : "";
  const url = `http://127.0.0.1:19100/messages${sinceParam}`;
  const raw = sandboxExecCapture(sandboxName, `curl -sf --max-time 5 ${url}`);
  if (!raw || !raw.trim()) return [];
  try {
    const data = JSON.parse(raw.trim());
    return data.messages || [];
  } catch {
    return [];
  }
}

// ── Render a single message ────────────────────────────────────────

function formatTimestamp(ts: string): string {
  // "2026-04-11T14:46:07.123Z" → "2026-04-11 14:46:07"
  return ts.slice(0, 19).replace("T", " ");
}

function renderMessage(msg: BusMessage): void {
  const who = msg.from || "unknown";
  const color = agentColor(who);
  const ts = formatTimestamp(msg.timestamp || "");
  const separator = `${DIM}——${RST} ${color}${BOLD}${who}${RST} ${DIM}——${RST}`;
  process.stdout.write(`${separator}\n`);
  if (ts) {
    process.stdout.write(`${DIM}${ts}${RST}\n`);
  }
  process.stdout.write(`${msg.content || ""}\n\n`);
}

// ── Main entry point ───────────────────────────────────────────────

export async function observe(opts: ObserveOptions): Promise<void> {
  const { sandboxName, follow, since, last } = opts;

  // Verify bus is reachable
  const health = sandboxExecCapture(sandboxName, "curl -sf --max-time 3 http://127.0.0.1:19100/health");
  if (!health || !health.includes('"ok"')) {
    console.error("  Swarm bus is not running in this sandbox.");
    console.error("  Add an agent first: nemoclaw <name> add-agent --agent <type>");
    process.exit(1);
  }

  // Fetch initial messages
  let messages = fetchMessages(sandboxName, since);

  // Apply --last / -n filter
  if (last !== undefined && last > 0 && messages.length > last) {
    messages = messages.slice(-last);
  }

  // Print history
  for (const msg of messages) {
    renderMessage(msg);
  }

  if (!follow) return;

  // Follow mode: poll for new messages
  let cursor = messages.length > 0 ? messages[messages.length - 1].timestamp : since || "";

  // Print a visual indicator that we're following
  process.stdout.write(`${DIM}── following (Ctrl-C to stop) ──${RST}\n\n`);

  const POLL_INTERVAL_MS = 3000;

  const poll = async () => {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const newMessages = fetchMessages(sandboxName, cursor);
      for (const msg of newMessages) {
        renderMessage(msg);
        if (msg.timestamp > cursor) {
          cursor = msg.timestamp;
        }
      }
    }
  };

  // Run until interrupted
  try {
    await poll();
  } catch {
    // SIGINT / broken pipe — exit cleanly
  }
}
