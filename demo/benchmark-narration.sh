#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Narration clips for the benchmark demo video.
# Each clip is timed to fit its demo section exactly.
#
# Demo section windows:
#   Intro:          8.0s
#   Context table: 19.5s
#   Crossover:      6.0s
#   Session table: 20.5s
#   Takeaways:     16.0s
#   Total:         70.0s

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIO="$DIR/audio/benchmark"
VOICE="Samantha"
RATE=185

rm -rf "$AUDIO"
mkdir -p "$AUDIO"

echo "Generating benchmark narration clips..."

# 1. Intro — must fit in 8s
say -v "$VOICE" -r "$RATE" -o "$AUDIO/01-intro.aiff" \
  "Flat versus typed index. Measured with tiktoken inside the NemoClaw sandbox."

# 2. Context window table — must fit in 19.5s
say -v "$VOICE" -r "$RATE" -o "$AUDIO/02-context.aiff" \
  "Context window tokens. This is what the agent loads every session. [[slnc 300]]
At ten entries, fifty percent savings. [[slnc 200]]
At a thousand entries, fifty-nine percent. [[slnc 200]]
At ten thousand, the flat file burns six hundred sixty-eight thousand tokens. The typed index uses two seventy-two thousand. [[slnc 200]]
Fifty-nine percent less."

# 3. Crossover — must fit in 6s
say -v "$VOICE" -r "$RATE" -o "$AUDIO/03-crossover.aiff" \
  "Crossover at about ten entries. Below that, flat is smaller."

# 4. Session cost — must fit in 20.5s
say -v "$VOICE" -r "$RATE" -o "$AUDIO/04-session.aiff" \
  "Now the honest part. Each tool call costs eighty tokens. [[slnc 200]]
Green means the typed index is cheaper. Red means it costs more. [[slnc 300]]
At ten entries with ten reads, the typed index is worse. [[slnc 200]]
But at fifty entries, it already wins. [[slnc 200]]
At a thousand entries, even heavy usage saves fifty-seven percent."

# 5. Takeaways — must fit in 16s
say -v "$VOICE" -r "$RATE" -o "$AUDIO/05-takeaways.aiff" \
  "Bottom line. [[slnc 200]]
Fifty-nine percent context savings at scale. [[slnc 200]]
Crossover at ten entries, which agents hit day one. [[slnc 200]]
Even with ten reads per session, typed index wins at fifty entries. [[slnc 200]]
All real numbers. Run npm run benchmark memory to reproduce."

echo "Converting to wav..."
for f in "$AUDIO"/*.aiff; do
  ffmpeg -y -i "$f" -ar 44100 -ac 1 "${f%.aiff}.wav" 2>/dev/null
done

echo "Done."
for f in "$AUDIO"/*.wav; do
  dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f")
  echo "  $(basename "$f"): ${dur}s"
done
