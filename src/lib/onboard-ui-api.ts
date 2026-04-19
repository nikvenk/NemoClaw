// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  arePolicyPresetsApplied as arePolicyPresetsAppliedWithDeps,
  presetsCheckboxSelector as presetsCheckboxSelectorWithDeps,
  selectPolicyTier as selectPolicyTierWithDeps,
  selectTierPresetsAndAccess as selectTierPresetsAndAccessWithDeps,
  setupPoliciesLegacy as setupPoliciesLegacyWithDeps,
  setupPoliciesWithSelection as setupPoliciesWithSelectionWithDeps,
} from "./onboard-policy-ui";
import {
  buildAuthenticatedDashboardUrl,
  ensureDashboardForward as ensureDashboardForwardWithDeps,
  fetchGatewayAuthTokenFromSandbox as fetchGatewayAuthTokenFromSandboxWithDeps,
  getDashboardAccessInfo as getDashboardAccessInfoWithDeps,
  getDashboardForwardStartCommand as getDashboardForwardStartCommandWithDeps,
  getDashboardGuidanceLines,
  getWslHostAddress,
} from "./onboard-dashboard";
import { printOnboardDashboard } from "./onboard-dashboard-print";

export function createPolicyUiApi(input: any) {
  const deps = {
    step: input.step,
    prompt: input.prompt,
    note: input.note,
    sleep: input.sleep,
    isNonInteractive: input.isNonInteractive,
    parsePolicyPresetEnv: input.parsePolicyPresetEnv,
    waitForSandboxReady: input.waitForSandboxReady,
    localInferenceProviders: input.localInferenceProviders,
    useColor: input.useColor,
    policies: input.policies,
    tiers: input.tiers,
    updateSandbox: input.updateSandbox,
  };

  return {
    async setupPoliciesLegacy(sandboxName: string, options: any = {}) {
      return setupPoliciesLegacyWithDeps(
        sandboxName,
        {
          ...options,
          getSuggestedPolicyPresets: input.getSuggestedPolicyPresets,
        },
        deps,
      );
    },
    arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[] = []) {
      return arePolicyPresetsAppliedWithDeps(sandboxName, selectedPresets, deps);
    },
    async selectPolicyTier() {
      return selectPolicyTierWithDeps(deps);
    },
    async selectTierPresetsAndAccess(
      tierName: string,
      allPresets: Array<{ name: string; description?: string }>,
      extraSelected: string[] = [],
    ) {
      return selectTierPresetsAndAccessWithDeps(tierName, allPresets, extraSelected, deps);
    },
    async presetsCheckboxSelector(
      allPresets: Array<{ name: string; description: string }>,
      initialSelected: string[],
    ) {
      return presetsCheckboxSelectorWithDeps(allPresets, initialSelected, deps);
    },
    async setupPoliciesWithSelection(sandboxName: string, options: any = {}) {
      return setupPoliciesWithSelectionWithDeps(sandboxName, options, deps);
    },
  };
}

export function createDashboardApi(input: any) {
  const ensureDashboardForward = (
    sandboxName: string,
    chatUiUrl = `http://127.0.0.1:${input.controlUiPort}`,
  ) =>
    ensureDashboardForwardWithDeps(sandboxName, {
      chatUiUrl,
      runOpenshell: input.runOpenshell,
      warningWriter: input.warningWriter,
    });

  const fetchGatewayAuthTokenFromSandbox = (sandboxName: string) =>
    fetchGatewayAuthTokenFromSandboxWithDeps(sandboxName, { runOpenshell: input.runOpenshell });

  const getDashboardForwardStartCommand = (sandboxName: string, options: any = {}) =>
    getDashboardForwardStartCommandWithDeps(sandboxName, {
      ...options,
      openshellShellCommand: input.openshellShellCommand,
    });

  const getDashboardAccessInfo = (sandboxName: string, options: any = {}) =>
    getDashboardAccessInfoWithDeps(sandboxName, {
      ...options,
      fetchToken: (name: string) => fetchGatewayAuthTokenFromSandbox(name),
      runCapture: options.runCapture || input.runCapture,
    });

  const printDashboard = (
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null = null,
    agent: unknown = null,
  ) =>
    printOnboardDashboard(sandboxName, model, provider, nimContainer, agent, {
      getNimStatus: (targetSandboxName: string, targetNimContainer: string | null) =>
        targetNimContainer
          ? input.nimStatusByName(targetNimContainer)
          : input.nimStatus(targetSandboxName),
      fetchGatewayAuthTokenFromSandbox,
      getDashboardAccessInfo: (targetSandboxName: string, options: any) =>
        getDashboardAccessInfo(targetSandboxName, options),
      getDashboardGuidanceLines,
      note: input.note,
      log: input.log,
      printAgentDashboardUi: input.printAgentDashboardUi,
      buildControlUiUrls: input.buildControlUiUrls,
      getWslHostAddress,
      buildAuthenticatedDashboardUrl,
    });

  return {
    ensureDashboardForward,
    fetchGatewayAuthTokenFromSandbox,
    getDashboardForwardStartCommand,
    getDashboardAccessInfo,
    printDashboard,
  };
}
