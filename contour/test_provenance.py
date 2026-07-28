import unittest
from provenance import Provenance, ProvenanceStore, rollback_evidence


class ProvenanceTest(unittest.TestCase):
    def test_deterministic_and_redacted(self):
        p = Provenance("m", "d", "l", ("e2", "e1"), "gpt", "codex", "abc", ("z", "a"))
        self.assertEqual(p.serialize(), Provenance("m", "d", "l", ("e1", "e2"), "gpt", "codex", "abc", ("a", "z")).serialize())
        self.assertNotIn("token", p.serialize())
        self.assertNotIn("supersecret", p.serialize())

    def test_rollback_requires_new_sha(self):
        p = Provenance("m", "d", "l", (), "m", "v", "abc", ())
        ev = rollback_evidence(p, restored_commit="def", recovery_event_id="r1")
        self.assertIn('"restored_commit":"def"', ev)
        with self.assertRaises(ValueError): rollback_evidence(p, restored_commit="abc", recovery_event_id="r2")
        with self.assertRaises(ValueError): rollback_evidence(p, restored_commit="def", recovery_event_id="")
        with self.assertRaises(ValueError): rollback_evidence(p, restored_commit="def", recovery_event_id="r3", commit_exists=lambda _: False)

    def test_store_reloads(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            s = ProvenanceStore(d + "/p.jsonl"); p = Provenance("m", "d", "l", (), "m", "v", "a", ())
            s.append(p); self.assertEqual(s.load()[0]["mission_id"], "m")


if __name__ == "__main__": unittest.main()
