// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shell-quote a value for safe interpolation into bash -c strings.
 * Wraps in single quotes and escapes embedded single quotes.
 */
export type ShellQuotable = string | number | boolean | null | undefined;

const SAFE_SHELL_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SHELL_ASSIGNMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteShellValue(value: ShellQuotable): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function shellQuote(value: ShellQuotable): string {
  return quoteShellValue(value);
}

export function formatShellToken(value: string): string {
  return SAFE_SHELL_TOKEN_RE.test(value) ? value : quoteShellValue(value);
}

export function joinShellWords(values: readonly string[]): string {
  return values.map((value) => formatShellToken(value)).join(" ");
}

export function buildShellAssignment(name: string, value: string): string {
  if (!SHELL_ASSIGNMENT_NAME_RE.test(name)) {
    throw new Error(`Invalid shell assignment name: ${JSON.stringify(name)}`);
  }
  return `${name}=${formatShellToken(value)}`;
}
