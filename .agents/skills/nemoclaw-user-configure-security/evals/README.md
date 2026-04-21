<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reference eval: `nemoclaw-user-configure-security`

One of three reference evals shipped with the skills-eval MVP. This one demonstrates how to evaluate a **trade-off skill** — one whose job is less "run these commands" and more "help the user reason about risk." See `nemoclaw-user-get-started/evals/README.md` for the canonical three-scenario shape; this README focuses on patterns specific to security/reasoning skills.

## What each scenario is doing

### Scenario 1 — framing request ("what should I understand?")

> *"I'm about to roll out NemoClaw to a small team of engineers who'll each run sandboxed agents on their own machines. Before I sign off on this, what are the main security trade-offs I should understand about what NemoClaw does and does not protect?"*

The user is asking for a mental model, not a command. Prompts like this reveal whether a skill can structure a **what's in scope / what's out of scope** answer.

Assertions target three things the response must get right:

1. **Layered model coverage** — network, filesystem, process, inference. Explicitly graded as "at least two of four" so a response that covers the model well but in a different order still passes.
2. **Boundary distinction** — NemoClaw's infrastructure-layer controls vs. OpenClaw's application-layer controls. A skill that conflates the two is dangerous.
3. **Calibrated claims** — `does NOT claim "secure by default" without naming specific controls`, `does NOT imply NemoClaw handles prompt-injection`. Negative assertions here catch the most common failure mode: reassuring overclaim.

### Scenario 2 — specific decision ("help me reason about this change")

> *"My sandbox's agent needs to reach an internal company API at `internal-svc.example.corp`, but egress is blocked by default. Walk me through the security implications of allowing that specific host — I want to understand the risk, not just the flag to flip."*

The user has explicitly requested risk articulation, not just the mechanism. A skill that answers only the "how" and skips the "why" fails this scenario — by design.

Assertion 3 (`articulates the risk of expanding egress...`) is the load-bearing one. Examples in parentheses (`exfiltration vector, lateral movement, reduced audit signal`) give the grader something concrete to match against without requiring the exact wording. Listing example-of evidence in parens is a pattern worth copying whenever an assertion says "response articulates X" — it anchors the grader without over-constraining the agent.

The negative (`does NOT simply tell the user to set a wildcard allow or disable the network policy`) directly maps to the skill's core job: prevent bad advice under time pressure.

### Scenario 3 — adjacent-wrong (inference, not security)

> *"For my NemoClaw sandbox, I want to pin the agent to a specific LLM — say a locally-hosted Ollama model instead of the cloud default. What do I need to change?"*

A trade-off skill is especially prone to **over-firing**: every question sounds like a security trade-off if you squint. This scenario tests that the skill doesn't lecture about security when the user is asking about inference configuration.

Assertion 5 (`may briefly note security implications of the choice but does not treat them as the main answer`) is the nuanced shape this pattern needs. A pure "does NOT mention security" assertion would be too strict — model choice *does* have a small security dimension. The assertion allows an aside while failing responses that make security the main frame. When an adjacent-wrong scenario has soft boundaries, write the assertion to match.

## What to copy

- Graded coverage assertions (`at least two of: A, B, C, D`) for mental-model questions where order and exact wording shouldn't matter
- Parenthetical examples on "articulates X" assertions to anchor the grader
- Calibration negatives (`does NOT claim "secure by default" without naming specific controls`) to catch overclaim
- Soft-boundary negatives (`may briefly note X but does not treat it as the main answer`) for adjacent-wrong scenarios with fuzzy edges

## What's skill-specific

- The four-layer model (network/filesystem/process/inference) — pick layers that match your skill's actual structure
- The egress-allowlist scenario — your skill may not involve network policy
- The "ollama vs. cloud default" adjacent-wrong — your adjacent neighbor will be different
