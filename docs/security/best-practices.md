---
title:
  page: "NemoClaw Security Best Practices — Controls, Risks, and Posture Profiles"
  nav: "Security Best Practices"
description: "A risk framework for every configurable security control in NemoClaw: defaults, what you can change, and what happens if you do."
keywords: ["nemoclaw security best practices", "sandbox security controls risk framework"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "security", "network_policy", "nemoclaw"]
content:
  type: concept
  difficulty: intermediate
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Security Best Practices

NemoClaw ships with deny-by-default security controls across four layers: network, filesystem, process, and inference.
Every control can be tuned, but each change shifts the risk profile.
This page documents every configurable knob, its default, what it protects, the concrete risk of relaxing it, and a recommendation for common use cases.

For background on how the layers fit together, refer to [How It Works](../about/how-it-works.md).

## Protection Layers at a Glance

NemoClaw enforces security at four layers.
Some are locked when the sandbox is created and require a restart to change.
Others can be hot-reloaded while the sandbox is running.

```{mermaid}
flowchart LR
    subgraph locked ["Locked at Creation"]
        FS["Filesystem\nRead-only mounts\nLandlock LSM"]
        PROC["Process\nCapability drops\nulimit · seccomp\nnon-root user"]
    end

    subgraph hotReload ["Hot-Reloadable at Runtime"]
        NET["Network\nDeny-by-default egress\nBinary-scoped rules\nOperator approval"]
        INF["Inference\nRouted via gateway\nCredential isolation\nProvider selection"]
    end

    AGENT["Agent in Sandbox"] --> NET
    AGENT --> FS
    AGENT --> PROC
    AGENT --> INF
```

:::{list-table}
:header-rows: 1
:widths: 20 30 20 30

* - Layer
  - What it protects
  - Enforcement point
  - Changeable at runtime

* - Network
  - Unauthorized outbound connections and data exfiltration.
  - OpenShell gateway
  - Yes. Use `openshell policy set` or operator approval.

* - Filesystem
  - System binary tampering, credential theft, config manipulation.
  - Landlock LSM + container mounts
  - No. Requires sandbox re-creation.

* - Process
  - Privilege escalation, fork bombs, syscall abuse.
  - Container runtime (Docker/K8s `securityContext`)
  - No. Requires sandbox re-creation.

* - Inference
  - Credential exposure, unauthorized model access, cost overruns.
  - OpenShell gateway
  - Yes. Use `openshell inference set`.

:::

## Network Controls

### Deny-by-Default Egress

