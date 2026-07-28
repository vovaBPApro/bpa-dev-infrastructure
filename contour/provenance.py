"""Deterministic, redacted acceptance provenance and rollback evidence."""
from __future__ import annotations
import json
import re
from pathlib import Path
import threading, os
import fcntl
import subprocess
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

def verify_checkout(root, expected_commit, image_digest=None, actual_image_digest=None):
    """Verify rollback target is current HEAD and (when supplied) image digest."""
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != expected_commit or (image_digest is not None and image_digest != actual_image_digest):
        raise ValueError("rollback target verification failed")
    return {"commit": head, "image_digest": actual_image_digest, "verified": True}


class ProvenanceStore:
    def __init__(self, path): self.path = Path(path); self._lock = threading.Lock()
    def append(self, manifest: Provenance):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        import tempfile
        with self._lock:
            lock_path = str(self.path) + ".lock"
            lock = open(lock_path, "a+"); fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                old = self.path.read_text() if self.path.exists() else ""
                fd, tmp = tempfile.mkstemp(dir=self.path.parent)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(old + manifest.serialize() + "\n"); f.flush(); os.fsync(f.fileno())
                os.replace(tmp, self.path)
                dfd = os.open(self.path.parent, os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN); lock.close()
    def load(self):
        if not self.path.exists(): return []
        rows = []
        lock = open(str(self.path) + ".lock", "a+"); fcntl.flock(lock, fcntl.LOCK_SH)
        try:
            lines = self.path.read_text().splitlines()
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN); lock.close()
        for line in lines:
            if not line.strip(): continue
            try:
                row = json.loads(line)
                if not all(k in row for k in ("mission_id", "dispatch_id", "commit")): raise ValueError
                rows.append(row)
            except (ValueError, json.JSONDecodeError):
                raise ValueError("corrupt provenance record")
        return rows
