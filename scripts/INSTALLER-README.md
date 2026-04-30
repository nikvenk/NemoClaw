<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Installer Guide — DGX Station GB300 (Local vLLM)

This guide covers the full installation of NemoClaw on a DGX Station GB300 using a
locally-served vLLM inference backend with the Nemotron-3 Super 120B NVFP4 model.

---

## One-Time System Preparation

These steps only need to be done once per system.

### 1. Add your user to the docker group

OpenShell gateway management requires Docker socket access without `sudo`.
Running `openshell` as root causes TLS certificate ownership mismatches that
break the installer at step [4/8].

```bash
sudo usermod -aG docker $USER
# Open a new terminal for the group change to take effect
```

Verify:

```bash
docker ps   # should succeed without sudo
```

### 2. Fix any root-owned directories

If the installer was ever run with `sudo` previously, several directories may be
owned by root. Fix them before running again:

```bash
sudo chown -R $USER:$USER ~/.config/openshell
sudo chown -R $USER:$USER ~/.nvm
sudo chown -R $USER:$USER ~/.npm
sudo chown -R $USER:$USER ~/.nemoclaw
sudo chown -R $USER:$USER ~/NemoClaw          # adjust to your checkout path
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

### 3. Obtain a HuggingFace token

The Nemotron-3 Super 120B NVFP4 model is gated. You need a token with read access
to the model repository:

- Accept the model license at: https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4
- Create a token at: https://huggingface.co/settings/tokens

Export it in every terminal session that runs the installer or vLLM:

```bash
export HUGGING_FACE_HUB_TOKEN="hf_..."
```

---

## Step 1: Start vLLM

The installer detects a running vLLM server and reuses it rather than starting a new one.
Start vLLM manually before running the installer to control which GPU and model are used.

### Find your compute GPU

On a DGX Station GB300 with a mixed GPU configuration (e.g., RTX PRO 6000 Workstation
on bus 0 + GB300 compute GPU on bus 1), use `nvidia-smi` to identify the right device index:

```bash
nvidia-smi -L
# GPU 0: NVIDIA RTX PRO 6000 Blackwell Workstation Edition ...
# GPU 1: NVIDIA GB300 ...
```

### Start the container

Replace `device=1` with the index of your compute GPU. Use `--network host` so the
installer's probe can reach the server on `localhost:8000`.

```bash
docker run --detach \
  --name nemoclaw-vllm \
  --restart unless-stopped \
  --network host \
  --gpus '"device=1"' \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  -e HF_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  vllm/vllm-openai:latest \
  --model nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 \
  --port 8000
```

> **Note on GPU flags:** `--gpus '"device=1"'` restricts the container to device 1 and
> remaps it to device 0 inside the container. Do **not** also set
> `-e CUDA_VISIBLE_DEVICES=1`; the two flags conflict and cause an
> `NVMLError_InvalidArgument` crash.

Wait for the server to be ready (first run downloads ~75 GB; subsequent runs load from cache
in ~2 minutes):

```bash
docker logs -f nemoclaw-vllm
# Wait for: INFO: Uvicorn running on http://0.0.0.0:8000
```

Verify it responds:

```bash
curl -s http://localhost:8000/v1/models | python3 -m json.tool
```

### Base URL for the installer wizard

When the onboard wizard asks for the base URL, use the host's LAN IP address
(not `localhost`) so the endpoint is reachable from inside Docker containers during
the gateway probe:

```
http://<host-lan-ip>:8000/v1
```

Find your LAN IP with `ip -4 addr show | grep inet`.

The `/v1` suffix is required. The wizard's probe appends `/chat/completions` directly
to whatever base URL you provide.

---

## Step 2: Start the OpenShell Gateway

Start the gateway as your regular user (not `sudo`). This ensures the TLS certificates
and config files are owned by the same user that runs the installer.

```bash
openshell gateway start --name nemoclaw
# Wait for: ✓ Gateway ready — Endpoint: https://127.0.0.1:8080
```

If the command fails with `Permission denied` on `~/.config/openshell/`, fix ownership
first (see One-Time System Preparation above).

---

## Step 3: Run the Installer

From the NemoClaw source checkout:

```bash
cd ~/NemoClaw
HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}" bash scripts/install.sh
```

### Onboard wizard answers

| Prompt | Answer |
|--------|--------|
| Inference option | `3` — Other OpenAI-compatible endpoint |
| Base URL | `http://<host-lan-ip>:8000/v1` |
| API key | Any non-empty string (vLLM has no auth by default) |
| Model | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` |
| Sandbox name | `my-assistant` (or any name you prefer) |
| Web search | `N` (unless you have a Brave API key) |
| Messaging | Enter to skip (or configure Slack/Discord/Telegram as needed) |
| Policy tier | `Open` (recommended for local use) |

The sandbox image build takes approximately 6–8 minutes on first run.

---

## Post-Installation Usage

### Connect to the sandbox

```bash
source ~/.bashrc   # pick up the updated PATH from nvm
nemoclaw my-assistant connect
```

Inside the sandbox:

```bash
# Terminal chat UI
openclaw tui

# Single-shot message
openclaw agent --agent main --local -m "hello" --session-id test
```

### Open the dashboard in a browser

The installer prints a one-time tokenized URL at the end of installation.
**Save it — it is not shown again.**

```
http://127.0.0.1:18789/#token=<auth-token>
```

If you are accessing the DGX Station remotely, forward port 18789 from the station
to your local machine via SSH:

```bash
ssh -L 18789:127.0.0.1:18789 nvidia@<dgx-station-ip>
```

If the port forward stopped (e.g., after a reboot), restart it:

```bash
openshell forward start --background 18789 my-assistant
```

### Check sandbox status

```bash
nemoclaw my-assistant status
nemoclaw my-assistant logs --follow
```

### Switch inference model at runtime

You can change the model or provider without rebuilding the sandbox:

```bash
openshell inference set -g nemoclaw \
  --model nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 \
  --provider compatible-endpoint
```

---

## Troubleshooting

### `invalid peer certificate: BadSignature` at step [4/8]

The gateway was started with `sudo` but the installer runs as the regular user.
The TLS certificates end up in different config directories.

Fix: destroy the gateway and restart it without `sudo`:

```bash
sudo openshell gateway destroy --name nemoclaw --force
sudo chown -R $USER:$USER ~/.config/openshell
openshell gateway start --name nemoclaw
```

### `Permission denied` on `~/.local/bin/nemoclaw` or `node_modules`

Leftover root-owned files from a previous `sudo` run. Fix:

```bash
sudo chown -R $USER:$USER ~/NemoClaw ~/.npm ~/.nvm ~/.nemoclaw ~/.config/openshell
```

### `ln: failed to create symbolic link '.../workspace/media': No such file or directory`

Fixed in the `Dockerfile` as of commit `c56e89aa`. Pull the latest and rerun.

### vLLM `NVMLError_InvalidArgument`

Caused by combining `--gpus '"device=N"'` with `-e CUDA_VISIBLE_DEVICES=N`.
Remove the `CUDA_VISIBLE_DEVICES` env var — `--gpus '"device=N"'` already restricts
and remaps the device.

### Installer launches a new vLLM container with the wrong model

The installer's `install_vllm()` function runs only if no vLLM server is detected on
port 8000. If vLLM is already running when the installer starts, it is reused.
Start vLLM before running the installer to avoid this.

### Session file owned by root

If `~/.nemoclaw/onboard-session.json` is owned by root (from a previous `sudo` run),
the installer cannot write to it:

```bash
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```
