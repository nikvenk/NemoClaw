#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Default to the OpenClaw agent when no agent is specified.
// This makes nemoclaw an alias like nemohermes — both set NEMOCLAW_AGENT
// before entering the shared CLI implementation.
if (!process.env.NEMOCLAW_AGENT) {
  process.env.NEMOCLAW_AGENT = "openclaw";
}
require("../dist/nemoclaw");
