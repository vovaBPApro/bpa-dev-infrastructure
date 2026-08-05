# V3-3.10 — token and cost accounting: retained evidence

Retained because the central claim of this row is not checkable by reading the code:
`instance/specs/token-usage-accounting.md` requires the lane log to be **unchanged in
readability** after the output format changed, and requires the recorded cost to match the
CLI's own figure. Both were proven by execution on 2026-08-05, and this is what was run.

## The lane log is unchanged

The hermetic lock is `daemon/mask-stream.test.ts`, which pipes
`tests/fixtures/usage/lane-stream-json.jsonl` through the masker and asserts the result is
**byte-identical** to `tests/fixtures/usage/lane-plain-print.txt` — a capture of what
`claude --print` produced for the same prompt before this row existed. Both fixtures were
captured from this host; the provider's opaque thinking signature was replaced with
`REDACTED-PROVIDER-SIGNATURE`, since a long base64 run is not usage data and has no
business entering git.

`probe-lane.log` is the log of a real lane launched through the real launcher
(`orchestrator/fleet/launch-lane.sh`, `instance/lane-agent-command-sonnet.conf`, a
transient systemd unit) against a throwaway clone. It reads as a lane log has always read:
the agent's own text, then the exit gate's `PASS` lines and `LANE-EXIT verdict=clear`. No
JSON reaches it.

That lane recorded two rows — `claude-sonnet-5` and `claude-haiku-4-5-20251001`, both
`role=coder lane=usageprobe item=V3-3.10`. One lane, two models: the reason rows are per
model rather than per lane.

## The cost matches the CLI's own figure

`reconcile-lane.log` is the log of a run whose raw stream was teed to a file, so the
recorded rows could be compared against the provider's own total from the same invocation:

```text
CLI total_cost_usd : 0.0233279
sum(rows.cost_usd) : 0.0233279
difference         : 0
```

Exact, at the live boundary. The hermetic equivalent is in `daemon/usage-capture.test.ts`,
which asserts the same reconciliation against the captured fixture.

## What was NOT done

The live daemon was not stopped or restarted, and no unit was installed, enabled or
started — the constraint on this lane. Durability is instead shown where it actually
lives: every row is written by a short-lived process that has exited before any query
process opens the database, so no row was ever held in a daemon's memory to lose.
`daemon/usage-capture.test.ts` closes and reopens the store and compares the rows.
