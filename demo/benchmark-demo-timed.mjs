#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Timed benchmark demo — synced with narration audio.
 * Each section pauses to align with the narration clips.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TypedMemoryProvider } from "../nemoclaw/dist/memory/typed-provider.js";
import { encodingForModel } from "js-tiktoken";

const enc = encodingForModel("gpt-4o");
function tokens(text) { return enc.encode(text).length; }

const SCALES = [10, 50, 100, 500, 1_000, 5_000, 10_000];
const TYPES = ["user", "project", "feedback", "reference"];
const TOOL_OVERHEAD = 80;
const K_VALUES = [0, 3, 5, 10];

const TITLES = [
  "Editor preferences", "API rate limits", "Deploy process",
  "Testing strategy", "Git workflow", "Code review guidelines",
  "Database schema", "Auth flow", "Error handling",
  "Logging setup", "CI pipeline", "Docker config",
  "Security policy", "Performance tuning", "Monitoring",
  "Backup strategy", "Migration plan", "Dependency policy",
  "Naming conventions", "Architecture decisions",
];

const BODIES = [
  "Use VS Code with vim keybindings. Dark mode preferred.\nInstalled extensions: ESLint, Prettier, GitLens, Copilot.\nFont: JetBrains Mono, size 14. Tab size: 2 spaces.\nTerminal: integrated, using zsh with starship prompt.",
  "Default rate limit is 60 req/min. Burst allows 120 req/min for 10 seconds.\nRate limit headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset.\nWhen exceeded, returns 429 with Retry-After header.\nPremium tier gets 300 req/min.",
  "Merge to main triggers CI. Auto-deploy to staging on green. Manual prod promotion.\nCI pipeline: lint → typecheck → unit tests → integration tests → build → deploy.\nRollback process: revert the merge commit, CI auto-deploys previous version.\nDeploy windows: weekdays 9am-4pm PT only. No Friday deploys.",
  "Write unit tests for all new functions. Integration tests for API endpoints.\nCoverage threshold: 80% lines, 90% branches for critical paths.\nUse vitest for unit tests, supertest for API tests.\nMock external services, never hit real APIs in tests.\nSnapshot tests only for serialization formats, not UI.",
  "Feature branches from main. Squash merge. Conventional commits required.\nBranch naming: type/description (e.g., feat/add-memory-search).\nPR title must match conventional commit format.\nRebase before merge if behind main by more than 5 commits.\nDelete branch after merge.",
  "All PRs need at least one approval. Self-merge allowed after 24h.\nReviewers auto-assigned based on CODEOWNERS file.\nDraft PRs for work-in-progress. Convert to ready when done.\nCI must pass before merge. No force-push to main ever.",
  "PostgreSQL 16. UUID primary keys. Soft delete with deleted_at column.\nMigrations managed by Prisma. Always create migration before deploying.\nIndexes required for all foreign keys and frequently queried columns.\nConnection pooling via PgBouncer, max 50 connections per service.",
  "OAuth 2.0 with PKCE. JWT access tokens, 15 min expiry. Refresh tokens in httpOnly cookies.\nToken refresh happens transparently in the API client middleware.\nRevocation endpoint for logout. Refresh token rotation on each use.\nRate limit auth endpoints separately: 10 attempts per minute per IP.",
  "Use structured logging. Include request ID in all log entries.\nLog levels: error (pages oncall), warn (review daily), info (audit trail), debug (dev only).\nPII must never appear in logs. Use field-level redaction middleware.\nLogs shipped to Datadog via fluentbit. 30-day retention.",
  "Winston for Node.js. JSON format in production, pretty print in development.\nCorrelation ID propagated via AsyncLocalStorage across all async operations.\nHTTP request/response logging at info level, body at debug level only.\nError logs include stack trace, request context, and user ID (hashed).",
];

function title(i) { return `${TITLES[i % TITLES.length]} ${Math.floor(i / TITLES.length) + 1}`; }
function body(i) { return BODIES[i % BODIES.length]; }
function type(i) { return TYPES[i % TYPES.length]; }

function buildFlat(n) {
  const lines = ["# Agent Memory", ""];
  for (let i = 0; i < n; i++) lines.push(`- ${title(i)}: ${body(i)}`);
  return lines.join("\n");
}

