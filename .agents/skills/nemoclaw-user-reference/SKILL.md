---
name: "nemoclaw-user-reference"
description: "Describes how NemoClaw combines a CLI plugin with a versioned blueprint to move OpenClaw into a controlled sandbox. Use when looking up NemoClaw architecture, plugin structure, or blueprint design. Lists all slash commands and standalone NemoClaw CLI commands. Use when looking up a command, checking command syntax, or browsing the CLI reference. Documents baseline network policy, filesystem rules, and operator approval flow. Use when reviewing default network policies, understanding egress controls, or looking up the approval flow. Diagnoses and resolves common NemoClaw installation, onboarding, and runtime issues. Use when troubleshooting errors, debugging sandbox problems, or resolving setup failures."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Reference

Describes how NemoClaw combines a CLI plugin with a versioned blueprint to move OpenClaw into a controlled sandbox. Use when looking up NemoClaw architecture, plugin structure, or blueprint design.

```{note}
This feature is under active development. Interfaces described here are proposals
and will change as implementation progresses.
```

## Step 1: Overview

NemoClaw gains the ability to run multiple agents ("claws") of potentially
different types inside the same OpenShell sandbox. Agents communicate through a
shared **swarm bus** using their native messaging interfaces, and an operator can
observe the conversation from the CLI.

### Design Principles

1. **Backwards compatible** — a sandbox with one agent behaves identically to today.
2. **Native messaging** — each agent talks to the bus through a per-type bridge
   adapter that presents the bus as just another messaging platform. Agents never
   learn a foreign protocol.
3. **Pluggable** — adding support for a new agent type means writing one bridge
   adapter. The bus protocol and adapter interface are the stable contracts.
4. **Shared infrastructure** — all agents in a sandbox share the inference
   endpoint and network policy. Each gets its own config space.

See `docs/reference/multi-agent-swarm.md` for the full design document.

## Reference

- [NemoClaw Architecture: Plugin, Blueprint, and Sandbox Structure](references/architecture.md)
- [NemoClaw CLI Commands Reference](references/commands.md)
- [NemoClaw Network Policies: Baseline Rules and Operator Approval](references/network-policies.md)
- [NemoClaw Troubleshooting Guide](references/troubleshooting.md)
