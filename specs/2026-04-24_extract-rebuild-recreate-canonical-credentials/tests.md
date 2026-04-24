# Test Specification: Extract Rebuild Recreate Path & Canonicalize Credential Resolution

**Spec:** `specs/2026-04-24_extract-rebuild-recreate-canonical-credentials/spec.md`

## Test Patterns & Conventions

This project uses **vitest** with the following patterns established by existing tests:

- **Test files:** `test/<feature>.test.ts` for integration/CLI tests, `src/lib/<module>.test.ts` for co-located unit tests
- **Imports:** `import { describe, expect, it, vi, afterEach, beforeEach } from "vitest"`
- **Compiled module testing:** Many tests import from `dist/lib/<module>.js` via `require()` or dynamic `import()`, using `vi.resetModules()` to get a fresh instance. This is because `src/lib/onboard.ts` uses `module.exports` (CJS), not ESM exports.
- **Subprocess testing:** CLI behavior is tested by spawning `node dist/nemoclaw.js` with fake binaries for `openshell` and `ssh` in a temp directory, pointed at a temp `HOME` with fixture data.
- **Temp fixture cleanup:** Tests create temp dirs via `fs.mkdtempSync()`, track them in an array, and clean up in `afterEach`.
- **Timeout:** Long-running subprocess tests use `{ timeout: 60_000 }`.

---

### Phase 1: Canonical Credential Resolution - Test Guide

**Existing Tests to Modify:**

- `test/rebuild-credential-hydration.test.ts`
  - Current behavior: Tests `hydrateCredentialEnv()` imported from `dist/lib/onboard.js` for all 6 providers
  - Required changes: Add parallel tests that verify `resolveProviderCredential()` imported from `dist/lib/credentials.js` — same parametric structure but testing the canonical function directly. Keep the existing hydrateCredentialEnv tests (they validate the delegation still works).

- `test/credentials.test.ts`
  - Current behavior: Tests `getCredential`, `saveCredential`, `loadCredentials`, `normalizeCredentialValue`
  - Required changes: Add test cases for `resolveProviderCredential` in the same file, since it lives in `credentials.ts`

**New Tests to Create:**

**File: `test/canonical-credential-resolution.test.ts`**

This is the primary parametric test file that ensures all 6 providers resolve credentials identically through the canonical function.

1. `resolveProviderCredential resolves NVIDIA_API_KEY from credentials.json when not in env`
   - **Input:** Temp HOME with `credentials.json: { "NVIDIA_API_KEY": "nvapi-test-resolve" }`, `process.env.NVIDIA_API_KEY` deleted
   - **Expected:** Returns `"nvapi-test-resolve"`, `process.env.NVIDIA_API_KEY` is now set to `"nvapi-test-resolve"`
   - **Covers:** AC: "resolveProviderCredential() is exported from src/lib/credentials.ts" + "All 6 parametric test cases pass"

2. `resolveProviderCredential resolves OPENAI_API_KEY from credentials.json when not in env`
   - **Input:** Same pattern as above with `OPENAI_API_KEY`
   - **Expected:** Returns the saved value, populates process.env
   - **Covers:** AC: "All 6 parametric test cases pass"

3. `resolveProviderCredential resolves ANTHROPIC_API_KEY from credentials.json when not in env`
   - **Input:** Same pattern with `ANTHROPIC_API_KEY`
   - **Expected:** Returns the saved value, populates process.env
   - **Covers:** AC: "All 6 parametric test cases pass"

4. `resolveProviderCredential resolves GEMINI_API_KEY from credentials.json when not in env`
   - **Input:** Same pattern with `GEMINI_API_KEY`
   - **Expected:** Returns the saved value, populates process.env
   - **Covers:** AC: "All 6 parametric test cases pass"

5. `resolveProviderCredential resolves COMPATIBLE_API_KEY from credentials.json when not in env`
   - **Input:** Same pattern with `COMPATIBLE_API_KEY`
   - **Expected:** Returns the saved value, populates process.env
   - **Covers:** AC: "All 6 parametric test cases pass"

