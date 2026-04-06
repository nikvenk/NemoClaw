---
name: pr-review
description: Runs a multi-agent review pipeline on a GitHub PR — four parallel specialist agents (security, regression, test coverage, architecture) plus E2E test integration. Maps PR changes to E2E test suites, pulls Brev E2E results, and synthesizes everything into one constructive comment. Trigger keywords - review pr, review pull request, pr review, full review, code review, review this pr.
user_invocable: true
---

# Multi-Agent PR Review Pipeline

Run a comprehensive review of a GitHub pull request using four parallel specialist agents, integrate E2E test results from the Brev workflow, and produce a single well-structured comment ready to post.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `git` must be available.
- You must be in the NemoClaw repository or have network access to clone it.

## Step 1: Parse the PR and Checkout

If the user provided a PR URL or number, extract the owner, repo, and number. If not, ask for one.

Supported formats:

- `https://github.com/OWNER/REPO/pull/NUMBER`
- `#NUMBER` (assumes current repo)
- A raw number

Fetch PR metadata:

```bash
gh pr view <number> --json title,body,baseRefName,headRefName,author,files,labels,additions,deletions
```

Check out the code:

```bash
gh pr checkout <number>
```

Get the full diff:

```bash
BASE=$(gh pr view <number> --json baseRefName -q .baseRefName)
git diff "$BASE"...HEAD --name-status
git diff "$BASE"...HEAD
```

Read every changed file in full.

### Fetch linked issue context

Parse the PR body for linked issues (`Fixes #N`, `Closes #N`, `Resolves #N`). For each linked issue, fetch its body:

```bash
gh issue view <issue-number> --json title,body,labels,state
```

This gives agents the *problem description* — what's broken, what was expected, who reported it — not just the diff. Pass the issue title and body to all four agents alongside the PR metadata.

If no linked issue is found, skip this step.

## Step 2: Map Changes to E2E Test Suites

Before launching review agents, determine which E2E test suites are relevant to this PR based on changed files. This mapping drives both the E2E recommendation and the regression agent's focus.

| Changed files | E2E test suite | TEST_SUITE value |
|---|---|---|
| `nemoclaw/src/commands/onboard*`, `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/blueprint.yaml`, `scripts/install.sh` | Full install → onboard → sandbox → inference | `full` |
| `nemoclaw/src/commands/deploy*`, `nemoclaw/src/deploy/` | Deploy CLI provisions remote sandbox | `deploy-cli` (via local `nemoclaw deploy`) |
| Credential handling, `sanitize*`, `migration*`, auth-profiles, snapshot logic | Credential stripping and sanitization | `credential-sanitization` |
| `nemoclaw/src/messaging/`, `nemoclaw-blueprint/orchestrator/telegram*`, `nemoclaw-blueprint/orchestrator/discord*`, bridge scripts | Messaging provider creation, credential isolation, L7 proxy | `messaging-providers` |
| Telegram bridge, input handling, `SANDBOX_NAME` validation | Command injection prevention | `telegram-injection` |
| Policies, Dockerfile, sandbox config, network rules | Security-focused — run `all` (credential-sanitization + telegram-injection) | `all` |
| Docs only, CI only, test-only changes | No E2E needed | — |

If multiple suites match, prefer `all` or list them individually.

## Step 3: Check for Existing E2E Results

Before recommending an E2E run, check if one already ran for this PR:

```bash
# Check PR checks
gh pr checks <number>

# Check for workflow runs on this PR
gh run list --workflow=e2e-brev.yaml --branch=$(gh pr view <number> --json headRefName -q .headRefName) --limit 5
```

If results exist, fetch them:

```bash
gh run view <run-id> --log 2>/dev/null | tail -50
```

Record the E2E status (passed, failed, not run) for inclusion in the final comment.

## Step 4: Launch Four Parallel Review Agents

Use the Agent tool to spawn four specialist agents in parallel. Each agent receives:

- The full diff (`git diff $BASE...HEAD`)
- The list of changed files
- The PR description and linked issues
- The full content of every changed file

Each agent must read the changed files itself and produce a structured findings report.

### Agent 1: Security Reviewer

**Persona:** Application security engineer performing an appsec review.

**Prompt template:**

