// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardPolicyHelpers(deps) {
  const {
    USE_COLOR,
    getCredential,
    isNonInteractive,
    note,
    parsePolicyPresetEnv,
    policies,
    prompt,
    sleep,
    step,
    waitForSandboxReady,
  } = deps;

  function getSuggestedPolicyPresets({ enabledChannels = null, webSearchConfig = null } = {}) {
    const suggestions = ["pypi", "npm"];
    const usesExplicitMessagingSelection = Array.isArray(enabledChannels);

    const maybeSuggestMessagingPreset = (channel, envKey) => {
      if (usesExplicitMessagingSelection) {
        if (enabledChannels.includes(channel)) suggestions.push(channel);
        return;
      }
      if (getCredential(envKey) || process.env[envKey]) {
        suggestions.push(channel);
        if (process.stdout.isTTY && !isNonInteractive() && process.env.CI !== "true") {
          console.log(`  Auto-detected: ${envKey} -> suggesting ${channel} preset`);
        }
      }
    };

    maybeSuggestMessagingPreset("telegram", "TELEGRAM_BOT_TOKEN");
    maybeSuggestMessagingPreset("slack", "SLACK_BOT_TOKEN");
    maybeSuggestMessagingPreset("discord", "DISCORD_BOT_TOKEN");

    if (webSearchConfig) suggestions.push("brave");

    return suggestions;
  }

  // eslint-disable-next-line complexity
  async function _setupPolicies(sandboxName, options = {}) {
    step(8, 8, "Policy presets");
    const suggestions = getSuggestedPolicyPresets(options);

    const allPresets = policies.listPresets();
    const applied = policies.getAppliedPresets(sandboxName);

    if (isNonInteractive()) {
      const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
      let selectedPresets = suggestions;

      if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
        note("  [non-interactive] Skipping policy presets.");
        return;
      }

      if (policyMode === "custom" || policyMode === "list") {
        selectedPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
        if (selectedPresets.length === 0) {
          console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
          process.exit(1);
        }
      } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
        const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
        if (envPresets.length > 0) {
          selectedPresets = envPresets;
        }
      } else {
        console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
        console.error("  Valid values: suggested, custom, skip");
        process.exit(1);
      }

      const knownPresets = new Set(allPresets.map((p) => p.name));
      const invalidPresets = selectedPresets.filter((name) => !knownPresets.has(name));
      if (invalidPresets.length > 0) {
        console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
        process.exit(1);
      }

      if (!waitForSandboxReady(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
        process.exit(1);
      }
      note(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
      for (const name of selectedPresets) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            policies.applyPreset(sandboxName, name);
            break;
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (message.includes("Unimplemented")) {
              console.error("  OpenShell policy updates are not supported by this gateway build.");
              console.error("  This is a known issue tracked in NemoClaw #536.");
              throw err;
            }
            if (!message.includes("sandbox not found") || attempt === 2) {
              throw err;
            }
            sleep(2);
          }
        }
      }
    } else {
      console.log("");
      console.log("  Available policy presets:");
      allPresets.forEach((p) => {
        const marker = applied.includes(p.name) || suggestions.includes(p.name) ? "●" : "○";
        const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
        console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
      });
      console.log("");

      const answer = await prompt(
        `  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `,
      );

      if (answer.toLowerCase() === "n") {
        console.log("  Skipping policy presets.");
        return;
      }

      if (!waitForSandboxReady(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
        process.exit(1);
      }

      if (answer.toLowerCase() === "list") {
        const picks = await prompt("  Enter preset names (comma-separated): ");
        const selected = picks
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const name of selected) {
          try {
            policies.applyPreset(sandboxName, name);
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (message.includes("Unimplemented")) {
              console.error("  OpenShell policy updates are not supported by this gateway build.");
              console.error("  This is a known issue tracked in NemoClaw #536.");
            }
            throw err;
          }
        }
      } else {
        for (const name of suggestions) {
          try {
            policies.applyPreset(sandboxName, name);
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (message.includes("Unimplemented")) {
              console.error("  OpenShell policy updates are not supported by this gateway build.");
              console.error("  This is a known issue tracked in NemoClaw #536.");
            }
            throw err;
          }
        }
      }
    }

    console.log("  ✓ Policies applied");
  }

  function arePolicyPresetsApplied(sandboxName, selectedPresets = []) {
    if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
    const applied = new Set(policies.getAppliedPresets(sandboxName));
    return selectedPresets.every((preset) => applied.has(preset));
  }

  /**
   * Raw-mode TUI preset selector.
   * Keys: ↑/↓ or k/j to move, Space to toggle, a to select/unselect all, Enter to confirm.
   * Falls back to a simple line-based prompt when stdin is not a TTY.
   */
  async function presetsCheckboxSelector(allPresets, initialSelected) {
    const selected = new Set(initialSelected);
    const n = allPresets.length;

    if (n === 0) {
      console.log("  No policy presets are available.");
      return [];
    }

    const GREEN_CHECK = USE_COLOR ? "[\x1b[32m✓\x1b[0m]" : "[✓]";

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log("");
      console.log("  Available policy presets:");
      allPresets.forEach((p) => {
        const marker = selected.has(p.name) ? GREEN_CHECK : "[ ]";
        console.log(`    ${marker} ${p.name.padEnd(14)} — ${p.description}`);
      });
      console.log("");
      const raw = await prompt("  Select presets (comma-separated names, Enter to skip): ");
      if (!raw.trim()) {
        console.log("  Skipping policy presets.");
        return [];
      }
      const knownNames = new Set(allPresets.map((p) => p.name));
      const chosen = [];
      for (const name of raw
        .split(",")
        .map((s) => s.trim())
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

    const HINT = "  ↑/↓ j/k  move    Space  toggle    a  all/none    Enter  confirm";

    const renderLines = () => {
      const lines = ["  Available policy presets:"];
      allPresets.forEach((p, i) => {
        const check = selected.has(p.name) ? GREEN_CHECK : "[ ]";
        const arrow = i === cursor ? ">" : " ";
        lines.push(`   ${arrow} ${check} ${p.name.padEnd(14)} — ${p.description}`);
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

      const onData = (key) => {
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
          const name = allPresets[cursor].name;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          redraw();
        } else if (key === "a") {
          if (selected.size === n) selected.clear();
          else for (const p of allPresets) selected.add(p.name);
          redraw();
        }
      };

      process.stdin.on("data", onData);
    });
  }

  // eslint-disable-next-line complexity
  async function setupPoliciesWithSelection(sandboxName, options = {}) {
    const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
    const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;
    const webSearchConfig = options.webSearchConfig || null;
    const enabledChannels = Array.isArray(options.enabledChannels) ? options.enabledChannels : null;

    step(8, 8, "Policy presets");

    const suggestions = getSuggestedPolicyPresets({ enabledChannels, webSearchConfig });

    const allPresets = policies.listPresets();
    const applied = policies.getAppliedPresets(sandboxName);
    let chosen = selectedPresets;

    if (chosen && chosen.length > 0) {
      if (onSelection) onSelection(chosen);
      if (!waitForSandboxReady(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
        process.exit(1);
      }
      note(`  [resume] Reapplying policy presets: ${chosen.join(", ")}`);
      for (const name of chosen) {
        if (applied.includes(name)) continue;
        policies.applyPreset(sandboxName, name);
      }
      return chosen;
    }

    if (isNonInteractive()) {
      const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
      chosen = suggestions;

      if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
        note("  [non-interactive] Skipping policy presets.");
        return [];
      }

      if (policyMode === "custom" || policyMode === "list") {
        chosen = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
        if (chosen.length === 0) {
          console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
          process.exit(1);
        }
      } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
        const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
        if (envPresets.length > 0) chosen = envPresets;
      } else {
        console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
        console.error("  Valid values: suggested, custom, skip");
        process.exit(1);
      }

      const knownPresets = new Set(allPresets.map((p) => p.name));
      const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
      if (invalidPresets.length > 0) {
        console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
        process.exit(1);
      }

      if (onSelection) onSelection(chosen);
      if (!waitForSandboxReady(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
        process.exit(1);
      }
      note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
      for (const name of chosen) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            policies.applyPreset(sandboxName, name);
            break;
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (message.includes("Unimplemented")) {
              console.error("  OpenShell policy updates are not supported by this gateway build.");
              console.error("  This is a known issue tracked in NemoClaw #536.");
              throw err;
            }
            if (!message.includes("sandbox not found") || attempt === 2) {
              throw err;
            }
            sleep(2);
          }
        }
      }
      return chosen;
    }

    const knownNames = new Set(allPresets.map((p) => p.name));
    const initialSelected = [
      ...applied.filter((name) => knownNames.has(name)),
      ...suggestions.filter((name) => knownNames.has(name) && !applied.includes(name)),
    ];
    const interactiveChoice = await presetsCheckboxSelector(allPresets, initialSelected);

    if (onSelection) onSelection(interactiveChoice);
    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }

    const newlySelected = interactiveChoice.filter((name) => !applied.includes(name));
    for (const name of newlySelected) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
            throw err;
          }
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
    return interactiveChoice;
  }

  return {
    _setupPolicies,
    arePolicyPresetsApplied,
    getSuggestedPolicyPresets,
    presetsCheckboxSelector,
    setupPoliciesWithSelection,
  };
}
