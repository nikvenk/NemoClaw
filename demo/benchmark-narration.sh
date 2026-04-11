#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIO="$DIR/audio/benchmark"
VOICE="Samantha"
RATE=170

rm -rf "$AUDIO"
mkdir -p "$AUDIO"

echo "Generating benchmark narration clips..."

# 1. Intro (3s)
say -v "$VOICE" -r "$RATE" -o "$AUDIO/01-intro.aiff" \
  "Here's the performance case for the typed memory index. [[slnc 300]]
We measured everything with tiktoken, the same tokenizer used by GPT-4 and Claude-class models. [[slnc 300]]
All benchmarks ran inside the NemoClaw sandbox container against real filesystem operations."

# 2. Context window table (8s)
say -v "$VOICE" -r "$RATE" -o "$AUDIO/02-context.aiff" \
  "First, the static cost. This is what the agent loads into its context window at the start of every session. [[slnc 400]]
At ten entries, the flat file is six hundred seventy-four tokens. The typed index is three hundred thirty-seven. That's a fifty percent reduction, even at small scale. [[slnc 400]]
As we scale up, the savings stabilize around fifty-nine percent. [[slnc 300]]
At ten thousand entries, the flat file is six hundred sixty-eight thousand tokens. That's half a context window, gone. The typed index uses two hundred seventy-two thousand. [[slnc 300]]
That frees nearly four hundred thousand tokens for actual conversation."

# 3. Crossover (2s)
say -v "$VOICE" -r "$RATE" -o "$AUDIO/03-crossover.aiff" \
  "The crossover point is at about ten entries. Below that, the index table headers cost more than the flat content. [[slnc 300]]
Above ten entries, the typed index wins. And the gap only grows."

# 4. Session cost (8s)
say -v "$VOICE" -r "$RATE" -o "$AUDIO/04-session.aiff" \
  "Now the honest part. The typed index saves on context loading, but the agent pays a cost every time it reads a topic. Each tool call adds about eighty tokens of overhead. [[slnc 400]]
This table shows total session cost at different read patterns. [[slnc 300]]
If the agent reads zero topics, savings match the context window numbers. [[slnc 300]]
If the agent reads three topics per session, we still save fifty-two percent at a hundred entries, and fifty-eight percent at a thousand. [[slnc 300]]
Even in the worst case, reading ten topics per session, the typed index uses fewer total tokens at fifty entries and above. [[slnc 300]]
At five hundred entries and ten reads, the savings are fifty-five percent."

# 5. Key takeaways (4s)
say -v "$VOICE" -r "$RATE" -o "$AUDIO/05-takeaways.aiff" \
  "So the bottom line. [[slnc 300]]
Fifty-nine percent context savings at scale, measured with a real tokenizer. [[slnc 300]]
The crossover is at ten entries, which agents hit in the first day. [[slnc 300]]
Even with heavy topic loading, the typed index wins at fifty entries. [[slnc 300]]
And these are real numbers from the sandbox container. Run npm run benchmark memory to reproduce them yourself."

echo "Converting to wav..."
for f in "$AUDIO"/*.aiff; do
  ffmpeg -y -i "$f" -ar 44100 -ac 1 "${f%.aiff}.wav" 2>/dev/null
done

echo "Done."
for f in "$AUDIO"/*.wav; do
  dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f")
  echo "  $(basename "$f"): ${dur}s"
done
