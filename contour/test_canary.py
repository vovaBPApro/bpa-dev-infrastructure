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


if __name__ == "__main__": unittest.main()
