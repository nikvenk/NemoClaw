// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedded swarm bus Python script.
 *
 * The bus script is embedded here so that add-agent can deploy it into any
 * sandbox without depending on host filesystem paths. This is the single
 * source of truth — the standalone scripts/nemoclaw-swarm-bus.py is kept
 * in sync for local development and Dockerfile.swarm bake-in.
 */

/* eslint-disable max-len */
export const SWARM_BUS_SCRIPT = `#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Swarm bus - JSONL-backed HTTP sidecar for inter-agent messaging."""
import argparse, json, os, sys, threading
from collections import deque
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from urllib.error import URLError

MAX_MESSAGES = 10000
DEFAULT_PORT = 19100
DEFAULT_LOG_FILE = "/sandbox/.nemoclaw/swarm/messages.jsonl"
MANIFEST_PATH = "/sandbox/.nemoclaw/swarm/manifest.json"

class MessageStore:
    def __init__(self, log_file):
        self.log_file = log_file
        self._messages = deque(maxlen=MAX_MESSAGES)
        self._lock = threading.Lock()
        self._subscribers = []
        self._sub_lock = threading.Lock()
        self._load_existing()

    def _load_existing(self):
        if not os.path.exists(self.log_file):
            os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
            return
        try:
            with open(self.log_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            self._messages.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except OSError:
            pass

    def append(self, msg):
        if "timestamp" not in msg:
            msg["timestamp"] = datetime.now(timezone.utc).isoformat()
        msg["platform"] = "swarm"
        with self._lock:
            self._messages.append(msg)
            try:
                with open(self.log_file, "a") as f:
                    f.write(json.dumps(msg) + "\\n")
            except OSError as e:
                print(f"[bus] write error: {e}", file=sys.stderr)
        with self._sub_lock:
            dead = []
            for i, cb in enumerate(self._subscribers):
                try:
                    cb(msg)
                except Exception:
                    dead.append(i)
            for i in reversed(dead):
                self._subscribers.pop(i)
        return msg

    def query(self, since=None):
        with self._lock:
            if since is None:
                return list(self._messages)
            return [m for m in self._messages if m.get("timestamp", "") > since]

    def subscribe(self, callback):
        with self._sub_lock:
            self._subscribers.append(callback)

    def unsubscribe(self, callback):
        with self._sub_lock:
            try:
                self._subscribers.remove(callback)
            except ValueError:
                pass

def read_manifest():
    try:
        with open(MANIFEST_PATH, "r") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

def probe_agent(health_url, timeout=2.0):
    try:
        resp = urlopen(health_url, timeout=timeout)
        return resp.status == 200
    except (URLError, OSError, ValueError):
        return False

class BusHandler(BaseHTTPRequestHandler):
    store = None
    def log_message(self, format, *args):
        pass
    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
    def _send_error(self, status, message):
        self._send_json({"error": message}, status)
    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path.rstrip("/")
        if p == "/health":
            self._send_json({"status": "ok", "port": DEFAULT_PORT})
        elif p == "/messages":
            params = parse_qs(parsed.query)
            since = params.get("since", [None])[0]
            messages = self.store.query(since)
            self._send_json({"messages": messages, "count": len(messages)})
        elif p == "/agents":
            manifest = read_manifest()
            if manifest is None:
                self._send_json({"agents": [], "error": "manifest not found"})
                return
            agents = []
            for agent in manifest.get("agents", []):
                health_url = agent.get("healthUrl", "")
                healthy = probe_agent(health_url) if health_url else False
                agents.append({"instanceId": agent.get("instanceId"), "agentType": agent.get("agentType"), "port": agent.get("port"), "healthy": healthy, "primary": agent.get("primary", False)})
            self._send_json({"agents": agents})
        elif p == "/stream":
            self._handle_sse()
        else:
            self._send_error(404, f"Not found: {p}")
    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path.rstrip("/")
        if p == "/send":
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._send_error(400, "Empty body")
                return
            try:
                body = json.loads(self.rfile.read(content_length))
            except json.JSONDecodeError:
                self._send_error(400, "Invalid JSON")
                return
            if "from" not in body or "content" not in body:
                self._send_error(400, "Missing required fields: from, content")
                return
            msg = {"from": body["from"], "to": body.get("to"), "content": body["content"]}
            result = self.store.append(msg)
            self._send_json(result, 201)
        else:
            self._send_error(404, f"Not found: {p}")
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
    def _handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        event = threading.Event()
        pending = []
        def on_message(msg):
            pending.append(msg)
            event.set()
        self.store.subscribe(on_message)
        try:
            while True:
                event.wait(timeout=15)
                if event.is_set():
                    event.clear()
                    while pending:
                        msg = pending.pop(0)
                        data = json.dumps(msg)
                        self.wfile.write(f"data: {data}\\n\\n".encode("utf-8"))
                    self.wfile.flush()
                else:
                    self.wfile.write(b": keepalive\\n\\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.store.unsubscribe(on_message)

def make_handler(store):
    class Handler(BusHandler):
        pass
    Handler.store = store
    return Handler

def main():
    parser = argparse.ArgumentParser(description="NemoClaw swarm bus sidecar")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--log-file", default=DEFAULT_LOG_FILE)
    args = parser.parse_args()
    store = MessageStore(args.log_file)
    handler = make_handler(store)
    server = HTTPServer(("127.0.0.1", args.port), handler)
    print(f"[swarm-bus] listening on 127.0.0.1:{args.port}", file=sys.stderr)
    print(f"[swarm-bus] log file: {args.log_file}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\n[swarm-bus] shutting down", file=sys.stderr)
        server.shutdown()

if __name__ == "__main__":
    main()
`;
/* eslint-enable max-len */
