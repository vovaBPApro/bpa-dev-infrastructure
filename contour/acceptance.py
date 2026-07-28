"""Small deterministic shadow acceptance harness.

Run from any directory with ``python3 contour/acceptance.py``.  The JSON
evidence is suitable for attaching to a lane report and contains no secrets.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

try:
    from .hygiene import LeaseBook
    from .mission_lifecycle import MissionStore
except ImportError:  # direct repo-root invocation
    from hygiene import LeaseBook
    from mission_lifecycle import MissionStore


def run() -> dict:
    now = [100.0]
    leases = LeaseBook(ttl=10, clock=lambda: now[0])
    with tempfile.TemporaryDirectory() as td:
        path = str(Path(td) / "events.jsonl")
        store = MissionStore(path)
        for mid in ("shadow-1", "shadow-2", "shadow-3"):
            store.create({"synthetic": True}, mission_id=mid, event_id=f"create-{mid}")
            store.transition(mid, "running", event_id=f"run-{mid}")
            store.transition(mid, "succeeded", event_id=f"done-{mid}")
        # Simulate process kill/restart by rebuilding from the append-only log.
        replay = MissionStore(path)
        projections_equal = [m.__dict__ for m in store.all()] == [m.__dict__ for m in replay.all()]
        # Duplicate delivery must not create a second side effect/version bump.
        before = replay.get("shadow-1").version
        replay._apply({"kind": "transitioned", "event_id": "done-shadow-1", "mission_id": "shadow-1", "state": "succeeded", "at": "duplicate"})
        duplicate_idempotent = replay.get("shadow-1").version == before
        terminal_not_active = all(m.state == "succeeded" for m in replay.all())
    leases.acquire("dispatch", "worker-a", "token-a")
    now[0] = 111.0
    try:
        leases.heartbeat("dispatch", "worker-a", "token-a")
        fenced = False
    except RuntimeError:
        fenced = True
    return {"missions": 3, "deterministic_replay": projections_equal,
            "restart_replay": projections_equal, "duplicate_idempotent": duplicate_idempotent,
            "terminal_not_active": terminal_not_active, "expired_lease_fenced": fenced,
            "remaining_gates": ["four_hour_soak", "manifest_and_rollback", "live_route_checks"]}


if __name__ == "__main__":
    print(json.dumps(run(), sort_keys=True))
