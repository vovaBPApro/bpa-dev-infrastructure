"""Crash-safe dispatch and watchdog policy primitives.

The contour deliberately keeps policy separate from transport: callers persist
the returned decisions and use a fencing token when talking to workers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional
import uuid


def _ts() -> float:
    return datetime.now(timezone.utc).timestamp()


@dataclass
class Lease:
    mission_id: str
    token: str
    owner: str
    heartbeat_at: float
    attempts: int = 1


class DispatchController:
    """Enforces manual-mode, width, heartbeat and fencing invariants."""

    def __init__(self, *, min_coders: int = 6, max_coders: int = 15,
                 heartbeat_ttl: float = 480.0, max_retries: int = 2):
        if not 1 <= min_coders <= max_coders:
            raise ValueError("invalid coder bounds")
        self.min_coders, self.max_coders = min_coders, max_coders
        self.heartbeat_ttl, self.max_retries = heartbeat_ttl, max_retries
        self.leases: Dict[str, Lease] = {}
        self._attempts: Dict[str, int] = {}

    def dispatch_allowed(self, *, manual: bool, approved: bool,
                         autonomous_green: bool) -> bool:
        """MANUAL blocks only unapproved generic fan-out."""
        return approved or autonomous_green

    def target_width(self, *, green_work: bool, active: int) -> int:
        if not green_work:
            return 0
        return min(self.max_coders, max(self.min_coders, active))

    def acquire(self, mission_id: str, owner: str, *, now: Optional[float] = None) -> Lease:
        existing = self.leases.get(mission_id)
        stamp = _ts() if now is None else now
        if existing and stamp - existing.heartbeat_at <= self.heartbeat_ttl:
            return existing
        attempts = (existing.attempts + 1) if existing else self._attempts.get(mission_id, 0) + 1
        lease = Lease(mission_id, uuid.uuid4().hex, owner, stamp, attempts)
        self.leases[mission_id] = lease
        self._attempts[mission_id] = attempts
        return lease

    def heartbeat(self, mission_id: str, token: str, *, now: Optional[float] = None) -> bool:
        lease = self.leases.get(mission_id)
        if not lease or lease.token != token:
            return False
        lease.heartbeat_at = _ts() if now is None else now
        return True

    def reap(self, *, now: Optional[float] = None) -> Dict[str, str]:
        """Fence expired leases and return action: retry or park."""
        stamp, actions = (_ts() if now is None else now), {}
        for mid, lease in list(self.leases.items()):
            if stamp - lease.heartbeat_at <= self.heartbeat_ttl:
                continue
            actions[mid] = "retry" if lease.attempts <= self.max_retries else "park"
            del self.leases[mid]
        return actions
