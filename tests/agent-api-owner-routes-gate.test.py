#!/usr/bin/env python3
from __future__ import annotations

import http.client
import http.server
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

WORKSPACE = Path(tempfile.mkdtemp(prefix="agent-api-owner-routes-"))
os.environ["SUTANDO_TEST_MODE"] = "1"
os.environ["SUTANDO_WORKSPACE"] = str(WORKSPACE)
os.environ.setdefault("SUTANDO_TELEMETRY", "0")
os.environ["SUTANDO_SUPPRESS_CCD_FALLBACK_BANNER"] = "1"
os.environ.pop("SUTANDO_API_TOKEN", None)

import local_api_gate

spec = importlib.util.spec_from_file_location("agent_api_owner_routes", REPO / "src" / "agent-api.py")
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
assert spec.loader is not None
spec.loader.exec_module(api)
api.API_TOKEN = ""
api._emit_task_processed = lambda _content: None

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
server.daemon_threads = True
PORT = server.server_address[1]
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()


def request(path, *, method="GET", headers=None, body=None):
    request_headers = {"Host": f"127.0.0.1:{PORT}", **(headers or {})}
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    conn.request(method, path, body=body, headers=request_headers)
    response = conn.getresponse()
    raw = response.read()
    result = response.status, response.headers, raw
    conn.close()
    return result


def post_task(headers=None):
    return request("/task", method="POST", headers=headers, body='{"task":"x"}')


def task_files():
    return set(api.TASK_DIR.glob("task-*.txt"))


class OwnerRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api.TASK_DIR.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        server.shutdown()
        server.server_close()

    def test_post_task_rejects_cross_origin_and_rebound_hosts_without_writing(self):
        before = task_files()
        status, _, raw = post_task({"Origin": "https://evil.example", "Content-Type": "text/plain"})
        self.assertEqual(status, 403, raw)
        self.assertEqual(task_files(), before)
        status, _, raw = post_task({"Host": f"evil.example:{PORT}"})
        self.assertEqual(status, 403, raw)
        self.assertEqual(task_files(), before)

    def test_post_task_accepts_local_owner_requests(self):
        status, _, raw = post_task({
            "Origin": "http://localhost:8080",
            "Content-Type": "application/json",
        })
        self.assertEqual(status, 200, raw)
        latest = max(task_files(), key=lambda path: path.stat().st_mtime_ns)
        self.assertIn("access_tier: owner", latest.read_text())

        before = task_files()
        status, _, raw = post_task({"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 200, raw)
        created = task_files() - before
        self.assertEqual(len(created), 1)
        self.assertIn("access_tier: owner", created.pop().read_text())

    def test_post_task_accepts_bearer_from_any_host_and_rejects_wrong_bearer(self):
        bearer = local_api_gate.local_api_token(api.WORKSPACE_DIR)
        status, _, raw = post_task({
            "Authorization": f"Bearer {bearer}",
            "Host": "evil.example",
        })
        self.assertEqual(status, 200, raw)
        status, _, raw = post_task({"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401, raw)

    def test_configured_api_token_remains_required(self):
        api.API_TOKEN = "cfg"
        try:
            status, _, raw = post_task({"Content-Type": "application/json"})
            self.assertEqual(status, 401, raw)
            status, _, raw = post_task({
                "Authorization": "Bearer cfg",
                "Content-Type": "application/json",
            })
            self.assertEqual(status, 200, raw)
        finally:
            api.API_TOKEN = ""

    def test_media_restricts_private_paths_and_extensions(self):
        state_token = local_api_gate.local_api_token(api.WORKSPACE_DIR)
        (api.WORKSPACE_DIR / "tasks").mkdir(exist_ok=True)
        (api.WORKSPACE_DIR / "tasks" / "task-1.txt").write_text("private")
        hidden = api.WORKSPACE_DIR / ".claude-sutando"
        hidden.mkdir(exist_ok=True)
        (hidden / "x.png").write_bytes(b"hidden")
        notes = api.WORKSPACE_DIR / "notes"
        notes.mkdir(exist_ok=True)
        (notes / "a.bin").write_bytes(b"binary")
        for path in (
            "/media/state/agent-api.token",
            "/media/tasks/task-1.txt",
            "/media/.claude-sutando/x.png",
            "/media/notes/a.bin",
        ):
            with self.subTest(path=path):
                status, _, raw = request(path)
                self.assertEqual(status, 404, raw)
        self.assertTrue(state_token)
        status, headers, raw = request("/media/../state/agent-api.token")
        self.assertEqual(status, 400, raw)
        self.assertNotEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("no-store", headers.get("Cache-Control", ""))

    def test_media_headers_and_origin_gate(self):
        results = api.WORKSPACE_DIR / "results"
        results.mkdir(exist_ok=True)
        image = results / "x.png"
        image.write_bytes(b"image-data")

        status, _, raw = request("/media/results/x.png", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403, raw)

        status, headers, raw = request("/media/results/x.png")
        self.assertEqual((status, raw), (200, b"image-data"))
        self.assertNotEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("no-store", headers.get("Cache-Control", ""))

        origin = "http://localhost:8080"
        status, headers, _ = request("/media/results/x.png", headers={"Origin": origin})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)

    def test_active_and_voice_log_routes_require_local_owner_context(self):
        logs = api.WORKSPACE_DIR / "logs"
        logs.mkdir(exist_ok=True)
        (logs / "voice-agent.log").write_text("line\n")

        for path in ("/tasks/active", "/logs/voice"):
            with self.subTest(path=path, case="cross-origin"):
                status, _, raw = request(path, headers={"Origin": "https://evil.example"})
                self.assertEqual(status, 403, raw)
            with self.subTest(path=path, case="rebound-host"):
                status, _, raw = request(path, headers={"Host": f"evil.example:{PORT}"})
                self.assertEqual(status, 403, raw)

        with mock.patch.object(api, "probe_pids", return_value=([], True)), \
                mock.patch.object(api.shutil, "which", return_value="tmux"), \
                mock.patch.object(api.subprocess, "run", return_value=mock.Mock(returncode=1)):
            origin = "http://localhost:8080"
            for path in ("/tasks/active", "/logs/voice"):
                with self.subTest(path=path):
                    status, headers, _ = request(path, headers={"Origin": origin})
                    self.assertEqual(status, 200)
                    self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)
                    self.assertIn("no-store", headers.get("Cache-Control", ""))

    def test_non_loopback_handler_is_refused_before_route_work(self):
        handler = api.Handler.__new__(api.Handler)
        handler.path = "/tasks/active"
        handler.client_address = ("192.168.1.5", 1)
        handler.headers = {}
        sent = []
        handler.send_owner_json = lambda status, payload: sent.append((status, payload))
        handler.do_GET()
        self.assertEqual(sent, [(401, {"error": "unauthorized"})])


if __name__ == "__main__":
    unittest.main(verbosity=2)
