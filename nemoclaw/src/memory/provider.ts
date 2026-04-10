// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryType, MemoryIndexEntry, MemoryTopicFrontmatter, MemoryStats } from "./index.js";

/**
 * Composable memory provider interface.
 *
 * NemoClaw ships a TypedMemoryProvider implementation. OpenClaw or third-party
 * plugins can implement this interface to provide alternative memory backends
 * (vector stores, databases, flat files, etc.).
 */
export interface MemoryProvider {
  /** Return content for the agent's context window at session start. */
  context(): string;

  /** Load a single topic by slug. Returns null if not found. */
  load(slug: string): { frontmatter: MemoryTopicFrontmatter; body: string } | null;

  /** Save or update a topic. Also updates the index entry. */
  save(slug: string, frontmatter: MemoryTopicFrontmatter, body: string): void;

  /** Delete a topic and its index entry. No-op if slug does not exist. */
  delete(slug: string): void;

  /** List index entries, optionally filtered by type. */
  list(filter?: { type?: MemoryType }): MemoryIndexEntry[];

  /** Keyword search across topic titles and bodies. Returns matching index entries sorted by relevance. */
  search(query: string): MemoryIndexEntry[];

  /** Usage stats: entry counts, type breakdown, cap warnings. */
  stats(): MemoryStats;

  /** Migrate a flat MEMORY.md string into this provider's format. Returns counts of imported and skipped entries. */
  migrate(flatContent: string): { imported: number; skipped: number };
}
