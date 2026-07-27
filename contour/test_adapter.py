import tempfile
from pathlib import Path
from adapter import Event, LocalAdapter

def test_reconnect_replays_once_and_dedupes():
    with tempfile.TemporaryDirectory() as d:
        a = LocalAdapter(Path(d) / 'state.jsonl'); a.send(Event('1','telegram',{'text':'hello'}))
        seen = []; assert [e.event_id for e in a.connect(seen.append)] == ['1']
        assert a.connect(seen.append) == []; assert not a.send(Event('1','telegram',{})); assert len(seen) == 1

def test_state_survives_restart():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'state.jsonl'; LocalAdapter(p).send(Event('2','mcp',{'method':'health'}))
        seen = []; LocalAdapter(p).connect(seen.append); assert seen[0].payload['method'] == 'health'