6. `resolveProviderCredential resolves COMPATIBLE_ANTHROPIC_API_KEY from credentials.json when not in env`
   - **Input:** Same pattern with `COMPATIBLE_ANTHROPIC_API_KEY`
   - **Expected:** Returns the saved value, populates process.env
   - **Covers:** AC: "All 6 parametric test cases pass"

7. `resolveProviderCredential returns env value when only in process.env`
   - **Input:** `process.env.TEST_KEY = "from-env"`, no credentials.json entry
   - **Expected:** Returns `"from-env"`
   - **Covers:** AC: "Edge case tests pass: env-only"

8. `resolveProviderCredential prefers env over credentials.json`
   - **Input:** `process.env.TEST_KEY = "from-env"`, credentials.json has `"TEST_KEY": "from-file"`
   - **Expected:** Returns `"from-env"` (existing getCredential behavior: env first)
   - **Covers:** AC: "Edge case tests pass: both"

9. `resolveProviderCredential returns null when credential exists nowhere`
   - **Input:** No env var, no credentials.json entry
   - **Expected:** Returns `null`, `process.env.TEST_KEY` remains undefined
   - **Covers:** AC: "Edge case tests pass: missing"

10. `resolveProviderCredential normalizes whitespace and carriage returns`
    - **Input:** credentials.json has `"TEST_KEY": "  nvapi-key \r\n"`
    - **Expected:** Returns `"nvapi-key"`, `process.env.TEST_KEY` is `"nvapi-key"`
    - **Covers:** AC: "Edge case tests pass: whitespace"

11. `resolveProviderCredential populates process.env on successful resolve from file`
    - **Input:** Only in credentials.json
    - **Expected:** After call, `process.env[key]` equals the resolved value
    - **Covers:** AC: Core behavior — downstream code reading process.env sees the value

12. `resolveProviderCredential does not pollute process.env on null resolve`
    - **Input:** Key exists nowhere
    - **Expected:** `process.env[key]` remains `undefined` after the call
    - **Covers:** AC: No side effects on missing credentials

**Test Implementation Notes:**
- Use the same `spawnSync` + temp HOME + child process pattern as `test/rebuild-credential-hydration.test.ts`. The function is in `dist/lib/credentials.js` so it needs `npm run build:cli` first.
- Alternatively, use `vi.resetModules()` + `vi.stubEnv("HOME", tmpDir)` + dynamic `import("../dist/lib/credentials.js")` like `test/credentials.test.ts` does. This avoids subprocess overhead.
- The parametric tests (1–6) should use a `for...of` loop over the 6 provider configs, generating one `it()` per provider (same pattern as existing hydration tests).

**File modifications: `test/credentials.test.ts`**

13. `resolveProviderCredential is exported and callable`
    - **Input:** Import the module, check `typeof credentials.resolveProviderCredential`
    - **Expected:** `"function"`
    - **Covers:** AC: "resolveProviderCredential() is exported from src/lib/credentials.ts"

**File modifications: `test/rebuild-credential-hydration.test.ts`**

14. `hydrateCredentialEnv still works after delegation (backward compat)`
    - **Input:** Existing tests unchanged — they test hydrateCredentialEnv
    - **Expected:** All 6 existing parametric tests still pass
    - **Covers:** AC: "hydrateCredentialEnv() delegates to resolveProviderCredential() — no duplicate logic"

---

### Phase 2: Extract Composable Sandbox Primitives - Test Guide

**Existing Tests to Modify:**

None — Phase 2 creates a new module. Existing tests are unaffected.

**New Tests to Create:**

**File: `src/lib/sandbox-recreate.test.ts`**

This file tests the extracted primitives using mocked dependencies. Since `sandbox-recreate.ts` composes functions from `onboard.ts`, `runner.ts`, `credentials.ts`, etc., we mock the external calls (openshell CLI, Docker) and test the composition logic.

**RecreateError tests:**

