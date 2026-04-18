// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InitializedOnboardRun } from "./onboard-bootstrap";
import type { OnboardStepName } from "./onboard-fsm";
import { createTrackedOnboardRun } from "./onboard-recorders";
import type { PersistentOnboardDriver } from "./onboard-persistent-driver";
import type { Session, SessionUpdates } from "./onboard-session";

export interface OnboardRunContext {
  readonly driver: PersistentOnboardDriver;
  readonly fromDockerfile: string | null;
  readonly session: Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
  startStep(stepName: OnboardStepName, updates?: SessionUpdates): Session;
  completeStep(stepName: OnboardStepName, updates?: SessionUpdates): Session;
  skipStep(stepName: OnboardStepName): Session;
  failStep(stepName: OnboardStepName, message?: string | null): Session;
  completeSession(updates?: SessionUpdates): Session;
}

export function createOnboardRunContext(initializedRun: InitializedOnboardRun): OnboardRunContext {
  const trackedRun = createTrackedOnboardRun(initializedRun.driver, initializedRun.session);

  return {
    driver: initializedRun.driver,
    fromDockerfile: initializedRun.fromDockerfile,
    get session(): Session {
      return trackedRun.session;
    },
    updateSession(mutator): Session {
      return trackedRun.update(mutator);
    },
    startStep(stepName, updates = {}): Session {
      return trackedRun.startStep(stepName, updates);
    },
    completeStep(stepName, updates = {}): Session {
      return trackedRun.completeStep(stepName, updates);
    },
    skipStep(stepName): Session {
      return trackedRun.skipStep(stepName);
    },
    failStep(stepName, message = null): Session {
      return trackedRun.failStep(stepName, message);
    },
    completeSession(updates = {}): Session {
      return trackedRun.completeSession(updates);
    },
  };
}
