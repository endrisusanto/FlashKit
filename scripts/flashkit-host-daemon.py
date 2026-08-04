#!/usr/bin/env python3
import json
import os
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = "/home/endri-pro/dev/BOW/bow-rust/src-tauri/target/debug/flashkit"
ROOT = "/home/endri-pro/dev/BOW"
BRIDGE = "http://127.0.0.1:9977/focus"


def focus_or_start():
    try:
        urllib.request.urlopen(urllib.request.Request(BRIDGE, method="POST"), timeout=1).read()
        return "focused"
    except Exception:
        env = os.environ.copy()
        env.setdefault("DISPLAY", ":0")
        env.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
        env.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        subprocess.Popen([APP], cwd=ROOT, env=env, start_new_session=True)
        return "started"


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.reply({})

    def do_GET(self):
        self.reply({"ok": True} if self.path == "/status" else {"ok": False})

    def do_POST(self):
        self.reply({"ok": True, "action": focus_or_start()} if self.path == "/reopen" else {"ok": False})

    def reply(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("0.0.0.0", 9914), Handler).serve_forever()
