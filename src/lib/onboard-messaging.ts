// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface MessagingChannelDefinition {
  name: string;
  envKey: string;
  description: string;
  help: string;
  label: string;
  userIdEnvKey?: string;
  userIdHelp?: string;
  userIdLabel?: string;
  allowIdsMode?: "dm" | "guild";
  serverIdEnvKey?: string;
  serverIdHelp?: string;
  serverIdLabel?: string;
  requireMentionEnvKey?: string;
  requireMentionHelp?: string;
  appTokenEnvKey?: string;
  appTokenHelp?: string;
  appTokenLabel?: string;
}

export const MESSAGING_CHANNELS: MessagingChannelDefinition[] = [
  {
    name: "telegram",
    envKey: "TELEGRAM_BOT_TOKEN",
    description: "Telegram bot messaging",
    help: "Create a bot via @BotFather on Telegram, then copy the token.",
    label: "Telegram Bot Token",
    userIdEnvKey: "TELEGRAM_ALLOWED_IDS",
    userIdHelp: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
    userIdLabel: "Telegram User ID (for DM access)",
    allowIdsMode: "dm",
  },
  {
    name: "discord",
    envKey: "DISCORD_BOT_TOKEN",
    description: "Discord bot messaging",
    help: "Discord Developer Portal → Applications → Bot → Reset/Copy Token.",
    label: "Discord Bot Token",
    serverIdEnvKey: "DISCORD_SERVER_ID",
    serverIdHelp:
      "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
    serverIdLabel: "Discord Server ID (for guild workspace access)",
    requireMentionEnvKey: "DISCORD_REQUIRE_MENTION",
    requireMentionHelp:
      "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
    userIdEnvKey: "DISCORD_USER_ID",
    userIdHelp:
      "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
    userIdLabel: "Discord User ID (optional guild allowlist)",
    allowIdsMode: "guild",
  },
  {
    name: "slack",
    envKey: "SLACK_BOT_TOKEN",
    description: "Slack bot messaging",
    help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
    label: "Slack Bot Token",
    appTokenEnvKey: "SLACK_APP_TOKEN",
    appTokenHelp: "Slack API → Your Apps → Basic Information → App-Level Tokens (xapp-...).",
    appTokenLabel: "Slack App Token (Socket Mode)",
  },
];

