// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that onboarding probes the gateway Docker container before trusting
// "healthy" metadata from the openshell CLI. Without this, a stale local
// state file causes step 2 to skip gateway startup even when the container
// has been removed, leading to "Connection refused" in step 4.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/2020

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("gateway liveness probe (#2020)", () => {
  const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");

  it("verifyGatewayContainerRunning() helper exists and checks Docker state", () => {
    expect(content).toContain("function verifyGatewayContainerRunning()");
    // Must use docker inspect to probe container state
    expect(content).toContain("docker inspect --type container");
    // Must check .State.Running, not just container existence
    expect(content).toContain("{{.State.Running}}");
  });

  it("preflight probes the container when gatewayReuseState is 'healthy'", () => {
    // The preflight section must call the probe before entering the port loop.
    // Find the first gatewayReuseState assignment and the port loop.
    const preflightProbe = content.match(
      /let gatewayReuseState = getGatewayReuseState[\s\S]*?verifyGatewayContainerRunning\(\)[\s\S]*?gatewayReuseState = "missing"/,
    );
    expect(preflightProbe).toBeTruthy();
  });

  it("main onboard flow probes the container before canReuseHealthyGateway", () => {
    // The main onboard flow must also probe before setting canReuseHealthyGateway.
    const mainFlowProbe = content.match(
      /let gatewayReuseState = getGatewayReuseState[\s\S]*?verifyGatewayContainerRunning\(\)[\s\S]*?const canReuseHealthyGateway/,
    );
    expect(mainFlowProbe).toBeTruthy();
  });

  it("downgrades to 'missing' when container is not running", () => {
    // Both probe sites must set gatewayReuseState = "missing" on failure
    const downgrades = content.match(/!verifyGatewayContainerRunning\(\)/g);
    expect(downgrades).toBeTruthy();
    expect(downgrades.length).toBeGreaterThanOrEqual(2);
  });

  it("cleans up stale metadata when container is not running", () => {
    // After detecting a stale container, the code must clean up forwarding
    // and destroy the gateway — same as the existing stale path.
    const cleanupAfterProbe = content.match(
      /!verifyGatewayContainerRunning\(\)[\s\S]*?forward.*stop[\s\S]*?gateway.*destroy/,
    );
    expect(cleanupAfterProbe).toBeTruthy();
  });

  it("does not modify isGatewayHealthy() in gateway-state.ts", () => {
    // isGatewayHealthy() must remain a pure function — no I/O
    const gsContent = fs.readFileSync(
      path.join(ROOT, "src/lib/gateway-state.ts"),
      "utf-8",
    );
    expect(gsContent).not.toContain("docker");
    expect(gsContent).not.toContain("spawn");
    expect(gsContent).not.toContain("exec");
  });
});
