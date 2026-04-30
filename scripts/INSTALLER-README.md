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

## Step 1: Start vLLM (optional — installer handles this automatically)

The installer detects a running vLLM server on port 8000 and reuses it. If none is
found, it automatically starts one via `install_vllm()`, selects the highest-VRAM GPU,
and **waits up to 10 minutes for the HTTP `/health` endpoint to respond** before
proceeding to the onboard wizard.

Start vLLM manually only if you want explicit control over GPU selection or model
parameters (e.g., during testing or when re-using an already-downloaded model).

### Find your compute GPU

On a DGX Station GB300 with a mixed GPU configuration (e.g., RTX PRO 6000 Workstation
on bus 0 + GB300 compute GPU on bus 1), use `nvidia-smi` to identify the right device index:

```bash
nvidia-smi -L
# GPU 0: NVIDIA RTX PRO 6000 Blackwell Workstation Edition ...
# GPU 1: NVIDIA GB300 ...
```

### Start the container

Replace `device=1` with the index of your compute GPU.

```bash
docker run --detach \
  --name nemoclaw-vllm \
  --restart unless-stopped \
  --network host \
  --gpus "device=1" \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  -e HF_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  vllm/vllm-openai:latest \
  --model nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 \
  --port 8000
```

> **Note on GPU flags:** `--gpus "device=1"` restricts the container to device 1 and
> remaps it to device 0 inside the container. Do **not** also set
> `-e CUDA_VISIBLE_DEVICES=1`; the two flags conflict and cause an
> `NVMLError_InvalidArgument` crash in vLLM's worker processes.
>
> **Note on `--network host`:** Required so the onboard wizard's curl probe can reach
> the server via any host IP. With bridge networking, Docker's userland proxy binds the
> host port immediately on container start — before vLLM is ready — causing false-positive
> readiness checks.

Wait for the server to be ready. First run downloads ~75 GB; subsequent runs load from
cache in ~5 minutes:

```bash
docker logs -f nemoclaw-vllm
# Wait for: INFO: Uvicorn running on http://0.0.0.0:8000
```

Verify it responds:

```bash
curl -s http://localhost:8000/v1/models | python3 -m json.tool
```

### Base URL for the installer wizard

When the onboard wizard asks for the base URL, include `/v1` and use the host's LAN
IP address rather than `localhost` — the gateway probe runs inside a Docker container
and needs a routable address:

```text
http://<host-lan-ip>:8000/v1
```

Find your LAN IP:

```bash
ip -4 addr show | grep "inet " | awk '{print $2}' | cut -d/ -f1
```

---

## Step 2: Start the OpenShell Gateway (optional — installer handles this)

If the gateway is not already running, the installer starts it automatically at step
[2/8]. The "Still starting gateway cluster... (Ns elapsed)" messages that appear during
first-time startup are normal — k3s initialisation takes 30–90 seconds.

Start the gateway manually only if you need it running before the installer, or to
verify it is healthy:

```bash
openshell gateway start --name nemoclaw
# Wait for: ✓ Gateway ready — Endpoint: https://127.0.0.1:8080
```

> **Important:** Always start the gateway as your regular user (not `sudo`). If the
> gateway is created by root, its TLS certificates are stored in root's config directory.
> When the installer then runs as the regular user, the certificate handshake fails with
> `invalid peer certificate: BadSignature`.

If the command fails with `Permission denied` on `~/.config/openshell/`, fix ownership
first (see One-Time System Preparation above).

---

## Step 3: Run the Installer

From the NemoClaw source checkout:

```bash
cd ~/NemoClaw && git pull
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

```text
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

## Teardown for Re-testing

Use this procedure when cycling through installs during testing. It tears down only
the NemoClaw-specific resources and leaves Docker, Node.js, and the model cache intact.
Tear down in reverse startup order to avoid orphaned containers and stale gateway state.

```bash
# 1. Stop the sandbox
nemoclaw my-assistant stop 2>/dev/null || true

# 2. Destroy the gateway (removes the OpenShell k3s cluster)
openshell gateway destroy --name nemoclaw

# 3. Stop and remove the vLLM container
docker stop nemoclaw-vllm && docker rm nemoclaw-vllm

# 4. Remove the onboard session file so the installer starts fresh
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

Then re-run the installer:

```bash
cd ~/NemoClaw && git pull
HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}" bash scripts/install.sh --fresh
```

On a clean install the installer launches vLLM automatically, waits for it to be
healthy, then proceeds to the onboard wizard. You do not need to start vLLM or the
gateway manually.

### Automatic backup before re-installation

When the installer finds an existing sandbox, it automatically calls `nemoclaw backup-all`
before doing anything destructive. Snapshots are stored as numbered archives:

```text
~/.nemoclaw/rebuild-backups/
  my-assistant-backup-1.tar.gz
  my-assistant-backup-2.tar.gz   ← increments on each re-run
