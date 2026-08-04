commit: c7e69164276714ba362b3feaedd6281f3d46b470 [ORCH] add the Fable lane command for the global review
verify: env -u BUN_BIN bash -c 'set -o pipefail; bun test 2>&1 | sed -E "s/^ +//"'
verify-count: 552/0
result: clean
secret-scan: clean
remaining: global review — findings below

# Global review of the v3 line — Fable, 2026-08-04

Reviewed SHA `c7e69164276714ba362b3feaedd6281f3d46b470`, which was `origin/main` when the
review began. Everything below was produced by running something. Where I only read code,
I say so.

While I was writing this, V3-0.15 landed and `origin/main` advanced to `c8e52f67`. I did
not rebase — every verdict below is pinned to the SHA in the header. Two consequences worth
naming: the board arithmetic in §1.9 is now understated by one more row, and this is
V3-0.25's churn visible in real time, on a review that took a couple of hours.

I pushed nothing, landed nothing, deleted no ref, and modified no file under `instance/`.
The only artifact I created is this report. Confirmed after the fact: the working tree is
clean, my HEAD is unchanged, and there are no `refs/meteorite-candidates/*` on origin.

Note on notation: this repository's completion guard forbids unstructured test-count
claims outside the `verify-count:` field, and it is right to — that control exists because
a lane once printed hard-coded counts. So counts appear here in words, and the one
authoritative measurement is in the header field above.

## Manifest consumption check

- review-policy sha256:9d10a41cf0c6 — Review Policy
- verification-and-locks sha256:07e760358365 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- tool-permissions sha256:955630cc416e — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

Instance facts: phase=sole-mission, active_scope=instruction-mechanics-only,
capture.mode=manual, operator.language=uk.

---

## 1. Per-claim verdicts

I checked 16 claims. I chose them by three rules, in order: (a) every claim on the
critical path to the operator's "reboot the whole machine" milestone; (b) every row marked
`done` whose acceptance criterion was a command I could run without mutating anything;
(c) the two claims the repository makes about *itself* as a system — that the review
process catches things, and that the "mechanism without executor" class is now detected.
Rule (c) is where the review paid for itself.

### 1.1 HOLDS — V3-0.4, decision-ledger drift

`bun test tools/check-decision-ledger-drift.test.ts` exits 0 with three passing cases and
no failures. The row's acceptance text says two cases; there are now three, the extra one
being V3-0.9's remote-tracking donor. Holds — and this checker genuinely runs against the
real repository (`tools/check-decision-ledger-drift.test.ts:23` sets `cwd: repoRoot` with
no fixture), so the ledger really is measured at every landing.

### 1.2 DOES NOT HOLD — V3-0.28, "a tracked mechanism with no executor"

**This is the most important finding in the review.** The row is marked `done`, landed
`1e4e0f2`, and its checker is green:

```
$ bun tools/check-mechanism-reachability.ts
MECHANISM-REACHABILITY clean          exit=0
```

`tools/check-mechanism-reachability.ts:61-74` decides "reachable" for a checker, cron,
gate or runner by asking whether **any tracked `.ts`/`.sh`/`.in` file contains the
mechanism's filename as a substring** (lines 72-73). It is a `text.includes(needle)` test.
It never asks whether anything invokes the mechanism, and on this code path it does not
even strip comments.

Proven by mutation, in a throwaway clone at the same SHA. `hygiene/check-shared-stash.sh`
is named by exactly one tracked file — its own test. Rename that test and rewrite its
mention:

```
$ git mv hygiene/check-shared-stash.test.sh hygiene/zzz-renamed.test.sh
$ sed -i 's#check-shared-stash\.sh#UNRELATED-NAME.sh#g' hygiene/zzz-renamed.test.sh
$ bun tools/check-mechanism-reachability.ts --repo /tmp/fable-mut
MECHANISM-REACHABILITY unreachable mechanism: checker:shared-stash    exit=1
```

So the *only* thing holding that mechanism "reachable" was a test file. Then, without
restoring anything, I appended a bare comment to an unrelated script:

```
$ printf '\n# see also check-shared-stash.sh\n' >> hygiene/reap.sh
$ bun tools/check-mechanism-reachability.ts --repo /tmp/fable-mut
MECHANISM-REACHABILITY clean          exit=0
```

