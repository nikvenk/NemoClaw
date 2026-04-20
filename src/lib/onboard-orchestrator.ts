// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hasCompletedOnboardStep } from "./onboard-flow-state";
import type {
  HostPreparationDeps,
  HostPreparationResult,
} from "./onboard-host-flow";
import type {
  InferenceLoopDeps,
  InferenceLoopResult,
  InferenceLoopState,
} from "./onboard-inference-loop";
import type { OnboardStepName, OnboardVisibleStep } from "./onboard-fsm";
import type {
  PolicyFlowDeps,
  PolicyFlowResult,
  PolicyFlowState,
} from "./onboard-policy-flow";
import type { OnboardRunContext } from "./onboard-run-context";
import type {
  RuntimeSetupDeps,
  RuntimeSetupState,
} from "./onboard-runtime-flow";
import type {
  SandboxFlowDeps,
  SandboxFlowResult,
  SandboxFlowState,
} from "./onboard-sandbox-flow";
import type { Session, SessionUpdates } from "./onboard-session";

export interface OnboardOrchestratorDeps<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
> {
  resume: boolean;
  dangerouslySkipPermissions: boolean;
  requestedAgent: string | null;
  resolveAgent: (options: { agentFlag?: string | null; session?: Session | null }) => TAgent | null;
  note: (message: string) => void;
  log: (message: string) => void;
  skippedStepMessage: (
    stepName: string,
    detail: string | null,
    reason?: "resume" | "reuse",
  ) => void;
  showPolicyHeader: () => void;
  host: Omit<
    HostPreparationDeps<TGpu>,
    | "resume"
    | "hasCompletedPreflight"
    | "hasCompletedGateway"
    | "onNote"
    | "onLog"
    | "onSkip"
    | "onStartStep"
    | "onCompleteStep"
  > & {
    run: (deps: HostPreparationDeps<TGpu>) => Promise<HostPreparationResult<TGpu>>;
  };
  inference: Omit<
    InferenceLoopDeps<TGpu>,
    | "gpu"
    | "resume"
    | "hasCompletedProviderSelection"
    | "hasCompletedInference"
    | "onSkip"
    | "onStartStep"
    | "onCompleteStep"
  > & {
    run: (
      initialState: InferenceLoopState,
      deps: InferenceLoopDeps<TGpu>,
    ) => Promise<InferenceLoopResult>;
  };
  sandbox: Omit<
    SandboxFlowDeps<TAgent | null, TGpu>,
    | "resume"
    | "sessionMessagingChannels"
    | "sessionWebSearchConfig"
    | "hasCompletedMessaging"
    | "hasCompletedSandbox"
    | "onNote"
    | "onSkip"
    | "onStartStep"
    | "onCompleteStep"
  > & {
    run: (
      initialState: SandboxFlowState<TAgent | null, TGpu>,
      deps: SandboxFlowDeps<TAgent | null, TGpu>,
    ) => Promise<SandboxFlowResult<TAgent | null, TGpu>>;
  };
  runtime: Omit<
    RuntimeSetupDeps<TAgent | null>,
    | "hasCompletedRuntimeSetup"
    | "onSkip"
    | "onStartStep"
    | "onCompleteStep"
    | "onSkipSiblingStep"
  > & {
    run: (
      state: RuntimeSetupState<TAgent | null>,
      deps: RuntimeSetupDeps<TAgent | null>,
    ) => Promise<void>;
  };
  policy: Omit<
    PolicyFlowDeps,
    | "resume"
    | "dangerouslySkipPermissions"
    | "hasCompletedPolicies"
    | "onShowHeader"
    | "onSkip"
    | "onStartStep"
    | "onCompleteStep"
    | "onSelectionPersist"
  > & {
    run: (state: PolicyFlowState, deps: PolicyFlowDeps) => Promise<PolicyFlowResult>;
  };
}

export interface OnboardOrchestratorResult<TAgent extends { name: string } = { name: string }> {
  sandboxName: string;
  model: string;
  provider: string;
  nimContainer: string | null;
  agent: TAgent | null;
  policyResult: PolicyFlowResult;
}

