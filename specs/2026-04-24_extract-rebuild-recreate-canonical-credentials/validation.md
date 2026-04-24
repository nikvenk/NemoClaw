# Validation Plan: Extract Rebuild Recreate Path & Canonicalize Credential Resolution

Generated from: `specs/2026-04-24_extract-rebuild-recreate-canonical-credentials/spec.md`
Test Spec: `specs/2026-04-24_extract-rebuild-recreate-canonical-credentials/tests.md`

## Overview

**Feature**: Replace the fragile `onboard()` call in `sandboxRebuild()` with a focused `recreateSandbox()` function, and canonicalize provider credential resolution with lint enforcement.

**Available Tools**:
- `vitest` — unit and integration test runner
- `bash` — shell scripts for E2E validation
- `gh` CLI — GitHub issue/PR management
- `npm run build:cli` — TypeScript compilation
- `npx eslint` — linting
- Nightly E2E workflows — `test/e2e/test-rebuild-openclaw.sh`, `test/e2e/test-rebuild-hermes.sh` on self-hosted runner
- `nemoclaw` CLI — end-to-end sandbox operations

## Coverage Summary

- Happy Paths: 8 scenarios
- Sad Paths: 7 scenarios
- Total: 15 scenarios

## Scope: What Unit Tests Already Cover

The test spec (`tests.md`) covers 57 unit/integration tests including:
- All 6 provider credential resolution paths (parametric)
- Each `RecreateError` code path
- Each sub-function (validate, create, inference, agent, policy) happy + failure
- `sandboxRebuild` CLI output assertions (recovery instructions, exit codes)
- ESLint rule valid/invalid patterns

This validation plan focuses on **end-to-end observable behavior** that unit tests cannot cover: real Docker sandbox operations, real gateway interaction, real credential file I/O, and CI workflow integration.

---

## Phase 1: Canonical Credential Resolution — Validation Scenarios

### Scenario 1.1: Credential resolved from file during non-interactive onboard [STATUS: pending]
**Type**: Happy Path

**Given**: A fresh temp HOME with `~/.nemoclaw/credentials.json` containing `NVIDIA_API_KEY`, no `NVIDIA_API_KEY` in `process.env`
**When**: `resolveProviderCredential("NVIDIA_API_KEY")` is called (via compiled dist module)
**Then**: Returns the saved value AND `process.env.NVIDIA_API_KEY` is populated

**Validation Steps**:
1. **Setup**: bash: Create temp HOME, write `credentials.json` with test key
2. **Execute**: node: Run a script that imports `dist/lib/credentials.js`, calls `resolveProviderCredential`, reports result as JSON
3. **Verify**: bash: Parse JSON output, assert returned value matches saved, assert env was populated

**Tools Required**: node, bash

---

### Scenario 1.2: Credential not found anywhere returns null without side effects [STATUS: pending]
**Type**: Sad Path

**Given**: Empty temp HOME, no env var set for `NVIDIA_API_KEY`
**When**: `resolveProviderCredential("NVIDIA_API_KEY")` is called
**Then**: Returns `null`, `process.env.NVIDIA_API_KEY` remains undefined

**Validation Steps**:
1. **Setup**: bash: Create empty temp HOME
2. **Execute**: node: Run script calling `resolveProviderCredential`, report result + env state
3. **Verify**: bash: Assert null return, assert env key absent

**Tools Required**: node, bash

---

### Scenario 1.3: hydrateCredentialEnv backward compatibility [STATUS: pending]
**Type**: Happy Path

**Given**: Existing code in onboard.ts that calls `hydrateCredentialEnv(credentialEnv)`
**When**: `npm run build:cli` compiles and `npm test` runs
**Then**: All existing `test/rebuild-credential-hydration.test.ts` tests pass without modification

**Validation Steps**:
1. **Execute**: bash: `npm run build:cli && npx vitest run test/rebuild-credential-hydration.test.ts`
2. **Verify**: bash: Exit code 0, all 6 parametric tests pass

**Tools Required**: npm, vitest

---

## Phase 2: Extract Composable Sandbox Primitives — Validation Scenarios

### Scenario 2.1: sandbox-recreate.ts compiles and exports correct interface [STATUS: pending]
**Type**: Happy Path

