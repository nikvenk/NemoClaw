// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "credentials",
  "help",
]);

export interface PromptValidatedSandboxNameDeps {
  promptOrDefault: (
    question: string,
    envVar: string | null,
    defaultValue: string,
  ) => Promise<string>;
  validateName: (value: string, label: string) => string;
  isNonInteractive: () => boolean;
  errorWriter?: (message?: string) => void;
  exit?: (code: number) => never;
}

export async function promptValidatedSandboxName(
  deps: PromptValidatedSandboxNameDeps,
): Promise<string> {
  const errorWriter = deps.errorWriter ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const nameAnswer = await deps.promptOrDefault(
      "  Sandbox name (lowercase, starts with letter, hyphens ok) [my-assistant]: ",
      "NEMOCLAW_SANDBOX_NAME",
      "my-assistant",
    );
    const sandboxName = (nameAnswer || "my-assistant").trim();

    try {
      const validatedSandboxName = deps.validateName(sandboxName, "sandbox name");
      if (RESERVED_SANDBOX_NAMES.has(validatedSandboxName)) {
        errorWriter(
          `  Reserved name: '${validatedSandboxName}' is a NemoClaw CLI command.`,
        );
        errorWriter("  Choose a different name to avoid routing conflicts.");
        if (deps.isNonInteractive()) {
          exit(1);
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          errorWriter("  Please try again.\n");
        }
        continue;
      }
      return validatedSandboxName;
    } catch (error: unknown) {
      errorWriter(`  ${(error as Error).message}`);
    }

    if (/^[0-9]/.test(sandboxName)) {
      errorWriter("  Names must start with a letter, not a digit.");
    } else {
      errorWriter("  Names must be lowercase, contain only letters, numbers, and hyphens,");
      errorWriter("  must start with a letter, and end with a letter or number.");
    }

    if (deps.isNonInteractive()) {
      exit(1);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      errorWriter("  Please try again.\n");
    }
  }

  errorWriter("  Too many invalid attempts.");
  exit(1);
  throw new Error("unreachable");
}
