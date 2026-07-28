import unittest
from root_guard import resolve_root

class RootGuardTest(unittest.TestCase):
    def test_canonical(self):
        self.assertTrue(str(resolve_root()).endswith("bpa-dev-infrastructure"))
    def test_reject_legacy(self):
        with self.assertRaises(RuntimeError): resolve_root("/home/bpa-shell/agents/stale")

if __name__ == "__main__": unittest.main()
