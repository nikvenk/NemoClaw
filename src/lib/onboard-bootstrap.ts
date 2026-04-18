// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { PersistentOnboardDriver } from "./onboard-persistent-driver";
import { buildResumeConflictLines, type ResumeConfigConflict } from "./onboard-resume";
import { createSession, type Session } from "./onboard-session";

export interface InitializeOnboardRunOptions {
  resume: boolean;
  mode: Session["mode"];
  requestedFromDockerfile: string | null;
  requestedAgent: string | null;
  getResumeConflicts?: (session: Session) => ResumeConfigConflict[];
}

export interface InitializedOnboardRun {
  driver: PersistentOnboardDriver;
  session: Session;
  fromDockerfile: string | null;
}

export interface InitializeOnboardRunFailure {
  ok: false;
  lines: string[];
}

export interface InitializeOnboardRunSuccess {
  ok: true;
  value: InitializedOnboardRun;
}

export type InitializeOnboardRunResult =
  | InitializeOnboardRunFailure
  | InitializeOnboardRunSuccess;

export function initializeOnboardRun(
  options: InitializeOnboardRunOptions,
): InitializeOnboardRunResult {
  const driver = new PersistentOnboardDriver({ resume: options.resume });

  if (options.resume) {
    const session = driver.session;
    if (!session || session.resumable === false) {
      return {
        ok: false,
        lines: ["  No resumable onboarding session was found.", "  Run: nemoclaw onboard"],
      };
    }

    const sessionFrom = session.metadata.fromDockerfile || null;
    const fromDockerfile = options.requestedFromDockerfile
      ? path.resolve(options.requestedFromDockerfile)
      : sessionFrom
        ? path.resolve(sessionFrom)
        : null;
    const resumeConflicts = options.getResumeConflicts?.(session) ?? [];
    if (resumeConflicts.length > 0) {
      return {
        ok: false,
        lines: buildResumeConflictLines(resumeConflicts),
      };
    }

    const updatedSession = driver.update((current) => {
      current.mode = options.mode;
      current.failure = null;
      current.status = "in_progress";
      return current;
    });
    return {
      ok: true,
      value: {
        driver,
        session: updatedSession,
        fromDockerfile,
      },
    };
  }

  const fromDockerfile = options.requestedFromDockerfile
    ? path.resolve(options.requestedFromDockerfile)
    : null;
  const session = driver.replaceSession(
    createSession({
      mode: options.mode,
      agent: options.requestedAgent,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
    }),
  );
  return {
    ok: true,
    value: {
      driver,
      session,
      fromDockerfile,
    },
  };
}