The sandbox blocks all outbound connections unless an endpoint is explicitly listed in the policy file `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.

| Aspect | Detail |
|---|---|
| Default | All egress denied. Only endpoints in the baseline policy are reachable. |
| What you can change | Add endpoints to the policy file (static) or via `openshell policy set` (dynamic). |
| Risk if relaxed | Each allowed endpoint is a potential data exfiltration path. The agent can send workspace content, credentials, or conversation history to any reachable host. |
| Recommendation | Add only endpoints the agent needs for its task. Prefer operator approval for one-off requests over permanently widening the baseline. |

### Binary-Scoped Endpoint Rules

Each network policy entry restricts which executables can reach the endpoint via the `binaries` field.

| Aspect | Detail |
|---|---|
| Default | Endpoints are restricted to specific binaries. For example, only `/usr/bin/gh` and `/usr/bin/git` can reach `github.com`. |
| What you can change | Add binaries to an endpoint entry, or omit the `binaries` field to allow any executable. |
| Risk if relaxed | Removing binary restrictions lets any process in the sandbox reach the endpoint. An agent could use `curl`, `wget`, or a Python script to exfiltrate data to an allowed host, bypassing the intended usage pattern. |
| Recommendation | Always scope endpoints to the binaries that need them. If the agent needs a host from a new binary, add that binary explicitly rather than removing the restriction. |

### Path-Scoped HTTP Rules

Endpoint rules can restrict allowed HTTP methods and URL paths.

| Aspect | Detail |
|---|---|
| Default | Most endpoints allow GET and POST on `/**`. Some are read-only (GET only), such as `docs.openclaw.ai`. |
| What you can change | Add methods (PUT, DELETE, PATCH) or restrict paths to specific prefixes. |
| Risk if relaxed | Allowing all methods on an API endpoint gives the agent write and delete access. For example, allowing DELETE on `api.github.com` lets the agent delete repositories. |
| Recommendation | Use GET-only rules for endpoints that the agent only reads. Add write methods only for endpoints where the agent must create or modify resources. Restrict paths to specific API routes when possible. |

### CONNECT Tunnel vs TLS-Terminated Inspection

Endpoints can be configured with `protocol: rest` (TLS-terminated, HTTP-level inspection) or `access: full` (CONNECT tunnel, no inspection).

| Aspect | Detail |
|---|---|
| Default | Most endpoints use `protocol: rest` with TLS termination. WebSocket endpoints (Discord gateway, Slack Socket Mode) use `access: full`. |
| What you can change | Switch any endpoint between `protocol: rest` and `access: full`. |
| Risk if relaxed | `access: full` bypasses HTTP-level inspection. The gateway cannot see or filter the request method, path, or body. The agent can send arbitrary data through the tunnel. Use this only for protocols that require persistent connections (WebSocket, gRPC streaming). |
| Recommendation | Use `protocol: rest` for all HTTP/REST APIs. Reserve `access: full` for WebSocket and streaming protocols that break under TLS termination. |

### Operator Approval Flow

When the agent reaches an unlisted endpoint, OpenShell blocks the request and prompts the operator in the TUI.

| Aspect | Detail |
|---|---|
| Default | Enabled. All unlisted endpoints are blocked and require approval. |
| What you can change | Approved endpoints persist for the current session only. They reset when the sandbox restarts. |
| Risk if relaxed | Approving an endpoint grants the agent access for the rest of the session. If you approve a broad domain (such as a CDN that hosts arbitrary content), the agent can fetch anything from that domain until the sandbox restarts. |
| Recommendation | Review each blocked request before approving. If you find yourself approving the same endpoint repeatedly, add it to the baseline policy with appropriate binary and path restrictions instead. |

### Policy Presets

NemoClaw ships preset policy files in `nemoclaw-blueprint/policies/presets/` for common integrations.

| Preset | What it enables | Key risk |
|---|---|---|
| `discord` | Discord REST API, WebSocket gateway, CDN. | CDN endpoint (`cdn.discordapp.com`) allows GET to any path. WebSocket uses `access: full` (no inspection). |
| `docker` | Docker Hub, NVIDIA container registry. | Allows pulling arbitrary container images into the sandbox. |
| `huggingface` | Hugging Face model registry. | Allows downloading arbitrary models and datasets. |
| `jira` | Atlassian Jira API. | Gives agent read/write access to project issues and comments. |
| `npm` | npm and Yarn registries. | Allows installing arbitrary npm packages, which may contain malicious code. |
| `outlook` | Microsoft 365, Outlook. | Gives agent access to email. |
| `pypi` | Python Package Index. | Allows installing arbitrary Python packages, which may contain malicious code. |
| `slack` | Slack API, Socket Mode, webhooks. | WebSocket uses `access: full`. Agent can post to any channel the bot token has access to. |
| `telegram` | Telegram Bot API. | Agent can send messages to any chat the bot token has access to. |

**Recommendation:** Apply presets only when the agent's task requires the integration. Review the preset's YAML file before applying to understand the endpoints, methods, and binary restrictions it adds.

## Filesystem Controls

### Read-Only System Paths

System directories are mounted read-only to prevent the agent from modifying binaries, libraries, or configuration files.

| Aspect | Detail |
|---|---|
| Default | `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/app`, `/etc`, `/var/log` are read-only. |
| What you can change | Add or remove paths in the `filesystem_policy.read_only` section of the policy file. |
| Risk if relaxed | Making `/usr` or `/lib` writable lets the agent replace system binaries (such as `curl` or `node`) with trojanized versions. Making `/etc` writable lets the agent modify DNS resolution, TLS trust stores, or user accounts. |
| Recommendation | Never make system paths writable. If the agent needs a writable location for generated files, use a subdirectory of `/sandbox`. |

### Read-Only `.openclaw` Config

The `/sandbox/.openclaw` directory contains the OpenClaw gateway configuration, including auth tokens and CORS settings.
It is mounted read-only while writable agent state (plugins, agent data) lives in `/sandbox/.openclaw-data` via symlinks.

| Aspect | Detail |
|---|---|
| Default | `/sandbox/.openclaw` is read-only. `/sandbox/.openclaw-data` is writable. |
| What you can change | Move `/sandbox/.openclaw` from `read_only` to `read_write` in the policy file. |
| Risk if relaxed | A writable `.openclaw` directory lets the agent modify its own gateway config: disabling CORS, changing auth tokens, or redirecting inference to an attacker-controlled endpoint. This is the single most dangerous filesystem change. |
| Recommendation | Never make `/sandbox/.openclaw` writable. |

### Writable Paths

The agent has read-write access to `/sandbox`, `/tmp`, and `/dev/null`.

| Aspect | Detail |
|---|---|
| Default | `/sandbox` (agent workspace), `/tmp` (temporary files), `/dev/null`. |
| What you can change | Add additional writable paths in `filesystem_policy.read_write`. |
| Risk if relaxed | Each additional writable path expands the agent's ability to persist data and potentially modify system behavior. Adding `/var` lets the agent write to log directories. Adding `/home` gives access to other user directories. |
| Recommendation | Keep writable paths to `/sandbox` and `/tmp`. If the agent needs a persistent working directory, create a subdirectory under `/sandbox`. |

### Landlock LSM Enforcement

Landlock is a Linux Security Module that enforces filesystem access rules at the kernel level.

| Aspect | Detail |
|---|---|
| Default | `compatibility: best_effort`. Landlock rules are applied when the kernel supports them and silently skipped on older kernels. |
| What you can change | This is a NemoClaw default, not a user-facing knob. |
| Risk if relaxed | On kernels without Landlock support (pre-5.13), filesystem restrictions rely solely on container mount configuration, which is less granular. |
| Recommendation | Run on a kernel that supports Landlock (5.13+). Ubuntu 22.04 LTS and later include Landlock support. |

## Process Controls

### Capability Drops

Linux capabilities are dropped at container launch to prevent privilege escalation.

| Aspect | Detail |
|---|---|
| Default | All capabilities are dropped (`--cap-drop=ALL`). Only `NET_BIND_SERVICE` is re-added in the Compose example. |
| What you can change | Add capabilities back via `--cap-add` in `docker run` or `cap_add` in Compose. |
| Risk if relaxed | `CAP_SYS_ADMIN` allows mounting filesystems and accessing `/proc` in ways that can escape the container. `CAP_NET_RAW` allows raw socket access for network sniffing. `CAP_DAC_OVERRIDE` bypasses filesystem permission checks. |
| Recommendation | Keep `--cap-drop=ALL`. Add capabilities back only if a specific binary requires them, and document the reason. |

### No New Privileges

The `no-new-privileges` security option prevents processes from gaining additional privileges through setuid binaries or capability inheritance.

| Aspect | Detail |
|---|---|
| Default | Enabled via `security_opt: no-new-privileges:true` in the Compose configuration. |
| What you can change | Remove the `no-new-privileges` flag from the container runtime configuration. |
| Risk if relaxed | Without this flag, a compromised process could execute a setuid binary to escalate to root inside the container, then attempt container escape techniques. |
| Recommendation | Always set `no-new-privileges:true`. |

### Process Limit

A process limit caps the number of processes the sandbox user can spawn.

| Aspect | Detail |
|---|---|
| Default | 512 processes (`ulimit -u 512`). |
| What you can change | Increase or decrease the limit via `--ulimit nproc=N:N` in `docker run` or the `ulimits` section in Compose. |
| Risk if relaxed | Removing or raising the limit makes the sandbox vulnerable to fork-bomb attacks, where a runaway process spawns children until the host runs out of resources. |
| Recommendation | Keep the default at 512. If the agent runs workloads that spawn many child processes (such as parallel test runners), increase to 1024 and monitor host resource usage. |

### Non-Root User

The sandbox runs all processes as a dedicated `sandbox` user and group.

| Aspect | Detail |
|---|---|
| Default | `run_as_user: sandbox`, `run_as_group: sandbox`. |
| What you can change | Change the `process` section in the policy file to run as a different user. |
| Risk if relaxed | Running as `root` inside the container gives the agent access to modify any file in the container filesystem and increases the impact of container escape vulnerabilities. |
| Recommendation | Never run as root. Keep the `sandbox` user. |

### Build Toolchain Removal

Compilers and network probes are removed from the runtime image.

| Aspect | Detail |
|---|---|
| Default | `gcc`, `g++`, `make`, and `netcat` are purged from the sandbox image. |
| What you can change | Modify the Dockerfile to keep these tools, or install them at runtime if package manager access is allowed. |
| Risk if relaxed | A compiler lets the agent build arbitrary native code, including kernel exploits or custom network tools. `netcat` enables arbitrary TCP connections that bypass HTTP-level policy enforcement. |
| Recommendation | Keep build tools removed. If the agent needs to compile code, run the build in a separate, purpose-built container and copy artifacts into the sandbox. |

## Inference Controls

### Routed Inference via `inference.local`

All inference requests from the agent are intercepted by the OpenShell gateway and routed to the configured provider.
The agent never receives the provider API key.

| Aspect | Detail |
|---|---|
| Default | The agent talks to `inference.local`. The host owns the credential and upstream endpoint. |
| What you can change | This architecture is not configurable. It is always enforced. |
| Risk if bypassed | If the agent could reach an inference endpoint directly (by adding it to the network policy), it would need an API key. Since credentials are not in the sandbox, this is a defense-in-depth measure. However, adding an inference provider's host to the network policy without going through OpenShell routing could let the agent use a stolen or hardcoded key. |
| Recommendation | Do not add inference provider hosts (such as `api.openai.com` or `api.anthropic.com`) to the network policy. Use OpenShell inference routing instead. |

### Provider Trust Tiers

Different inference providers have different trust and cost profiles.

| Provider | Trust level | Cost risk | Data handling |
|---|---|---|---|
| NVIDIA Endpoints | High. Hosted on `build.nvidia.com`. | Pay-per-token via API key. Unattended agents can accumulate cost. | Requests processed by NVIDIA infrastructure. |
| OpenAI | High. Commercial API. | Pay-per-token. Same cost risk as NVIDIA Endpoints. | Subject to OpenAI data policies. |
| Anthropic | High. Commercial API. | Pay-per-token. Same cost risk. | Subject to Anthropic data policies. |
| Google Gemini | High. Commercial API. | Pay-per-token. Same cost risk. | Subject to Google data policies. |
| Local Ollama | Self-hosted. No data leaves the machine. | No per-token cost. GPU/CPU resource cost. | Data stays local. |
| Custom compatible endpoint | Varies. Depends on the proxy or gateway. | Varies. | Depends on the endpoint operator. |

**Recommendation:** For sensitive workloads, use local Ollama to keep data on-premise. For general use, NVIDIA Endpoints provide a good balance of capability and trust. Review the data policies of any cloud provider you use.

### Experimental Providers

Local NVIDIA NIM and local vLLM are gated behind the `NEMOCLAW_EXPERIMENTAL=1` environment variable.

| Aspect | Detail |
|---|---|
| Default | Disabled. These providers do not appear in the onboarding wizard. |
| What you can change | Set `NEMOCLAW_EXPERIMENTAL=1` before running `nemoclaw onboard`. |
| Risk if relaxed | These providers are not fully validated. NIM requires a NIM-capable GPU. vLLM must already be running on `localhost:8000`. Misconfiguration can result in failed inference or unexpected behavior. |
| Recommendation | Use experimental providers only for evaluation. Do not rely on them for always-on assistants. |

## Posture Profiles

The following profiles describe how to configure NemoClaw for different use cases.
They are not separate policy files. They are guidance on which controls to keep tight or relax.

### Locked-Down (Default)

Use for always-on assistants with minimal external access.

- Keep all defaults. Do not add presets.
- Use operator approval for any endpoint the agent requests.
- Use NVIDIA Endpoints or local Ollama for inference.
- Monitor the TUI for unexpected network requests.

### Development

Use when the agent needs package registries, Docker Hub, or broader GitHub access during development tasks.

- Apply the `pypi` and `npm` presets for package installation.
- Apply the `docker` preset if the agent builds or pulls container images.
- Keep binary restrictions on all presets.
- Review the agent's network activity periodically via `openshell term`.
- Use operator approval for any endpoint not covered by a preset.

### Integration Testing

Use when the agent talks to internal APIs or third-party services during testing.

- Add custom endpoint entries with tight path and method restrictions.
- Use `protocol: rest` for all HTTP APIs to maintain inspection.
- Use operator approval for unknown endpoints during test runs.
- Review and clean up the baseline policy after testing. Remove endpoints that are no longer needed.

## Common Mistakes

The following patterns weaken security without providing meaningful benefit.

**Using `access: full` for REST APIs.**
`access: full` creates a CONNECT tunnel that bypasses HTTP-level inspection.
The gateway cannot see the request method, path, or body.
Use `protocol: rest` with explicit method and path rules for all HTTP/REST APIs.
Reserve `access: full` for WebSocket and streaming protocols.

**Adding endpoints to the baseline policy for one-off requests.**
If the agent needs an endpoint once, use operator approval.
Approved endpoints persist for the session and reset on restart.
Adding an endpoint to the baseline policy makes it permanently reachable across all sessions.

**Running the container without `--cap-drop=ALL`.**
The Dockerfile cannot enforce capability drops.
If you launch the container with `docker run` without `--cap-drop=ALL`, the container runs with the default Docker capability set, which includes `CAP_NET_RAW`, `CAP_CHOWN`, and others.

**Granting write access to `/sandbox/.openclaw`.**
This directory contains the OpenClaw gateway configuration.
A writable `.openclaw` lets the agent modify auth tokens, disable CORS, or redirect inference routing.
Agent-writable state belongs in `/sandbox/.openclaw-data`.

**Adding inference provider hosts to the network policy.**
Do not add hosts like `api.openai.com` or `api.anthropic.com` to the network policy.
Use OpenShell inference routing instead.
Direct network access to an inference host bypasses credential isolation and usage tracking.

## Related Topics

- [Network Policies](../reference/network-policies.md) for the full baseline policy reference.
- [Customize the Network Policy](../network-policy/customize-network-policy.md) for static and dynamic policy changes.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) for the operator approval flow.
- [Sandbox Hardening](../deployment/sandbox-hardening.md) for container-level security measures.
- [Inference Profiles](../reference/inference-profiles.md) for provider configuration details.
- [How It Works](../about/how-it-works.md) for the protection layer architecture.
