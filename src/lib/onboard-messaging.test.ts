// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { MESSAGING_CHANNELS, setupMessagingChannels } from "../../dist/lib/onboard-messaging";

describe("onboard-messaging", () => {
  it("exports the expected messaging channel definitions", () => {
    expect(MESSAGING_CHANNELS.map((channel) => channel.name)).toEqual([
      "telegram",
      "discord",
      "slack",
    ]);
  });

  it("returns configured channels in non-interactive mode and probes Telegram reachability once", async () => {
    const note = vi.fn();
    const checkTelegramReachability = vi.fn(async () => {});

    const result = await setupMessagingChannels({
      step: vi.fn(),
      isNonInteractive: () => true,
      note,
      getCredential: (envKey) => (envKey === "SLACK_BOT_TOKEN" ? "xoxb-token" : null),
      normalizeCredentialValue: (value) => String(value || ""),
      prompt: async () => "",
      promptOrDefault: async () => "n",
      saveCredential: vi.fn(),
      checkTelegramReachability,
      env: {
        NEMOCLAW_NON_INTERACTIVE: "1",
        TELEGRAM_BOT_TOKEN: "123456:ABC-telegram-token",
      } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual(["telegram", "slack"]);
    expect(note).toHaveBeenCalledWith(
      "  [non-interactive] Messaging tokens detected: telegram, slack",
    );
    expect(checkTelegramReachability).toHaveBeenCalledWith(
      "123456:ABC-telegram-token",
    );
  });

  it("returns an empty array when no messaging tokens are configured", async () => {
    const note = vi.fn();

    const result = await setupMessagingChannels({
      step: vi.fn(),
      isNonInteractive: () => true,
      note,
      getCredential: () => null,
      normalizeCredentialValue: (value) => String(value || ""),
      prompt: async () => "",
      promptOrDefault: async () => "n",
      saveCredential: vi.fn(),
      checkTelegramReachability: vi.fn(async () => {}),
      env: { NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual([]);
    expect(note).toHaveBeenCalledWith(
      "  [non-interactive] No messaging tokens configured. Skipping.",
    );
  });
});
