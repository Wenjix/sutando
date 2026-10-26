#!/usr/bin/env python3
"""Tests Telegram result routing for the standalone [dm-only] marker."""
from __future__ import annotations

from _helpers.hermetic_env import isolate_os_environ

isolate_os_environ()

import importlib.util
import os
import re
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
_WORKSPACE_TMP = tempfile.mkdtemp(prefix="sutando-telegram-dm-only-test-")
os.environ["SUTANDO_WORKSPACE"] = _WORKSPACE_TMP
os.environ["SUTANDO_TEST_MODE"] = "1"
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-token-not-real")

spec = importlib.util.spec_from_file_location(
    "tbridge_dm_only", REPO / "src" / "telegram-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class TestTelegramDmOnlyReply(unittest.TestCase):
    def test_group_route_uses_owner_from_access_data(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertEqual(
            bridge._reply_destination(
                -100123, parsed, {"allowFrom": ["42"]}, None),
            42,
        )

    def test_group_route_uses_environment_override(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertEqual(
            bridge._reply_destination(
                -100123, parsed, {"allowFrom": ["42"]}, "84"),
            84,
        )

    def test_private_route_is_unchanged(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertEqual(
            bridge._reply_destination(42, parsed, {"allowFrom": ["84"]}, "84"),
            42,
        )

    def test_group_route_without_marker_is_unchanged(self):
        parsed = bridge.parse_markers("Ordinary reply")
        self.assertEqual(
            bridge._reply_destination(-100123, parsed, {"allowFrom": ["42"]}, None),
            -100123,
        )

    def test_group_route_without_owner_is_unroutable(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertIsNone(
            bridge._reply_destination(-100123, parsed, {"allowFrom": []}, None))

    def test_non_integer_chat_id_is_not_treated_as_private(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertEqual(
            bridge._reply_destination("malformed-chat-id", parsed, {"allowFrom": ["42"]}, None),
            42,
        )

    def test_non_integer_owner_id_is_unroutable(self):
        parsed = bridge.parse_markers("[dm-only]\nPrivate reply")
        self.assertIsNone(
            bridge._reply_destination(-100123, parsed, {"allowFrom": ["not-an-id"]}, None))

    def test_reply_loop_routes_before_send_and_restores_origin(self):
        source = (REPO / "src" / "telegram-bridge.py").read_text()
        start = source.find(
            "for task_id in _gather_pending_task_ids(pending_replies, RESULTS_DIR, TASKS_DIR):")
        self.assertGreater(start, 0)
        head = source.rfind("\n", 0, start) + 1
        indent = len(source[head:start])
        end = len(source)
        for match in re.finditer(r"^[ \t]*(?=\S)", source[start:], re.M):
            if match.start() and len(match.group()) <= indent:
                end = start + match.start()
                break
        block = source[start:end]

        destination_pos = block.find("destination = _reply_destination(")
        send_pos = block.find("send_reply(chat_id, parsed.body")
        self.assertGreater(destination_pos, 0)
        self.assertGreater(send_pos, destination_pos)
        unroutable = block.find("if destination is None:")
        refusal = block.find("if not delivered_ok:")
        self.assertGreater(unroutable, 0)
        self.assertGreater(refusal, 0)
        self.assertIn(
            "pending_replies[task_id] = origin_chat_id",
            block[unroutable:refusal],
        )
        self.assertIn(
            "pending_replies[task_id] = origin_chat_id",
            block[refusal:],
        )


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(TestTelegramDmOnlyReply))
    raise SystemExit(0 if result.wasSuccessful() else 1)