function normalizeSessionUpdates(
  updates:
    | {
        sandboxName?: string | null;
        provider?: string | null;
        model?: string | null;
        endpointUrl?: string | null;
        credentialEnv?: string | null;
        preferredInferenceApi?: string | null;
        nimContainer?: string | null;
        messagingChannels?: string[];
        policyPresets?: string[];
        webSearchConfig?: SessionUpdates["webSearchConfig"];
      }
    | undefined,
): SessionUpdates {
  if (!updates) {
    return {};
  }
  const normalized: SessionUpdates = {};
  if (updates.sandboxName === null) normalized.sandboxName = null;
  else if (typeof updates.sandboxName === "string") normalized.sandboxName = updates.sandboxName;
  if (updates.provider === null) normalized.provider = null;
  else if (typeof updates.provider === "string") normalized.provider = updates.provider;
  if (updates.model === null) normalized.model = null;
  else if (typeof updates.model === "string") normalized.model = updates.model;
  if (updates.endpointUrl === null) normalized.endpointUrl = null;
  else if (typeof updates.endpointUrl === "string") normalized.endpointUrl = updates.endpointUrl;
  if (updates.credentialEnv === null) normalized.credentialEnv = null;
  else if (typeof updates.credentialEnv === "string") normalized.credentialEnv = updates.credentialEnv;
  if (updates.preferredInferenceApi === null) normalized.preferredInferenceApi = null;
  else if (typeof updates.preferredInferenceApi === "string") {
    normalized.preferredInferenceApi = updates.preferredInferenceApi;
  }
  if (updates.nimContainer === null) normalized.nimContainer = null;
  else if (typeof updates.nimContainer === "string") normalized.nimContainer = updates.nimContainer;
  if (Array.isArray(updates.messagingChannels)) {
    normalized.messagingChannels = updates.messagingChannels;
  }
  if (Array.isArray(updates.policyPresets)) {
    normalized.policyPresets = updates.policyPresets;
  }
  if (updates.webSearchConfig !== undefined) {
    normalized.webSearchConfig = updates.webSearchConfig;
  }
  return normalized;
}

