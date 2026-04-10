<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Multi-Agent Swarm Design

```{note}
This feature is under active development. Interfaces described here are proposals
and will change as implementation progresses.
```

## Overview

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
