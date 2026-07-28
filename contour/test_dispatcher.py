import unittest
from dispatcher import DispatchController


class DispatcherPolicyTest(unittest.TestCase):
    def test_manual_only_blocks_generic_fanout_and_width_floor(self):
        d = DispatchController()
        self.assertFalse(d.dispatch_allowed(manual=True, approved=False, autonomous_green=False))
        self.assertTrue(d.dispatch_allowed(manual=True, approved=True, autonomous_green=False))
        self.assertEqual(d.target_width(green_work=True, active=0), 6)
        self.assertEqual(d.target_width(green_work=True, active=99), 15)
        self.assertEqual(d.target_width(green_work=False, active=9), 0)

    def test_fencing_and_expiry_retry_then_park(self):
        d = DispatchController(heartbeat_ttl=10, max_retries=1)
        lease = d.acquire("m", "worker", now=0)
        self.assertFalse(d.heartbeat("m", "stale", now=1))
        self.assertEqual(d.reap(now=11), {"m": "retry"})
        lease2 = d.acquire("m", "worker-2", now=12)
        self.assertNotEqual(lease.token, lease2.token)
        self.assertEqual(d.reap(now=23), {"m": "park"})


if __name__ == "__main__":
    unittest.main()
