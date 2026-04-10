// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createOnboardSharedHelpers(deps) {
  const {
    DIM,
    RESET,
    getCredential,
    getNonInteractiveFlag,
    getRecreateSandboxFlag,
    onboardSession,
    prompt,
  } = deps;

  function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
  }

  function secureTempFile(prefix, ext = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    return path.join(dir, `${prefix}${ext}`);
  }

  function cleanupTempDir(filePath, expectedPrefix) {
    const parentDir = path.dirname(filePath);
    if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith(`${expectedPrefix}-`)) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  }

  function isNonInteractive() {
    return getNonInteractiveFlag() || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  }

  function isRecreateSandbox() {
    return getRecreateSandboxFlag() || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  }

  function note(message) {
    console.log(`${DIM}${message}${RESET}`);
  }

  async function promptOrDefault(question, envVar, defaultValue) {
    if (isNonInteractive()) {
      const val = envVar ? process.env[envVar] : null;
      const result = val || defaultValue;
      note(`  [non-interactive] ${question.trim()} → ${result}`);
      return result;
    }
    return prompt(question);
  }

  function step(n, total, msg) {
    console.log("");
    console.log(`  [${n}/${total}] ${msg}`);
    console.log(`  ${"─".repeat(50)}`);
  }

  function hydrateCredentialEnv(envName) {
    if (!envName) return null;
    const value = getCredential(envName);
    if (value) {
      process.env[envName] = value;
    }
    return value || null;
  }

  function getNavigationChoice(value = "") {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (normalized === "back") return "back";
    if (normalized === "exit" || normalized === "quit") return "exit";
    return null;
  }

  function exitOnboardFromPrompt() {
    console.log("  Exiting onboarding.");
    process.exit(1);
  }

  function encodeDockerJsonArg(value) {
    return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
  }

  function isAffirmativeAnswer(value) {
    return ["y", "yes"].includes(
      String(value || "")
        .trim()
        .toLowerCase(),
    );
  }

  function getRequestedSandboxNameHint() {
    const raw = process.env.NEMOCLAW_SANDBOX_NAME;
    if (typeof raw !== "string") return null;
    const normalized = raw.trim().toLowerCase();
    return normalized || null;
  }

  function getResumeSandboxConflict(session) {
    const requestedSandboxName = getRequestedSandboxNameHint();
    if (!requestedSandboxName || !session?.sandboxName) {
      return null;
    }
    return requestedSandboxName !== session.sandboxName
      ? { requestedSandboxName, recordedSandboxName: session.sandboxName }
      : null;
  }

  function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
    if (!nonInteractive) return null;
    const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
    if (!providerKey) return null;
    const aliases = {
      cloud: "build",
      nim: "nim-local",
      vllm: "vllm",
      anthropiccompatible: "anthropicCompatible",
    };
    return aliases[providerKey] || providerKey;
  }

  function getRequestedModelHint(nonInteractive = isNonInteractive()) {
    if (!nonInteractive) return null;
    const model = (process.env.NEMOCLAW_MODEL || "").trim();
    return model || null;
  }

  function getEffectiveProviderName(providerKey) {
    if (!providerKey) return null;
    const providerMap = {
      build: "nvidia-prod",
      openai: "openai-api",
      anthropic: "anthropic-prod",
      anthropicCompatible: "compatible-anthropic-endpoint",
      gemini: "gemini-api",
      custom: "compatible-endpoint",
      "nim-local": "nvidia-nim",
      ollama: "ollama-local",
      vllm: "vllm-local",
    };
    return providerMap[providerKey] || providerKey;
  }

  function getResumeConfigConflicts(session, opts = {}) {
    const conflicts = [];
    const nonInteractive = opts.nonInteractive ?? isNonInteractive();

    const sandboxConflict = getResumeSandboxConflict(session);
    if (sandboxConflict) {
      conflicts.push({
        field: "sandbox",
        requested: sandboxConflict.requestedSandboxName,
        recorded: sandboxConflict.recordedSandboxName,
      });
    }

    const requestedProvider = getRequestedProviderHint(nonInteractive);
    const effectiveRequestedProvider = getEffectiveProviderName(requestedProvider);
    if (
      effectiveRequestedProvider &&
      session?.provider &&
      effectiveRequestedProvider !== session.provider
    ) {
      conflicts.push({
        field: "provider",
        requested: effectiveRequestedProvider,
        recorded: session.provider,
      });
    }

    const requestedModel = getRequestedModelHint(nonInteractive);
    if (requestedModel && session?.model && requestedModel !== session.model) {
      conflicts.push({ field: "model", requested: requestedModel, recorded: session.model });
    }

    const requestedFrom = opts.fromDockerfile ? path.resolve(opts.fromDockerfile) : null;
    const recordedFrom = session?.metadata?.fromDockerfile
      ? path.resolve(session.metadata.fromDockerfile)
      : null;
    if (requestedFrom !== recordedFrom) {
      conflicts.push({
        field: "fromDockerfile",
        requested: requestedFrom,
        recorded: recordedFrom,
      });
    }

    const requestedAgent = opts.agent || process.env.NEMOCLAW_AGENT || null;
    const recordedAgent = session?.agent || null;
    if (requestedAgent && recordedAgent && requestedAgent !== recordedAgent) {
      conflicts.push({ field: "agent", requested: requestedAgent, recorded: recordedAgent });
    }

    return conflicts;
  }

  function startRecordedStep(stepName, updates = {}) {
    onboardSession.markStepStarted(stepName);
    if (Object.keys(updates).length > 0) {
      onboardSession.updateSession((session) => {
        if (typeof updates.sandboxName === "string") session.sandboxName = updates.sandboxName;
        if (typeof updates.provider === "string") session.provider = updates.provider;
        if (typeof updates.model === "string") session.model = updates.model;
        return session;
      });
    }
  }

  const ONBOARD_STEP_INDEX = {
    preflight: { number: 1, title: "Preflight checks" },
    gateway: { number: 2, title: "Starting OpenShell gateway" },
    provider_selection: { number: 3, title: "Configuring inference (NIM)" },
    inference: { number: 4, title: "Setting up inference provider" },
    messaging: { number: 5, title: "Messaging channels" },
    sandbox: { number: 6, title: "Creating sandbox" },
    openclaw: { number: 7, title: "Setting up OpenClaw inside sandbox" },
    policies: { number: 8, title: "Policy presets" },
  };

  function skippedStepMessage(stepName, detail, reason = "resume") {
    const stepInfo = ONBOARD_STEP_INDEX[stepName];
    if (stepInfo) {
      step(stepInfo.number, 8, stepInfo.title);
    }
    const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
    console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
  }

  return {
    cleanupTempDir,
    encodeDockerJsonArg,
    envInt,
    exitOnboardFromPrompt,
    getNavigationChoice,
    getRequestedModelHint,
    getRequestedProviderHint,
    getRequestedSandboxNameHint,
    getResumeConfigConflicts,
    getResumeSandboxConflict,
    hydrateCredentialEnv,
    isAffirmativeAnswer,
    isNonInteractive,
    isRecreateSandbox,
    note,
    promptOrDefault,
    secureTempFile,
    skippedStepMessage,
    startRecordedStep,
    step,
  };
}
