// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export async function runOnboardPreflight(deps: any): Promise<any> {
  deps.step(1, 8, "Preflight checks");

  const host = deps.assessHost();

  // Docker / runtime
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    deps.printRemediationActions(deps.planHostRemediation(host));
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  if (host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${host.runtime}`);
  }
  // Podman is now supported — no unsupported runtime warning needed.
  if (host.notes.includes("Running under WSL")) {
    console.log("  ⓘ Running under WSL");
  }

  // OpenShell CLI — install if missing, upgrade if below minimum version.
  // MIN_VERSION in install-openshell.sh handles the version gate; calling it
  // when openshell already exists is safe (it exits early if version is OK).
  let openshellInstall: {
    installed?: boolean;
    localBin: string | null;
    futureShellPathHint: string | null;
  } = { localBin: null, futureShellPathHint: null };
  if (!deps.isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = deps.installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  } else {
    const currentVersion = deps.getInstalledOpenshellVersion();
    if (!currentVersion) {
      console.log("  openshell version could not be determined. Reinstalling...");
      openshellInstall = deps.installOpenshell();
      if (!openshellInstall.installed) {
        console.error("  Failed to reinstall openshell CLI.");
        console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
        process.exit(1);
      }
    } else {
      const parts = currentVersion.split(".").map(Number);
      const minParts = [0, 0, 24]; // must match MIN_VERSION in scripts/install-openshell.sh
      const needsUpgrade =
        parts[0] < minParts[0] ||
        (parts[0] === minParts[0] && parts[1] < minParts[1]) ||
        (parts[0] === minParts[0] && parts[1] === minParts[1] && parts[2] < minParts[2]);
      if (needsUpgrade) {
        console.log(
          `  openshell ${currentVersion} is below minimum required version. Upgrading...`,
        );
        openshellInstall = deps.installOpenshell();
        if (!openshellInstall.installed) {
          console.error("  Failed to upgrade openshell CLI.");
          console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
          process.exit(1);
        }
      }
    }
  }
  const openshellVersionOutput = deps.runCaptureOpenshell(["--version"], { ignoreError: true });
  console.log(`  ✓ openshell CLI: ${openshellVersionOutput || "unknown"}`);
  const installedOpenshellVersion = deps.getInstalledOpenshellVersion(openshellVersionOutput);
  const minOpenshellVersion = deps.getBlueprintMinOpenshellVersion();
  if (
    installedOpenshellVersion &&
    minOpenshellVersion &&
    !deps.versionGte(installedOpenshellVersion, minOpenshellVersion)
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
  const maxOpenshellVersion = deps.getBlueprintMaxOpenshellVersion();
  if (
    installedOpenshellVersion &&
    maxOpenshellVersion &&
    !deps.versionGte(maxOpenshellVersion, installedOpenshellVersion)
  ) {
    console.error("");
    console.error(
      `  ✗ openshell ${installedOpenshellVersion} is above the maximum supported by this NemoClaw release.`,
    );
    console.error(`    blueprint.yaml max_openshell_version: ${maxOpenshellVersion}`);
    console.error("");
    console.error("    Upgrade NemoClaw to a version that supports your OpenShell release,");
    console.error("    or install a supported OpenShell version:");
    console.error("      https://github.com/NVIDIA/OpenShell/releases");
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

  const gatewayStatus = deps.runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName], {
    ignoreError: true,
  });
  const activeGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], {
    ignoreError: true,
  });
  let gatewayReuseState = deps.getGatewayReuseState(gatewayStatus, gwInfo, activeGatewayInfo);

  if (gatewayReuseState === "healthy") {
    const containerState = deps.verifyGatewayContainerRunning();
    if (containerState === "missing") {
      console.log("  Gateway metadata is stale (container not running). Cleaning up...");
      deps.runOpenshell(["forward", "stop", String(deps.dashboardPort)], { ignoreError: true });
      deps.destroyGateway();
      deps.clearRegistryAll();
      gatewayReuseState = "missing";
      console.log("  ✓ Stale gateway metadata cleaned up");
    } else if (containerState === "unknown") {
      console.log(
        "  Warning: could not verify gateway container state (Docker may be unavailable). Proceeding with cached health status.",
      );
    }
  }

  if (gatewayReuseState === "stale" || gatewayReuseState === "active-unnamed") {
    console.log("  Cleaning up previous NemoClaw session...");
    deps.runOpenshell(["forward", "stop", String(deps.dashboardPort)], { ignoreError: true });
    const destroyResult = deps.runOpenshell(["gateway", "destroy", "-g", deps.gatewayName], {
      ignoreError: true,
    });
    if (destroyResult.status === 0) {
      deps.clearRegistryAll();
    }
    console.log("  ✓ Previous session cleaned up");
  }

  if (gatewayReuseState === "missing") {
    const containerName = `openshell-cluster-${deps.gatewayName}`;
    const inspectResult = deps.run(
      `docker inspect --type container --format '{{.State.Status}}' ${containerName} 2>/dev/null`,
      { ignoreError: true, suppressOutput: true },
    );
    if (inspectResult.status === 0) {
      console.log("  Cleaning up orphaned gateway container...");
      deps.run(`docker stop ${containerName} >/dev/null 2>&1`, {
        ignoreError: true,
        suppressOutput: true,
      });
      deps.run(`docker rm ${containerName} >/dev/null 2>&1`, {
        ignoreError: true,
        suppressOutput: true,
      });
      const postInspectResult = deps.run(
        `docker inspect --type container ${containerName} 2>/dev/null`,
        {
          ignoreError: true,
          suppressOutput: true,
        },
      );
      if (postInspectResult.status !== 0) {
        deps.run(
          `docker volume ls -q --filter "name=openshell-cluster-${deps.gatewayName}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${deps.gatewayName}" | xargs docker volume rm 2>/dev/null || true`,
          { ignoreError: true, suppressOutput: true },
        );
        deps.clearRegistryAll();
        console.log("  ✓ Orphaned gateway container removed");
      } else {
        console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
      }
    }
  }

  const requiredPorts = [
    { port: deps.gatewayPort, label: "OpenShell gateway" },
    { port: deps.dashboardPort, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    let portCheck = await deps.checkPortAvailable(port);
    if (!portCheck.ok) {
      if (
        (port === deps.gatewayPort || port === deps.dashboardPort) &&
        gatewayReuseState === "healthy"
      ) {
        console.log(`  ✓ Port ${port} already owned by healthy NemoClaw runtime (${label})`);
        continue;
      }
      if (port === deps.dashboardPort && portCheck.process === "ssh" && portCheck.pid) {
        const cmdline = deps.runCapture(
          `ps -p ${portCheck.pid} -o args= 2>/dev/null`,
          { ignoreError: true },
        ).trim();
        if (cmdline.includes("openshell")) {
          console.log(
            `  Cleaning up orphaned SSH port-forward on port ${port} (PID ${portCheck.pid})...`,
          );
          deps.run(`kill ${portCheck.pid} 2>/dev/null || true`, { ignoreError: true });
          deps.sleep(1);
          portCheck = await deps.checkPortAvailable(port);
          if (portCheck.ok) {
            console.log(`  ✓ Port ${port} available after orphaned forward cleanup (${label})`);
            continue;
          }
        }
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
        for (const hint of deps.getPortConflictServiceHints()) {
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

  const gpu = deps.nimDetectGpu();
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

  if ((deps.processPlatform ?? process.platform) === "linux") {
    const mem = deps.getMemoryInfo();
    if (mem) {
      if (mem.totalMB < 12000) {
        console.log(
          `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
        );

        let proceedWithSwap = false;
        if (!deps.isNonInteractive()) {
          const answer = await deps.prompt(
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
          const swapResult = deps.ensureSwap(12000);
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