function requireString(value: string | null, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} was not resolved during onboarding orchestration.`);
  }
  return value;
}

export async function runOnboardingOrchestrator<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
>(
  runContext: OnboardRunContext,
  deps: OnboardOrchestratorDeps<TGpu, TAgent>,
): Promise<OnboardOrchestratorResult<TAgent>> {
  const agent = deps.resolveAgent({
    agentFlag: deps.requestedAgent,
    session: runContext.session,
  });
  if (agent) {
    runContext.updateSession((session) => {
      session.agent = agent.name;
      return session;
    });
  }

  const resumeFlowState = deps.resume ? runContext.driver.flowState : null;
  const hasCompleted = (stepName: OnboardVisibleStep): boolean =>
    !!resumeFlowState && hasCompletedOnboardStep(resumeFlowState, stepName);
  const startStep = (stepName: OnboardStepName, updates?: SessionUpdates): void => {
    runContext.startStep(stepName, updates);
  };
  const completeStep = (stepName: OnboardStepName, updates?: SessionUpdates): void => {
    runContext.completeStep(stepName, updates);
  };

  const { gpu } = await deps.host.run({
    ...deps.host,
    resume: deps.resume,
    hasCompletedPreflight: hasCompleted("preflight"),
    hasCompletedGateway: hasCompleted("gateway"),
    onNote: deps.note,
    onLog: deps.log,
    onSkip: deps.skippedStepMessage,
    onStartStep: (stepName) => {
      startStep(stepName);
    },
    onCompleteStep: (stepName) => {
      completeStep(stepName);
    },
  });

  const currentSession = runContext.session;
  let sandboxName = currentSession.sandboxName || null;
  let model = currentSession.model || null;
  let provider = currentSession.provider || null;
  let endpointUrl = currentSession.endpointUrl || null;
  let credentialEnv = currentSession.credentialEnv || null;
  let preferredInferenceApi = currentSession.preferredInferenceApi || null;
  let nimContainer = currentSession.nimContainer || null;
  let webSearchConfig = currentSession.webSearchConfig || null;
  let selectedMessagingChannels = Array.isArray(currentSession.messagingChannels)
    ? [...currentSession.messagingChannels]
    : [];

  ({
    sandboxName,
    model,
    provider,
    endpointUrl,
    credentialEnv,
    preferredInferenceApi,
    nimContainer,
  } = await deps.inference.run(
    {
      sandboxName,
      model,
      provider,
      endpointUrl,
      credentialEnv,
      preferredInferenceApi,
      nimContainer,
    },
    {
      ...deps.inference,
      gpu,
      resume: deps.resume,
      hasCompletedProviderSelection: hasCompleted("provider_selection"),
      hasCompletedInference: hasCompleted("inference"),
      onSkip: deps.skippedStepMessage,
      onStartStep: (stepName, updates) => startStep(stepName, normalizeSessionUpdates(updates)),
      onCompleteStep: (stepName, updates) =>
        completeStep(stepName, normalizeSessionUpdates(updates)),
    },
  ));

  model = requireString(model, "model");
  provider = requireString(provider, "provider");

  ({ sandboxName, webSearchConfig, selectedMessagingChannels } = await deps.sandbox.run(
    {
      gpu,
      sandboxName,
      model,
      provider,
      preferredInferenceApi,
      webSearchConfig,
      selectedMessagingChannels,
      nimContainer,
      fromDockerfile: runContext.fromDockerfile,
      agent,
      dangerouslySkipPermissions: deps.dangerouslySkipPermissions,
    },
    {
      ...deps.sandbox,
      resume: deps.resume,
      sessionMessagingChannels: Array.isArray(currentSession.messagingChannels)
        ? [...currentSession.messagingChannels]
        : null,
      sessionWebSearchConfig: currentSession.webSearchConfig || null,
      hasCompletedMessaging: hasCompleted("messaging"),
      hasCompletedSandbox: hasCompleted("sandbox"),
      onNote: deps.note,
      onSkip: deps.skippedStepMessage,
      onStartStep: (stepName, updates) => startStep(stepName, normalizeSessionUpdates(updates)),
      onCompleteStep: (stepName, updates) =>
        completeStep(stepName, normalizeSessionUpdates(updates)),
    },
  ));

  await deps.runtime.run(
    {
      sandboxName: requireString(sandboxName, "sandboxName"),
      model,
      provider,
      agent,
      resume: deps.resume,
      session: runContext.session,
    },
    {
      ...deps.runtime,
      hasCompletedRuntimeSetup: hasCompleted("runtime_setup"),
      onSkip: deps.skippedStepMessage,
      onStartStep: (stepName, updates) => startStep(stepName, normalizeSessionUpdates(updates)),
      onCompleteStep: (stepName, updates) =>
        completeStep(stepName, normalizeSessionUpdates(updates)),
      onSkipSiblingStep: (stepName) => {
        runContext.skipStep(stepName);
      },
    },
  );

  const latestSession = runContext.driver.session;
  const recordedPolicyPresets = Array.isArray(latestSession?.policyPresets)
    ? latestSession.policyPresets
    : null;
  const policyResult = await deps.policy.run(
    {
      sandboxName: requireString(sandboxName, "sandboxName"),
      provider,
      model,
      webSearchConfig,
      enabledChannels: selectedMessagingChannels,
      recordedPolicyPresets,
    },
    {
      ...deps.policy,
      resume: deps.resume,
      dangerouslySkipPermissions: deps.dangerouslySkipPermissions,
      hasCompletedPolicies: hasCompleted("policies"),
      onShowHeader: deps.showPolicyHeader,
      onSkip: deps.skippedStepMessage,
      onStartStep: (stepName, updates) => startStep(stepName, normalizeSessionUpdates(updates)),
      onCompleteStep: (stepName, updates) =>
        completeStep(stepName, normalizeSessionUpdates(updates)),
      onSelectionPersist: (policyPresets) => {
        runContext.updateSession((session) => {
          session.policyPresets = policyPresets;
          return session;
        });
      },
    },
  );

  if (policyResult.kind === "complete") {
    runContext.completeSession({
      sandboxName: requireString(sandboxName, "sandboxName"),
      provider,
      model,
      policyPresets: policyResult.policyPresets,
    });
  }

  return {
    sandboxName: requireString(sandboxName, "sandboxName"),
    model,
    provider,
    nimContainer,
    agent,
    policyResult,
  };
}
