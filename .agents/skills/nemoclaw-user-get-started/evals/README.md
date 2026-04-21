<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reference eval: `nemoclaw-user-get-started`

This is one of three reference evals shipped with the skills-eval MVP. It demonstrates the **canonical three-scenario shape** from [`.agents/skills/EVALS.md`](../../EVALS.md): happy-path, partial-state, adjacent-wrong. Read this alongside `evals.json` if you're authoring a new eval and want a concrete example of what "good" looks like.

## What each scenario is doing

### Scenario 1 — happy path

> *"I'm brand new to NemoClaw and working on a MacBook. Walk me through getting my first sandbox running so I can talk to an agent."*

Hits the implementation-vagueness test: strip the skill name and you still know this is a get-started prompt, but you couldn't cheat by grepping for a specific command. The user voice is what someone would actually type in Slack, not an invocation.

Assertions probe the full journey (install → onboard → connect → talk), plus a **platform negative** (`does NOT assume Windows`) that catches skills drifting into platform-agnostic prose when the user explicitly named macOS. Assertion count is 6, above the 4-minimum — the happy-path scenario usually warrants more assertions because it's where most of the skill's value lives.

### Scenario 2 — partial state

> *"I ran the NemoClaw install script and it said it finished, but now when I type `nemoclaw` in my terminal I get 'command not found'. I use nvm to manage Node. What should I try?"*

The user is stuck mid-journey with a specific environment detail (nvm). This scenario separates "skill knows the install flow" from "skill knows the gotchas" — a skill that only covers the happy path will fail the `nvm or fnm` assertion even if the install steps are right.

The negative assertions here (`does NOT recommend uninstall/reinstall`, `does NOT claim the install failed`) catch a common failure mode: an agent trying to "solve" the problem by restarting from scratch instead of explaining what went wrong. These are worth including any time a scenario has a clear *wrong-but-plausible* answer.

### Scenario 3 — adjacent-wrong

> *"I already have a NemoClaw sandbox running — it's working fine — but I want to switch the model it uses from the default Nemotron model to a different provider. How do I do that?"*

This scenario **should not fire the skill** — it belongs to `nemoclaw-user-configure-inference`. The agent's job is to recognize the misroute and redirect.

The assertions are weighted toward negatives (`does NOT re-run install`, `does NOT walk through first-time onboarding`) because "don't do the wrong thing" is exactly what this scenario is testing. Positive assertions cover the correct redirect (points to inference configuration) and a state-preservation claim (existing sandbox keeps running) to make sure the redirect isn't destructive.

Every skill's eval should have at least one adjacent-wrong scenario. Without one, you can't tell a skill that correctly fires on get-started prompts from a skill that fires on *everything*.

## What to copy

- The three-scenario spine (happy / partial / adjacent-wrong)
- Mixing positive and negative assertions in the same scenario
- Keeping prompts in first-person user voice, not third-person descriptions
- Sizing assertions: 5–6 on the scenario where the skill is load-bearing, 4–5 on the edges

## What's skill-specific

- The `curl | bash` installer string — most skills won't need to test an install one-liner
- The `nvm / fnm` edge — specific to tools that install via Node
- The Nemotron → other-provider pattern in scenario 3 — your skill will have a different adjacent-wrong neighbor
