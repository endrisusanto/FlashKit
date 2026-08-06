#!/usr/bin/env python3
# ponytail: minimal python host daemon to relaunch/focus tauri desktop app on port 9914
import http.server
import socketserver
import subprocess
import json
import os
import sys

PORT = 9914

class ReopenHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path in ["/reopen", "/reopen/", "/"]:
            try:
                # ponytail: use pgrep -x to match exact binary name 'flashkit' and avoid matching daemon's own command line
                res = subprocess.run(["pgrep", "-x", "flashkit"], capture_output=True)
                if res.returncode != 0:
                    env = os.environ.copy()
                    if "DISPLAY" not in env:
                        env["DISPLAY"] = ":0"
                    
                    user = env.get("USER", "endri-pro")
                    if "XAUTHORITY" not in env and os.path.exists(f"/home/{user}/.Xauthority"):
                        env["XAUTHORITY"] = f"/home/{user}/.Xauthority"
                    
                    # ponytail: launch native desktop app binary
                    if os.path.exists("/usr/bin/flashkit"):
                        subprocess.Popen(["/usr/bin/flashkit"], env=env, start_new_session=True)
                    elif os.path.exists("/usr/bin/gtk-launch"):
                        subprocess.Popen(["gtk-launch", "flash-kit"], env=env, start_new_session=True)
                    else:
                        subprocess.Popen(["flashkit"], env=env, start_new_session=True)
                    print("🚀 Host Daemon: Reopened FlashKit Desktop App")
                else:
                    print("ℹ️ Host Daemon: FlashKit Desktop App is already running")
            except Exception as e:
                print(f"⚠️ Host Daemon Error: {e}")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        return # ponytail: silent logging

if __name__ == "__main__":
    try:
        with socketserver.TCPServer(("0.0.0.0", PORT), ReopenHandler) as httpd:
            print(f"🚀 FlashKit Host Daemon running on port {PORT}...")
            httpd.serve_forever()
    except Exception as e:
        print(f"Fatal daemon error: {e}", file=sys.stderr)
