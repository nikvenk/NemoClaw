# Refactor `onboard.ts` (6,382 lines) into ~11 focused modules

## Context

`src/lib/onboard.ts` is a 6,382-line god-file containing the entire onboarding wizard — 133 functions, 83 exports, and functions up to 900 lines long. The project already has a pattern of extracting modules (gateway-state, validation, http-probe, dashboard, etc.) but onboard.ts was never broken up.

**Goal:** No file over ~600 lines, no function over ~80 lines, each module has one clear domain. The refactor is purely structural — no behavior changes.

## Critical rules

1. **No behavior changes.** Move code, don't rewrite it. The only new code is glue (imports/exports), the consolidated `validateProviderSelection()` (Step 3), and `getProviderLabel()` (Step 1).
2. **Backward compat.** All 83 existing exports must remain accessible from `onboard.ts` via re-exports. The test file `test/onboard.test.ts` imports directly from `onboard.ts` and must not be modified.
3. **One step = one commit.** Each step is a separate commit. Run `npm test` after each step before committing. Use conventional commit format: `refactor(onboard): extract <module-name>`.
4. **SPDX headers** on every new .ts file: `// @ts-nocheck` + SPDX block.
5. **CJS format** — `src/lib/` uses CommonJS (`require`/`module.exports`).
6. **No new file over 600 lines**, no function over ~80 lines.

## Dependency injection pattern

**Problem:** Several extracted functions (`upsertProvider`, `providerExistsInGateway`, etc.) call `runOpenshell()`, which is defined in `onboard.ts` and depends on mutable module state (`OPENSHELL_BIN`). Importing from `onboard.ts` back would create a circular dependency.

**Solution:** Functions that need `runOpenshell` accept it as a **last parameter** in the extracted module. `onboard.ts` creates thin wrapper functions (same original signature) that inject `runOpenshell`:

```js
// In onboard-providers.ts:
function upsertProvider(name, type, credentialEnv, baseUrl, env, _runOpenshell) { ... }

// In onboard.ts:
const providers = require("./onboard-providers");
function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
  return providers.upsertProvider(name, type, credentialEnv, baseUrl, env, runOpenshell);
}
```

Same pattern for `isNonInteractive` — functions like `getRequestedProviderHint(nonInteractive)` drop the default parameter; the `onboard.ts` wrapper supplies `isNonInteractive()` as default.

Other dependencies (`compactText`, `redact`, `isSafeModelId`, etc.) come from their own modules (`url-utils`, `runner`, `validation`) and can be imported directly — no circular issue.

---

## Execution order

### Step 1: Extract `onboard-providers.ts` (~280 lines)

**Why first:** Provider metadata is referenced everywhere.

**Move from `onboard.ts`:**
- `REMOTE_PROVIDER_CONFIG` object (L163-228) + endpoint URL constants (L157-161)
- `LOCAL_INFERENCE_PROVIDERS` constant (L52)
- `DISCORD_SNOWFLAKE_RE` (L230)
- `getEffectiveProviderName()` (L2032-2048)
- `getNonInteractiveProvider()` (L2245-2275)
- `getNonInteractiveModel()` (L2277-2286)
- `getRequestedProviderHint()` (L2022-2024) — drop default, wrapper in onboard.ts
- `getRequestedModelHint()` (L2026-2030) — drop default, wrapper in onboard.ts
- `buildProviderArgs()` (L778-789) — pure, re-export directly
- `upsertProvider()` (L803-817) — DI for `runOpenshell`
- `providerExistsInGateway()` (L849-855) — DI for `runOpenshell`
- `upsertMessagingProviders()` (L826-838) — DI for `runOpenshell`
- `getSandboxInferenceConfig()` (L1130-1172) — pure, re-export directly

**New function:** `getProviderLabel(provider)` — replaces scattered if/else chains in `printDashboard` (L5716-5729).

**Imports needed:** `redact` (runner), `isSafeModelId` (validation), `compactText` (url-utils), `DEFAULT_CLOUD_MODEL` (inference-config).

### Step 2: Extract `onboard-ollama-proxy.ts` (~180 lines)

**Why second:** Zero coupling to other onboard logic. Pure self-contained subsystem.

