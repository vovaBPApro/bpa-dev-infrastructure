"""Minimal manager entrypoint wired to dispatch/watchdog policy."""
try:  # package import from repo root
    from .dispatcher import DispatchController
    from .provenance import verify_checkout, ProvenanceStore
except ImportError:  # direct script/test execution from contour/
    from dispatcher import DispatchController
    from provenance import verify_checkout, ProvenanceStore


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

    def verify_rollback(self, root, expected_commit, *, image_digest=None,
                        actual_image_digest=None, evidence_store=None):
        evidence = verify_checkout(root, expected_commit, image_digest, actual_image_digest)
        if evidence_store:
            evidence.update({"kind":"rollback", "mission_id":"runtime", "dispatch_id":"runtime", "from_commit":expected_commit, "restored_commit":expected_commit, "recovery_event_id":"runtime-rollback"})
            ProvenanceStore(evidence_store).append_raw(evidence)
        return evidence
