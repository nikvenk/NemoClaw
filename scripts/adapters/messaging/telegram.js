// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram messaging adapter.
 *
 * Uses the Telegram Bot API via long polling (no external dependencies).
 */

const https = require("https");

module.exports = function createAdapter(config) {
  const TOKEN = process.env[config.credential_env];
  // Support legacy ALLOWED_CHAT_IDS for backwards compatibility
  const allowedRaw = process.env[config.allowed_env] || process.env.ALLOWED_CHAT_IDS;
  const ALLOWED = allowedRaw ? allowedRaw.split(",").map((s) => s.trim()) : null;

  let offset = 0;

  function tgApi(method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        {
          hostname: "api.telegram.org",
          path: `/bot${TOKEN}/${method}`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try {
              const json = JSON.parse(buf);
              if (json.ok) resolve(json); else reject(new Error(json.description || "Telegram API error"));
            } catch { reject(new Error(`Unparseable Telegram response: ${buf.slice(0, 200)}`)); }
          });
        },
      );
      req.setTimeout(60000, () => req.destroy(new Error("Telegram API request timed out")));
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  return {
    name: "telegram",

    async start(onMessage) {
      let me;
      try {
        me = await tgApi("getMe", {});
      } catch (err) {
        throw new Error(`Failed to connect to Telegram: ${err.message}`);
      }

      const botName = `@${me.result.username}`;

      async function poll() {
        try {
          const res = await tgApi("getUpdates", { offset, timeout: 30 });
          if (res.ok && res.result?.length > 0) {
            for (const update of res.result) {
              offset = update.update_id + 1;
              const msg = update.message;
              if (!msg?.text) continue;

              const channelId = String(msg.chat.id);
              if (ALLOWED && !ALLOWED.includes(channelId)) continue;

              const userName = msg.from?.first_name || "someone";

              // Handle bot commands locally — these existed in the
              // monolithic telegram-bridge.js and users may depend on them.
              if (msg.text === "/start") {
                await tgApi("sendMessage", {
                  chat_id: channelId,
                  text: "NemoClaw — powered by Nemotron\n\nSend me a message and I'll run it through the OpenClaw agent inside an OpenShell sandbox.",
                  reply_to_message_id: msg.message_id,
                }).catch(() => {});
                continue;
              }
              if (msg.text === "/reset") {
                await tgApi("sendMessage", {
                  chat_id: channelId,
                  text: "Session reset.",
                  reply_to_message_id: msg.message_id,
                }).catch(() => {});
                continue;
              }

              await onMessage({
                channelId,
                userName,
                text: msg.text,
                async sendTyping() {
                  await tgApi("sendChatAction", { chat_id: channelId, action: "typing" }).catch(() => {});
                },
                async reply(text) {
                  await tgApi("sendMessage", {
                    chat_id: channelId,
                    text,
                    reply_to_message_id: msg.message_id,
                    parse_mode: "Markdown",
                  }).catch(() =>
                    tgApi("sendMessage", { chat_id: channelId, text, reply_to_message_id: msg.message_id }),
                  );
                },
              });
            }
          }
        } catch (err) {
          console.error("Poll error:", err.message);
        }
        setTimeout(poll, 100);
      }

      poll();
      return botName;
    },
  };
};