**Given**: `src/lib/sandbox-recreate.ts` exists with all exported functions
**When**: `npm run build:cli` is executed
**Then**: `dist/lib/sandbox-recreate.js` exists and exports `recreateSandbox`, `RecreateError`, `validateRecreateCredentials`, `createSandboxDirect`, `configureInferenceDirect`, `setupAgentDirect`, `applyPolicyPresetsDirect`

**Validation Steps**:
1. **Execute**: bash: `npm run build:cli`
2. **Verify**: node: `const m = require('./dist/lib/sandbox-recreate.js'); console.log(Object.keys(m))` — verify all expected exports present
3. **Verify**: bash: Assert exit code 0 from build

**Tools Required**: npm, node

---

### Scenario 2.2: No process.exit calls in sandbox-recreate.ts [STATUS: pending]
**Type**: Happy Path (structural guarantee)

**Given**: `src/lib/sandbox-recreate.ts` file on disk
**When**: Searching for `process.exit` in the source
**Then**: Zero occurrences found

**Validation Steps**:
1. **Execute**: bash: `grep -c "process\.exit" src/lib/sandbox-recreate.ts`
2. **Verify**: bash: Output is `0`

**Tools Required**: grep

---

### Scenario 2.3: RecreateError is instanceof Error with correct code [STATUS: pending]
**Type**: Happy Path

**Given**: Compiled `dist/lib/sandbox-recreate.js`
**When**: `new RecreateError("test", "credential_missing")` is created
**Then**: `err instanceof Error === true`, `err.name === "RecreateError"`, `err.code === "credential_missing"`

**Validation Steps**:
1. **Execute**: node: Import module, construct error, check properties
2. **Verify**: node: Assert all properties correct

**Tools Required**: node

---

## Phase 3: Rewire sandboxRebuild — Validation Scenarios

### Scenario 3.1: Rebuild succeeds end-to-end with real sandbox (OpenClaw) [STATUS: pending]
**Type**: Happy Path

**Given**: A running OpenClaw sandbox created via `nemoclaw onboard`, `NVIDIA_API_KEY` saved in credentials.json
**When**: `nemoclaw <sandbox> rebuild --yes` is executed
**Then**: Sandbox is destroyed and recreated, workspace state is restored, inference works, policy presets survive

**Validation Steps**:
1. **Setup**: bash: Ensure sandbox is running with `nemoclaw list`
2. **Setup**: bash: Write a marker file into sandbox workspace: `openshell sandbox exec <name> bash -c 'echo MARKER > /sandbox/.openclaw-data/workspace/marker.txt'`
3. **Setup**: bash: Record applied policy presets: `nemoclaw <name> policy-list`
4. **Execute**: bash: `nemoclaw <name> rebuild --yes`
5. **Verify**: bash: Exit code 0
6. **Verify**: bash: `nemoclaw <name> status` shows sandbox running
7. **Verify**: bash: Marker file exists: `openshell sandbox exec <name> cat /sandbox/.openclaw-data/workspace/marker.txt` outputs `MARKER`
8. **Verify**: bash: Policy presets match pre-rebuild state: `nemoclaw <name> policy-list`
9. **Verify**: bash: No onboard lock file left behind: `[ ! -f ~/.nemoclaw/onboard.lock ]`

**Tools Required**: nemoclaw CLI, openshell CLI, bash
**Environment**: Self-hosted runner with Docker (nightly E2E or sparky)

---

### Scenario 3.2: Rebuild fails gracefully when credential is missing [STATUS: pending]
**Type**: Sad Path

**Given**: A running sandbox, `NVIDIA_API_KEY` removed from both env and `credentials.json`
**When**: `nemoclaw <sandbox> rebuild --yes` is executed
**Then**: Rebuild aborts BEFORE destroying the sandbox, prints "Rebuild preflight failed", sandbox is untouched

**Validation Steps**:
1. **Setup**: bash: Remove credential: `nemoclaw credentials reset NVIDIA_API_KEY --yes`, `unset NVIDIA_API_KEY`
2. **Execute**: bash: `nemoclaw <name> rebuild --yes 2>&1`
3. **Verify**: bash: Exit code non-zero
4. **Verify**: bash: Output contains "Rebuild preflight failed" and "Sandbox is untouched"
5. **Verify**: bash: Sandbox is still running: `nemoclaw <name> status` shows healthy

