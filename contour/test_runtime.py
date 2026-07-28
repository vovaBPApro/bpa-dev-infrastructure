import unittest
from runtime import RuntimeManager


class RuntimeWiringTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