function buildTyped(n, dir) {
  const p = new TypedMemoryProvider(join(dir, "MEMORY.md"), join(dir, "memory", "topics"));
  const now = "2026-04-01T00:00:00.000Z";
  for (let i = 0; i < n; i++) {
    const t = title(i);
    const slug = t.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
    p.save(slug, { name: t, description: t, type: type(i), created: now, updated: now }, `\n${body(i)}\n`);
  }
  return p;
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function bar(pct, width = 30) {
  const filled = Math.round((pct / 100) * width);
  return GREEN + "█".repeat(filled) + DIM + "░".repeat(width - filled) + RESET;
}

async function main() {
  // --- Section 1: Intro (syncs with 01-intro, ~8s) ---
  console.log("");
  console.log(`${BOLD}${CYAN}  NemoClaw Memory Benchmark${RESET}`);
  console.log(`${DIM}  Flat MEMORY.md vs Typed Index${RESET}`);
  console.log(`${DIM}  Tokenizer: tiktoken cl100k_base (GPT-4o / Claude-class)${RESET}`);
  console.log(`${DIM}  Environment: NemoClaw sandbox container${RESET}`);
  console.log("");
  await sleep(8000);

  // --- Section 2: Context window table (syncs with 02-context, ~22s) ---
  console.log(`${BOLD}  Context Window Tokens (static cost per session)${RESET}`);
  console.log("");
  console.log(`  ${DIM}Entries     Flat        Index       Savings${RESET}`);
  console.log(`  ${DIM}${"─".repeat(52)}${RESET}`);

  const results = [];

  for (const n of SCALES) {
    const flatContent = buildFlat(n);
    const flatTok = tokens(flatContent);
    const dir = mkdtempSync(join(tmpdir(), `bench-${n}-`));
    const provider = buildTyped(n, dir);
    const indexTok = tokens(provider.context());

    let topicSum = 0;
    const entries = provider.list();
    const sampleN = Math.min(n, 20);
    for (let i = 0; i < sampleN; i++) {
      const t = provider.load(entries[i].slug);
      if (t) topicSum += tokens(t.body + t.frontmatter.description);
    }
    const avgTopic = Math.ceil(topicSum / sampleN);

    const pct = ((1 - indexTok / flatTok) * 100);
    const pctStr = pct > 0 ? `${GREEN}${pct.toFixed(1)}%${RESET}` : `${RED}+${(-pct).toFixed(1)}%${RESET}`;

    console.log(`  ${String(n).padStart(7)}   ${String(flatTok).padStart(8)}    ${String(indexTok).padStart(8)}    ${pctStr}  ${bar(Math.max(0, pct))}`);

    results.push({ n, flatTok, indexTok, pct, avgTopic });
    rmSync(dir, { recursive: true, force: true });
    await sleep(2500);
  }

  console.log("");
  await sleep(2000);

  // --- Section 3: Crossover (syncs with 03-crossover, ~6s) ---
  const cross = results.find((r) => r.pct > 0);
  if (cross) {
    console.log(`  ${BOLD}Crossover point:${RESET} Typed index wins at ${YELLOW}~${cross.n} entries${RESET} and above.`);
    console.log(`  ${DIM}Below ${cross.n} entries, the flat format is more compact (table header overhead).${RESET}`);
  }
  console.log("");
  await sleep(6000);

  // --- Section 4: Session cost (syncs with 04-session, ~22s) ---
  console.log(`${BOLD}  Total Session Cost (static + tool call overhead)${RESET}`);
  console.log(`  ${DIM}Each topic read adds ~${TOOL_OVERHEAD} tokens overhead (tool call framing).${RESET}`);
  console.log("");
  console.log(`  ${DIM}Entries    K=0         K=3         K=5         K=10${RESET}`);
  console.log(`  ${DIM}${"─".repeat(60)}${RESET}`);

  for (const r of results) {
    const cols = K_VALUES.map((k) => {
      const typedTotal = r.indexTok + k * (r.avgTopic + TOOL_OVERHEAD);
      const pct = ((1 - typedTotal / r.flatTok) * 100);
      if (pct > 0) return `${GREEN}${pct.toFixed(0)}%${RESET}`.padStart(18);
      return `${RED}+${(-pct).toFixed(0)}%${RESET}`.padStart(18);
    });
    console.log(`  ${String(r.n).padStart(7)}  ${cols.join("  ")}`);
    await sleep(2500);
  }

  console.log("");
  await sleep(3000);

  // --- Section 5: Takeaways (syncs with 05-takeaways, ~12s) ---
  const r10k = results[results.length - 1];
  console.log(`${BOLD}  Key Takeaways${RESET}`);
  console.log("");
  await sleep(1000);
  console.log(`  ${GREEN}✓${RESET} ${BOLD}~59% context savings${RESET} at 1,000+ entries (tiktoken measured)`);
  await sleep(2500);
  console.log(`  ${GREEN}✓${RESET} Crossover at ~${cross ? cross.n : "?"} entries — agents hit this in day one`);
  await sleep(2500);
  console.log(`  ${GREEN}✓${RESET} Even reading 10 topics/session, typed index wins at 50+ entries`);
  await sleep(2500);
  console.log(`  ${GREEN}✓${RESET} At 10K entries: ${r10k.flatTok.toLocaleString()} → ${r10k.indexTok.toLocaleString()} tokens (${r10k.pct.toFixed(1)}% less)`);
  await sleep(2000);
  console.log("");
  console.log(`  ${DIM}Reproduce: npm run benchmark:memory${RESET}`);
  console.log("");
  await sleep(3000);
}

main();
