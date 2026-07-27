import json
import tempfile
import unittest
from pathlib import Path

from mission_lifecycle import MissionStore


class MissionLifecycleTest(unittest.TestCase):
    def test_replay_and_idempotent_retry(self):
        with tempfile.TemporaryDirectory() as td:
            path = str(Path(td) / "missions.jsonl")
            store = MissionStore(path)
            mission = store.create({"kind": "smoke"}, mission_id="m1", event_id="create-1")
            self.assertEqual(mission.state, "queued")
            store.transition("m1", "running", event_id="run-1")
            store.transition("m1", "succeeded", event_id="done-1")
            # Duplicate event in a retry must not increment version/state.
            store._apply({"kind": "transitioned", "event_id": "done-1", "mission_id": "m1", "state": "succeeded", "at": "later"})
            self.assertEqual(store.get("m1").version, 3)
            restored = MissionStore(path)
            self.assertEqual(restored.get("m1"), store.get("m1"))

    def test_recovery_path_and_invalid_transition(self):
        with tempfile.TemporaryDirectory() as td:
            store = MissionStore(str(Path(td) / "missions.jsonl"))
            store.create(mission_id="m2")
            store.transition("m2", "running")
            store.transition("m2", "recovering")
            store.transition("m2", "queued")
            self.assertEqual(store.get("m2").state, "queued")
            with self.assertRaises(ValueError):
                store.transition("m2", "succeeded")


if __name__ == "__main__":
    unittest.main()