export interface SetupMessagingChannelsDeps {
  step: (current: number, total: number, message: string) => void;
  isNonInteractive: () => boolean;
  note: (message: string) => void;
  getCredential: (envKey: string) => string | null;
  normalizeCredentialValue: (value: unknown) => string;
  prompt: (question: string, options?: { secret?: boolean }) => Promise<string>;
  promptOrDefault: (
    question: string,
    envVar: string | null,
    defaultValue: string,
  ) => Promise<string>;
  saveCredential: (envKey: string, token: string) => void;
  checkTelegramReachability: (token: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function setupMessagingChannels(
  deps: SetupMessagingChannelsDeps,
): Promise<string[]> {
  const env = deps.env ?? process.env;
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stderr;

  deps.step(5, 8, "Messaging channels");

  const getMessagingToken = (envKey: string): string | null =>
    deps.getCredential(envKey) || deps.normalizeCredentialValue(env[envKey]) || null;

  if (deps.isNonInteractive() || env.NEMOCLAW_NON_INTERACTIVE === "1") {
    const found = MESSAGING_CHANNELS.filter((channel) => getMessagingToken(channel.envKey)).map(
      (channel) => channel.name,
    );
    if (found.length > 0) {
      deps.note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      if (found.includes("telegram")) {
        await deps.checkTelegramReachability(getMessagingToken("TELEGRAM_BOT_TOKEN") || "");
      }
    } else {
      deps.note("  [non-interactive] No messaging tokens configured. Skipping.");
    }
    return found;
  }

  const enabled = new Set(
    MESSAGING_CHANNELS.filter((channel) => getMessagingToken(channel.envKey)).map(
      (channel) => channel.name,
    ),
  );

  const linesAbovePrompt = MESSAGING_CHANNELS.length + 3;
  let firstDraw = true;
  const showList = () => {
    if (!firstDraw) {
      output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
    }
    firstDraw = false;
    output.write("\n");
    output.write("  Available messaging channels:\n");
    MESSAGING_CHANNELS.forEach((channel, index) => {
      const marker = enabled.has(channel.name) ? "●" : "○";
      const status = getMessagingToken(channel.envKey) ? " (configured)" : "";
      output.write(
        `    [${index + 1}] ${marker} ${channel.name} — ${channel.description}${status}\n`,
      );
    });
    output.write("\n");
    output.write("  Press 1-3 to toggle, Enter when done: ");
  };

  showList();

  await new Promise<void>((resolve, reject) => {
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function onData(chunk: Buffer | string) {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        const num = parseInt(ch, 10);
        if (num >= 1 && num <= MESSAGING_CHANNELS.length) {
          const channel = MESSAGING_CHANNELS[num - 1];
          if (enabled.has(channel.name)) {
            enabled.delete(channel.name);
          } else {
            enabled.add(channel.name);
          }
          showList();
        }
      }
    }

    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });

  const selected = Array.from(enabled);
  if (selected.length === 0) {
    console.log("  Skipping messaging channels.");
    return [];
  }

  for (const name of selected) {
    const channel = MESSAGING_CHANNELS.find((entry) => entry.name === name);
    if (!channel) {
      console.log(`  Unknown channel: ${name}`);
      continue;
    }
    if (getMessagingToken(channel.envKey)) {
      console.log(`  ✓ ${channel.name} — already configured`);
    } else {
      console.log("");
      console.log(`  ${channel.help}`);
      const token = deps.normalizeCredentialValue(
        await deps.prompt(`  ${channel.label}: `, { secret: true }),
      );
      if (token) {
        deps.saveCredential(channel.envKey, token);
        env[channel.envKey] = token;
        console.log(`  ✓ ${channel.name} token saved`);
      } else {
        console.log(`  Skipped ${channel.name} (no token entered)`);
        continue;
      }
    }
    if (channel.serverIdEnvKey) {
      const existingServerIds = env[channel.serverIdEnvKey] || "";
      if (existingServerIds) {
        console.log(`  ✓ ${channel.name} — server ID already set: ${existingServerIds}`);
      } else {
        console.log(`  ${channel.serverIdHelp}`);
        const serverId = (await deps.prompt(`  ${channel.serverIdLabel}: `)).trim();
        if (serverId) {
          env[channel.serverIdEnvKey] = serverId;
          console.log(`  ✓ ${channel.name} server ID saved`);
        } else {
          console.log(`  Skipped ${channel.name} server ID (guild channels stay disabled)`);
        }
      }
    }
    if (channel.requireMentionEnvKey && channel.serverIdEnvKey && env[channel.serverIdEnvKey]) {
      const existingRequireMention = env[channel.requireMentionEnvKey];
      if (existingRequireMention === "0" || existingRequireMention === "1") {
        const mode = existingRequireMention === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${channel.name} — reply mode already set: ${mode}`);
      } else {
        console.log(`  ${channel.requireMentionHelp}`);
        const answer = (await deps.prompt("  Reply only when @mentioned? [Y/n]: "))
          .trim()
          .toLowerCase();
        env[channel.requireMentionEnvKey] = answer === "n" || answer === "no" ? "0" : "1";
        const mode = env[channel.requireMentionEnvKey] === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${channel.name} reply mode saved: ${mode}`);
      }
    }
    if (channel.userIdEnvKey && (!channel.serverIdEnvKey || env[channel.serverIdEnvKey])) {
      const existingIds = env[channel.userIdEnvKey] || "";
      if (existingIds) {
        console.log(`  ✓ ${channel.name} — allowed IDs already set: ${existingIds}`);
      } else {
        console.log(`  ${channel.userIdHelp}`);
        const userId = (await deps.prompt(`  ${channel.userIdLabel}: `)).trim();
        if (userId) {
          env[channel.userIdEnvKey] = userId;
          console.log(`  ✓ ${channel.name} user ID saved`);
        } else {
          const skippedReason =
            channel.allowIdsMode === "guild"
              ? "any member in the configured server can message the bot"
              : "bot will require manual pairing";
          console.log(`  Skipped ${channel.name} user ID (${skippedReason})`);
        }
      }
    }
  }
  console.log("");

  if (
    !deps.isNonInteractive() &&
    selected.includes("telegram") &&
    getMessagingToken("TELEGRAM_BOT_TOKEN")
  ) {
    await deps.checkTelegramReachability(getMessagingToken("TELEGRAM_BOT_TOKEN") || "");
  }

  return selected;
}