1. `RecreateError has correct name and code for credential_missing`
   - **Input:** `new RecreateError("Missing NVIDIA_API_KEY", "credential_missing")`
   - **Expected:** `err.name === "RecreateError"`, `err.code === "credential_missing"`, `err.message === "Missing NVIDIA_API_KEY"`, `err instanceof Error === true`
   - **Covers:** AC: "RecreateError.code allows callers to distinguish failure types"

2. `RecreateError has correct name and code for each failure type`
   - **Input:** Construct with each of the 5 codes: `credential_missing`, `sandbox_create_failed`, `inference_failed`, `agent_setup_failed`, `policy_failed`
   - **Expected:** Each has the correct `.code` and `.name`
   - **Covers:** AC: "RecreateError.code allows callers to distinguish failure types"

**validateRecreateCredentials tests:**

3. `validateRecreateCredentials passes when credential exists`
   - **Input:** Mock `resolveProviderCredential("NVIDIA_API_KEY")` to return `"nvapi-xxx"`
   - **Expected:** Does not throw
   - **Covers:** AC: Happy path

4. `validateRecreateCredentials throws credential_missing when credential is absent`
   - **Input:** Mock `resolveProviderCredential("NVIDIA_API_KEY")` to return `null`
   - **Expected:** Throws `RecreateError` with code `"credential_missing"`, message mentions `NVIDIA_API_KEY`
   - **Covers:** AC: "Credential validation failure → throws with code credential_missing"

5. `validateRecreateCredentials skips validation when credentialEnv is null (local inference)`
   - **Input:** `credentialEnv = null`
   - **Expected:** Does not throw, does not call resolveProviderCredential
   - **Covers:** AC: Local inference path

**configureInferenceDirect tests:**

6. `configureInferenceDirect calls upsertProvider and inference set on success`
   - **Input:** Mock `upsertProvider` returning `{ ok: true }`, mock `runOpenshell` for gateway select and inference set returning `{ status: 0 }`
   - **Expected:** upsertProvider called with correct provider name/type/credential, inference set called with `--provider` and `--model` args
   - **Covers:** AC: Happy path inference configuration

7. `configureInferenceDirect passes --no-verify for skipVerify providers`
   - **Input:** Provider is `"nvidia-prod"` (skipVerify: true in REMOTE_PROVIDER_CONFIG)
   - **Expected:** `inference set` args include `"--no-verify"`
   - **Covers:** AC: Correct openshell CLI arguments

8. `configureInferenceDirect throws inference_failed when upsertProvider fails`
   - **Input:** Mock `upsertProvider` returning `{ ok: false, message: "connection refused" }`
   - **Expected:** Throws `RecreateError` with code `"inference_failed"`
   - **Covers:** AC: "Inference configuration failure → throws with code inference_failed"

9. `configureInferenceDirect throws inference_failed when inference set exits non-zero`
   - **Input:** Mock `runOpenshell` for `inference set` returning `{ status: 1 }`
   - **Expected:** Throws `RecreateError` with code `"inference_failed"`
   - **Covers:** AC: "Inference configuration failure → throws with code inference_failed"

**setupAgentDirect tests:**

10. `setupAgentDirect runs config sync script for openclaw`
    - **Input:** `agent = null` (default openclaw), mock `buildSandboxConfigSyncScript` returning a script, mock `run()` for openshell sandbox connect
    - **Expected:** `run()` called with `["openshell", "sandbox", "connect", sandboxName]` and script as stdin input
    - **Covers:** AC: Happy path agent setup

11. `setupAgentDirect loads agent definition and waits for health probe for non-openclaw agents`
    - **Input:** `agent = "hermes"`, mock agent def with healthProbe, mock openshell sandbox exec curl returning `"ok"`
    - **Expected:** Health probe checked, no throw
    - **Covers:** AC: Agent-specific setup path

12. `setupAgentDirect throws agent_setup_failed when config sync fails`
    - **Input:** Mock `run()` throwing an error
    - **Expected:** Throws `RecreateError` with code `"agent_setup_failed"`
    - **Covers:** AC: "Agent setup failure → throws with code agent_setup_failed"

