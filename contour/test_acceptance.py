import unittest
from acceptance import run


class AcceptanceTest(unittest.TestCase):
    def test_shadow_evidence(self):
        evidence = run()
        self.assertTrue(evidence["deterministic_replay"])
        self.assertTrue(evidence["restart_replay"])
        self.assertTrue(evidence["duplicate_idempotent"])
        self.assertTrue(evidence["terminal_not_active"])
        self.assertEqual(len(evidence["remaining_gates"]), 3)


if __name__ == "__main__": unittest.main()
