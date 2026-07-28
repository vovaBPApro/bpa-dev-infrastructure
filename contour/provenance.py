"""Deterministic, redacted acceptance provenance and rollback evidence."""
from __future__ import annotations
import json
import re
from pathlib import Path
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
        data = _redact(data)
        return json.dumps(data, sort_keys=True, separators=(",", ":"))


_SECRET = re.compile(r"(?i)(token|secret|password|api[_-]?key)=([^\s,;]+)")
def _redact(value):
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if re.search(r"(?i)(token|secret|password|key)", k) else _redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [_redact(v) for v in value]
    return _SECRET.sub(r"\1=[REDACTED]", str(value)) if isinstance(value, str) else value


def rollback_evidence(provenance: Provenance, *, restored_commit: str,
                      recovery_event_id: str, commit_exists=None) -> str:
    """Return stable evidence that recovery restored the prior immutable SHA."""
    if not restored_commit or restored_commit == provenance.commit or commit_exists is None or not commit_exists(restored_commit) or not recovery_event_id:
        raise ValueError("rollback must restore a different known commit")
    data: Mapping[str, Any] = {
        "kind": "rollback",
        "mission_id": provenance.mission_id,
        "dispatch_id": provenance.dispatch_id,
        "from_commit": provenance.commit,
        "restored_commit": restored_commit,
        "recovery_event_id": recovery_event_id,
        "verified": True,
        "redaction": provenance.redaction,
    }
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


class ProvenanceStore:
    def __init__(self, path): self.path = Path(path)
    def append(self, manifest: Provenance):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        import tempfile, os
        old = self.path.read_text() if self.path.exists() else ""
        fd, tmp = tempfile.mkstemp(dir=self.path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(old + manifest.serialize() + "\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, self.path)
    def load(self):
        if not self.path.exists(): return []
        return [json.loads(x) for x in self.path.read_text().splitlines() if x.strip()]
