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

    def verify_rollback(self, root, expected_commit, *, prior_commit=None, image_digest=None,
                        actual_image_digest=None, evidence_store=None, lifecycle=None):
        if evidence_store and lifecycle is None:
            raise ValueError("lifecycle required for persisted rollback evidence")
        if evidence_store and image_digest is None:
            raise ValueError("image digest required for persisted rollback evidence")
        if lifecycle is not None:
            prior_commit = lifecycle.capture_source()
            if lifecycle.current_commit() != expected_commit:
                raise ValueError("lifecycle target mismatch")
            actual_image_digest = lifecycle.current_image_digest()
        if evidence_store and (not prior_commit or prior_commit == expected_commit):
            raise ValueError("explicit distinct prior_commit required")
        evidence = verify_checkout(root, expected_commit, image_digest, actual_image_digest)
        if evidence_store:
            evidence.update({"kind":"rollback", "mission_id":"runtime", "dispatch_id":"runtime", "from_commit":prior_commit, "restored_commit":expected_commit, "recovery_event_id":"runtime-rollback"})
            ProvenanceStore(evidence_store).append_raw(evidence)
        return evidence

    def capture_rollback_source(self, root):
        """Capture pre-transition HEAD for a subsequent verified rollback."""
        import subprocess
        return subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
