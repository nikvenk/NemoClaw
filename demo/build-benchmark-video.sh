#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Step 1: Generate narration ==="
bash demo/benchmark-narration.sh

echo ""
echo "=== Step 2: Concatenate audio ==="
AUDIO="demo/audio/benchmark"
ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.8 "$AUDIO/silence.wav" 2>/dev/null

: >"$AUDIO/concat.txt"
for f in "$AUDIO"/0*.wav; do
  [ -f "$f" ] || continue
  [[ "$(basename "$f")" == silence.wav ]] && continue
  echo "file '$(basename "$f")'" >>"$AUDIO/concat.txt"
  echo "file 'silence.wav'" >>"$AUDIO/concat.txt"
done

ffmpeg -y -f concat -safe 0 -i "$AUDIO/concat.txt" -c:a pcm_s16le "$AUDIO/narration-full.wav" 2>/dev/null
AUDIO_DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$AUDIO/narration-full.wav")
echo "  Narration: ${AUDIO_DUR}s"

echo ""
echo "=== Step 3: Record terminal ==="
# Calculate sleep time: audio duration + 5s buffer
SLEEP_TIME=$(echo "$AUDIO_DUR" | awk '{t = $1 + 5; printf "%d", t}')

cat >demo/benchmark-timed.tape <<TAPE
Output demo/benchmark-timed.mp4

Set Width 1000
Set Height 750
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 0
Set PlaybackSpeed 1

Sleep 500ms
Type "node demo/benchmark-demo-timed.mjs"
Enter
Sleep ${SLEEP_TIME}s
TAPE

echo "  Recording (${SLEEP_TIME}s)..."
vhs demo/benchmark-timed.tape 2>&1 | tail -2

echo ""
echo "=== Step 4: Merge video + audio ==="
VIDEO_DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 demo/benchmark-timed.mp4)
echo "  Video: ${VIDEO_DUR}s  Audio: ${AUDIO_DUR}s"

ffmpeg -y \
  -i demo/benchmark-timed.mp4 \
  -i "$AUDIO/narration-full.wav" \
  -c:v copy -c:a aac -b:a 128k \
  -shortest -movflags +faststart \
  demo/nemoclaw-benchmark-demo.mp4 2>/dev/null

SIZE=$(stat -f%z demo/nemoclaw-benchmark-demo.mp4 2>/dev/null || stat --format=%s demo/nemoclaw-benchmark-demo.mp4 2>/dev/null)
SIZE=$(echo "$SIZE" | awk '{printf "%.1fM", $1/1048576}')
DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 demo/nemoclaw-benchmark-demo.mp4)

echo ""
echo "=== Done ==="
echo "  demo/nemoclaw-benchmark-demo.mp4  ($SIZE, ${DUR}s)"
echo "  open demo/nemoclaw-benchmark-demo.mp4"
