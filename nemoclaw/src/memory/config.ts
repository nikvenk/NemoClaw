// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory provider configuration — persists the active memory mode
 * and handles AGENTS.md injection/removal.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_DIR } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryMode = "default" | "typed-index";

export interface MemoryConfig {
  mode: MemoryMode;
  enabledAt?: string;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = ".nemoclaw-memory.json";

function configPath(workspaceDir: string = WORKSPACE_DIR): string {
  return join(workspaceDir, CONFIG_FILENAME);
}

export function loadMemoryConfig(workspaceDir: string = WORKSPACE_DIR): MemoryConfig {
  const path = configPath(workspaceDir);
  if (!existsSync(path)) {
    return { mode: "default" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const mode = raw.mode === "typed-index" ? "typed-index" : "default";
    return {
      mode,
      enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : undefined,
    };
  } catch {
    return { mode: "default" };
  }
}

export function saveMemoryConfig(config: MemoryConfig, workspaceDir: string = WORKSPACE_DIR): void {
  writeFileSync(configPath(workspaceDir), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// AGENTS.md injection
// ---------------------------------------------------------------------------

const AGENTS_FILENAME = "AGENTS.md";
const MARKER_START = "<!-- nemoclaw:memory:v1:start -->";
const MARKER_END = "<!-- nemoclaw:memory:v1:end -->";

export { MARKER_START, MARKER_END };

const MEMORY_INSTRUCTIONS = `${MARKER_START}

## Memory System (NemoClaw Typed Index)

Your memory uses a typed index. At session start, you see a table in MEMORY.md
with titles, types, and dates — not the full content.

**To read a memory topic:**
\`/nemoclaw memory read <slug>\`

**To search for something:**
\`/nemoclaw memory search <query>\`

**When saving new memories, use the appropriate type:**
- \`user\` — preferences, habits, context about the user
- \`project\` — project structure, conventions, tooling
- \`feedback\` — guidance on how to approach work, corrections, confirmations
- \`reference\` — frequently-referenced facts, APIs, commands

**Important:** Do NOT load all topics at once. Read the index, identify what is
relevant to the current task, and load only those topics.

${MARKER_END}`;

function agentsPath(workspaceDir: string = WORKSPACE_DIR): string {
  return join(workspaceDir, AGENTS_FILENAME);
}

/**
 * Returns true if the AGENTS.md file contains the memory instruction block.
 */
export function hasMemoryInstructions(workspaceDir: string = WORKSPACE_DIR): boolean {
  const path = agentsPath(workspaceDir);
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf-8");
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

/**
 * Inject the memory instruction block into AGENTS.md.
 * Appends to existing content. Idempotent — will not double-inject.
 */
export function injectMemoryInstructions(workspaceDir: string = WORKSPACE_DIR): void {
  if (hasMemoryInstructions(workspaceDir)) return;

  const path = agentsPath(workspaceDir);
  let content = "";
  if (existsSync(path)) {
    content = readFileSync(path, "utf-8");
  }

  const separator = content.length > 0 && !content.endsWith("\n\n") ? "\n\n" : "";
  writeFileSync(path, content + separator + MEMORY_INSTRUCTIONS + "\n");
}

/**
 * Remove the memory instruction block from AGENTS.md.
 * Idempotent — safe to call if block is already absent.
 */
export function removeMemoryInstructions(workspaceDir: string = WORKSPACE_DIR): void {
  const path = agentsPath(workspaceDir);
  if (!existsSync(path)) return;

  let content = readFileSync(path, "utf-8");
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.slice(0, startIdx).replace(/\n+$/, "");
  const after = content.slice(endIdx + MARKER_END.length).replace(/^\n+/, "");

  content = before + (before && after ? "\n\n" : "") + after;
  writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
}
