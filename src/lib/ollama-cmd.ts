// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type KvCacheType = "f16" | "q8_0" | "q4_0";

export interface ParsedOllamaArgs {
  subcommand?: "status" | "optimize" | "apply" | "reset";
  help: boolean;
  vramPercent?: number | null;
  numCtx?: number | null;
  numBatch?: number | null;
  flashAttention?: boolean | null;
  kvCacheType?: KvCacheType | null;
  sudo: boolean;
  yes: boolean;
  optimizeApply: boolean;
  optimizeCtx?: number;
  optimizeVram?: number;
}

const HELP_TEXT = [
  "Usage: nemoclaw ollama <subcommand|assignment...>",
  "",
  "Subcommands:",
  "  status               Show current Ollama VRAM tuning and GPU budget",
  "  optimize             Auto-tune GPU settings for the active model",
  "  apply                Apply pending daemon-level recommendations",
  "  reset                Clear all tuning overrides and revert daemon env",
  "",
  "Assignment args (combinable in one invocation):",
  "  vram=N%              Cap VRAM usage (1..100%); vram=off to clear",
  "  ctx=N                Set context window size; ctx=off to clear",
  "  batch=N              Set batch size; batch=off to clear",
  "  flash=on|off         Enable/disable OLLAMA_FLASH_ATTENTION (restart)",
  "  kv-cache=f16|q8_0|q4_0  Set OLLAMA_KV_CACHE_TYPE (restart)",
  "",
  "Flags:",
  "  --apply              Apply changes immediately (for optimize)",
  "  --sudo               Allow sudo for systemd daemon restart",
  "  --yes                Skip interactive confirmation prompts",
  "  --help, -h           Show this help",
  "",
  "Examples:",
  "  nemoclaw ollama vram=80% ctx=32768",
  "  nemoclaw ollama vram=80% ctx=32768 kv-cache=q8_0 flash=on",
  "  nemoclaw ollama optimize --apply --sudo",
  "  nemoclaw ollama status",
].join("\n");

export class OllamaArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaArgParseError";
  }
}

export function parseOllamaArgs(argv: string[]): ParsedOllamaArgs {
  const result: ParsedOllamaArgs = {
    help: false,
    sudo: false,
    yes: false,
    optimizeApply: false,
  };

  const remaining = [...argv];
  let i = 0;

  while (i < remaining.length) {
    const arg = remaining[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "--sudo") {
      result.sudo = true;
      i++;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      i++;
      continue;
    }

    if (arg === "--apply") {
      result.optimizeApply = true;
      i++;
      continue;
    }

    if (arg === "--ctx" && i + 1 < remaining.length) {
      const val = parseInt(remaining[i + 1], 10);
      if (isNaN(val) || val <= 0) {
        throw new OllamaArgParseError(`Invalid --ctx value: ${remaining[i + 1]}`);
      }
      result.optimizeCtx = val;
      i += 2;
      continue;
    }

    if (arg === "--vram" && i + 1 < remaining.length) {
      const raw = remaining[i + 1].replace(/%$/, "");
      const val = parseInt(raw, 10);
      if (isNaN(val) || val < 1 || val > 100) {
        throw new OllamaArgParseError(`Invalid --vram value: ${remaining[i + 1]}`);
      }
      result.optimizeVram = val;
      i += 2;
      continue;
    }

    // Named subcommands
    if (
      arg === "status" ||
      arg === "optimize" ||
      arg === "apply" ||
      arg === "reset"
    ) {
      if (result.subcommand !== undefined) {
        throw new OllamaArgParseError(
          `Unexpected subcommand "${arg}" — already have "${result.subcommand}"`,
        );
      }
      result.subcommand = arg;
      i++;
      continue;
    }

    // Assignment-style args: key=value
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      parseAssignment(key, value, result);
      i++;
      continue;
    }

    throw new OllamaArgParseError(`Unknown argument: ${arg}`);
  }

  return result;
}

function parseAssignment(key: string, value: string, result: ParsedOllamaArgs): void {
  switch (key) {
    case "vram": {
      if (value === "off") {
        result.vramPercent = null;
        break;
      }
      const raw = value.replace(/%$/, "");
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        throw new OllamaArgParseError(
          `Invalid vram value "${value}" — expected 1..100 or "off"`,
        );
      }
      result.vramPercent = n;
      break;
    }
    case "ctx": {
      if (value === "off") {
        result.numCtx = null;
        break;
      }
      const n = parseInt(value, 10);
      if (isNaN(n) || n <= 0) {
        throw new OllamaArgParseError(
          `Invalid ctx value "${value}" — expected positive integer or "off"`,
        );
      }
      result.numCtx = n;
      break;
    }
    case "batch": {
      if (value === "off") {
        result.numBatch = null;
        break;
      }
      const n = parseInt(value, 10);
      if (isNaN(n) || n <= 0) {
        throw new OllamaArgParseError(
          `Invalid batch value "${value}" — expected positive integer or "off"`,
        );
      }
      result.numBatch = n;
      break;
    }
    case "flash": {
      if (value === "on") {
        result.flashAttention = true;
      } else if (value === "off") {
        result.flashAttention = false;
      } else {
        throw new OllamaArgParseError(`Invalid flash value "${value}" — expected "on" or "off"`);
      }
      break;
    }
    case "kv-cache": {
      if (value === "off") {
        result.kvCacheType = null;
        break;
      }
      if (value !== "f16" && value !== "q8_0" && value !== "q4_0") {
        throw new OllamaArgParseError(
          `Invalid kv-cache value "${value}" — expected "f16", "q8_0", or "q4_0"`,
        );
      }
      result.kvCacheType = value;
      break;
    }
    default:
      throw new OllamaArgParseError(`Unknown key "${key}" — expected vram, ctx, batch, flash, or kv-cache`);
  }
}

function formatParsed(parsed: ParsedOllamaArgs): string {
  const parts: string[] = [];
  if (parsed.vramPercent !== undefined && parsed.vramPercent !== null)
    parts.push(`vramPercent: ${parsed.vramPercent}`);
  if (parsed.numCtx !== undefined && parsed.numCtx !== null)
    parts.push(`numCtx: ${parsed.numCtx}`);
  if (parsed.numBatch !== undefined && parsed.numBatch !== null)
    parts.push(`numBatch: ${parsed.numBatch}`);
  if (parsed.flashAttention !== undefined && parsed.flashAttention !== null)
    parts.push(`flashAttention: ${parsed.flashAttention}`);
  if (parsed.kvCacheType !== undefined && parsed.kvCacheType !== null)
    parts.push(`kvCacheType: "${parsed.kvCacheType}"`);
  return `{ ${parts.join(", ")} }`;
}

export async function runOllamaCommand(argv: string[]): Promise<void> {
  // argv is process.argv starting from the token after "nemoclaw", e.g. ["ollama", "vram=80%"]
  // Strip leading "ollama" token if present
  const args = argv[0] === "ollama" ? argv.slice(1) : argv;

  let parsed: ParsedOllamaArgs;
  try {
    parsed = parseOllamaArgs(args);
  } catch (err) {
    if (err instanceof OllamaArgParseError) {
      console.error(`Error: ${err.message}`);
      console.error("");
      console.error(HELP_TEXT);
      process.exit(1);
    }
    throw err;
  }

  if (parsed.help || (args.length === 0 && parsed.subcommand === undefined)) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (parsed.subcommand) {
    console.log(`would apply: subcommand="${parsed.subcommand}"`);
    process.exit(0);
  }

  console.log(`would apply: ${formatParsed(parsed)}`);
  process.exit(0);
}
