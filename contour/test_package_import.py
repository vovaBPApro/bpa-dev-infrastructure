import unittest


class PackageImportTest(unittest.TestCase):
    def test_runtime_imports_as_package(self):
        import contour.runtime as runtime
        self.assertTrue(hasattr(runtime, "RuntimeManager"))


if __name__ == "__main__":
    unittest.main()
