# Orchestrator execution contract

This is the operational checklist for every migration or infrastructure
mission. It is intentionally mechanical so that conversation cannot replace
delivery.

## Start gate

Create a mission record containing scope, acceptance matrix, risk tier, owner,
and the Human's verbatim requirements. Freeze the chain and name the first
artifact. Do not report a percentage at this point.

## Step gate

For each step, the manager must attach a terminal record with:

1. artifact path and a one-line purpose;
2. commit SHA and `git push` confirmation;
3. exact verification commands and complete output summary;
4. Docker evidence when runtime behavior is involved (build, start, health,
   authenticated route, resource limits, soak duration, and teardown);
5. remaining acceptance rows and one next action.

The orchestrator advances only after all five fields exist. A prose update,
agent heartbeat, or green-looking log is not a terminal record.

## Failure and blocker gate

Missing fixtures, timeouts, unavailable services, or unverifiable rollback are
explicit `NO-GO` outcomes. Record the failed command and preserve its output;
never weaken a check, fabricate evidence, or relabel a timeout as a warning to
make a green result. The mission may pivot only to a separately approved,
autonomous-green item while this blocker remains visible.

## Progress and communication gate

Percentages are allowed only when calculated from the current acceptance
matrix: each numerator row must reference a landed SHA and passing evidence,
and every denominator row must be listed. Otherwise report `unmeasured` or
`NO-GO`, not an estimate. Send concise updates only at step transitions or
when a blocker changes; do not start a new narrative in place of the current
rollup.

## Close gate

Close the mission only with an independent review, final test/Docker evidence,
all acceptance rows dispositioned, and a pushed final SHA. If any row remains
open, keep the mission active and name the blocker. The final rollup must link
the artifacts so a fresh orchestrator can resume without relying on chat
history.
