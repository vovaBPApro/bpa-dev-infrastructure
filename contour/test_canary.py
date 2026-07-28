import tempfile
import unittest
from pathlib import Path
from canary import run


class CanaryTest(unittest.TestCase):
    def test_two_clean_runs_and_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            evidence = run(str(Path(td) / "evidence.json"))
            self.assertTrue(evidence["two_clean_e2e"])
            self.assertTrue(evidence["disk_hysteresis"])
            self.assertTrue(evidence["fail_closed"])

    def test_zero_soak_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(SystemExit): run(str(Path(td) / "evidence.json"), 0)


if __name__ == "__main__": unittest.main()
