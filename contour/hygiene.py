"""Fail-closed lifecycle hygiene primitives for the control plane.

These helpers are deliberately filesystem-only and dependency free.  They are
used by a manager before admitting work and by the reaper during recovery.
"""
from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional


@dataclass(frozen=True)
class Lease:
    owner: str
    token: str
    expires_at: float
    heartbeat_at: float

    def alive(self, now: Optional[float] = None) -> bool:
        return (time.time() if now is None else now) < self.expires_at


class LeaseBook:
    """In-memory lease authority; callers persist the token with their report."""

    def __init__(self, ttl: float = 300.0, clock: Callable[[], float] = time.time):
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        self.ttl, self.clock = ttl, clock
        self._leases: dict[str, Lease] = {}

    def acquire(self, resource: str, owner: str, token: str) -> Lease:
        if not resource or not owner or not token:
            raise ValueError("resource, owner and token are required")
        current = self._leases.get(resource)
        now = self.clock()
        if current and current.alive(now) and current.owner != owner:
            raise RuntimeError("resource lease is held")
        lease = Lease(owner, token, now + self.ttl, now)
        self._leases[resource] = lease
        return lease

    def heartbeat(self, resource: str, owner: str, token: str) -> Lease:
        current = self._leases.get(resource)
        if not current or current.owner != owner or current.token != token or not current.alive(self.clock()):
            raise RuntimeError("invalid or expired lease")
        now = self.clock()
        lease = Lease(owner, token, now + self.ttl, now)
        self._leases[resource] = lease
        return lease

    def release(self, resource: str, owner: str, token: str) -> None:
        current = self._leases.get(resource)
        if current and current.owner == owner and current.token == token:
            self._leases.pop(resource)

    def get(self, resource: str) -> Optional[Lease]:
        return self._leases.get(resource)


class WorktreeReaper:
    """Remove only explicitly stale, owned worktrees; unknown ownership is safe."""

    def __init__(self, root: str, ttl: float = 3600.0, clock: Callable[[], float] = time.time):
        self.root, self.ttl, self.clock = Path(root), ttl, clock

    def reap(self, records: Iterable[Mapping[str, object]], active_owners: set[str] | None = None) -> list[str]:
        active_owners = active_owners or set()
        removed: list[str] = []
        now = self.clock()
        for record in records:
            path = Path(str(record.get("path", "")))
            owner = record.get("owner")
            heartbeat = record.get("heartbeat_at")
            # Fail closed: path must be beneath root, owner and timestamp known,
            # and no active process may claim it.
            try:
                resolved_root = self.root.resolve()
                resolved_path = path.resolve()
                # Never remove the root itself, even when metadata is stale.
                if resolved_path == resolved_root:
                    continue
                resolved_path.relative_to(resolved_root)
                stale = now - float(heartbeat) > self.ttl
            except (ValueError, TypeError, OSError):
                continue
            if not owner or owner in active_owners or not stale or not path.exists():
                continue
            shutil.rmtree(path)
            removed.append(str(path))
        return removed


@dataclass
class DiskAdmission:
    high_watermark: float = 0.90
    low_watermark: float = 0.85
    blocked: bool = False

    def __post_init__(self) -> None:
        if not 0 < self.low_watermark < self.high_watermark < 1:
            raise ValueError("watermarks must satisfy 0 < low < high < 1")

    def update(self, used_fraction: float) -> bool:
        if not 0 <= used_fraction <= 1:
            raise ValueError("used_fraction must be between 0 and 1")
        if self.blocked:
            if used_fraction <= self.low_watermark:
                self.blocked = False
        elif used_fraction >= self.high_watermark:
            self.blocked = True
        return not self.blocked

    def admit(self, path: str) -> bool:
        usage = shutil.disk_usage(path)
        return self.update(usage.used / usage.total)