**Tools Required**: nemoclaw CLI, bash
**Environment**: Self-hosted runner with Docker

---

### Scenario 3.3: Rebuild recovery instructions on recreate failure [STATUS: pending]
**Type**: Sad Path

**Given**: A running sandbox with valid credential, but the Docker daemon is stopped/broken after backup+delete
**When**: `nemoclaw <sandbox> rebuild --yes` is executed and sandbox creation fails
**Then**: Recovery instructions are printed including backup path, `onboard --resume` command, and `snapshot restore` command

**Validation Steps**:
1. **Setup**: This scenario is hard to reproduce with real infrastructure. Rely on the unit test (test #25 in tests.md) which uses fake openshell.
2. **Verify**: Unit test covers: stderr contains "Recreate failed", "recover manually", "onboard --resume", backup path

**Tools Required**: vitest (unit test)
**Note**: Validated via unit test, not E2E.

---

### Scenario 3.4: upgrade-sandboxes batch rebuild works [STATUS: pending]
**Type**: Happy Path

**Given**: Two running sandboxes, one at a stale agent version
**When**: `nemoclaw upgrade-sandboxes --auto` is executed
**Then**: Stale sandbox is rebuilt, current sandbox is skipped, batch completes successfully

**Validation Steps**:
1. **Setup**: bash: Create two sandboxes via onboard, manually set one's agentVersion to an old value in `~/.nemoclaw/sandboxes.json`
2. **Execute**: bash: `nemoclaw upgrade-sandboxes --auto`
3. **Verify**: bash: Output shows one sandbox rebuilt, one skipped ("up to date")
4. **Verify**: bash: Both sandboxes are running after the batch

**Tools Required**: nemoclaw CLI, bash
**Environment**: Self-hosted runner with Docker

---

### Scenario 3.5: No session file manipulation during rebuild [STATUS: pending]
**Type**: Happy Path (structural guarantee)

**Given**: A running sandbox with a valid session file
**When**: `nemoclaw <sandbox> rebuild --yes` is executed
**Then**: The session file (`~/.nemoclaw/onboard-session.json`) is NOT modified by rebuild before the recreate step. No `resumable: true` or `status: in_progress` written.

**Validation Steps**:
1. **Setup**: bash: Record session file checksum before rebuild: `md5 ~/.nemoclaw/onboard-session.json`
2. **Execute**: bash: Run rebuild but instrument to check session mid-flight (or check afterward)
3. **Verify**: bash: Session file was not written with `resumable: true` and `status: in_progress` by rebuild (may have been modified by recreateSandbox internals for different reasons — the key check is no `onboardSession.updateSession` call from nemoclaw.ts)

**Tools Required**: bash, nemoclaw CLI
**Note**: Best validated by grep-checking `src/nemoclaw.ts` for absence of `onboardSession.updateSession` in `sandboxRebuild()`.

---

### Scenario 3.6: No process.exit interceptor in sandboxRebuild [STATUS: pending]
**Type**: Happy Path (structural guarantee)

**Given**: `src/nemoclaw.ts` after Phase 3 changes
**When**: Searching for process.exit override pattern in `sandboxRebuild`
**Then**: No `_savedExit`, no `process.exit = `, no `RebuildOnboardExit` sentinel

**Validation Steps**:
1. **Execute**: bash: `sed -n '/^async function sandboxRebuild/,/^async function \|^function \|^const \|^\/\/ ──/p' src/nemoclaw.ts | grep -E '_savedExit|process\.exit\s*=|RebuildOnboardExit'`
2. **Verify**: bash: Zero matches

**Tools Required**: grep, sed

---

### Scenario 3.7: Policy presets applied exactly once [STATUS: pending]
**Type**: Happy Path

**Given**: A sandbox with policy presets ["balanced", "npm"] saved in backup manifest
**When**: `nemoclaw <sandbox> rebuild --yes` is executed
**Then**: After rebuild, `nemoclaw <name> policy-list` shows exactly ["balanced", "npm"] — not duplicated

**Validation Steps**:
1. **Setup**: bash: Apply presets, confirm with `policy-list`
2. **Execute**: bash: `nemoclaw <name> rebuild --yes`
3. **Verify**: bash: `nemoclaw <name> policy-list` matches pre-rebuild state exactly

**Tools Required**: nemoclaw CLI, bash
**Environment**: Self-hosted runner with Docker

---

## Phase 4: ESLint Guard Rule — Validation Scenarios

### Scenario 4.1: ESLint passes on onboard.ts with no credential env violations [STATUS: pending]
**Type**: Happy Path

**Given**: Phase 1 changes applied (all direct `process.env[credentialKey]` replaced), ESLint rule registered
**When**: `npx eslint src/lib/onboard.ts` is executed
**Then**: Zero violations for rule `nemoclaw/no-direct-credential-env`

**Validation Steps**:
1. **Execute**: bash: `npx eslint src/lib/onboard.ts --format json`
2. **Verify**: bash: Parse JSON, count messages with ruleId `nemoclaw/no-direct-credential-env` — expect 0

**Tools Required**: eslint, bash

---

### Scenario 4.2: ESLint catches regression if someone adds direct process.env credential access [STATUS: pending]
**Type**: Sad Path (regression guard)

**Given**: A temporary modification to `src/lib/onboard.ts` adding `if (!process.env.NVIDIA_API_KEY)` in the provider selection area
**When**: `npx eslint src/lib/onboard.ts` is executed
**Then**: At least one violation reported for `nemoclaw/no-direct-credential-env`

**Validation Steps**:
1. **Setup**: bash: Add a line `const _test = process.env.NVIDIA_API_KEY;` to onboard.ts
2. **Execute**: bash: `npx eslint src/lib/onboard.ts --format json`
3. **Verify**: bash: At least 1 message with ruleId `nemoclaw/no-direct-credential-env`
4. **Cleanup**: bash: `git checkout src/lib/onboard.ts`

**Tools Required**: eslint, git, bash

---

## Phase 5: Clean the House — Validation Scenarios

### Scenario 5.1: Full test suite passes [STATUS: pending]
**Type**: Happy Path

**Given**: All phases implemented
**When**: `npm test` is executed
**Then**: All tests pass, zero failures

**Validation Steps**:
1. **Execute**: bash: `npm test`
2. **Verify**: bash: Exit code 0

**Tools Required**: npm, vitest

---

### Scenario 5.2: No TODO or FIXME references to #2306 remain [STATUS: pending]
**Type**: Happy Path (cleanup)

**Given**: All phases implemented
**When**: Searching the codebase for `TODO.*2306` or `FIXME.*2306`
**Then**: Zero matches

**Validation Steps**:
1. **Execute**: bash: `grep -rn "TODO.*2306\|FIXME.*2306" src/ test/ eslint-rules/`
2. **Verify**: bash: Zero output

**Tools Required**: grep

---

## Nightly E2E Integration

The existing nightly E2E workflow (`nightly-e2e.yaml`) includes two rebuild tests:
- `rebuild-openclaw-e2e` → `test/e2e/test-rebuild-openclaw.sh`
- `rebuild-hermes-e2e` → `test/e2e/test-rebuild-hermes.sh`

These scripts test the full rebuild lifecycle: install → create old sandbox → write markers → rebuild → verify markers survive → verify version updated → verify no credential leaks → verify policy presets survive.

**After merging this PR**, these E2E tests should pass without modification because the external behavior of `nemoclaw <name> rebuild --yes` is unchanged. The nightly run validates Scenarios 3.1 and 3.7 automatically.

If modifications to the E2E scripts are needed (unlikely), update them in the same PR.

---

## Summary

| Phase | Happy | Sad | Total | Passed | Failed | Pending |
|-------|-------|-----|-------|--------|--------|---------|
| Phase 1: Credential Resolution | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 2: Sandbox Primitives | 2 | 1 | 3 | 0 | 0 | 3 |
| Phase 3: Rewire sandboxRebuild | 4 | 1 | 5 | 0 | 0 | 5 |
| Phase 4: ESLint Guard | 1 | 1 | 2 | 0 | 0 | 2 |
| Phase 5: Clean the House | 2 | 0 | 2 | 0 | 0 | 2 |
| **Total** | **11** | **4** | **15** | **0** | **0** | **15** |