**A comment is accepted as an executor.** That is the defect class the row exists to
detect, reproduced inside the mechanism built to detect it.

The consequences are concrete, not theoretical. Of the five checkers in
`instance/required-mechanisms.tsv`, only one has a real production executor:

| mechanism | real executor? | evidence |
|---|---|---|
| `checker:retained-branches` | **yes** | `gate/land.sh:416` invokes it at every landing |
| `checker:decision-ledger` | yes, incidentally | its test runs it against the real repo (`cwd: repoRoot`) |
| `checker:mechanism-reachability` | yes, incidentally | its test asserts `check(root)` on the real repo |
| `checker:shared-stash` | **no** | `hygiene/check-shared-stash.test.sh:7` is pure fixture (`mktemp -d`); nothing ever checks this repository's shared stash |
| `checker:github-ref-protection` | **no** | every case in its test is stubbed (`STUB_MODE`, fixture spec); live GitHub is never queried |

`git grep` confirms the gate invokes none of the four by any other name:
`grep -niE "ledger|drift|ref-protection|shared-stash|reachab" gate/land.sh gate/land-lib.sh`
returns only an unrelated `unit-drift` key and a comment.

The needle is also far too weak to mean anything. `runner:meteorite`'s needle is the
basename `run.sh`, which **eight tracked files** contain — including
`docker/whisper-proof-run.sh`, which has nothing to do with the meteorite. The Hard
Floor 5 proof would read as "reachable" on the strength of an unrelated Whisper script.

Finally, the workboard claims the checker "encodes the two distinctions that decided three
rows this session: **installed is not armed**". It cannot: the checker never reads host
state (it contains a single `spawnSync`, used for `git ls-files`). `hasArmEdge` greps
tracked text for `systemctl … enable … <unit>`, which is neither installed nor armed. The
2026-08-01 incident that motivated the row — `orch-runtime-watchdog.timer` installed and
never armed — would have reported `clean` throughout.

Measured on this host right now:

```
bpa-orchestrator.service            load=loaded    active=inactive
bpa-orchestrator-watchdog.service   load=not-found active=inactive
bpa-orchestrator-watchdog.timer     load=not-found active=inactive
bpa-meteorite.timer                 load=not-found active=inactive
bpa-deploy-drift-guard.timer        load=not-found active=inactive
bpa-full-suite.timer                load=loaded    active=inactive
$ crontab -l
no crontab for root
```

Fair caveat, stated because it materially softens this: HR-1720 defers host deployment to
v3, so units being absent from *this* host is partly in-scope-deferred, and V3-2.1/V3-2.3
are correctly still open. But `no crontab for root` is verbatim the string V3-0.28's own
row cites as instance #2 of the class, and it is still true today with the row closed. The
orchestrator currently has no supervision running on this host.

### 1.3 HOLDS — V3-0.27, retained branches

`bun hygiene/check-retained-branches.ts` → `RETAINED-BRANCHES PASS remote=origin
checked=12`, exit 0. And this one has a real executor (`gate/land.sh:416`, unconditional).
Genuinely closed.

### 1.4 HOLDS — V3-2.6, meteorite blocker names its missing input

My first attempt was wrong (I omitted `--ref` and hit ref-validation first, which taught me
nothing). Corrected, each donor input unset in turn:

```
NO-GO input-validation: required input METEORITE_DONOR_SHA is unset or empty; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>
NO-GO input-validation: required input METEORITE_DONOR_REF is unset or empty; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>
```

Holds exactly as claimed.

### 1.5 HOLDS — V3-2.7, meteorite leaves the tree clean

`git status --short` was empty after three separate `meteorite/run.sh` invocations. Holds.

### 1.6 HOLDS — V3-0.14, ref-protection fails closed without a credential

```
$ ( unset GITHUB_TOKEN GH_TOKEN; bash tools/check-github-ref-protection.sh )
NO-GO github-ref-protection reason=credential-missing set=GITHUB_TOKEN-or-GH_TOKEN
exit=2
```

Fails closed correctly, and the row's `implemented` (not `done`) status is honest. Note
this is *why* it has no executor (§1.2): nothing can run it without a credential. The row
is honest; the reachability checker calling it "reachable" is not.

### 1.7 COULD NOT REPRODUCE — V3-0.23, suite decidability

