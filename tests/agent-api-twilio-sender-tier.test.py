#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

os.environ["SUTANDO_TEST_MODE"] = "1"
os.environ["SUTANDO_WORKSPACE"] = tempfile.mkdtemp(prefix="agent-api-twilio-tier-")
os.environ.setdefault("SUTANDO_TELEMETRY", "0")
os.environ["SUTANDO_SUPPRESS_CCD_FALLBACK_BANNER"] = "1"
os.environ.pop("SUTANDO_API_TOKEN", None)
os.environ.pop("OWNER_NUMBER", None)

spec = importlib.util.spec_from_file_location("agent_api_twilio_tier", REPO / "src" / "agent-api.py")
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
assert spec.loader is not None
spec.loader.exec_module(api)
api._emit_task_processed = lambda _content: None


class TwilioSenderTierTests(unittest.TestCase):
    def run_handler(self, method, sender, owner_numbers):
        task_dir = Path(tempfile.mkdtemp(prefix="agent-api-twilio-task-"))
        api.TASK_DIR = task_dir
        if owner_numbers is None:
            os.environ.pop("OWNER_NUMBER", None)
        else:
            os.environ["OWNER_NUMBER"] = owner_numbers
        handler = api.Handler.__new__(api.Handler)
        handler.send_twiml = Mock()
        handler.send_json = Mock()
        form_data = {"From": [sender], "Body": ["hello"], "TranscriptionText": ["hello"], "CallSid": ["CA1"]}
        getattr(handler, method)(form_data)
        files = list(task_dir.glob("task-*.txt"))
        self.assertEqual(len(files), 1)
        return files[0].read_text()

    def test_each_inbound_handler_assigns_sender_tier_from_current_owner_number(self):
        for method in ("handle_twilio_voice", "handle_twilio_sms", "handle_twilio_transcription"):
            with self.subTest(method=method, case="non-owner"):
                self.assertIn("access_tier: other", self.run_handler(method, "+14155550000", "+14155551234"))
            with self.subTest(method=method, case="formatted-owner"):
                self.assertIn("access_tier: owner", self.run_handler(method, "(415) 555-1234", "+14155551234"))
            with self.subTest(method=method, case="unset-owner"):
                self.assertIn("access_tier: other", self.run_handler(method, "+14155550000", None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
