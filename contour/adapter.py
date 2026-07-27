"""Local-only Telegram/MCP adapter contract (no network or credentials)."""
from dataclasses import dataclass
from pathlib import Path
import json

@dataclass(frozen=True)
class Event:
    event_id: str
    channel: str
    payload: dict

class LocalAdapter:
    def __init__(self, state_file):
        self.path = Path(state_file); self.connected = False
        self._events = {}; self._delivered = set()
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                row = json.loads(line); e = Event(row['event_id'], row['channel'], row['payload'])
                self._events[e.event_id] = e
                if row.get('delivered'): self._delivered.add(e.event_id)
    def _persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rows = [json.dumps({'event_id': e.event_id, 'channel': e.channel, 'payload': e.payload,
                            'delivered': e.event_id in self._delivered}, sort_keys=True)
                for e in self._events.values()]
        self.path.write_text('\n'.join(rows) + ('\n' if rows else ''))
    def disconnect(self): self.connected = False
    def connect(self, sink=None): self.connected = True; return self.replay(sink)
    def send(self, event, sink=None):
        if event.event_id in self._events: return False
        self._events[event.event_id] = event; self._persist()
        if self.connected: self.replay(sink)
        return True
    def replay(self, sink=None):
        out = []
        for e in self._events.values():
            if e.event_id in self._delivered: continue
            if sink: sink(e)
            self._delivered.add(e.event_id); out.append(e)
        if out: self._persist()
        return out
    def pending(self): return [e for i, e in self._events.items() if i not in self._delivered]
