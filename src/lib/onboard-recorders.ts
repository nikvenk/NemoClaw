// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardStepName } from "./onboard-fsm";
import { PersistentOnboardDriver } from "./onboard-persistent-driver";
import type { Session, SessionUpdates } from "./onboard-session";

export interface TrackedOnboardRun {
  readonly driver: PersistentOnboardDriver;
  readonly session: Session;
  update(mutator: (session: Session) => Session | void): Session;
  startStep(stepName: OnboardStepName, updates?: SessionUpdates): Session;
  completeStep(stepName: OnboardStepName, updates?: SessionUpdates): Session;
  skipStep(stepName: OnboardStepName): Session;
  failStep(stepName: OnboardStepName, message?: string | null): Session;
  completeSession(updates?: SessionUpdates): Session;
}

export function createTrackedOnboardRun(
  driver: PersistentOnboardDriver,
  initialSession: Session,
): TrackedOnboardRun {
  let session = initialSession;

  return {
    driver,
    get session(): Session {
      return session;
    },
    update(mutator): Session {
      session = driver.update(mutator);
      return session;
    },
    startStep(stepName, updates = {}): Session {
      session = driver.startStep(stepName, updates);
      return session;
    },
    completeStep(stepName, updates = {}): Session {
      session = driver.completeStep(stepName, updates);
      return session;
    },
    skipStep(stepName): Session {
      session = driver.skipStep(stepName);
      return session;
    },
    failStep(stepName, message = null): Session {
      session = driver.failStep(stepName, message);
      return session;
    },
    completeSession(updates = {}): Session {
      session = driver.completeSession(updates);
      return session;
    },
  };
}