This matters more than any other verdict, because the entire critical path is parked behind
this row. I ran the full suite three times and got a decidable triple every time — the
counts are in the `verify-count:` field above, and they were identical in all three runs
with no failures:

| run | conditions | elapsed | outcome |
|---|---|---|---|
| 1 | fleet quiet (load 2.0) | 129s | decidable, exit 0, 23 lines of output |
| 2 | genuine fleet load — load 10.15, ten concurrent `bun test` processes, a landing walk in flight | 121s | decidable, exit 0, 23 lines |
| 3 | piped through `head -63` | 126s | decidable, exit 0 |

I also tried to manufacture the claimed symptom (exit 0 after roughly 63 lines with no
trailing triple) directly. A deadline below the runtime gives `Terminated` and exit 143 or
124 — a loud failure, not a false green. A `head` pipe does not truncate, because a green
suite only emits 23 lines in total.

Two further full-suite runs happened afterwards, driven by the completion guard itself when
it validated this report in a detached worktree at this SHA (154.83s and 122.53s). Both were
decidable with identical counts and no failures. **Five full-suite runs, five decidable
triples, zero truncations.**

So: **I could not reproduce the harness-level false green in any attempt.** What I can
state decidably is narrower and still actionable — the suite costs 121–129s, tightly
clustered, and barely moves under load (121s at load 10 was *faster* than 129s at load 2,
so the dominant cost is not CPU contention). The workboard's own numbers (126s and 133s
quiet, 115.19s at twelve workers) agree. That means **any lane-side deadline at or below
about 130s kills a passing run**, which is exactly the OPEN-1 symptom the row records. On
this evidence the defect looks like a deadline set below the measured runtime, not a
non-deterministic suite.

Caveat, stated plainly: I deliberately did not pile twelve synthetic CPU hogs onto the
host, because a landing walk (`gate/land.sh --branch ag-dirty-tree`) was in flight and the
row's own thesis is that such load corrupts other lanes' results. My first attempt at
synthetic load also killed my own shell (`pkill -f` matched the harness's own command
line, exit 144) — recorded because it is the same class of self-interference the row is
about. A heavier load than I could safely apply may still reproduce it.

**The recommendation this drives:** before spending another round on V3-0.23, re-measure
it. If the row is misdiagnosed, then V3-0.29 → V3-1.9 → V3-4.2 → cutover are all blocked
behind a phantom, and that is the single most expensive possible error in the current plan.

### 1.8 HOLDS at the gate, FAILS as an answer — V3-1.9's park

The brief states V3-1.9 is parked and only the operator can clear it. Asked directly, the
counter disagrees:

```
$ bun gate/review-rounds.ts check --state "$(git rev-parse --git-common-dir)/bpa-review-rounds.json" --item-id V3-1.9
REVIEW_ROUNDS status=admissible item=V3-1.9 round=0    exit=0
```

V3-1.9 is absent from the local cache *and* from the durable
`origin/main:.bpa/review-rounds.json`. It was wiped by a later landing: `gate/land.sh:221`
does `rm -f "$review_round_state"` and rebuilds the cache from the target branch, which
only ever records items that *landed*.

The park is nonetheless real, because it is reconstructed from the durable attempt refs.
V3-1.9 has three attempt refs and three mirrors on origin. Replaying them exactly as
`gate/land.sh:264-281` does:

```
replay 1 → REVIEW_ROUNDS status=pass round=1 no_progress=1
replay 2 → REVIEW_ROUNDS status=pass round=2 no_progress=2
replay 3 → REVIEW_ROUNDS status=pass round=3 no_progress=3
gate's own attempt (land.sh:305) → REVIEW_ROUNDS status=fail detail=item=V3-1.9 parked=no-progress   exit=2
```

