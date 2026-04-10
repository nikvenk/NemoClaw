#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the typed memory index module.
 * Exercises the full CRUD cycle against a real filesystem (temp dir).
 *
 * Run: node test/integration/memory-index.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import compiled module
import {
  loadMemoryIndex,
  saveMemoryIndex,
  loadTopic,
  saveTopic,
  listTopicSlugs,
  isValidMemoryType,
  slugify,
  parseTopicFrontmatter,
  getMemoryStats,
  MEMORY_TYPES,
  INDEX_SOFT_CAP,
  TOPIC_SOFT_CAP,
} from "../../nemoclaw/dist/memory/index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

// ---------------------------------------------------------------------------
// Setup temp workspace
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-memory-test-"));
const indexPath = join(tmpDir, "MEMORY.md");
const topicsDir = join(tmpDir, "memory", "topics");

console.log(`\n📁 Temp workspace: ${tmpDir}\n`);

try {
  // -------------------------------------------------------------------------
  // 1. Validation helpers
  // -------------------------------------------------------------------------

  section("Validation helpers");

  assert(isValidMemoryType("user") === true, "isValidMemoryType('user') → true");
  assert(isValidMemoryType("project") === true, "isValidMemoryType('project') → true");
  assert(isValidMemoryType("feedback") === true, "isValidMemoryType('feedback') → true");
  assert(isValidMemoryType("decision") === false, "isValidMemoryType('decision') → false");
  assert(isValidMemoryType("reference") === true, "isValidMemoryType('reference') → true");
  assert(isValidMemoryType("invalid") === false, "isValidMemoryType('invalid') → false");
  assert(isValidMemoryType("") === false, "isValidMemoryType('') → false");

  assert(slugify("My Cool Topic") === "my-cool-topic", "slugify spaces → hyphens");
  assert(slugify("Hello, World! (2026)") === "hello-world-2026", "slugify strips special chars");
  assert(slugify("a  --  b") === "a-b", "slugify collapses hyphens");
  assert(slugify("a".repeat(100)).length === 80, "slugify truncates to 80");

  // -------------------------------------------------------------------------
  // 2. Empty state
  // -------------------------------------------------------------------------

  section("Empty state (no files exist)");

  const emptyIndex = loadMemoryIndex(indexPath);
  assert(emptyIndex.entries.length === 0, "loadMemoryIndex returns empty for missing file");

  const emptySlugs = listTopicSlugs(topicsDir);
  assert(emptySlugs.length === 0, "listTopicSlugs returns empty for missing dir");

  const emptyStats = getMemoryStats(indexPath, topicsDir);
  assert(emptyStats.indexEntryCount === 0, "getMemoryStats.indexEntryCount = 0");
  assert(emptyStats.topicCount === 0, "getMemoryStats.topicCount = 0");
  assert(emptyStats.indexOverCap === false, "getMemoryStats.indexOverCap = false");

  // -------------------------------------------------------------------------
  // 3. Legacy flat MEMORY.md (backward compatibility)
  // -------------------------------------------------------------------------

  section("Legacy flat MEMORY.md (backward compat)");

  writeFileSync(indexPath, "# My Notes\n\nSome random content here.\nMore stuff.\n");
  const legacyIndex = loadMemoryIndex(indexPath);
  assert(legacyIndex.entries.length === 0, "Legacy flat content returns empty entries (no crash)");

  // -------------------------------------------------------------------------
  // 4. Save and load topics
  // -------------------------------------------------------------------------

  section("Topic CRUD");

  const fm1 = {
    name: "preferred-editor",
    description: "User prefers VS Code with vim keybindings",
    type: "user",
    created: "2026-03-20T10:00:00.000Z",
    updated: "2026-03-20T10:00:00.000Z",
  };
  saveTopic("preferred-editor", fm1, "\nUser strongly prefers VS Code with vim keybindings.\n", topicsDir);
  assert(true, "saveTopic('preferred-editor') succeeded (created topics dir)");

  const loaded1 = loadTopic("preferred-editor", topicsDir);
  assert(loaded1 !== null, "loadTopic('preferred-editor') returns non-null");
  assert(loaded1.frontmatter.name === "preferred-editor", "Round-trip: name matches");
  assert(loaded1.frontmatter.type === "user", "Round-trip: type matches");
  assert(loaded1.frontmatter.description === "User prefers VS Code with vim keybindings", "Round-trip: description matches");
  assert(loaded1.body.includes("VS Code with vim keybindings"), "Round-trip: body content preserved");

  const fm2 = {
    name: "api-rate-limits",
    description: "Rate limits for the inference API",
    type: "reference",
    created: "2026-03-19T08:00:00.000Z",
    updated: "2026-03-19T14:00:00.000Z",
  };
  saveTopic("api-rate-limits", fm2, "\nDefault: 60 req/min. Burst: 120 req/min.\n", topicsDir);

  const fm3 = {
    name: "use-typescript",
    description: "Feedback to use TypeScript for all new modules",
    type: "feedback",
    created: "2026-03-18T09:00:00.000Z",
    updated: "2026-03-18T09:00:00.000Z",
  };
  saveTopic("use-typescript", fm3, "\nAll new plugin modules must be TypeScript.\nRationale: type safety, IDE support.\n", topicsDir);

  const slugs = listTopicSlugs(topicsDir);
  assert(slugs.length === 3, `listTopicSlugs returns 3 (got ${slugs.length})`);
  assert(slugs.includes("preferred-editor"), "Slugs include 'preferred-editor'");
  assert(slugs.includes("api-rate-limits"), "Slugs include 'api-rate-limits'");
  assert(slugs.includes("use-typescript"), "Slugs include 'use-typescript'");

  assert(loadTopic("nonexistent", topicsDir) === null, "loadTopic returns null for missing file");

  // -------------------------------------------------------------------------
  // 5. Save and load memory index
  // -------------------------------------------------------------------------

  section("Memory index CRUD");

  const index = {
    entries: [
      { slug: "preferred-editor", title: "Editor Prefs", type: "user", updatedAt: "2026-03-20" },
      { slug: "api-rate-limits", title: "API Limits", type: "reference", updatedAt: "2026-03-19" },
      { slug: "use-typescript", title: "Use TypeScript", type: "feedback", updatedAt: "2026-03-18" },
    ],
  };
  saveMemoryIndex(index, indexPath);
  assert(true, "saveMemoryIndex succeeded");

  const savedContent = readFileSync(indexPath, "utf-8");
  assert(savedContent.includes("| Topic | Type | Updated |"), "Index contains table header");
  assert(savedContent.includes("[Editor Prefs](memory/topics/preferred-editor.md)"), "Index contains entry link");
  assert(savedContent.includes("| reference |"), "Index contains type column");

  const reloaded = loadMemoryIndex(indexPath);
  assert(reloaded.entries.length === 3, `Reloaded index has 3 entries (got ${reloaded.entries.length})`);
  assert(reloaded.entries[0].slug === "preferred-editor", "Sorted: newest first (2026-03-20)");
  assert(reloaded.entries[1].slug === "api-rate-limits", "Sorted: second (2026-03-19)");
  assert(reloaded.entries[2].slug === "use-typescript", "Sorted: oldest last (2026-03-18)");

  // -------------------------------------------------------------------------
  // 6. Memory stats
  // -------------------------------------------------------------------------

  section("Memory stats");

  const stats = getMemoryStats(indexPath, topicsDir);
  assert(stats.indexEntryCount === 3, `indexEntryCount = 3 (got ${stats.indexEntryCount})`);
  assert(stats.topicCount === 3, `topicCount = 3 (got ${stats.topicCount})`);
  assert(stats.topicsByType.user === 1, `topicsByType.user = 1 (got ${stats.topicsByType.user})`);
  assert(stats.topicsByType.reference === 1, `topicsByType.reference = 1`);
  assert(stats.topicsByType.feedback === 1, `topicsByType.feedback = 1`);
  assert(stats.topicsByType.project === 0, `topicsByType.project = 0`);
  assert(stats.indexOverCap === false, "indexOverCap = false (3 < 200)");
  assert(stats.oversizedTopics.length === 0, "No oversized topics");

  // -------------------------------------------------------------------------
  // 7. parseTopicFrontmatter
  // -------------------------------------------------------------------------

  section("parseTopicFrontmatter");

  const topicContent = readFileSync(join(topicsDir, "preferred-editor.md"), "utf-8");
  const parsed = parseTopicFrontmatter(topicContent);
  assert(parsed !== null, "Parses valid topic file");
  assert(parsed.frontmatter.name === "preferred-editor", "Parsed name matches");

  assert(parseTopicFrontmatter("Just plain text") === null, "Returns null for no frontmatter");
  assert(parseTopicFrontmatter("---\n: [bad\n---\nbody") === null, "Returns null for invalid YAML");

  // -------------------------------------------------------------------------
  // 8. Constants
  // -------------------------------------------------------------------------

  section("Constants");

  assert(MEMORY_TYPES.length === 4, `MEMORY_TYPES has 4 entries`);
  assert(INDEX_SOFT_CAP === 200, `INDEX_SOFT_CAP = 200`);
  assert(TOPIC_SOFT_CAP === 500, `TOPIC_SOFT_CAP = 500`);

  // -------------------------------------------------------------------------
  // 9. Show generated files
  // -------------------------------------------------------------------------

  section("Generated files");

  console.log("\n--- MEMORY.md ---");
  console.log(readFileSync(indexPath, "utf-8"));

  console.log("--- memory/topics/preferred-editor.md ---");
  console.log(readFileSync(join(topicsDir, "preferred-editor.md"), "utf-8"));

  console.log("--- memory/topics/api-rate-limits.md ---");
  console.log(readFileSync(join(topicsDir, "api-rate-limits.md"), "utf-8"));

} finally {
  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"═".repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
