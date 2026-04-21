<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reference eval: `nemoclaw-maintainer-cut-release-tag`

One of three reference evals shipped with the skills-eval MVP. This one demonstrates how to evaluate a **procedural workflow skill** — one whose value is tight sequencing, confirmation gates, and knowing when *not* to run. See `nemoclaw-user-get-started/evals/README.md` for the canonical three-scenario shape; this README focuses on patterns specific to maintainer workflow skills.

## What each scenario is doing

### Scenario 1 — happy path with required confirmation gate

> *"We're ready to ship the next NemoClaw release. It's a normal release cut — a handful of bug fixes and docs changes since the last tag. Walk me through what to do."*

Release workflows have a load-bearing **safety property**: never tag without the user explicitly confirming the version string. The happy-path scenario exists primarily to grade whether the skill enforces that gate.

Assertions break down into three families:

1. **Ordering** — fetch tags → determine current → propose bump → dry run → real run → tag. The assertion `recommends running the version bump in dry-run mode first, then confirming before the real run` captures the ordering without locking a specific phrasing.
2. **Tooling** — `invokes npm run bump:version (or scripts/bump-version.ts) rather than hand-editing version strings`. Named alternatives in parens give the grader two acceptable surface forms.
3. **Safety gate** — two assertions cover this from both sides: `proposes patch as the default bump for bug fixes and explicitly asks for user confirmation of the version` (positive) and `does NOT tag without explicit user confirmation of the version` (negative). The pair catches skills that either skip the gate outright or ask for confirmation in a way a judge can't grade.

Double-asserting the critical property from both a positive and a negative angle is worth copying anytime a skill has a behavior that absolutely must hold.

### Scenario 2 — mid-workflow continuation ("I already did step 1")

> *"I already ran `npm run bump:version -- 0.0.22 --dry-run` and the output looks correct. What do I do next? I'd rather go through a PR than push straight to main."*

Users don't always invoke a skill from scratch. This scenario tests whether the skill can **pick up mid-workflow** and respect a user's explicit preference (PR over direct push).

Assertion 1 uses a precise positive claim (`re-run npm run bump:version -- 0.0.22 without --dry-run`) paired with assertion 2's negative (`explicitly does NOT recommend --no-create-pr --push because the user asked to go through a PR`). Together they test the skill's ability to honor user intent over default behavior.

Assertion 5 (`notes the latest tag must be pushed with --force because it moves`) is the kind of gotcha assertion that catches surface-level skills. A response can hit every other beat and still fail if it forgets the moving-tag force-push detail — which is exactly the kind of thing a real user would get bitten by.

### Scenario 3 — adjacent-wrong (rollback, not release)

> *"Our nightly E2E run just started failing on main after a recent commit landed. I want to get back to a known-good state. What's the fastest path?"*

This prompt uses **release-adjacent vocabulary** ("get back to a known-good state") but is actually a rollback/regression-investigation task. A skill fixated on releases might see "known-good state" and reach for `bump:version`. The correct response is to redirect entirely.

Assertion 5 (`may mention that a later fix could be shipped as a patch release but does not conflate rollback with a release cut`) is a soft-boundary assertion: it allows the skill to mention the release pathway as a follow-up without treating rollback as a release-cut problem. Use soft-boundary assertions whenever two skills have overlapping territory and the response can reasonably touch both without confusing them.

The negative-heavy assertion set (`does NOT invoke npm run bump:version`, `does NOT create a new semver tag as the fix`) makes this scenario a strong test of the skill's *non-firing* behavior.

## What to copy

- Double-asserting a safety gate from both a positive and negative angle
- Parenthetical alternatives (`npm run bump:version (or scripts/bump-version.ts)`) to allow surface variation
- Gotcha assertions for skill-specific details that would bite real users
- Soft-boundary assertions (`may mention X but does not conflate X with Y`) for adjacent-wrong scenarios with overlapping vocabulary
- Mid-workflow scenarios for any skill a user might invoke in pieces rather than as one linear flow

## What's skill-specific

- The `bump:version` tooling and `git tag -a` flow — your workflow will have different mechanics
- The dry-run / real-run / tag ordering — some skills aren't ordered this way
- The rollback adjacent-wrong — your skill's confusable neighbor will be different (inference config, security posture, triage, etc.)
