---
name: "nemoclaw-user-get-started"
description: "Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time. Windows-only prerequisites before the Quickstart. Enables WSL 2, installs Ubuntu, and configures Docker Desktop with the WSL 2 backend. Use when installing NemoClaw on Windows, setting up WSL, or troubleshooting Windows-specific prerequisites."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Get Started

Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time.

## Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

- Windows 10 (build 19041 or later) or Windows 11.
- Hardware requirements are the same as the Quickstart (see the `nemoclaw-user-get-started` skill).

> **Alpha software:** NemoClaw is in alpha, available as an early preview since March 16, 2026.
> APIs, configuration schemas, and runtime behavior are subject to breaking changes between releases.
> Do not use this software in production environments.
> File issues and feedback through the GitHub repository as the project continues to stabilize.

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

## Step 1: Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

> **Note:** NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

> **Note:** The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
> This is a build-time setting baked into the sandbox image, not a runtime knob.
> If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.

When the install completes, a summary confirms the running environment:

```text
──────────────────────────────────────────────────
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

## Step 2: Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

```bash
nemoclaw my-assistant connect
```

In the sandbox shell, open the OpenClaw terminal UI and start a chat:

```bash
openclaw tui
```

Alternatively, send a single message and print the response:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

## Step 3: Uninstall

To remove NemoClaw and all resources created during setup, run the uninstall script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

For troubleshooting installation or onboarding issues, see the Troubleshooting guide (see the `nemoclaw-user-reference` skill).

---

NemoClaw runs inside Windows Subsystem for Linux (WSL 2) on Windows.
Complete these steps before following the Quickstart (see the `nemoclaw-user-get-started` skill).
Linux and macOS users do not need this page and can go directly to the Quickstart.

> **Note:** This guide has been tested on x86-64.

## Step 4: Enable WSL 2

Open an elevated PowerShell (Run as Administrator):

```console
$ wsl --install --no-distribution
```

This enables both the Windows Subsystem for Linux and Virtual Machine Platform features.

Reboot if prompted.

## Step 5: Install and Register Ubuntu

After reboot, open an elevated PowerShell again:

```console
$ wsl --install -d Ubuntu
```

Let the distribution launch and complete first-run setup (pick a Unix username and password), then type `exit` to return to PowerShell.

> **Warning:** Do not use the `--no-launch` flag.
> The `--no-launch` flag downloads the package but does not register the distribution with WSL.
> Commands like `wsl -d Ubuntu` fail with "There is no distribution with the supplied name" until the distribution has been launched at least once.

Verify the distribution is registered and running WSL 2:

```console
$ wsl -l -v
```

Expected output:

```text
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

## Step 6: Install Docker Desktop

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 backend (the default on Windows 11).

After installation, open Docker Desktop Settings and confirm that WSL integration is enabled for your Ubuntu distribution (Settings > Resources > WSL integration).

Verify from inside WSL:

```console
$ wsl
$ docker info
```

`docker info` prints server information.
If you see "Cannot connect to the Docker daemon", confirm that Docker Desktop is running and that WSL integration is enabled.

## Step 7: Set Up Local Inference with Ollama (Optional)

If you plan to select Ollama as your inference provider during onboarding, install it inside WSL before running the NemoClaw installer:

```console
$ curl -fsSL https://ollama.com/install.sh | sh
```

If Ollama is also running on the Windows side, quit it before running `nemoclaw onboard` (system tray > right-click > Quit).
The Windows and WSL instances bind to the same port and conflict.

The onboarding process starts Ollama in WSL if it is not already running.
You can also start it yourself beforehand with `ollama serve`.

## Step 8: Next Step

Your Windows environment is ready.
Open a WSL terminal (type `wsl` in PowerShell, or open Ubuntu from Windows Terminal) and continue with the Quickstart (see the `nemoclaw-user-get-started` skill) to install NemoClaw and launch your first sandbox.

All NemoClaw commands run inside WSL, not in PowerShell.

## Related Skills

- `nemoclaw-user-configure-inference` — Switch inference providers to use a different model or endpoint
- `nemoclaw-user-manage-policy` — Approve or deny network requests when the agent tries to reach external hosts
- `nemoclaw-user-deploy-remote` — Deploy to a remote GPU instance for always-on operation
- `nemoclaw-user-monitor-sandbox` — Monitor sandbox activity through the OpenShell TUI