**Move from `onboard.ts`:**
- `PROXY_STATE_DIR`, `PROXY_TOKEN_PATH`, `PROXY_PID_PATH` (L1784-1786)
- `ollamaProxyToken` module state (L1788)
- `ensureProxyStateDir()` (L1790-1794)
- `persistProxyToken()` / `loadPersistedProxyToken()` (L1796-1813)
- `persistProxyPid()` / `loadPersistedProxyPid()` / `clearPersistedProxyPid()` (L1815-1841)
- `isOllamaProxyProcess()` (L1843-1847)
- `spawnOllamaAuthProxy()` (L1849-1863) — DI for `runOpenshell`/`runCaptureOpenshell`
- `killStaleProxy()` (L1865-1888)
- `startOllamaAuthProxy()` (L1890-1903) — DI
- `ensureOllamaAuthProxy()` (L1909-1925) — DI
- `getOllamaProxyToken()` (L1927-1932)
- `promptOllamaModel()` (L1934-1958) — DI for `prompt`/`isNonInteractive`
- `printOllamaExposureWarning()` (L1960-1967)
- `pullOllamaModel()` (L1969-1984) — DI for `runOpenshell`
- `prepareOllamaModel()` (L1986-2003) — DI

### Step 3: Extract `onboard-inference-probes.ts` (~350 lines)

**Move from `onboard.ts`:**
- `parseJsonObject()` (L1305-1312)
- `hasResponsesToolCall()` (L1314-1329)
- `shouldRequireResponsesToolCalling()` (L1331-1335)
- `getProbeAuthMode()` (L1340-1342)
- `getValidationProbeCurlArgs()` (L1351-1356)
- `probeResponsesToolCalling()` (L1358-1412) — DI for `runCaptureOpenshell`
- `probeOpenAiLikeEndpoint()` (L1414-1601) — DI
- `probeAnthropicEndpoint()` (L1603-1636) — DI

**Consolidate 4 validation functions into `validateProviderSelection()`** replacing `validateOpenAiLikeSelection` (L1638-1669), `validateAnthropicSelectionWithRetryMessage` (L1671-1701), `validateCustomOpenAiLikeSelection` (L1703-1736), `validateCustomAnthropicSelection` (L1738-1767).

### Step 4: Extract `onboard-dashboard.ts` (~200 lines)

**Move from `onboard.ts`:**
- `CONTROL_UI_PORT` (L5552)
- `ensureDashboardForward()` (L5558-5578)
- `findOpenclawJsonPath()` (L5580-5593)
- `fetchGatewayAuthTokenFromSandbox()` (L5599-5622)
- `getDashboardForwardPort()` / `getDashboardForwardTarget()` / `getDashboardForwardStartCommand()` (L5626-5651)
- `buildAuthenticatedDashboardUrl()` (L5653-5656)
- `getWslHostAddress()` (L5658-5672)
- `getDashboardAccessInfo()` / `getDashboardGuidanceLines()` (L5674-5714)
- `printDashboard()` (L5716-5790) — use `getProviderLabel()` from Step 1

### Step 5: Extract `onboard-gateway.ts` (~300 lines)

**Move from `onboard.ts`:**
- `verifyGatewayContainerRunning()` (L136-154)
- `streamGatewayStart()` (L307-450)
- `startGatewayWithOptions()` (L2625-2789)
- `startGateway()` / `startGatewayForRecovery()` (L2791-2797)
- `getGatewayStartEnv()` (L2799-2810)
- `recoverGatewayRuntime()` (L2812-2857)
- `destroyGateway()` (L2193-2207)

**Decompose `streamGatewayStart()`** into `classifyLine()`, `setPhase()`, heartbeat timer setup.

### Step 6: Extract `onboard-preflight.ts` (~350 lines)

**Move from `onboard.ts`:**
- `preflight()` (L2291-2619)
- `isOpenshellInstalled()` (L2132-2134)
- `installOpenshell()` (L2158-2187)
- `getInstalledOpenshellVersion()` (L458-463)
- `versionGte()` (L469-484)
- `getBlueprintVersionField()` / `getBlueprintMinOpenshellVersion()` / `getBlueprintMaxOpenshellVersion()` (L492-518)
- `getStableGatewayImageRef()` (L571-575)
- `getPortConflictServiceHints()` (L2143-2156)
- `printRemediationActions()` (L2116-2130)
- `getContainerRuntime()` (L2111-2114)