So the mechanism is sound: **the park survives a wiped cache, and the design claim holds.**
The defect is that it is invisible outside a landing attempt. This is not cosmetic — it is
what produced V3-0.32. That row states that six live items "all report `admissible
round=0`" after between one and three rejections each. I reproduced all six. The reading is
right but the inference is unsafe: `check` reports the cache, not the reconstructed truth.
V3-0.32's underlying complaint (a rejection charges no round) is still correct — all six
have zero attempt refs despite documented rejections — but anyone using `check` as a status
query is reading an answer that is wrong for precisely the items that matter most.

### 1.9 DOES NOT HOLD — V3-0.30, board reconciliation, live recurrence today

V3-0.20 landed. Its tip is on main and the counter records it:

```
$ git merge-base --is-ancestor 5702f995f990634417eb362539bc0fa2c0571107 origin/main → YES
origin/main:.bpa/review-rounds.json → "V3-0.20": landedSha 5702f995…, park null
```

The workboard still says:

> **in flight** — round 1 (`5a2bc9e`, `ag-s10-3`) REJECTed on evidence… Round 2 running as `ag-s10-3-r2`.

Three sources, three answers, again — and the dispatch brief for *this* review names the
landing ("One landing today: V3-0.20 at `cd0b1c3`"), so the information was in hand and the
row still was not closed. This is the third recorded instance, and it happened while the
row to fix it was in flight. The board arithmetic inherits it: 69 rows, 32 marked `done`,
and at least 33 have landed.

### 1.10 DOES NOT HOLD — V3-0.31, the report has two names

Still live, still unlanded, and it applies to this review.
`orchestrator/fleet/launch-lane.sh:77` derives `report="$lanes_dir/$name.report.md"` and
exports it as `LANE_REPORT_PATH` (`:135`), which the guard checks at `:165`. For this lane
that is `fable-global-review.report.md`, while the branch is `ag-fable-global-review` —
and `ag-fable-global-review.report.md` does not exist. My brief told me to write
`$LANE_REPORT_PATH`, which is the correct fix direction, but the fix is prose in one brief,
not a mechanism. Any brief written from memory reintroduces it.

### 1.11 Present, not executed by me — V3-0.21, the gate's rebuild-proof trigger

`gate/land.sh:355-396` really does compute `meteorite_required` and call
`land_run_meteorite`, with rollback on failure. The structural half exists as claimed. I
did not execute it (see §5).

### 1.12 HOLDS, and is the strongest thing in the repository — the review process

I had all 73 `*.review.md` artifacts audited in full (6,385 lines). `reviewed-sha:` is
present in every one of the 73; `independence:` likewise in every one. Of roughly 630
findings, about 520 carry executed evidence. There are 24 ACCEPT verdicts and 49 that are
REJECT or NO-GO. Per-finding closed/moved/open disposition is genuinely applied in 62 of
the 73 — the eleven that lack it all predate the rule landing in `ag-s6-22`, so the rule
was adopted rather than echoed.

**No ACCEPT with zero executed evidence, and no cosmetic REJECT.** Reviews repeatedly kill
things the tests called green, by running an attack rather than describing one:
`ag-s9-20.review.md` deleted a checker and its manifest row together and got
`MECHANISM-REACHABILITY clean, exit 0`; `ag-s7-2.review.md` changed one variable and
recorded a false green where the lock should have gone red; `ag-s10-1.review.md` measured a
failing test against an all-green claim and found the verify line printed hard-coded
counts.

The one case where the process visibly failed is worth naming, because it is the pattern:
`ag-s6-23.review.md` closed "irreversible deletion is ownership-guarded" on a fixture that
used a deliberately different UID; `ag-s10-7-r2.review.md` later executed the real path and
got `T4_ACCOUNT=DELETED / T4_DATA=DESTROYED`. The finding was closed by evidence one step
away from the claim — the same shape as §1.2. Residual weakness: "no assertion was deleted"
and "this finding is closed" are still commonly settled by reading a diff, and
`ag-s5-3-r2` waved through an actually-deleted test file that way.

### 1.13 HOLDS — the completion guard accepts this report

Run against this file at this SHA: `report-shape`, `commit-exists`, `branch-tip`, `result
clean`, `secret-scan clean`, `verify present`, `verify-run`, `working-tree clean` all pass.
It also correctly rejected an earlier draft of this report with `FAIL verify-count
test-count-claim-must-use-verify-count-field` — the anti-fabrication control working on the
reviewer, which is the right direction for it to work in.

### 1.14 HOLDS — canonical secret scan

Pattern extracted from `gate/land-lib.sh` (length 200), applied to `origin/main...HEAD` and
to this artifact: no hits.

### 1.15 DOES NOT HOLD — a piped `verify:` command turns the lane-exit guard green on a red check

Found while getting *this* report through the guard, which is the only reason I found it —
it is not on the board.

`gate/completion-guard.ts:131` runs the lane's `verify:` command with
`spawnSync(command, { shell: true })`. A shell pipeline exits with the status of its **last**
command, so any `verify:` line ending in a pipe reports success no matter what the real
check did. Proven with a report identical to this one except for the `verify:` line:

```
  verify: exit 1 | cat   →  PASS verify-run tail=(no output)   GUARD verdict=pass       exit=0
  verify: exit 1         →  FAIL verify-run exit=1             GUARD verdict=violation  exit=2
