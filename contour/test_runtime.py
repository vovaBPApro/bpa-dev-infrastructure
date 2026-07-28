import unittest
from runtime import RuntimeManager


class RuntimeWiringTest(unittest.TestCase):
    class Life:
        def __init__(self, head): self.head=head
        def capture_source(self): self.called=True; return "0"*40
        def current_commit(self): return self.head
        def current_image_digest(self): return "sha:x"
    class SameLife(Life):
        def capture_source(self): self.called=True; return self.head
    def test_manual_rejects_generic_but_accepts_green(self):
        r = RuntimeManager(manual=True)
        self.assertIsNone(r.submit("generic", "w"))
        lease = r.submit("green", "w", autonomous_green=True, now=0)
        self.assertIsNotNone(lease)
        self.assertTrue(r.heartbeat("green", lease.token, now=1))

    def test_watchdog_reaps_stale_runtime_lease(self):
        r = RuntimeManager(manual=False)
        r.submit("m", "w", now=0)
        self.assertEqual(r.watchdog(now=481), {"m": "retry"})

    def test_verify_rollback_and_mismatch_guards(self):
        import subprocess, tempfile, os
        root = os.path.dirname(os.path.dirname(__file__))
        head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
        with tempfile.TemporaryDirectory() as d:
            path = d + "/evidence.jsonl"
            life = self.Life(head)
            got = RuntimeManager().verify_rollback(root, head, prior_commit="0"*40, image_digest="sha:x", actual_image_digest="sha:x", evidence_store=path, lifecycle=life)
            self.assertTrue(getattr(life, "called", False))
            self.assertTrue(got["verified"])
            with open(path) as fh: self.assertIn('"verified":true', fh.read())
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, head, image_digest="sha:x", evidence_store=path)
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, head, image_digest=None, evidence_store=path, lifecycle=self.Life(head))
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, head, image_digest="sha:y", evidence_store=path, lifecycle=self.Life(head))
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, "bad", image_digest="sha:x", actual_image_digest="sha:x")
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, head, image_digest="sha:x", evidence_store=path, lifecycle=self.SameLife(head))
            with self.assertRaises(ValueError): RuntimeManager().verify_rollback(root, head, image_digest="sha:x", actual_image_digest="sha:y")


if __name__ == "__main__":
    unittest.main()
