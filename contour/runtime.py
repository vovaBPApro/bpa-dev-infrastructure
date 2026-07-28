"""Minimal manager entrypoint wired to dispatch/watchdog policy."""
from dispatcher import DispatchController


class RuntimeManager:
    def __init__(self, *, manual=True, controller=None):
        self.manual = manual
        self.controller = controller or DispatchController()

    def submit(self, mission_id, owner, *, approved=False, autonomous_green=False, now=None):
        if not self.controller.dispatch_allowed(manual=self.manual, approved=approved,
                                                autonomous_green=autonomous_green):
            return None
        return self.controller.acquire(mission_id, owner, now=now)

    def heartbeat(self, mission_id, token, *, now=None):
        return self.controller.heartbeat(mission_id, token, now=now)

    def watchdog(self, *, now=None):
        return self.controller.reap(now=now)