```text
You are a security reviewer for the NemoClaw open source project — a sandboxed runtime for AI agents. Review PR #<number> for security issues.

PR title: <title>
PR description: <body>
Linked issue: <issue title and body, if available — this describes the root problem being fixed>
Changed files: <file list>

Read every changed file and the diff. Apply this 9-category checklist, assigning PASS/WARNING/FAIL to each:

1. Secrets and Credentials — no hardcoded secrets, tokens via env vars only
2. Input Validation — all user input validated, no injection (command, path, SSRF)
3. Auth and Authorization — endpoints enforce auth, no privilege escalation
4. Dependencies — new deps checked for CVEs, pinned versions, trusted registries
5. Error Handling — no secrets/stack traces in error output, no PII in logs
6. Cryptography — standard algorithms only, no MD5/SHA-1 for security
7. Configuration — secure defaults, non-root containers, minimal ports
8. Security Testing — security edge cases tested, no coverage regression
9. Holistic Posture — least privilege, no TOCTOU races, no overall degradation

For NemoClaw, pay special attention to sandbox escape vectors: SSRF bypasses, Dockerfile injection, network policy circumvention, credential leakage, blueprint tampering.

Output format:
- A verdict table (category | verdict | one-line justification)
- Detailed findings with file:line, severity, description, and suggested fix
- Overall risk assessment (one paragraph)
```

### Agent 2: Regression Reviewer

**Persona:** QA engineer focused on "does this break existing behavior?"

**Prompt template:**

```text
You are a QA/regression reviewer for the NemoClaw open source project. Review PR #<number> for regressions — changes that could break existing functionality.

PR title: <title>
PR description: <body>
Linked issue: <issue title and body, if available — verify the fix addresses the root cause described here, not just symptoms>
Changed files: <file list>
Relevant E2E test suites for this PR: <mapped suites from Step 2>
E2E status: <passed/failed/not run from Step 3>

Read every changed file and the diff. Check for:

1. Changed function signatures, renamed exports, or modified return types that callers depend on
2. Modified CLI flags, config schema, or default values that users or scripts rely on
3. Removed or changed error messages that other code matches against
4. Changed behavior in onboarding, inference routing, or sandbox lifecycle
5. State management changes (sandboxes.json, auth-profiles.json, migration snapshots)
6. Docker/blueprint changes that affect sandbox creation or startup
7. Race conditions introduced by changed async/concurrent logic
8. Platform-specific regressions (macOS vs Linux vs DGX Spark)

Cross-reference with E2E results if available:
- If E2E passed: note which areas are covered and which are NOT covered by E2E
- If E2E failed: identify which failure likely relates to this PR's changes
- If E2E not run: recommend which suite(s) to run and why

Output format:
- Regression risk assessment (high/medium/low with justification)
- List of specific regression risks with file:line and impact description
- E2E coverage analysis (what's tested vs what's not)
- Recommended manual testing steps for anything E2E doesn't cover
```

### Agent 3: Test Coverage Reviewer

**Persona:** Test architect evaluating whether the changes are adequately tested.

**Prompt template:**

```text
You are a test coverage reviewer for the NemoClaw open source project. Review PR #<number> for test adequacy.

PR title: <title>
PR description: <body>
Linked issue: <issue title and body, if available>
Changed files: <file list>

Read every changed file and the diff. Evaluate:

1. Are new code paths covered by unit or integration tests in this PR?
2. Are edge cases tested (empty input, missing config, network failure, invalid state)?
3. Are error paths tested (what happens when things fail)?
4. Does this PR modify existing tests? If so, are the modifications justified by the code changes or are they weakening assertions?
5. Are there existing test files for the modified modules? If tests exist but weren't updated, is that a gap?
6. For CLI command changes: are there command-line integration tests?
7. For blueprint/policy changes: are there E2E test scripts that cover this?

Cross-reference with existing E2E test scripts in test/e2e/:
- test-full-e2e.sh — install, onboard, sandbox, live inference
- test-credential-sanitization.sh — credential stripping, auth-profiles, digest verification
- test-telegram-injection.sh — command injection prevention
- test-messaging-providers.sh — provider creation, credential isolation, L7 proxy
- test-double-onboard.sh — re-onboarding behavior
- test-onboard-repair.sh — onboard recovery
- test-onboard-resume.sh — onboard resume after interruption
- test-sandbox-survival.sh — sandbox persistence across restarts

Output format:
- Coverage verdict (adequate/gaps/insufficient)
- List of untested code paths with file:line and what test is needed
- Suggested test additions (concrete test descriptions, not just "add tests")
- Note any tests that were weakened or removed
```

### Agent 4: Architecture Reviewer ("Majora")

**Persona:** Senior architect ensuring the PR respects NemoClaw's design boundaries and conventions.

**Prompt template:**

