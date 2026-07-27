"""Small, dependency-free mission lifecycle store.

The log is append-only JSONL.  State is rebuilt from events on startup, so a
crash cannot leave an in-memory-only mission.  Event ids make retries safe.
"""
from __future__ import annotations

import json
import os
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

STATES = {"queued", "running", "succeeded", "failed", "recovering"}
TRANSITIONS = {
    "queued": {"running", "failed"},
    "running": {"succeeded", "failed", "recovering"},
    "recovering": {"queued", "running", "failed"},
    "failed": {"recovering", "queued"},
    "succeeded": set(),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class Mission:
    mission_id: str
    state: str
    created_at: str
    updated_at: str
    payload: dict
    version: int


class MissionStore:
    def __init__(self, path: str):
        self.path = path
        self._missions: Dict[str, Mission] = {}
        self._event_ids = set()
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        with open(self.path, encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                self._apply(json.loads(line), replay=True)

    def _append(self, event: dict) -> None:
        parent = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(parent, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def _apply(self, event: dict, replay: bool = False) -> None:
        event_id = event["event_id"]
        if event_id in self._event_ids:
            return
        self._event_ids.add(event_id)
        mid, state = event["mission_id"], event["state"]
        if event["kind"] == "created":
            self._missions[mid] = Mission(mid, state, event["at"], event["at"], event.get("payload", {}), 1)
            return
        previous = self._missions.get(mid)
        if previous is None:
            raise ValueError(f"unknown mission: {mid}")
        self._missions[mid] = Mission(mid, state, previous.created_at, event["at"], previous.payload, previous.version + 1)

    def create(self, payload: Optional[dict] = None, mission_id: Optional[str] = None, event_id: Optional[str] = None) -> Mission:
        mid = mission_id or str(uuid.uuid4())
        if mid in self._missions:
            return self._missions[mid]
        event = {"kind": "created", "event_id": event_id or str(uuid.uuid4()), "mission_id": mid, "state": "queued", "at": _now(), "payload": payload or {}}
        self._append(event)
        self._apply(event)
        return self._missions[mid]

    def transition(self, mission_id: str, state: str, event_id: Optional[str] = None) -> Mission:
        if state not in STATES:
            raise ValueError(f"invalid state: {state}")
        current = self._missions.get(mission_id)
        if current is None:
            raise ValueError(f"unknown mission: {mission_id}")
        if state == current.state:
            return current
        if state not in TRANSITIONS[current.state]:
            raise ValueError(f"invalid transition: {current.state} -> {state}")
        event = {"kind": "transitioned", "event_id": event_id or str(uuid.uuid4()), "mission_id": mission_id, "state": state, "at": _now()}
        self._append(event)
        self._apply(event)
        return self._missions[mission_id]

    def get(self, mission_id: str) -> Optional[Mission]:
        return self._missions.get(mission_id)

    def all(self) -> Iterable[Mission]:
        return tuple(self._missions.values())

