import unittest
from acceptance import run


class AcceptanceTest(unittest.TestCase):
    def test_shadow_evidence(self):
        evidence = run()
        self.assertEqual(evidence, {"deterministic_replay": True, "expired_lease_fenced": True, "missions": 3})


if __name__ == "__main__": unittest.main()
