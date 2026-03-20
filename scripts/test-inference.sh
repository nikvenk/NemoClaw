#!/usr/bin/env bash
# Test inference.local routing through OpenShell provider
set -euo pipefail

MODEL="$(openshell inference get --json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("model") or "nvidia/nemotron-3-super-120b-a12b"))' 2>/dev/null || echo "nvidia/nemotron-3-super-120b-a12b")"
echo "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"say hello\"}]}" > /tmp/req.json
curl -s https://inference.local/v1/chat/completions -H "Content-Type: application/json" -d @/tmp/req.json
