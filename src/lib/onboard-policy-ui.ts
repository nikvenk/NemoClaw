// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface PolicyUiDeps {
  step: (current: number, total: number, message: string) => void;
  prompt: (question: string) => Promise<string>;
  note: (message: string) => void;
  sleep: (seconds: number) => void;
  isNonInteractive: () => boolean;
  parsePolicyPresetEnv: (raw: string | undefined) => string[];
  waitForSandboxReady: (sandboxName: string, attempts?: number, delaySeconds?: number) => boolean;
  localInferenceProviders: string[];
  useColor: boolean;
  policies: {
    listPresets: () => Array<{ name: string; description: string }>;
    getAppliedPresets: (sandboxName: string) => string[];
    applyPreset: (sandboxName: string, name: string, options?: { access?: string }) => void;
    removePreset: (sandboxName: string, name: string) => boolean;
  };
  tiers: {
    listTiers: () => Array<{ name: string; label: string }>;
    getTier: (name: string) =>
      | { name: string; label: string; presets: Array<{ name: string; access: string }> }
      | null;
    resolveTierPresets: (name: string) => Array<{ name: string; access: string }>;
  };
  updateSandbox: (sandboxName: string, patch: Record<string, unknown>) => void;
}

export interface LegacySetupPoliciesOptions {
  enabledChannels?: string[] | null;
  webSearchConfig?: unknown;
  provider?: string | null;
  getSuggestedPolicyPresets: (options?: {
    enabledChannels?: string[] | null;
    webSearchConfig?: unknown;
    provider?: string | null;
  }) => string[];
}

export interface SetupPoliciesWithSelectionOptions {
  selectedPresets?: string[] | null;
  onSelection?: ((presets: string[]) => void) | null;
  webSearchConfig?: unknown;
  enabledChannels?: string[] | null;
  provider?: string | null;
}

// eslint-disable-next-line complexity
export async function setupPoliciesLegacy(
  sandboxName: string,
  options: LegacySetupPoliciesOptions,
  deps: PolicyUiDeps,
): Promise<void> {
  deps.step(8, 8, "Policy presets");
  const suggestions = options.getSuggestedPolicyPresets(options);

  const allPresets = deps.policies.listPresets();
  const applied = deps.policies.getAppliedPresets(sandboxName);

  if (deps.isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      deps.note("  [non-interactive] Skipping policy presets.");
      return;
    }

    if (policyMode === "custom" || policyMode === "list") {
      selectedPresets = deps.parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (selectedPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = deps.parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (envPresets.length > 0) {
        selectedPresets = envPresets;
      }
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((preset) => preset.name));
    const invalidPresets = selectedPresets.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    deps.note(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
    for (const name of selectedPresets) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          deps.policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          deps.sleep(2);
        }
      }
    }
  } else {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((preset) => {
      const marker = applied.includes(preset.name) || suggestions.includes(preset.name) ? "●" : "○";
      const suggested = suggestions.includes(preset.name) ? " (suggested)" : "";
      console.log(`    ${marker} ${preset.name} — ${preset.description}${suggested}`);
    });
    console.log("");

    const answer = await deps.prompt(
      `  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `,
    );

    if (answer.toLowerCase() === "n") {
      console.log("  Skipping policy presets.");
      return;
    }

    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }

    if (answer.toLowerCase() === "list") {
      const picks = await deps.prompt("  Enter preset names (comma-separated): ");
      const selected = picks
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      for (const name of selected) {
        deps.policies.applyPreset(sandboxName, name);
      }
    } else {
      for (const name of suggestions) {
        deps.policies.applyPreset(sandboxName, name);
      }
    }
  }

  console.log("  ✓ Policies applied");
}

export function arePolicyPresetsApplied(
  sandboxName: string,
  selectedPresets: string[] = [],
  deps: PolicyUiDeps,
): boolean {
  if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
  const applied = new Set(deps.policies.getAppliedPresets(sandboxName));
  return selectedPresets.every((preset) => applied.has(preset));
}

