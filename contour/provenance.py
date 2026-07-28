"""Deterministic, redacted acceptance provenance and rollback evidence."""
from __future__ import annotations
import json
from dataclasses import dataclass, asdict
from typing import Any, Mapping


@dataclass(frozen=True)
class Provenance:
    mission_id: str
    dispatch_id: str
    lease_id: str
    event_ids: tuple[str, ...]
    model: str
    vendor: str
    commit: str
    tests: tuple[str, ...]
    redaction: str = "secrets omitted"

    def serialize(self) -> str:
        data = asdict(self)
        data["event_ids"] = sorted(data["event_ids"])
        data["tests"] = sorted(data["tests"])
        return json.dumps(data, sort_keys=True, separators=(",", ":"))


def rollback_evidence(provenance: Provenance, *, restored_commit: str,
                      recovery_event_id: str) -> str:
    """Return stable evidence that recovery restored the prior immutable SHA."""
    if not restored_commit or restored_commit == provenance.commit:
        raise ValueError("rollback must restore a different known commit")
    data: Mapping[str, Any] = {
        "kind": "rollback",
        "mission_id": provenance.mission_id,
        "dispatch_id": provenance.dispatch_id,
        "from_commit": provenance.commit,
        "restored_commit": restored_commit,
        "recovery_event_id": recovery_event_id,
        "redaction": provenance.redaction,
    }
    return json.dumps(data, sort_keys=True, separators=(",", ":"))