**applyPolicyPresetsDirect tests:**

13. `applyPolicyPresetsDirect applies specified presets`
    - **Input:** `presets = ["balanced", "brave"]`, mock `policies.applyPreset` returning true
    - **Expected:** Both presets applied, returns `["balanced", "brave"]`
    - **Covers:** AC: Happy path policy application

14. `applyPolicyPresetsDirect computes suggestions when no presets specified`
    - **Input:** `presets = []`, mock `getSuggestedPolicyPresets` returning `["balanced"]`
    - **Expected:** Suggestions computed and applied, returns `["balanced"]`
    - **Covers:** AC: Default policy suggestion behavior

15. `applyPolicyPresetsDirect calls shieldsDownPermanent when dangerouslySkipPermissions`
    - **Input:** `dangerouslySkipPermissions = true`
    - **Expected:** `shields.shieldsDownPermanent(sandboxName)` called, returns `[]`
    - **Covers:** AC: Permissive mode

16. `applyPolicyPresetsDirect throws policy_failed when preset application fails`
    - **Input:** Mock `policies.applyPreset` throwing an error
    - **Expected:** Throws `RecreateError` with code `"policy_failed"`
    - **Covers:** AC: "Policy application failure → throws with code policy_failed"

**recreateSandbox orchestrator tests:**

17. `recreateSandbox calls all sub-functions in order on happy path`
    - **Input:** Full `RecreateParams` with valid values, all sub-functions mocked to succeed
    - **Expected:** Called in order: validateRecreateCredentials → createSandboxDirect → configureInferenceDirect → setupAgentDirect → applyPolicyPresetsDirect. Returns `{ sandboxName, appliedPresets }`.
    - **Covers:** AC: Happy path, composable orchestration

18. `recreateSandbox propagates credential_missing from validateRecreateCredentials`
    - **Input:** Mock `resolveProviderCredential` to return null
    - **Expected:** Throws `RecreateError` with code `"credential_missing"`, `createSandboxDirect` never called
    - **Covers:** AC: Early failure prevents sandbox creation

19. `recreateSandbox propagates sandbox_create_failed from createSandboxDirect`
    - **Input:** Mock `createSandboxDirect` throwing `RecreateError("create failed", "sandbox_create_failed")`
    - **Expected:** Throws with same error, `configureInferenceDirect` never called
    - **Covers:** AC: Error propagation

20. `recreateSandbox propagates inference_failed from configureInferenceDirect`
    - **Input:** Mock `configureInferenceDirect` throwing
    - **Expected:** Throws with code `"inference_failed"`
    - **Covers:** AC: Error propagation

21. `recreateSandbox does not read from onboard-session.json`
    - **Input:** Standard RecreateParams
    - **Expected:** No calls to `onboardSession.loadSession()` or `onboardSession.updateSession()`
    - **Covers:** AC: "recreateSandbox() accepts explicit RecreateParams — no session file reads"

22. `recreateSandbox does not call process.exit`
    - **Input:** Make one sub-function fail
    - **Expected:** Throws RecreateError, never calls `process.exit`
    - **Covers:** AC: "No process.exit() calls in sandbox-recreate.ts"

**Test Implementation Notes:**
- Use `vi.mock()` to mock `./runner`, `./onboard`, `./credentials`, `./policies`, `./shields`, `./registry`, `./sandbox-create-stream`, `./agent-defs`, `./agent-onboard`
- For process.exit verification: spy on `process.exit` via `vi.spyOn(process, 'exit')` and verify it's never called
- The `createSandboxDirect` function is the most complex to test because it involves filesystem operations (staging build context). Mock `fs.mkdtempSync`, `fs.cpSync`, `streamSandboxCreate`, etc.
- Consider extracting a `describe("createSandboxDirect", () => { ... })` block with additional sub-tests if the function is complex enough during implementation

---

### Phase 3: Rewire sandboxRebuild - Test Guide

