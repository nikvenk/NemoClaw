---
orphan: true
title: "NemoClaw Project Governance"
description: "Central reference for how NemoClaw is managed, triaged, reviewed, and shipped. Covers sprint cadence, version strategy, backlog refinement, escalation policy, quality gates, maintainer roles, and incident response."
keywords: governance, project management, sprint, escalation, backlog, maintainer, roles, incidents
topics: [maintainer, community]
tags: [maintainer, governance, project-management]
content_type: reference
difficulty: intermediate
audience: maintainers
status: active
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Project Governance

Central reference for how NemoClaw is managed, triaged, reviewed, and shipped. This document covers the gaps not addressed by the specific policy docs — see the [Cross-Reference Index](#cross-reference-index) at the bottom for the full map.

**Audience:** Maintainers and agents operating on the NemoClaw repo.

---

## 1. Sprint Cadence and Themes

NemoClaw runs **2-week sprints**, each closing with a release. A sprint is optionally anchored to a theme.

### Defining a sprint theme

A theme is a sentence that describes the focus for the period: "Reliability: reduce connection drop rate" or "Ecosystem: add Slack and Discord integration parity." Themes guide prioritization — they do not block unrelated work.

**Where themes live:** Open a GitHub milestone named `Sprint YYYY-WXX: [Theme]` (e.g., `Sprint 2026-W17: Reliability`). Assign issues and PRs to it. This gives skills and humans a single query target.

**Sprint kickoff checklist:**

1. Open the milestone with start and end dates
2. Set the release tag target for the sprint (e.g., `v0.0.24`)
3. Move approved backlog items matching the theme to `In Progress`
4. Ensure each item in the milestone has an owner or is unassigned-but-claimed

### Sprint review

At sprint close, the TPM runs the `nemoclaw-maintainer-evening` skill to generate a handoff summary and bump open items to the next sprint. The engineering maintainer then reviews the milestone: close shipped items, note what slipped and why, and cut the release tag.

---

## 2. Version Strategy

| Tag type | When | Required |
|---|---|---|
| **Patch** (`v0.0.x`) | Bug fixes, small enhancements, dependency bumps | Default — no changelog entry required |
| **Minor** (`v0.x.0`) | New user-facing capabilities, breaking config changes | Changelog entry + docs update in same PR |
| **Major** (`vx.0.0`) | API contract changes, significant architecture shifts | Design doc in Discussions + advance notice to users |

**Straggler policy:** Items labeled for a version that did not ship are automatically bumped to the next version by the `nemoclaw-maintainer-evening` skill. Do not manually reassign version labels for individual stragglers — let the automation handle it.

**Breaking change policy:**

- Label the PR with `breaking change`
- Call it out explicitly in the PR description
- Add an entry to `CHANGELOG.md`
- For minor and major bumps, update affected documentation in the same PR

---

## 3. Backlog Refinement

Feature requests arrive as `No Status` in Enhancement Parking — unreviewed, with no implied commitment.

**Promotion criteria (No Status → Backlog):**

- Clear user-facing use case that cannot be addressed by existing config or blueprints
- Non-trivial value: not already solved by a workaround users can apply themselves
- Maintainer has explicitly reviewed and approved it — never promote automatically

**Refinement cadence:** The `nemoclaw-maintainer-triage` skill scans unlabeled items daily and applies initial labels. Promotion from `No Status` to `Backlog` is a TPM decision — review the Enhancement Parking board and promote or close items at sprint kickoff. Items in `No Status` for 60+ days with no activity are candidates for closure.

**No timeline at Backlog state.** A timeline is only set when an item moves to `In Progress` and a sprint milestone is assigned.

---

## 4. Escalation Policy

### Architecture decision blocked

1. Post a comment naming the specific decision needed
2. Apply `status: blocked` + `needs-design` labels
3. Allow 14 days for async discussion in the issue or a linked Discussion thread
4. If unresolved after 14 days, escalate to a synchronous maintainer review

### Security concern (non-PSIRT)

1. Flag inline in the PR comment thread — do not close the PR
2. Notify the maintainer channel within 24 hours
3. If unresolved within 48 hours, escalate to [PSIRT](https://www.nvidia.com/en-us/security/) via `psirt@nvidia.com`
4. Do not describe the vulnerability in public comments if it has not been patched

### External dependency blocked

1. Apply `status: blocked`, note the specific blocker in a comment
2. Check status weekly
3. If unresolved after 30 days, evaluate a design-around or close as won't-fix with an explanation

### Contributor unresponsive

Follow the needs-info or needs-rebase 14-day flow (label day 0, warn day 7, close day 14). See [maintainer-guide.md](maintainer-guide.md) §9 and §9a.

---

## 5. Quality Gates

These complement the hard gates in `MERGE-GATE.md` and apply across all PRs.

**Always required:**

- CI must be green before merge — no exceptions for "known flaky" tests without a documented flake record in the issue tracker
- New user-facing behavior requires a docs update in the same PR (not a follow-up)

**Required for security-touching code:**

- Security sweep skill sign-off before merging
- "Security-touching" means: auth flows, credential handling, sandbox configuration, external API calls, shell execution, or file system access

**Required for performance-sensitive paths:**

- Benchmark comment in the PR showing before/after numbers
- "Performance-sensitive" means: inference routing, connection pooling, session management, or any hot path called on every user message

---

## 6. Maintainer Roles

| Role | Responsibilities |
|---|---|
| **TPM** | Runs `nemoclaw-maintainer-morning` and `nemoclaw-maintainer-evening` skills daily; first responder for new issues and PRs; manages sprint milestones and Enhancement Parking |
| **Engineering maintainer** | Runs auto-merges via `nemoclaw-maintainer-day`; cuts release tags; owns PR review queue and merge decisions |
| **Area owner: security** | Reviews PRs flagged for security sweep; approves PSIRT escalations |
| **Area owner: docs** | Reviews doc-only PRs and doc sections in feature PRs |
| **Area owner: testing** | Reviews test coverage gaps; approves CI changes |
| **Area owner: integrations** | Reviews PRs touching integration adapters (Slack, Discord, etc.) |

**Rotation:** Defined externally by the team. The TPM hands off context via the `nemoclaw-maintainer-evening` skill's handoff summary — not Slack threads.

**Decision authority:**

- Engineering maintainer can merge PRs and close issues unilaterally
- Minor release tags require a second maintainer to acknowledge the changelog entry
- Major release tags require a second maintainer sign-off and a Discussions thread open for at least 7 days

---

## 7. Incident Response

### Severity levels

| Level | Definition | Response |
|---|---|---|
| **P0** | Production outage, data loss, credential exposure | Immediate; skip normal review queue; PSIRT if security |
| **P1** | Critical breakage for a common configuration; blocked install | Prioritized in next morning plan; same-day fix target |
| **P2** | Significant bug with an available workaround | Backlog with `priority: medium`; target within 2 sprints |

### Hotfix flow

1. Branch off the affected release tag: `git checkout -b hotfix/description vX.Y.Z`
2. Apply the minimal fix — no unrelated changes
3. Open a PR labeled `hotfix` and `priority: high`
4. Security sweep if the fix touches auth, credentials, or external calls
5. Merge and cut a patch tag the same day
6. Backport to `main` if the fix applies there

### Post-incident review

For P0 and P1 incidents, open a GitHub Discussion in the Maintainers category within 48 hours of resolution. Cover: what happened, what the fix was, and what process change (if any) prevents recurrence.

---

## 8. Cross-Reference Index

This document covers sprint cadence, version strategy, backlog refinement, escalation, quality gates, maintainer roles, and incident response. Everything else is here:

| Topic | Document |
|---|---|
| Label taxonomy (3-tier) and board status semantics | [docs/project-workflow.md](project-workflow.md) |
| Community response templates and response time SLAs | [docs/maintainer-guide.md](maintainer-guide.md) |
| Quick-reference templates | [docs/maintainer-guide-snippet.md](maintainer-guide-snippet.md) |
| AI triage rules, tone, and skip list | [docs/triage-instructions.md](triage-instructions.md) |
| PR review priorities and queue ranking | `.agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md` |
| Merge hard gates | `.agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md` |
| Security code review checklist | `.agents/skills/nemoclaw-maintainer-security-code-review/SKILL.md` |
| Release tag and version bump procedures | `.agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md` |
| PSIRT and vulnerability disclosure | [SECURITY.md](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md) |
| Contributor scope and PR process | [CONTRIBUTING.md](https://github.com/NVIDIA/NemoClaw/blob/main/CONTRIBUTING.md) |

---

## Next Steps

- [Project Workflow](project-workflow.md) — board status semantics and label taxonomy
- [Maintainer Guide](maintainer-guide.md) — community response workflows and response time commitments
- [Triage Instructions](triage-instructions.md) — AI-assisted label triage rules