/**
 * Prompt the user to select a policy tier (restricted / balanced / open).
 * Uses the same radio-style TUI as presetsCheckboxSelector (single-select).
 * In non-interactive mode reads NEMOCLAW_POLICY_TIER (default: balanced).
 * Returns the tier name string.
 */
export async function selectPolicyTier(deps: PolicyUiDeps): Promise<string> {
  const allTiers = deps.tiers.listTiers();
  const defaultTier = (allTiers.find((tier) => tier.name === "balanced") || allTiers[1])!;

  if (deps.isNonInteractive()) {
    const name = (process.env.NEMOCLAW_POLICY_TIER || "balanced").trim().toLowerCase();
    if (!deps.tiers.getTier(name)) {
      console.error(
        `  Unknown policy tier: ${name}. Valid: ${allTiers.map((tier) => tier.name).join(", ")}`,
      );
      process.exit(1);
    }
    deps.note(`  [non-interactive] Policy tier: ${name}`);
    return name;
  }

  const RADIO_ON = deps.useColor ? "[\x1b[32m✓\x1b[0m]" : "[✓]";
  const RADIO_OFF = deps.useColor ? "\x1b[2m[ ]\x1b[0m" : "[ ]";

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Policy tier — controls which network presets are enabled:");
    allTiers.forEach((tier) => {
      const marker = tier.name === defaultTier.name ? RADIO_ON : RADIO_OFF;
      console.log(`    ${marker} ${tier.label}`);
    });
    console.log("");
    const answer = await deps.prompt(
      `  Select tier [1-${allTiers.length}] (default: ${allTiers.indexOf(defaultTier) + 1} ${defaultTier.name}): `,
    );
    const idx =
      answer.trim() === "" ? allTiers.indexOf(defaultTier) : parseInt(answer.trim(), 10) - 1;
    const chosen = allTiers[idx] || defaultTier;
    console.log(`  Tier: ${chosen.label}`);
    return chosen.name;
  }

  let cursor = allTiers.indexOf(defaultTier);
  let selectedIdx = cursor;
  const n = allTiers.length;

  const G = deps.useColor ? "\x1b[32m" : "";
  const D = deps.useColor ? "\x1b[2m" : "";
  const R = deps.useColor ? "\x1b[0m" : "";
  const HINT = deps.useColor
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}select${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  select    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Policy tier — controls which network presets are enabled:"];
    allTiers.forEach((tier, index) => {
      const radio = index === selectedIdx ? RADIO_ON : RADIO_OFF;
      const arrow = index === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${radio} ${tier.label}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(allTiers[selectedIdx]!.name);
      } else if (key === " ") {
        selectedIdx = cursor;
        redraw();
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Combined preset selector: shows ALL available presets, pre-checks those in
 * the chosen tier, and lets the user include/exclude any preset and toggle
 * per-preset access (read vs read-write).
 */
export async function selectTierPresetsAndAccess(
  tierName: string,
  allPresets: Array<{ name: string; description?: string }>,
  extraSelected: string[] = [],
  deps: PolicyUiDeps,
): Promise<Array<{ name: string; access: string }>> {
  const tierDef = deps.tiers.getTier(tierName);
  const tierPresetMap: Record<string, string> = {};
  if (tierDef) {
    for (const preset of tierDef.presets) {
      tierPresetMap[preset.name] = preset.access;
    }
  }

  const tierNames = tierDef ? tierDef.presets.map((preset) => preset.name) : [];
  const tierSet = new Set(tierNames);
  const ordered = [
    ...tierNames.map((name) => allPresets.find((preset) => preset.name === name)).filter(Boolean),
    ...allPresets.filter((preset) => !tierSet.has(preset.name)),
  ] as Array<{ name: string; description?: string }>;

  const included = new Set([
    ...tierNames,
    ...extraSelected.filter((name) => ordered.find((preset) => preset.name === name)),
  ]);

  const accessModes: Record<string, string> = {};
  for (const preset of ordered) {
    accessModes[preset.name] = tierPresetMap[preset.name] ?? "read-write";
  }

  const G = deps.useColor ? "\x1b[32m" : "";
  const O = deps.useColor ? "\x1b[38;5;208m" : "";
  const D = deps.useColor ? "\x1b[2m" : "";
  const R = deps.useColor ? "\x1b[0m" : "";
  const GREEN_CHECK = deps.useColor ? `[${G}✓${R}]` : "[✓]";
  const EMPTY_CHECK = deps.useColor ? `${D}[ ]${R}` : "[ ]";
  const TOGGLE_RW = deps.useColor ? `[${O}rw${R}]` : "[rw]";
  const TOGGLE_R = deps.useColor ? `${D}[ r]${R}` : "[ r]";

  const label = tierDef ? `  Presets  (${tierDef.label} defaults):` : "  Presets:";
  const n = ordered.length;

  if (deps.isNonInteractive()) {
    return ordered
      .filter((preset) => included.has(preset.name))
      .map((preset) => ({ name: preset.name, access: accessModes[preset.name]! }));
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log(label);
    ordered.forEach((preset) => {
      const isIncluded = included.has(preset.name);
      const isRw = accessModes[preset.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      const badge = isIncluded ? (isRw ? "[rw]" : "[ r]") : "    ";
      console.log(`    ${check} ${badge} ${preset.name}`);
    });
    console.log("");
    const rawInclude = await deps.prompt(
      "  Include presets (comma-separated names, Enter to keep defaults): ",
    );
    if (rawInclude.trim()) {
      const knownNames = new Set(ordered.map((preset) => preset.name));
      included.clear();
      for (const name of rawInclude
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (knownNames.has(name)) {
          included.add(name);
        } else {
          console.error(`  Unknown preset name ignored: ${name}`);
        }
      }
    }
    return ordered
      .filter((preset) => included.has(preset.name))
      .map((preset) => ({ name: preset.name, access: accessModes[preset.name]! }));
  }

  let cursor = 0;

  const HINT = deps.useColor
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}include${R}    ${G}r${R}  ${D}toggle rw${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  include    r  toggle rw    Enter  confirm";

  const renderLines = () => {
    const lines = [label];
    ordered.forEach((preset, index) => {
      const isIncluded = included.has(preset.name);
      const isRw = accessModes[preset.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      const badge = isIncluded ? (isRw ? `${TOGGLE_RW} ` : `${TOGGLE_R} `) : "     ";
      const arrow = index === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${badge}${preset.name}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(
          ordered
            .filter((preset) => included.has(preset.name))
            .map((preset) => ({ name: preset.name, access: accessModes[preset.name]! })),
        );
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const name = ordered[cursor]!.name;
        if (included.has(name)) {
          included.delete(name);
        } else {
          included.add(name);
        }
        redraw();
      } else if (key === "r" || key === "R") {
        const name = ordered[cursor]!.name;
        accessModes[name] = accessModes[name] === "read-write" ? "read" : "read-write";
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Raw-mode TUI preset selector.
 * Keys: ↑/↓ or k/j to move, Space to toggle, a to select/unselect all, Enter to confirm.
 * Falls back to a simple line-based prompt when stdin is not a TTY.
 */
export async function presetsCheckboxSelector(
  allPresets: Array<{ name: string; description: string }>,
  initialSelected: string[],
  deps: PolicyUiDeps,
): Promise<string[]> {
  const selected = new Set(initialSelected);
  const n = allPresets.length;

  if (n === 0) {
    console.log("  No policy presets are available.");
    return [];
  }

  const GREEN_CHECK = deps.useColor ? "[\x1b[32m✓\x1b[0m]" : "[✓]";

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((preset) => {
      const marker = selected.has(preset.name) ? GREEN_CHECK : "[ ]";
      console.log(`    ${marker} ${preset.name.padEnd(14)} — ${preset.description}`);
    });
    console.log("");
    const raw = await deps.prompt("  Select presets (comma-separated names, Enter to skip): ");
    if (!raw.trim()) {
      console.log("  Skipping policy presets.");
      return [];
    }
    const knownNames = new Set(allPresets.map((preset) => preset.name));
    const chosen: string[] = [];
    for (const name of raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (knownNames.has(name)) {
        chosen.push(name);
      } else {
        console.error(`  Unknown preset name ignored: ${name}`);
      }
    }
    return chosen;
  }

  let cursor = 0;

  const G = deps.useColor ? "\x1b[32m" : "";
  const D = deps.useColor ? "\x1b[2m" : "";
  const R = deps.useColor ? "\x1b[0m" : "";
  const HINT = deps.useColor
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}toggle${R}    ${G}a${R}  ${D}all/none${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  toggle    a  all/none    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Available policy presets:"];
    allPresets.forEach((preset, index) => {
      const check = selected.has(preset.name) ? GREEN_CHECK : "[ ]";
      const arrow = index === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${preset.name.padEnd(14)} — ${preset.description}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve([...selected]);
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const name = allPresets[cursor]!.name;
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        redraw();
      } else if (key === "a") {
        if (selected.size === n) selected.clear();
        else for (const preset of allPresets) selected.add(preset.name);
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

// eslint-disable-next-line complexity
export async function setupPoliciesWithSelection(
  sandboxName: string,
  options: SetupPoliciesWithSelectionOptions = {},
  deps: PolicyUiDeps,
): Promise<string[]> {
  const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
  const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;
  const webSearchConfig = options.webSearchConfig || null;
  const provider = options.provider || null;

  deps.step(8, 8, "Policy presets");

  const allPresets = deps.policies.listPresets();
  const applied = deps.policies.getAppliedPresets(sandboxName);
  let chosen = selectedPresets;

  if (chosen && chosen.length > 0) {
    if (onSelection) onSelection(chosen);
    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    deps.note(`  [resume] Reapplying policy presets: ${chosen.join(", ")}`);
    for (const name of chosen) {
      if (applied.includes(name)) continue;
      deps.policies.applyPreset(sandboxName, name);
    }
    return chosen;
  }

  const tierName = await selectPolicyTier(deps);
  deps.updateSandbox(sandboxName, { policyTier: tierName });
  const suggestions = deps.tiers.resolveTierPresets(tierName).map((preset) => preset.name);
  if (webSearchConfig && !suggestions.includes("brave")) suggestions.push("brave");
  if (
    provider &&
    deps.localInferenceProviders.includes(provider) &&
    !suggestions.includes("local-inference")
  ) {
    suggestions.push("local-inference");
  }

  if (deps.isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    chosen = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      deps.note("  [non-interactive] Skipping policy presets.");
      return [];
    }

    if (policyMode === "custom" || policyMode === "list") {
      chosen = deps.parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (chosen.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = deps.parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (envPresets.length > 0) chosen = envPresets;
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((preset) => preset.name));
    const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (onSelection) onSelection(chosen);
    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    deps.note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
    for (const name of chosen) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          deps.policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          deps.sleep(2);
        }
      }
    }
    return chosen;
  }

  const knownNames = new Set(allPresets.map((preset) => preset.name));
  const extraSelected = [
    ...applied.filter((name) => knownNames.has(name)),
    ...suggestions.filter((name) => knownNames.has(name) && !applied.includes(name)),
  ];
  const resolvedPresets = await selectTierPresetsAndAccess(
    tierName,
    allPresets,
    extraSelected,
    deps,
  );
  const interactiveChoice = resolvedPresets.map((preset) => preset.name);

  if (onSelection) onSelection(interactiveChoice);
  if (!deps.waitForSandboxReady(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
    process.exit(1);
  }

  const accessByName: Record<string, string> = {};
  for (const preset of resolvedPresets) accessByName[preset.name] = preset.access;
  const newlySelected = interactiveChoice.filter((name) => !applied.includes(name));
  const deselected = applied.filter((name) => !interactiveChoice.includes(name));

  for (const name of deselected) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!deps.policies.removePreset(sandboxName, name)) {
          throw new Error(`Failed to remove preset '${name}'.`);
        }
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        deps.sleep(2);
      }
    }
  }

  for (const name of newlySelected) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        deps.policies.applyPreset(sandboxName, name, { access: accessByName[name] });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        deps.sleep(2);
      }
    }
  }
  return interactiveChoice;
}
