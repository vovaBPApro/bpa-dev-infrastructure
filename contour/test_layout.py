import unittest
from layout import layout
class LayoutTest(unittest.TestCase):
    def test_missing_outer_is_non_destructive_signal(self):
        x = layout(); self.assertIn("migration_required", x)
if __name__ == "__main__": unittest.main()