**Existing Tests to Modify:**

- `test/rebuild-credential-preflight.test.ts`
  - Current behavior: Tests the full CLI `nemoclaw <sandbox> rebuild --yes` flow including process.exit interception and recovery instructions
  - Required changes:
    - The "Layer 3: recovery on recreate failure" tests should still work — they verify CLI-level output (recovery instructions, exit codes). The internal mechanism changes from process.exit interception to try/catch, but the observable output is the same.
    - Remove or update any assertions that depend on the process.exit override internals (e.g., "RebuildOnboardExit" sentinel name).
    - Add a test that verifies `recreateSandbox` is used instead of `onboard`.

**New Tests to Create:**

**File modifications: `test/rebuild-credential-preflight.test.ts`**

23. `rebuild calls recreateSandbox instead of onboard`
    - **Input:** Full rebuild fixture with valid credential, fake openshell that supports create
    - **Expected:** The rebuild process does NOT acquire the onboard lock (no lock file created). The session file is NOT manipulated before recreate (no `resumable: true` / `status: in_progress` writes).
    - **Covers:** AC: "sandboxRebuild() no longer calls onboard()", "No session file manipulation"
    - **Implementation:** Check for absence of onboard lock file after rebuild. Check that session file was not modified between backup and recreate steps.

24. `rebuild does not override process.exit`
    - **Input:** Rebuild with a credential that triggers a recreate failure
    - **Expected:** `process.exit` is the original function throughout (can verify by checking stderr doesn't mention "RebuildOnboardExit")
    - **Covers:** AC: "No process.exit interceptor in sandboxRebuild"

25. `rebuild prints recovery instructions when recreateSandbox throws`
    - **Input:** Fixture where sandbox create will fail (e.g., fake openshell returns non-zero for sandbox create)
    - **Expected:** stderr contains "Recreate failed", "recover manually", "onboard --resume", backup path
    - **Covers:** AC: "On recreate failure: error message, backup path, and recovery instructions are printed"
    - **Note:** This may overlap with the existing "prints recovery instructions when recreate fails after destroy" test. Verify the existing test still passes; if it does, this test may be a refinement rather than a new test.

26. `rebuild exits non-zero when recreateSandbox throws and throwOnError is false`
    - **Input:** Fixture where recreate fails, no `throwOnError`
    - **Expected:** `process.exit` called with non-zero (observable via spawn exit code)
    - **Covers:** AC: "On recreate failure with throwOnError: error propagates"

27. `rebuild throws when recreateSandbox throws and throwOnError is true`
    - **Input:** Fixture simulating `upgradeSandboxes` calling `sandboxRebuild(name, ["--yes"], { throwOnError: true })` where recreate fails
    - **Expected:** The error propagates (not swallowed by process.exit). In practice, test via spawning the full CLI with `upgrade-sandboxes --auto` and a failing sandbox.
    - **Covers:** AC: "upgradeSandboxes --auto still works for batch rebuilds"

28. `rebuild applies policy presets exactly once`
    - **Input:** Fixture with saved policy presets in backup manifest
    - **Expected:** After successful rebuild, the sandbox has the presets applied. No duplicate application warnings. Check by examining the fake openshell calls — preset-related openshell commands should appear exactly once.
    - **Covers:** AC: "Policy presets are applied exactly once"

29. `rebuild still performs state restore after successful recreate`
    - **Input:** Full rebuild fixture with backup data
    - **Expected:** "State restored" appears in output after "Creating new sandbox"
    - **Covers:** AC: "State restore (Step 5) still runs after successful recreate"

30. `rebuild still runs post-restore agent migration`
    - **Input:** Full rebuild fixture for openclaw agent
    - **Expected:** `openclaw doctor --fix` command is executed (visible in openshell fake calls or output)
    - **Covers:** AC: "Post-restore agent migration (openclaw doctor --fix) still runs"

31. `credential preflight still aborts before destroying when credential is missing`
    - **Input:** Fixture with missing credential, no `savedCredential`
    - **Expected:** "Rebuild preflight failed" in output, "Sandbox is untouched" in output, sandbox NOT deleted (openshell sandbox delete never called)
    - **Covers:** AC: "Existing rebuild credential preflight (Step 0) is unchanged"
    - **Note:** This is the existing test "aborts rebuild BEFORE destroying sandbox when credential is missing" — verify it still passes unchanged.

**Test Implementation Notes:**
- The existing `createFixture()` helper in `test/rebuild-credential-preflight.test.ts` sets up the full environment (temp HOME, fake openshell, fake ssh, registry, session). Extend it to support the new `recreateSandbox` path.
- The fake openshell binary needs to handle `sandbox create` (which it may not currently do if the old path went through onboard's create). Check and extend as needed.
- For test 23 (verifying recreateSandbox vs onboard), the most reliable check is absence of the onboard lock file and absence of session manipulation. The onboard lock file is at `~/.nemoclaw/onboard.lock`.
- For test 28 (single policy application), inspect the fake openshell's received commands to count policy-related calls.

---

### Phase 4: ESLint Guard Rule - Test Guide

**Existing Tests to Modify:**

None — this creates a new ESLint rule with its own test file.

**New Tests to Create:**

**File: `test/no-direct-credential-env.test.ts`**

Use vitest to test the ESLint rule. Import the rule module and use either `@eslint/rule-tester` (if available) or manual AST checking.

**Invalid patterns (rule should report):**

32. `flags process.env.NVIDIA_API_KEY in read context`
    - **Input:** `const key = process.env.NVIDIA_API_KEY;`
    - **Expected:** Rule reports with suggestion to use `resolveProviderCredential()` or `getCredential()`
    - **Covers:** AC: "Rule flags all 6 known credential env names"

33. `flags process.env.OPENAI_API_KEY in conditional`
    - **Input:** `if (!process.env.OPENAI_API_KEY) { ... }`
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags all 6 known credential env names"

34. `flags process.env.ANTHROPIC_API_KEY in read context`
    - **Input:** `const x = process.env.ANTHROPIC_API_KEY;`
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags all 6 known credential env names"

35. `flags process.env.GEMINI_API_KEY in read context`
    - **Input:** `const x = process.env.GEMINI_API_KEY;`
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags all 6 known credential env names"

36. `flags process.env.COMPATIBLE_API_KEY in read context`
    - **Input:** `const x = process.env.COMPATIBLE_API_KEY;`
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags all 6 known credential env names"

37. `flags process.env.COMPATIBLE_ANTHROPIC_API_KEY in read context`
    - **Input:** `const x = process.env.COMPATIBLE_ANTHROPIC_API_KEY;`
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags all 6 known credential env names"

38. `flags process.env[credentialEnv] dynamic read`
    - **Input:** `if (!process.env[credentialEnv]) { ... }` where `credentialEnv` is a variable name containing "credential"
    - **Expected:** Rule reports
    - **Covers:** AC: "Rule flags dynamic process.env[credentialEnv] pattern"

**Valid patterns (rule should NOT report):**

39. `allows process.env.NVIDIA_API_KEY assignment (write context)`
    - **Input:** `process.env.NVIDIA_API_KEY = "nvapi-xxx";`
    - **Expected:** No report
    - **Covers:** AC: "Rule does NOT flag assignment targets"

40. `allows process.env[credentialEnv] assignment`
    - **Input:** `process.env[credentialEnv] = providerKey;`
    - **Expected:** No report
    - **Covers:** AC: "Rule does NOT flag assignment targets"

41. `allows getCredential("NVIDIA_API_KEY")`
    - **Input:** `const key = getCredential("NVIDIA_API_KEY");`
    - **Expected:** No report
    - **Covers:** AC: Correct pattern is allowed

42. `allows resolveProviderCredential("NVIDIA_API_KEY")`
    - **Input:** `const key = resolveProviderCredential("NVIDIA_API_KEY");`
    - **Expected:** No report
    - **Covers:** AC: Correct pattern is allowed

43. `allows process.env.SOME_OTHER_VAR (non-credential)`
    - **Input:** `const x = process.env.NEMOCLAW_MODEL;`
    - **Expected:** No report
    - **Covers:** AC: Rule only targets credential keys

44. `allows process.env.NEMOCLAW_PROVIDER_KEY (override mechanism, not resolution)`
    - **Input:** `const _nvProviderKey = process.env.NEMOCLAW_PROVIDER_KEY;`
    - **Expected:** No report
    - **Covers:** AC: User-facing override is intentional

**Integration test:**

45. `npx eslint src/lib/onboard.ts passes with no violations`
    - **Input:** Run eslint on the actual onboard.ts after Phase 1 changes
    - **Expected:** Zero rule violations for `nemoclaw/no-direct-credential-env`
    - **Covers:** AC: "Running npx eslint src/lib/onboard.ts passes with no violations"
    - **Implementation:** Either a test that spawns `npx eslint` or a manual verification step

**Test Implementation Notes:**
- The simplest approach is to use `RuleTester` from `eslint` (or `@eslint/rule-tester`). Import the rule, create a `RuleTester` instance with the TypeScript parser, and define valid/invalid test cases.
- If `@eslint/rule-tester` is not in devDependencies, use the vitest approach: import the rule's `create` function, feed it mock AST nodes, and check whether it reports.
- The rule's detection of "read vs. write context" can be done by checking whether the `MemberExpression` is the left side of an `AssignmentExpression`.
- For dynamic access (`process.env[credentialEnv]`), the rule should check if the computed property name is an Identifier whose name matches `/credential/i`.

---

### Phase 5: Clean the House - Test Guide

**Existing Tests to Modify:**

- `test/rebuild-credential-preflight.test.ts`
  - Required changes: Final audit — ensure no tests reference "RebuildOnboardExit", `process.exit` override, or onboard lock behavior in rebuild context. All should have been updated in Phase 3, but verify here.

**New Tests to Create:**

No new tests. This phase is about cleanup and verification.

**Verification Steps (not automated tests, but checklist):**

46. `no TODO #2306 comments in codebase`
    - **Command:** `grep -rn "TODO.*2306\|FIXME.*2306" src/ test/`
    - **Expected:** Zero results

47. `no dead imports in nemoclaw.ts`
    - **Command:** `npm run build:cli` (TypeScript compiler catches unused imports if configured)
    - **Expected:** Clean compile

48. `no process.exit interception tests remain`
    - **Command:** `grep -n "RebuildOnboardExit\|_savedExit\|process\.exit.*interceptor" test/`
    - **Expected:** Zero results

49. `full test suite passes`
    - **Command:** `npm test`
    - **Expected:** All tests pass

50. `eslint passes`
    - **Command:** `npx eslint .`
    - **Expected:** No new warnings or errors

---

## Test Dependency Map

```
Phase 1 tests (1-14):  No dependencies — can run immediately
Phase 2 tests (1-22):  Depend on Phase 1 (resolveProviderCredential must exist)
Phase 3 tests (23-31): Depend on Phase 2 (recreateSandbox must exist)
Phase 4 tests (32-45): Depend on Phase 1 (canonical function must exist for valid patterns)
Phase 5 tests (46-50): Depend on all prior phases
```

## Summary

| Phase | Test File(s) | New Tests | Modified Tests |
|-------|-------------|-----------|----------------|
| 1 | `test/canonical-credential-resolution.test.ts`, `test/credentials.test.ts`, `test/rebuild-credential-hydration.test.ts` | 12 | 2 files touched |
| 2 | `src/lib/sandbox-recreate.test.ts` | 22 | 0 |
| 3 | `test/rebuild-credential-preflight.test.ts` | 9 | 1 file updated |
| 4 | `test/no-direct-credential-env.test.ts` | 14 | 0 |
| 5 | (verification only) | 0 | 1 file audited |
| **Total** | | **57** | |
