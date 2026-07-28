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
        replay = MissionStore(path)
        projections_equal = [m.__dict__ for m in store.all()] == [m.__dict__ for m in replay.all()]
    leases.acquire("dispatch", "worker-a", "token-a")
    now[0] = 111.0
    try:
        leases.heartbeat("dispatch", "worker-a", "token-a")
        fenced = False
    except RuntimeError:
        fenced = True
    return {"missions": 3, "deterministic_replay": projections_equal, "expired_lease_fenced": fenced}


if __name__ == "__main__":
    print(json.dumps(run(), sort_keys=True))
