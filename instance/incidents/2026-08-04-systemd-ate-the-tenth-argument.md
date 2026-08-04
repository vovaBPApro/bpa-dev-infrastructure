# systemd ate the tenth argument, and every lane reported `failed`, 2026-08-04

Found after two lanes in one evening produced verified-good work and were both recorded
as `state: failed`. The first was written off as unexplained. The second was launched from
a different repository specifically to rule out the leading hypothesis, failed identically,
and that is what made the real cause findable.

## The defect

`orchestrator/fleet/launch-lane.sh` runs the lane through `systemd-run`, passing a shell
script to `/bin/bash -c` with eleven-plus positional parameters:

```sh
prompt=$1; bun=$2; masker=$3; log=$4; report=$5; status=$6; gate=$7; repo=$8; branch=$9; role=${10}
...
pipeline_status=("${PIPESTATUS[@]}")
```

**systemd performs its own variable expansion on `ExecStart` before bash ever sees it.**
`${10}`, `${PIPESTATUS[@]}`, `${pipeline_status[0]}` and `${pipeline_status[1]}` are not
valid environment variable names, so systemd replaces each with an **empty string**.
Unbraced `$1`…`$9` are left alone, because they are not valid names either and systemd
only rewrites the braced form.

systemd says so, in the unit's own journal, on every single launch:

```
lane-…service: Invalid environment variable name evaluates to an empty string:
10, PIPESTATUS[@], pipeline_status[0], pipeline_status[1]
```

Proven directly rather than inferred:

```sh
systemd-run --collect --wait /bin/bash -c \
  'printf "nine=[%s] ten=[%s] pipestatus=[%s]\n" "$9" "${10}" "${PIPESTATUS[@]}" > /tmp/probe' \
  _ a1 a2 a3 a4 a5 a6 a7 a8 NINE TEN
# -> nine=[NINE] ten=[] pipestatus=[]
```

The ninth argument arrives. The tenth does not.

## What it broke

`role` is the tenth parameter, so **every lane invoked its exit gate as `--role ""`**.
`gate/lane-exit.sh` treats an empty flag value as a usage error, prints its usage line and
exits 2, and the wrapper records:

```
state: failed
reason: report-invalid
exit: 2
```

**This happens no matter how good the lane's work is**, and it happens before a single
check runs — which is why these logs contain a usage line and no `PASS`/`FAIL`/`GUARD`
output at all. That absence was the diagnostic signature and it was misread twice, once as
a repository mismatch (a real but different failure mode) and once as unexplained.

The second consequence is worse because it is silent. `pipeline_status` is empty, so
`agent_status` and `mask_status` are empty strings, and `((agent_status != 0))` on an empty
string evaluates as zero — **true, do-nothing**. The checks that detect a crashed agent and
a failed log masker are therefore disabled. A lane whose agent died mid-turn is not
reported as `payload-exit`; it falls through to the gate and is misfiled like everything
else.

## Why this went unfixed for so long

Row V3-0.44 landed today (`6714091`) against the symptom *"`gate/lane-exit.sh` never
learned a lane's role, so all 14 reviewer lanes reported failed"*. The diagnosis was
correct about the effect and wrong about the cause: the role is not lost because the
launcher forgets to pass it — the launcher passes it correctly, and **systemd removes it in
transit**. So the fix could not work, the row is recorded `done`, and the defect is live.

Both the caller and the callee read as correct in isolation. Nothing between them was ever
inspected, because the transport was assumed to be lossless. That is the general lesson,
and it is the same shape as the day's other findings: the gate checked an artifact rather
than observing the behaviour.

## Scale

Lane status files on this host: **59 `failed` / 36 `terminal`**. The failed share is now
suspect wholesale rather than individually — some of those lanes did land work, which is
itself proof the status was not load-bearing. An earlier attempt to attribute the split by
grepping logs produced a junk number (the pattern matched the word `FAIL` in report prose)
and was withdrawn; the honest statement is that the tally is unattributed and the mechanism
above affected every launch.

## The fix, not applied here

This is lane work on runtime code, not orchestrator work, and it must not be hand-patched
on the host — hand-patching a host copy is what produced the fleet-nudge drift the same
evening.

1. Stop passing `${10}`. Either reorder so no parameter beyond the ninth is needed, pass
   the role through the environment (`--setenv`), or write the wrapper to a file and exec
   that file, so systemd never parses the script body.
2. `${PIPESTATUS[@]}` must survive. Same remedy; capturing exit status through a
   systemd-expanded string is not safe in any form.
3. Add a regression lock that **launches a real lane through systemd** and asserts the gate
   received a non-empty role. A unit test of `launch-lane.sh` in isolation cannot catch
   this, because the defect lives in systemd's parsing, not in the script. The test has to
   cross the boundary that was assumed lossless.
4. Reopen V3-0.44 rather than filing a new row against the same symptom. Its acceptance was
   met and its cause was not.

Until it lands, a lane reporting `failed` means nothing on its own. Collect
`$LANE_REPORT_PATH` and run `gate/lane-exit.sh` by hand with an explicit `--role`.