**Decompose `preflight()`** into ~5 sub-functions, each under 80 lines.

### Step 7: Extract `onboard-messaging.ts` (~350 lines)

**Move from `onboard.ts`:**
- `MESSAGING_CHANNELS` constant (L4461-4502)
- `TELEGRAM_NETWORK_CURL_CODES` (L4506)
- `checkTelegramReachability()` (L4508-4557)
- `setupMessagingChannels()` (L4559-4764)
- `makeConflictProbe()` (L901-919)

**Decompose `setupMessagingChannels()`** into TUI selector + credential prompter + orchestrator.

### Step 8: Extract `onboard-policies.ts` (~500 lines)

**Move from `onboard.ts`:**
- `getSuggestedPolicyPresets()` (L4766-4795)
- `computeSetupPresetSuggestions()` (L5381-5396)
- `arePolicyPresetsApplied()` (L4930-4934)
- `selectPolicyTier()` (L4944-5058)
- `selectTierPresetsAndAccess()` (L5079-5249)
- `presetsCheckboxSelector()` (L5256-5379)
- `setupPoliciesWithSelection()` (L5399-5548)
- `_setupPolicies()` (L4826-4928)

### Step 9: Extract `onboard-inference-setup.ts` (~400 lines)

**Depends on:** Steps 1, 2, 3.

**Move from `onboard.ts`:**
- `setupNim()` (L3616-4286) — decompose into ~5 sub-functions
- `setupInference()` (L4290-4457) — decompose into ~3 sub-functions

### Step 10: Extract `onboard-sandbox.ts` (~500 lines)

**Depends on:** Steps 1, 7.

**Move from `onboard.ts`:**
- `promptValidatedSandboxName()` (L2861-2926)
- `getRequestedSandboxNameHint()` (L2005-2010)
- `getResumeSandboxConflict()` (L2012-2020)
- `getResumeConfigConflicts()` (L2050-2109)
- `getSandboxReuseState()` (L289-294)
- `repairRecordedSandbox()` (L296-302)
- `pruneStaleSandboxEntry()` (L941-948)
- `buildSandboxConfigSyncScript()` (L950-963)
- `writeSandboxConfigSyncFile()` (L969-973)
- `isOpenclawReady()` (L965-967)
- `waitForSandboxReady()` (L2218-2240)
- `patchStagedDockerfile()` (L1174-1303)
- `createSandbox()` (L2931-3611) — decompose into ~6 sub-functions
- Base image helpers: `SANDBOX_BASE_IMAGE`, `SANDBOX_BASE_TAG`, `pullAndResolveBaseImageDigest()` (L526-569)

### Step 11: Slim down `onboard.ts` to orchestrator-only (~500 lines)

**What remains:**
- Imports from all new modules
- Global state: `NON_INTERACTIVE`, `RECREATE_SANDBOX`, `OPENSHELL_BIN`
- Shared helpers: `isNonInteractive()`, `isRecreateSandbox()`, `note()`, `step()`, `sleep()`
- Prompt helpers: `promptOrDefault()`, `promptValidationRecovery()`, `replaceNamedCredential()`, `ensureNamedCredential()`
- Session helpers: `ONBOARD_STEP_INDEX`, `startRecordedStep()`, `skippedStepMessage()`
- Small utilities: `secureTempFile()`, `cleanupTempDir()`, `openshellShellCommand()`, `runOpenshell()`, `runCaptureOpenshell()`, `getOpenshellBinary()`
- `setupOpenclaw()` (L4799-4821)
- `onboard()` orchestrator (L5827-6297)
- `module.exports` — re-exports everything for backward compat

---

## Verification

After each step:
1. `npm test` — all existing tests pass (baseline: 2 pre-existing failures unrelated to onboard)
2. Verify new file has `// @ts-nocheck` + SPDX header
3. Verify `wc -l` of onboard.ts is shrinking and new file is under 600 lines

After all steps:
1. `npm test` — full test suite
2. `wc -l src/lib/onboard*.ts` — no file exceeds 600 lines
3. `node bin/nemoclaw.js --help` — CLI still works