```text
You are "Majora", an architecture reviewer for the NemoClaw open source project. You have high signal-to-noise ratio — only flag things that genuinely matter for maintainability and architectural coherence.

PR title: <title>
PR description: <body>
Linked issue: <issue title and body, if available>
Changed files: <file list>

Read every changed file and the diff. NemoClaw has a clear layered architecture:

- CLI plugin layer (`nemoclaw/src/`) — user-facing commands, thin orchestration
- Blueprint layer (`nemoclaw-blueprint/`) — Dockerfile, orchestrator scripts, policy files
- OpenShell runtime — managed by OpenShell CLI, not by NemoClaw directly
- Policies (`nemoclaw-blueprint/policies/`) — declarative YAML network/process rules
- Scripts (`scripts/`) — setup, installation, deployment helpers

Review for:

1. Layer violations — does CLI code reach into blueprint internals? Does blueprint code assume CLI state? Is NemoClaw doing something that should be an OpenShell concern?
2. Module boundaries — are new functions in the right file/module? Is there code that belongs in a different layer?
3. API contracts — do changes to shared interfaces (CLI flags, config schema, env vars, file formats) maintain backward compatibility or document breaking changes?
4. Naming and conventions — do new commands, flags, env vars, and file paths follow existing patterns?
5. Complexity budget — is the added complexity justified by the problem being solved? Could this be simpler without losing functionality?
6. Separation of concerns — is one function/file doing too many things? Are concerns mixed (e.g., UI logic in business logic)?

DO NOT flag:
- Subjective style preferences (quote style, bracket placement)
- Minor naming opinions unless genuinely confusing
- "Could be more elegant" without a concrete improvement
- Anything that works correctly and is readable

Output format:
- Architecture verdict (clean/minor concerns/significant concerns)
- Only list findings that a senior maintainer would actually want addressed
- For each finding: file:line, what the concern is, why it matters for long-term maintainability, and a concrete suggestion
```

## Step 5: Collect Agent Results

Wait for all four agents to complete. Gather their structured outputs.

## Step 6: Present Full Analysis to the Reviewer

Show the **full detailed analysis** from all four agents directly in the conversation. This is for the reviewer's eyes only — it does NOT get posted to GitHub. Include:

- All verdict tables, detailed findings, file:line references, risk assessments
- Deduplicated where agents overlap (merge into the most actionable framing)
- E2E status and coverage analysis
- Regression risks, test gaps, architecture concerns — everything

This is the reviewer's decision-making context. Keep it comprehensive.

## Step 7: Draft the Concise PR Comment

After showing the full analysis, draft a **short, concise** PR comment for GitHub using `references/comment-template.md`. The comment must be:

- **Brief** — aim for under 30 lines. Contributors should be able to read it in 30 seconds.
- **Actionable** — only include things the contributor needs to act on or know about.
- **Structured** — verdict line, blockers (if any), 2-3 key non-blocking callouts, done.

Omit sections that have nothing to report (no empty "Blocking: None" sections). Don't repeat the PR description back. Don't include the full security verdict table unless there are WARNING/FAIL items worth calling out.

### Deduplication

Multiple agents may flag the same issue. Deduplicate:

- If the same file:line appears in multiple agent reports, merge into one finding.
- Credit the finding to whichever agent's framing is most actionable.

### Blocking vs Non-blocking

- **Blocking** — security FAIL verdicts, confirmed bugs, regressions, breaking changes without migration
- **Non-blocking** — security WARNINGs, test coverage gaps, architecture nits. Pick only the top 2-3 most important ones for the comment.

## Step 8: Present to the User

Show the drafted comment. Ask if they want to:

1. Post as-is via `gh pr review <number> --comment`
2. Edit first
3. Post as formal review (`--approve` or `--request-changes`)
4. Trigger an E2E run first via `gh workflow run e2e-brev.yaml -f pr_number=<number> -f test_suite=<suite> -f brev_token=<token>` (user provides token)

Never post without user confirmation.

## Important Notes

- If the PR has no code changes (docs-only, CI-only), skip functional agents and focus on doc quality. Still run the architecture agent to check doc structure.
- If the PR is a draft, adjust tone — focus on direction rather than line-level feedback.
- For first-time contributors, be extra welcoming. Link to `CONTRIBUTING.md` if needed.
- When the PR fixes a known issue, verify the fix addresses the root cause described in the issue.
- Each agent runs with full repo checkout for context — they can read any file, not just changed ones.
- The agents run in parallel using the Agent tool. Do not run them sequentially.
