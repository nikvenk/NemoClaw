// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function createOnboardFlowHelpers(deps) {
  const {
    GATEWAY_NAME,
    agentOnboard,
    arePolicyPresetsApplied,
    buildSandboxConfigSyncScript,
    cleanupTempDir,
    configureWebSearch,
    createSandbox,
    ensureUsageNoticeConsent,
    ensureValidatedBraveSearchCredential,
    getGatewayReuseState,
    getOpenshellBinary,
    getResumeConfigConflicts,
    getSandboxReuseState,
    hydrateCredentialEnv,
    isInferenceRouteReady,
    isNonInteractive,
    isOpenclawReady,
    note,
    onboardSession,
    openshellShellCommand,
    preflight,
    printDashboard,
    registry,
    repairRecordedSandbox,
    runCaptureOpenshell,
    setNonInteractiveFlag,
    setRecreateSandboxFlag,
    setupInference,
    setupMessagingChannels,
    setupNim,
    setupOpenclaw,
    setupPoliciesWithSelection,
    skippedStepMessage,
    startGateway,
    startRecordedStep,
    step,
    writeSandboxConfigSyncFile,
  } = deps;

  async function onboard(opts = {}) {
    setNonInteractiveFlag(opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1");
    setRecreateSandboxFlag(opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1");
    const dangerouslySkipPermissions =
      opts.dangerouslySkipPermissions || process.env.NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS === "1";
    if (dangerouslySkipPermissions) {
      console.error("");
      console.error("  ⚠  --dangerously-skip-permissions: sandbox security restrictions disabled.");
      console.error("     Network:    all known endpoints open (no method/path filtering)");
      console.error("     Filesystem: sandbox home directory is writable");
      console.error("     Use for development/testing only.");
      console.error("");
    }
    delete process.env.OPENSHELL_GATEWAY;
    const resume = opts.resume === true;
    const requestedFromDockerfile =
      opts.fromDockerfile ||
      (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
    const noticeAccepted = await ensureUsageNoticeConsent({
      nonInteractive: isNonInteractive(),
      acceptedByFlag: opts.acceptThirdPartySoftware === true,
      writeLine: console.error,
    });
    if (!noticeAccepted) {
      process.exit(1);
    }
    const lockResult = onboardSession.acquireOnboardLock(
      `nemoclaw onboard${resume ? " --resume" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
    );
    if (!lockResult.acquired) {
      console.error("  Another NemoClaw onboarding run is already in progress.");
      if (lockResult.holderPid) {
        console.error(`  Lock holder PID: ${lockResult.holderPid}`);
      }
      if (lockResult.holderStartedAt) {
        console.error(`  Started: ${lockResult.holderStartedAt}`);
      }
      console.error(
        "  Wait for it to finish, or remove the stale lock if the previous run crashed:",
      );
      console.error(`    rm -f "${lockResult.lockFile}"`);
      process.exit(1);
    }

    let lockReleased = false;
    const releaseOnboardLock = () => {
      if (lockReleased) return;
      lockReleased = true;
      onboardSession.releaseOnboardLock();
    };
    process.once("exit", releaseOnboardLock);

    try {
      let session;
      let selectedMessagingChannels = [];
      let fromDockerfile;
      if (resume) {
        session = onboardSession.loadSession();
        if (!session || session.resumable === false) {
          console.error("  No resumable onboarding session was found.");
          console.error("  Run: nemoclaw onboard");
          process.exit(1);
        }
        const sessionFrom = session?.metadata?.fromDockerfile || null;
        fromDockerfile = requestedFromDockerfile
          ? path.resolve(requestedFromDockerfile)
          : sessionFrom
            ? path.resolve(sessionFrom)
            : null;
        const resumeConflicts = getResumeConfigConflicts(session, {
          nonInteractive: isNonInteractive(),
          fromDockerfile: requestedFromDockerfile,
          agent: opts.agent || null,
        });
        if (resumeConflicts.length > 0) {
          for (const conflict of resumeConflicts) {
            if (conflict.field === "sandbox") {
              console.error(
                `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            } else if (conflict.field === "agent") {
              console.error(
                `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            } else if (conflict.field === "fromDockerfile") {
              if (!conflict.recorded) {
                console.error(
                  `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
                );
              } else if (!conflict.requested) {
                console.error(
                  `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
                );
              } else {
                console.error(
                  `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
                );
              }
            } else {
              console.error(
                `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            }
          }
          console.error("  Run: nemoclaw onboard              # start a fresh onboarding session");
          console.error("  Or rerun with the original settings to continue that session.");
          process.exit(1);
        }
        onboardSession.updateSession((current) => {
          current.mode = isNonInteractive() ? "non-interactive" : "interactive";
          current.failure = null;
          current.status = "in_progress";
          return current;
        });
        session = onboardSession.loadSession();
      } else {
        fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
        session = onboardSession.saveSession(
          onboardSession.createSession({
            mode: isNonInteractive() ? "non-interactive" : "interactive",
            metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
          }),
        );
      }

      let completed = false;
      process.once("exit", (code) => {
        if (!completed && code !== 0) {
          const current = onboardSession.loadSession();
          const failedStep = current?.lastStepStarted;
          if (failedStep) {
            onboardSession.markStepFailed(
              failedStep,
              "Onboarding exited before the step completed.",
            );
          }
        }
      });

      console.log("");
      console.log("  NemoClaw Onboarding");
      if (isNonInteractive()) note("  (non-interactive mode)");
      if (resume) note("  (resume mode)");
      console.log("  ===================");

      const agent = agentOnboard.resolveAgent({ agentFlag: opts.agent, session });
      if (agent) {
        onboardSession.updateSession((s) => {
          s.agent = agent.name;
          return s;
        });
      }

      let gpu;
      const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
      if (resumePreflight) {
        skippedStepMessage("preflight", "cached");
        gpu = deps.nim.detectGpu();
      } else {
        startRecordedStep("preflight");
        gpu = await preflight();
        onboardSession.markStepComplete("preflight");
      }

      const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
      const gatewayInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
        ignoreError: true,
      });
      const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      const gatewayReuseState = getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);
      const canReuseHealthyGateway = gatewayReuseState === "healthy";
      const resumeGateway =
        resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
      if (resumeGateway) {
        skippedStepMessage("gateway", "running");
      } else if (!resume && canReuseHealthyGateway) {
        skippedStepMessage("gateway", "running", "reuse");
        note("  Reusing healthy NemoClaw gateway.");
      } else {
        if (resume && session?.steps?.gateway?.status === "complete") {
          if (gatewayReuseState === "active-unnamed") {
            note(
              "  [resume] Gateway is active but named metadata is missing; recreating it safely.",
            );
          } else if (gatewayReuseState === "foreign-active") {
            note("  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.");
          } else if (gatewayReuseState === "stale") {
            note("  [resume] Recorded gateway is unhealthy; recreating it.");
          } else {
            note("  [resume] Recorded gateway state is unavailable; recreating it.");
          }
        }
        startRecordedStep("gateway");
        await startGateway(gpu);
        onboardSession.markStepComplete("gateway");
      }

      let sandboxName = session?.sandboxName || null;
      let model = session?.model || null;
      let provider = session?.provider || null;
      let endpointUrl = session?.endpointUrl || null;
      let credentialEnv = session?.credentialEnv || null;
      let preferredInferenceApi = session?.preferredInferenceApi || null;
      let nimContainer = session?.nimContainer || null;
      let webSearchConfig = session?.webSearchConfig || null;
      let forceProviderSelection = false;
      while (true) {
        const resumeProviderSelection =
          !forceProviderSelection &&
          resume &&
          session?.steps?.provider_selection?.status === "complete" &&
          typeof provider === "string" &&
          typeof model === "string";
        if (resumeProviderSelection) {
          skippedStepMessage("provider_selection", `${provider} / ${model}`);
          hydrateCredentialEnv(credentialEnv);
        } else {
          startRecordedStep("provider_selection", { sandboxName });
          const selection = await setupNim(gpu);
          model = selection.model;
          provider = selection.provider;
          endpointUrl = selection.endpointUrl;
          credentialEnv = selection.credentialEnv;
          preferredInferenceApi = selection.preferredInferenceApi;
          nimContainer = selection.nimContainer;
          onboardSession.markStepComplete("provider_selection", {
            sandboxName,
            provider,
            model,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            nimContainer,
          });
        }

        process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
        const resumeInference =
          !forceProviderSelection &&
          resume &&
          typeof provider === "string" &&
          typeof model === "string" &&
          isInferenceRouteReady(provider, model);
        if (resumeInference) {
          skippedStepMessage("inference", `${provider} / ${model}`);
          if (nimContainer) {
            registry.updateSandbox(sandboxName, { nimContainer });
          }
          onboardSession.markStepComplete("inference", {
            sandboxName,
            provider,
            model,
            nimContainer,
          });
          break;
        }

        startRecordedStep("inference", { sandboxName, provider, model });
        const inferenceResult = await setupInference(
          GATEWAY_NAME,
          model,
          provider,
          endpointUrl,
          credentialEnv,
        );
        delete process.env.NVIDIA_API_KEY;
        if (inferenceResult?.retry === "selection") {
          forceProviderSelection = true;
          continue;
        }
        if (nimContainer) {
          registry.updateSandbox(sandboxName, { nimContainer });
        }
        onboardSession.markStepComplete("inference", {
          sandboxName,
          provider,
          model,
          nimContainer,
        });
        break;
      }

      if (webSearchConfig) {
        note("  [resume] Revalidating Brave Search configuration.");
        const braveApiKey = await ensureValidatedBraveSearchCredential();
        if (braveApiKey) {
          webSearchConfig = { fetchEnabled: true };
          onboardSession.updateSession((current) => {
            current.webSearchConfig = webSearchConfig;
            return current;
          });
          note("  [resume] Reusing Brave Search configuration.");
        } else {
          webSearchConfig = await configureWebSearch(null);
          onboardSession.updateSession((current) => {
            current.webSearchConfig = webSearchConfig;
            return current;
          });
        }
      } else {
        webSearchConfig = await configureWebSearch(webSearchConfig);
        onboardSession.updateSession((current) => {
          current.webSearchConfig = webSearchConfig;
          return current;
        });
      }

      const sandboxReuseState = getSandboxReuseState(sandboxName);
      const resumeSandbox =
        resume && session?.steps?.sandbox?.status === "complete" && sandboxReuseState === "ready";
      if (resumeSandbox) {
        skippedStepMessage("sandbox", sandboxName);
      } else {
        if (resume && session?.steps?.sandbox?.status === "complete") {
          if (sandboxReuseState === "not_ready") {
            note(
              `  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`,
            );
            repairRecordedSandbox(sandboxName);
          } else {
            note("  [resume] Recorded sandbox state is unavailable; recreating it.");
            if (sandboxName) {
              registry.removeSandbox(sandboxName);
            }
          }
        }
        startRecordedStep("sandbox", { sandboxName, provider, model });
        selectedMessagingChannels = await setupMessagingChannels();
        onboardSession.updateSession((current) => {
          current.messagingChannels = selectedMessagingChannels;
          return current;
        });
        sandboxName = await createSandbox(
          gpu,
          model,
          provider,
          preferredInferenceApi,
          sandboxName,
          webSearchConfig,
          selectedMessagingChannels,
          fromDockerfile,
          agent,
          dangerouslySkipPermissions,
        );
        onboardSession.markStepComplete("sandbox", { sandboxName, provider, model, nimContainer });
      }

      if (agent) {
        await agentOnboard.handleAgentSetup(sandboxName, model, provider, agent, resume, session, {
          step,
          runCaptureOpenshell,
          openshellShellCommand,
          buildSandboxConfigSyncScript,
          writeSandboxConfigSyncFile,
          cleanupTempDir,
          startRecordedStep,
          skippedStepMessage,
        });
      } else {
        const resumeOpenclaw = resume && sandboxName && isOpenclawReady(sandboxName);
        if (resumeOpenclaw) {
          skippedStepMessage("openclaw", sandboxName);
          onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
        } else {
          startRecordedStep("openclaw", { sandboxName, provider, model });
          await setupOpenclaw(sandboxName, model, provider);
          onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
        }
      }

      const recordedPolicyPresets = Array.isArray(session?.policyPresets)
        ? session.policyPresets
        : null;
      if (dangerouslySkipPermissions) {
        step(8, 8, "Policy presets");
        console.log("  Skipped — --dangerously-skip-permissions applies permissive base policy.");
        onboardSession.markStepComplete("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: [],
        });
      } else {
        const resumePolicies =
          resume &&
          sandboxName &&
          arePolicyPresetsApplied(sandboxName, recordedPolicyPresets || []);
        if (resumePolicies) {
          skippedStepMessage("policies", (recordedPolicyPresets || []).join(", "));
          onboardSession.markStepComplete("policies", {
            sandboxName,
            provider,
            model,
            policyPresets: recordedPolicyPresets || [],
          });
        } else {
          startRecordedStep("policies", {
            sandboxName,
            provider,
            model,
            policyPresets: recordedPolicyPresets || [],
          });
          const appliedPolicyPresets = await setupPoliciesWithSelection(sandboxName, {
            selectedPresets:
              resume &&
              session?.steps?.policies?.status !== "complete" &&
              Array.isArray(recordedPolicyPresets) &&
              recordedPolicyPresets.length > 0
                ? recordedPolicyPresets
                : null,
            enabledChannels: selectedMessagingChannels,
            webSearchConfig,
            onSelection: (policyPresets) => {
              onboardSession.updateSession((current) => {
                current.policyPresets = policyPresets;
                return current;
              });
            },
          });
          onboardSession.markStepComplete("policies", {
            sandboxName,
            provider,
            model,
            policyPresets: appliedPolicyPresets,
          });
        }
      }

      onboardSession.completeSession({ sandboxName, provider, model });
      completed = true;
      printDashboard(sandboxName, model, provider, nimContainer, agent);
    } finally {
      releaseOnboardLock();
    }
  }

  return {
    onboard,
  };
}