```

To restore a backup after a failed re-installation:

```bash
ls ~/.nemoclaw/rebuild-backups/
nemoclaw my-assistant snapshot restore <backup-name>
```

---

## Uninstalling

The uninstaller is a single script that removes all NemoClaw host-side resources.
Docker, Node.js, npm, and Ollama are **not** touched.

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

### What the uninstaller removes

- All OpenShell sandboxes, the NemoClaw gateway, and registered inference providers
- NemoClaw-related Docker containers, images, and volumes (including `nemoclaw-vllm`)
- `~/.nemoclaw/`, `~/.config/openshell/`, `~/.config/nemoclaw/`
- The global `nemoclaw` npm package and CLI shim
- The `openshell` binary (unless `--keep-openshell` is passed)
- NemoClaw-managed swap file (if any)
- Shell profile PATH entries added by the installer

### What the uninstaller does NOT remove

- Docker, Node.js, npm, and nvm
- Ollama and its models (pass `--delete-models` to remove NemoClaw-pulled Ollama models)
- The HuggingFace model cache (`~/.cache/huggingface/`) — remove manually if needed:

```bash
rm -rf ~/.cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4
```

### Flags

| Flag | Effect |
|------|--------|
| `--yes` | Skip the confirmation prompt (useful for scripted teardowns) |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Remove NemoClaw-pulled Ollama models |

Example — non-interactive full teardown including Ollama models:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh \
  | bash -s -- --yes --delete-models
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

Caused by combining `--gpus "device=N"` with `-e CUDA_VISIBLE_DEVICES=N`.
Remove the `CUDA_VISIBLE_DEVICES` env var — `--gpus "device=N"` already restricts
and remaps the device to index 0 inside the container.

### Onboard wizard validation fails with `exit 7` (connection refused) on port 8000

vLLM was launched by the installer in the background but the model had not finished
loading when the wizard's probe ran. Watch the container logs in another terminal:

```bash
docker logs -f nemoclaw-vllm
# Wait for: INFO: Uvicorn running on http://0.0.0.0:8000
```

Once that line appears, type `retry` in the wizard. This is fixed in the installer as
of commit `b88861fa` — `install_vllm()` now polls the `/health` HTTP endpoint (not just
port reachability) and waits up to 10 minutes before proceeding.

### Session file owned by root

If `~/.nemoclaw/onboard-session.json` is owned by root (from a previous `sudo` run),
the installer cannot write to it:

```bash
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

### vLLM `401 Unauthorized` or `404 Not Found` when downloading the model

**Wrong model ID.** The NVIDIA API / NIM catalog name for Nemotron-3 Super is
`nvidia/nemotron-3-super-120b-a12b`, but that identifier does not exist on HuggingFace.
vLLM fetches weights from HuggingFace and requires the HuggingFace repository name:

```text
nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4   ← correct (HuggingFace)
nvidia/nemotron-3-super-120b-a12b                ← wrong (NIM/NGC API name only)
```

A 401 means the HuggingFace token is missing or not exported in the container's
environment. A 404 means the model ID itself is wrong.

### NGC vLLM container cannot resolve HuggingFace

If you use the NGC-hosted vLLM image (`nvcr.io/nvidia/vllm:...`) instead of the
Docker Hub image (`vllm/vllm-openai:latest`), the container may fail to reach
`huggingface.co` due to NGC proxy or DNS restrictions in the container's network
namespace. Switch to `--network host` or use the Docker Hub image. The `docker run`
command in Step 1 already uses `--network host` and `vllm/vllm-openai:latest`.

### Installer launches a new vLLM container instead of reusing the existing one

The installer reuses a running vLLM server on port 8000. If it launches a new container,
the existing one was not detected — check that it is running and actually serving:

```bash
docker ps | grep nemoclaw-vllm
curl -sf http://localhost:8000/health && echo "healthy" || echo "not ready"
```

If the container is running but the health check fails, wait for the model to finish
loading (watch `docker logs -f nemoclaw-vllm`).
