import tempfile
import unittest
from pathlib import Path

from hygiene import DiskAdmission, LeaseBook, WorktreeReaper


class HygieneTest(unittest.TestCase):
    def test_lease_heartbeat_and_expiry(self):
        now = [100.0]
        book = LeaseBook(10, lambda: now[0])
        book.acquire("m", "a", "t")
        with self.assertRaises(RuntimeError): book.acquire("m", "b", "x")
        book.heartbeat("m", "a", "t")
        now[0] = 111
        with self.assertRaises(RuntimeError): book.heartbeat("m", "a", "t")

    def test_reaper_unknown_and_active_are_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); stale = root / "stale"; active = root / "active"; stale.mkdir(); active.mkdir()
            reaper = WorktreeReaper(str(root), ttl=10, clock=lambda: 100)
            removed = reaper.reap([
                {"path": str(stale), "owner": "dead", "heartbeat_at": 0},
                {"path": str(active), "owner": "live", "heartbeat_at": 0},
                {"path": str(root / "unknown"), "heartbeat_at": 0},
            ], {"live"})
            self.assertEqual(removed, [str(stale)]); self.assertTrue(active.exists())

    def test_disk_hysteresis(self):
        gate = DiskAdmission(.9, .8)
        self.assertTrue(gate.update(.89)); self.assertFalse(gate.update(.91)); self.assertFalse(gate.update(.85)); self.assertTrue(gate.update(.8))


if __name__ == "__main__": unittest.main()
