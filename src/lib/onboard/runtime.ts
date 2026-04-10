// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function createOnboardRuntimeHelpers(deps) {
  const {
    GATEWAY_NAME,
    OPENCLAW_LAUNCH_AGENT_PLIST,
    ROOT,
    SCRIPTS,
    assessHost,
    checkPortAvailable,
    ensureSwap,
    getGatewayReuseState,
    getMemoryInfo,
    getOpenshellBin,
    inferContainerRuntime,
    isNonInteractive,
    nim,
    planHostRemediation,
    prompt,
    registry,
    resolveOpenshell,
    run,
    runCapture,
    setOpenshellBin,
    shellQuote,
    step,
  } = deps;

  function getInstalledOpenshellVersion(versionOutput = null) {
    const output = String(
      versionOutput ?? runCapture("openshell -V", { ignoreError: true }),
    ).trim();
    const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
    if (!match) return null;
    return match[1];
  }

  function versionGte(left = "0.0.0", right = "0.0.0") {
    const lhs = String(left)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    const rhs = String(right)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(lhs.length, rhs.length);
    for (let index = 0; index < length; index += 1) {
      const a = lhs[index] || 0;
      const b = rhs[index] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  }

  function getBlueprintMinOpenshellVersion(rootDir = ROOT) {
    try {
      const YAML = require("yaml");
      const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
      if (!fs.existsSync(blueprintPath)) return null;
      const raw = fs.readFileSync(blueprintPath, "utf8");
      const parsed = YAML.parse(raw);
      const value = parsed && parsed.min_openshell_version;
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  function getStableGatewayImageRef(versionOutput = null) {
    const version = getInstalledOpenshellVersion(versionOutput);
    if (!version) return null;
    return `ghcr.io/nvidia/openshell/cluster:${version}`;
  }

  function getOpenshellBinary() {
    const current = getOpenshellBin();
    if (current) return current;
    const resolved = resolveOpenshell();
    if (!resolved) {
      console.error("  openshell CLI not found.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
    setOpenshellBin(resolved);
    return resolved;
  }

  function openshellShellCommand(args) {
    return [shellQuote(getOpenshellBinary()), ...args.map((arg) => shellQuote(arg))].join(" ");
  }

  function runOpenshell(args, opts = {}) {
    return run(openshellShellCommand(args), opts);
  }

  function runCaptureOpenshell(args, opts = {}) {
    return runCapture(openshellShellCommand(args), opts);
  }

  function getContainerRuntime() {
    const info = runCapture("docker info 2>/dev/null", { ignoreError: true });
    return inferContainerRuntime(info);
  }

  function printRemediationActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
      return;
    }

    console.error("");
    console.error("  Suggested fix:");
    console.error("");
    for (const action of actions) {
      console.error(`  - ${action.title}: ${action.reason}`);
      for (const command of action.commands || []) {
        console.error(`    ${command}`);
      }
    }
  }

  function isOpenshellInstalled() {
    return resolveOpenshell() !== null;
  }

  function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
    if (String(pathValue).split(path.delimiter).includes(binDir)) {
      return null;
    }
    return `export PATH="${binDir}:$PATH"`;
  }

  function getPortConflictServiceHints(platform = process.platform) {
    if (platform === "darwin") {
      return [
        "       # or, if it's a launchctl service (macOS):",
        "       launchctl list | grep -i claw   # columns: PID | ExitStatus | Label",
        `       launchctl unload ${OPENCLAW_LAUNCH_AGENT_PLIST}`,
        "       # or: launchctl bootout gui/$(id -u)/ai.openclaw.gateway",
      ];
    }
    return [
      "       # or, if it's a systemd service:",
      "       systemctl --user stop openclaw-gateway.service",
    ];
  }

  function installOpenshell() {
    const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 300_000,
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
      if (output) {
        console.error(output);
      }
      return { installed: false, localBin: null, futureShellPathHint: null };
    }
    const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
    const openshellPath = path.join(localBin, "openshell");
    const futureShellPathHint = fs.existsSync(openshellPath)
      ? getFutureShellPathHint(localBin, process.env.PATH)
      : null;
    if (fs.existsSync(openshellPath) && futureShellPathHint) {
      process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
    }
    setOpenshellBin(resolveOpenshell());
    return {
      installed: getOpenshellBin() !== null,
      localBin,
      futureShellPathHint,
    };
  }

  function sleep(seconds) {
    spawnSync("sleep", [String(seconds)]);
  }

  async function preflight() {
    step(1, 8, "Preflight checks");

    const host = assessHost();

    if (!host.dockerReachable) {
      console.error("  Docker is not reachable. Please fix Docker and try again.");
      printRemediationActions(planHostRemediation(host));
      process.exit(1);
    }
    console.log("  ✓ Docker is running");

    if (host.runtime !== "unknown") {
      console.log(`  ✓ Container runtime: ${host.runtime}`);
    }
    if (host.notes.includes("Running under WSL")) {
      console.log("  ⓘ Running under WSL");
    }

    let openshellInstall = { localBin: null, futureShellPathHint: null };
    if (!isOpenshellInstalled()) {
      console.log("  openshell CLI not found. Installing...");
      openshellInstall = installOpenshell();
      if (!openshellInstall.installed) {
        console.error("  Failed to install openshell CLI.");
        console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
        process.exit(1);
      }
    } else {
      const currentVersion = getInstalledOpenshellVersion();
      if (!currentVersion) {
        console.log("  openshell version could not be determined. Reinstalling...");
        openshellInstall = installOpenshell();
        if (!openshellInstall.installed) {
          console.error("  Failed to reinstall openshell CLI.");
          console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
          process.exit(1);
        }
      } else {
        const parts = currentVersion.split(".").map(Number);
        const minParts = [0, 0, 24];
        const needsUpgrade =
          parts[0] < minParts[0] ||
          (parts[0] === minParts[0] && parts[1] < minParts[1]) ||
          (parts[0] === minParts[0] && parts[1] === minParts[1] && parts[2] < minParts[2]);
        if (needsUpgrade) {
          console.log(
            `  openshell ${currentVersion} is below minimum required version. Upgrading...`,
          );
          openshellInstall = installOpenshell();
          if (!openshellInstall.installed) {
            console.error("  Failed to upgrade openshell CLI.");
            console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
            process.exit(1);
          }
        }
      }
    }

    const openshellVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
    console.log(`  ✓ openshell CLI: ${openshellVersionOutput || "unknown"}`);
    const installedOpenshellVersion = getInstalledOpenshellVersion(openshellVersionOutput);
    const minOpenshellVersion = getBlueprintMinOpenshellVersion();
    if (
      installedOpenshellVersion &&
      minOpenshellVersion &&
      !versionGte(installedOpenshellVersion, minOpenshellVersion)
    ) {
      console.error("");
      console.error(
        `  ✗ openshell ${installedOpenshellVersion} is below the minimum required by this NemoClaw release.`,
      );
      console.error(`    blueprint.yaml min_openshell_version: ${minOpenshellVersion}`);
      console.error("");
      console.error("    Upgrade openshell and retry:");
      console.error("      https://github.com/NVIDIA/OpenShell/releases");
      console.error(
        "    Or remove the existing binary so the installer can re-fetch a current build:",
      );
      console.error('      command -v openshell && rm -f "$(command -v openshell)"');
      console.error("");
      process.exit(1);
    }
    if (openshellInstall.futureShellPathHint) {
      console.log(
        `  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`,
      );
      console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
      console.log(
        "  Add that export to your shell profile, or open a new terminal before running openshell directly.",
      );
    }

    const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
    const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    const gatewayReuseState = getGatewayReuseState(gatewayStatus, gwInfo, activeGatewayInfo);
    if (gatewayReuseState === "stale" || gatewayReuseState === "active-unnamed") {
      console.log("  Cleaning up previous NemoClaw session...");
      runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
      const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
        ignoreError: true,
      });
      if (destroyResult.status === 0) {
        registry.clearAll();
      }
      console.log("  ✓ Previous session cleaned up");
    }

    if (gatewayReuseState === "missing") {
      const containerName = `openshell-cluster-${GATEWAY_NAME}`;
      const inspectResult = run(
        `docker inspect --type container --format '{{.State.Status}}' ${containerName} 2>/dev/null`,
        { ignoreError: true, suppressOutput: true },
      );
      if (inspectResult.status === 0) {
        console.log("  Cleaning up orphaned gateway container...");
        run(`docker stop ${containerName} >/dev/null 2>&1`, {
          ignoreError: true,
          suppressOutput: true,
        });
        run(`docker rm ${containerName} >/dev/null 2>&1`, {
          ignoreError: true,
          suppressOutput: true,
        });
        const postInspectResult = run(
          `docker inspect --type container ${containerName} 2>/dev/null`,
          {
            ignoreError: true,
            suppressOutput: true,
          },
        );
        if (postInspectResult.status !== 0) {
          run(
            `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm 2>/dev/null || true`,
            { ignoreError: true, suppressOutput: true },
          );
          registry.clearAll();
          console.log("  ✓ Orphaned gateway container removed");
        } else {
          console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
        }
      }
    }

    const requiredPorts = [
      { port: 8080, label: "OpenShell gateway" },
      { port: 18789, label: "NemoClaw dashboard" },
    ];
    for (const { port, label } of requiredPorts) {
      const portCheck = await checkPortAvailable(port);
      if (!portCheck.ok) {
        if ((port === 8080 || port === 18789) && gatewayReuseState === "healthy") {
          console.log(`  ✓ Port ${port} already owned by healthy NemoClaw runtime (${label})`);
          continue;
        }
        console.error("");
        console.error(`  !! Port ${port} is not available.`);
        console.error(`     ${label} needs this port.`);
        console.error("");
        if (portCheck.process && portCheck.process !== "unknown") {
          console.error(
            `     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`,
          );
          console.error("");
          console.error("     To fix, stop the conflicting process:");
          console.error("");
          if (portCheck.pid) {
            console.error(`       sudo kill ${portCheck.pid}`);
          } else {
            console.error(`       sudo lsof -i :${port} -sTCP:LISTEN -P -n`);
          }
          for (const hint of getPortConflictServiceHints()) {
            console.error(hint);
          }
        } else {
          console.error(`     Could not identify the process using port ${port}.`);
          console.error(`     Run: sudo lsof -i :${port} -sTCP:LISTEN`);
        }
        console.error("");
        console.error(`     Detail: ${portCheck.reason}`);
        process.exit(1);
      }
      console.log(`  ✓ Port ${port} available (${label})`);
    }

    const gpu = nim.detectGpu();
    if (gpu && gpu.type === "nvidia") {
      console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
      if (!gpu.nimCapable) {
        console.log("  ⓘ GPU VRAM too small for local NIM — will use cloud inference");
      }
    } else if (gpu && gpu.type === "apple") {
      console.log(
        `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
      );
      console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
    } else {
      console.log("  ⓘ No GPU detected — will use cloud inference");
    }

    if (process.platform === "linux") {
      const mem = getMemoryInfo();
      if (mem) {
        if (mem.totalMB < 12000) {
          console.log(
            `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
          );

          let proceedWithSwap = false;
          if (!isNonInteractive()) {
            const answer = await prompt(
              "  Create a 4 GB swap file to prevent OOM during sandbox build? (requires sudo) [y/N]: ",
            );
            proceedWithSwap = answer && answer.toLowerCase().startsWith("y");
          }

          if (!proceedWithSwap) {
            console.log(
              "  ⓘ Skipping swap creation. Sandbox build may fail with OOM on this system.",
            );
          } else {
            console.log("  Creating 4 GB swap file to prevent OOM during sandbox build...");
            const swapResult = ensureSwap(12000);
            if (swapResult.ok && swapResult.swapCreated) {
              console.log("  ✓ Swap file created and activated");
            } else if (swapResult.ok) {
              if (swapResult.reason) {
                console.log(`  ⓘ ${swapResult.reason} — existing swap should help prevent OOM`);
              } else {
                console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
              }
            } else {
              console.log(`  ⚠ Could not create swap: ${swapResult.reason}`);
              console.log("  Sandbox creation may fail with OOM on low-memory systems.");
            }
          }
        } else {
          console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
        }
      }
    }

    return gpu;
  }

  return {
    getBlueprintMinOpenshellVersion,
    getContainerRuntime,
    getFutureShellPathHint,
    getInstalledOpenshellVersion,
    getOpenshellBinary,
    getPortConflictServiceHints,
    getStableGatewayImageRef,
    installOpenshell,
    isOpenshellInstalled,
    openshellShellCommand,
    preflight,
    printRemediationActions,
    runCaptureOpenshell,
    runOpenshell,
    sleep,
    versionGte,
  };
}
