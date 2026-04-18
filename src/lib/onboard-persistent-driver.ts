// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deriveOnboardFlowState, hasCompletedOnboardStep } from "./onboard-flow-state";
import type { OnboardFlowState } from "./onboard-fsm";
import {
  applySessionComplete,
  applyStepComplete,
  applyStepFailed,
  applyStepSkipped,
  applyStepStarted,
  filterSafeUpdates,
  loadSession,
  saveSession,
  updateSession,
  type Session,
  type SessionUpdates,
} from "./onboard-session";
import type { OnboardStepName, OnboardVisibleStep } from "./onboard-fsm";

export interface PersistentOnboardDriverOptions {
  resume?: boolean;
  requestedSandboxName?: string | null;
}

export class PersistentOnboardDriver {
  readonly #resume: boolean;
  readonly #requestedSandboxName: string | null;

  constructor(options: PersistentOnboardDriverOptions = {}) {
    this.#resume = options.resume ?? false;
    this.#requestedSandboxName = options.requestedSandboxName ?? null;
  }

  get session(): Session | null {
    return loadSession();
  }

  get requiredSession(): Session {
    const session = this.session;
    if (!session) {
      throw new Error("No onboarding session is available.");
    }
    return session;
  }

  get flowState(): OnboardFlowState {
    return deriveOnboardFlowState(this.session, {
      resume: this.#resume,
      requestedSandboxName: this.#requestedSandboxName,
    });
  }

  replaceSession(session: Session): Session {
    return saveSession(session);
  }

  hasCompleted(step: OnboardVisibleStep): boolean {
    return hasCompletedOnboardStep(this.flowState, step);
  }

  update(mutator: (session: Session) => Session | void): Session {
    return updateSession(mutator);
  }

  startStep(stepName: OnboardStepName, updates: SessionUpdates = {}): Session {
    return updateSession((session) => {
      applyStepStarted(session, stepName);
      Object.assign(session, filterSafeUpdates(updates));
      return session;
    });
  }

  completeStep(stepName: OnboardStepName, updates: SessionUpdates = {}): Session {
    return updateSession((session) => applyStepComplete(session, stepName, updates));
  }

  skipStep(stepName: OnboardStepName): Session {
    return updateSession((session) => applyStepSkipped(session, stepName));
  }

  failStep(stepName: OnboardStepName, message: string | null = null): Session {
    return updateSession((session) => applyStepFailed(session, stepName, message));
  }

  completeSession(updates: SessionUpdates = {}): Session {
    return updateSession((session) => applySessionComplete(session, updates));
  }
}
