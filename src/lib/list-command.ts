// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import {
  getSandboxInventory,
  type ListSandboxesCommandDeps,
  renderSandboxInventoryText,
} from "./inventory-commands";

export interface RunListCommandDeps extends ListSandboxesCommandDeps {
  rootDir: string;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

let activeDeps: RunListCommandDeps | null = null;

function requireActiveDeps(): RunListCommandDeps {
  if (!activeDeps) {
    throw new Error("list command runtime dependencies are not configured");
  }

  return activeDeps;
}

export function printListUsage(log: (message?: string) => void = console.log): void {
  log("  Usage: nemoclaw list [--json]");
  log("");
}

function isListParseError(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { constructor?: { name?: string } }).constructor?.name : "";
  return name === "NonExistentFlagsError" || name === "UnexpectedArgsError";
}

export class ListCommand extends Command {
  static strict = true;
  static summary = "List all sandboxes";
  static description = "List all registered sandboxes with their model, provider, and policy presets.";
  static usage = ["list [--json]"];
  static flags = {
    help: Flags.boolean({ char: "h" }),
    json: Flags.boolean(),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ListCommand);
    const deps = requireActiveDeps();
    const log = deps.log ?? console.log;

    if (flags.help) {
      printListUsage(log);
      return;
    }

    const inventory = await getSandboxInventory(deps);
    if (flags.json) {
      log(JSON.stringify(inventory, null, 2));
      return;
    }

    renderSandboxInventoryText(inventory, log);
  }
}

export async function runListCommand(
  args: string[],
  deps: RunListCommandDeps,
): Promise<void> {
  activeDeps = deps;
  try {
    await ListCommand.run(args, deps.rootDir);
  } catch (error) {
    if (isListParseError(error)) {
      const errorLine = deps.error ?? console.error;
      const exit = deps.exit ?? ((code: number) => process.exit(code));
      errorLine(`  Unknown argument(s) for list: ${args.join(", ")}`);
      printListUsage(errorLine);
      exit(1);
    }
    throw error;
  } finally {
    activeDeps = null;
  }
}