```

`verify-count:` would catch it — but that field is **optional**, and the guard only compares
when it is present. So `verify: bun test | tail -3`, with no `verify-count`, yields a green
completion guard on a failing suite.

The two defects compose, which is what makes this more than a curiosity.
`parseVerificationCount` (`:116-117`) requires the summary lines to be anchored at column 1
(`/^([0-9]+) pass$/`), and Bun indents them by one space. So `verify: bun test` can *never*
satisfy `verify-count:` — the guard rejected my own first attempt with
`FAIL verify-count command-output-missing-unambiguous-pass/fail-count` after running the
suite successfully. The natural fix an author reaches for is to pipe through `sed` or `awk`
to strip the indent — which is exactly the construction that silently discards the exit code.
**The control that would catch the hole pushes authors into the hole.**

Scope, stated carefully so this is not overclaimed. `gate/lane-exit.sh:67` invokes the guard
**without** `--defer-verify`, so the lane-exit path — the choke point V3-0.17 and V3-0.5 were
built to create — is fooled: a lane can terminate `state: terminal` on a red suite. The
landing path is *not* trivially fooled, because `gate/land.sh:285` passes `--defer-verify`
when `--run-verify` is set and `land.sh:403` runs `land_run_declared_checks` with a
gate-owned baseline count (V3-0.25's fix). So this is a lane-exit false green, not yet a
demonstrated landing false green — but the lane-exit guard is precisely the mechanism whose
entire purpose is that work without evidence cannot be recorded as done.

The correct form, which this report's own `verify:` line now uses, preserves the exit code
and unindents in one step:
`env -u BUN_BIN bash -c 'set -o pipefail; bun test 2>&1 | sed -E "s/^ +//"'`.

### 1.16 COULD NOT VERIFY — the meteorite end to end. See §5.

---

## 2. Where progress is illusory

Ranked by how much confidence rests on the artifact versus the property.

1. **V3-0.28 is the load-bearing illusion.** It is marked `done`, it is green, it is in the
   landing tier, and it certifies as "reachable" two mechanisms that nothing runs plus one
   that an unrelated Whisper script vouches for. Worse than the individual gaps: the row's
   existence *retires the question*. Nobody will ask "which mechanisms have no executor?"
   again, because a green checker now answers it — wrongly. A wrong answer that closes an
   open question is more expensive than no answer at all.
2. **"Installed is not armed" is claimed and not implemented.** The workboard asserts the
   checker encodes it. It reads repository text and never touches the host, so it cannot
   detect the incident it was built from.
3. **The round counter's `check` command is a status query that is wrong for parked items.**
   The mechanism is right; the interface lies. V3-0.32 was filed partly on its output.
4. **The lane-exit guard can be turned green by a pipe** (§1.15). The mechanism V3-0.17 and
   V3-0.5 built to make "work without evidence cannot be recorded as done" structural
   accepts `verify: <anything> | tail -3` on a failing check. Not on the board.
5. **The workboard is not evidence.** V3-0.20 is the third instance; the count is off by at
   least one today, and this row's own fix was in flight while the defect recurred.
6. **`checker:github-ref-protection` reads as a control and is a stub.** Every test case is
   stubbed; live GitHub protection has never been measured. The row says so honestly
   (`implemented`, not `done`) — but the reachability checker overrides that honesty with a
   green.

---

## 3. What we have missed — rows that should exist and do not

In priority order. Each is absent from all 69 rows; I checked by keyword sweep over
`instance/workboard.md`.

1. **Backup and restore of state that is not in git.** Zero hits for "backup". The meteorite
   proves the *repository* rebuilds a host; it does not preserve the SQLite state DB,
   mission and lane history, or the durable evidence under `$XDG_STATE_HOME`. Hard Floor 5's
   own text requires host state that must not be in git to be *enumerated* — "not in git is
   never allowed to mean not written down" — and there is no such enumeration and no restore
   path. This is the largest gap and it sits directly under the operator's "reboot the whole
   machine" milestone: he can rebuild the machine and still lose the record of what it was
   doing.
2. **Credential provisioning and rotation as a written, verified procedure.** Zero hits for
   "rotation". Provider credentials are interactive by design and correctly excluded from
   git, but nothing enumerates what they are, where they go, what permissions they need, and
   the command that verifies each — which `reproducible-from-git` requires by name. On a
   rebuild this is the step that stops everything, and it is exactly where an untested
   runbook reads like a tested one.
3. **Provider quota exhaustion mid-lane.** V3-3.6 *displays* quota; nothing defines what
   happens when it reaches zero with lanes running. At a fleet of five to ten, a mid-flight
   exhaustion produces a wave of lanes that stop without terminal reports — which V3-0.37
   has now shown makes their committed work unlandable. Quota exhaustion is therefore a
   work-loss event, not an inconvenience.
4. **The operator being unavailable for a week.** Zero hits. V3-1.9 is parked pending an
   operator action; V3-1.7 awaits his restatement; V3-4.3 needs his explicit go. Three
   critical-path items block on one person with no defined timeout, fallback, or safe-idle
   behaviour. HR-2109's administrator bot improves *reachability*, not *absence*.
5. **The Telegram daemon as a single point of failure.** V3-4.1 proves it survives a
   restart; nothing covers the token being revoked, Telegram being unreachable, or the
   daemon wedging while the orchestrator is healthy. It is the only channel, and its
   supervision on this host is currently inactive.
6. **A mechanism-inventory diff against `v2-deprecated`.** The workboard's own closing
   section says this is still open — "Phase 1's list is a snapshot that can go stale the
   same way the ledger did" — and it has no row. The ledger got a checker; mechanisms did
   not.
7. **Disk and log growth.** Zero hits for "log rotation". Lane worktrees, container images,
   meteorite runs and per-lane logs all accumulate under `/root/.cache` and
   `$XDG_STATE_HOME` with no measured bound.

---

## 4. Recommended sprint sequence

The current critical path is V3-0.23 → V3-0.29 → unpark V3-1.9 → V3-1.9a/b → V3-4.2 →
V3-4.3. I would change the order at the front and add one row before anything else.

**Sprint A — re-measure before you build. Cheap, and it may delete work.**

- **A1. Re-measure V3-0.23 under controlled, reproducible load before writing more code for
  it.** My three runs were all decidable at 121–129s. If the real defect is a deadline below
  the runtime, the fix is a number and a `PIPESTATUS` check, not a concurrency redesign —
  and four blocked rows unblock immediately. *No dependencies. Highest expected value in the
  plan.*
- **A2. Reconcile the board by execution and close V3-0.20's row.** *Depends on nothing.*
  Until this is mechanical (V3-0.30), every dispatch decision is made from a document that
  is wrong today.

**Sprint B — repair the detector before trusting anything it certified.**

- **B1. Reopen V3-0.28.** Replace `text.includes(needle)` with an invocation test, exclude
  `*.test.*` from counting as an executor, and distinguish "a test drives this against the
  real repository" from "a test drives this against a fixture". Add a fail-before lock: the
  comment-only mutation in §1.2 must be red. *Depends on nothing. Blocks any claim that the
  executor class is closed.*
- **B2. Wire or exempt the two mechanisms B1 will expose** — `checker:shared-stash` (never
  run) and `checker:github-ref-protection` (stub-only, needs the credential decision).
  *Depends on B1.*
- **B1a. Close the piped-`verify:` hole (§1.15).** Run the verify command through
  `bash -o pipefail`, or reject a `verify:` line containing an unguarded pipe, and fix
  `parseVerificationCount` to tolerate leading whitespace so `verify-count:` works with the
  repository's own test command. Consider making `verify-count:` mandatory when
  `result: clean`. Fail-before evidence already exists: `verify: exit 1 | cat` must go red.
  *Depends on nothing. This is a Hard Floor 7 item and it is not on the board.*
- **B3. Give the round counter an honest status query** — make `check` and `round`
  reconstruct from attempt refs, or refuse to answer outside a landing. *Depends on nothing;
  it is what makes V3-0.32's evidence trustworthy.*

**Sprint C — the operator door. Unchanged in substance, re-ordered.**

- **C1. V3-0.29 round 3** — land the recording format. Its round-2 work already closed both
  attacks; it reported NO-GO only because the suite would not decide. *Depends on A1.*
- **C2. Unpark V3-1.9** on the decision already on record, then V3-1.9a and V3-1.9b.
  *Depends on C1.*
- **C3. V3-1.10** (administrator bot) becomes the authorised signer. *Depends on C2 —
  root-owned means nothing until lanes are non-root.*

**Sprint D — the gaps that are not on the board.**

- **D1. Enumerate every piece of non-git host state, with the command that verifies each**
  (§3.1, §3.2). This is a Hard Floor 5 obligation already written into
  `reproducible-from-git` and not discharged. *Depends on nothing; blocks V3-4.2 being
  meaningful.*
- **D2. State backup and restore**, proven by restoring into the meteorite container.
  *Depends on D1.*
- **D3. Quota exhaustion and operator-absence behaviour** (§3.3, §3.4). *Depends on B3 for
  the park semantics.*

**Sprint E — cutover.** V3-4.2 then V3-4.3, unchanged, on his explicit go. V3-4.2 should not
be attempted before D1 and D2, or it will prove a rebuild that loses the system's memory.

One sequencing warning: **V3-0.37 (lanes losing work by ending a turn mid-measurement) is a
multiplier on everything above.** Every sprint here contains a long measurement. Until it is
fixed, the most valuable rows are the most likely to be discarded, and the eight lanes it
hit today were not careless — they were the ones running the longest probes.

---

## 5. What I could not verify, and why

- **The meteorite end to end.** This is the biggest hole in my review. `meteorite/run.sh`
  requires `METEORITE_DONOR_REF` to match
  `^refs/meteorite-candidates/[0-9]+-[0-9]+-[0-9a-f]{40}/v2-deprecated$` (`:158`), which only
  `meteorite/prove-candidate.sh` can produce, and that wrapper **pushes two temporary refs to
  origin** (`:97`). My constraints forbid pushing refs, so I stopped. My attempt using the
  already-published `refs/heads/v2-deprecated` was correctly refused:
  `NO-GO input-validation: METEORITE_DONOR_REF has an unsupported shape`. I therefore have
  **no independent evidence about Hard Floor 5 at this SHA** — I can only report that the
  gate's trigger exists in code. Given that Hard Floor 5 regressed twice in one evening on
  2026-08-03, both times through a green landing, this gap should be closed by someone who is
  allowed to push, and it should be closed before V3-4.2.
- **V3-0.21's trigger in action.** Same reason: proving it requires a landing.
- **The gate's refusal paths, attacked directly.** I did not construct a hostile landing,
  because doing it against this repository risks mutating origin. Partial substitute: the
  shell tier pins `gate/land.test.sh`, `gate/meteorite-gate.test.sh`,
  `gate/land-target-branch.test.sh`, `gate/lane-exit.test.sh` and `gate/land-rollback.test.sh`,
  and all of them executed inside my green suite runs. So the refusal paths are exercised at
  every landing — but by their own authors' fixtures, and I added no adversarial case. The
  brief is right that a gate nobody has attacked has unknown strength; I did not change that.
- **V3-0.23's claimed harness-level false green.** Five full-suite runs, none reproduced it (§1.7). I
  could not safely apply the twelve-worker load its own measurement used, because a landing
  was in flight. Treat my result as "not reproduced under load at or below 10", not as "the
  row is wrong".
- **Whether host units are absent by policy or by drift.** HR-1720 defers host deployment, so
  I report the measurement (§1.2) without claiming it is a violation. Someone should decide
  which of those six units are supposed to be running here today.
- **Anything requiring a credential**: live GitHub ref protection, real Telegram transport,
  provider quota against a live API. I read no credential and touched no daemon.

---

## 6. One sentence, if only one is read

The review process works and should be trusted; the workboard should not; and V3-0.28 — the
row that certifies this repository no longer ships mechanisms nobody runs — currently
accepts a code comment as proof that a mechanism runs.
