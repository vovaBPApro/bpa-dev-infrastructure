# Consilium synthesis — the sprint to cutover, 2026-08-04 evening

Five members, four models plus a dedicated adversary, none seeing another's answer.
Verbatim reports are the sibling `-opus`, `-fable`, `-sonnet`, `-haiku`, `-adversary`
files. This file is the orchestrator's synthesis and its dispatchable programme.

Members were briefed with a "~10 lanes" assumption. **HR-2342 capped parallelism at
three** mid-flight; the two still running were corrected, the three already finished
were not. Their lane-hour arithmetic is stale where it assumes ten. Their reasoning is
not, and it is the reasoning that is used here.

## The one paragraph

The previous consilium's answer — "fix the landing machinery before advancing the
chain" — is **not wrong, but it is no longer first**. It governs *throughput*. What was
discovered today governs *validity*: this system cannot currently be rebuilt from its own
repository, its autonomy loop is dead, and its test suite returns a different verdict
depending on which checkout runs it. Cutover is by definition "bring it up on a new
server from the repository" (HR-2335), so the capability the sprint exists to deliver is
precisely the one measured broken. Fix the instrument first, because every hour spent
before that is measured with a thermometer known to be wrong.

## What was verified today, and by whom

Every claim below was checked against git or the filesystem by the orchestrator before
entering this file. Claims from member reports that did **not** survive that check are
listed in the last section rather than silently dropped.

| finding | status |
|---|---|
| `orchestrator/launch.sh` calls `mission_cli reap` / `lease …`; `core/mission-cli.ts` implements neither (vocabulary is `mission\|manager\|lane\|outbox\|status`) | verified |
| `orchestrator/preflight-cli-auth.sh` required by the launcher, **absent from `HEAD`** (last alive `75411d9`) | verified |
| Both worked around only in `orchestrator/runtime.env`, which is **gitignored** — so the running orchestrator is not reproducible from git | verified |
| Six branches carrying **five ACCEPTed rows** existed only in `/root/.cache/infra-lanes` clones — absent from the primary object store and from all 31 origin heads | verified; **fixed** — scanned and pushed, now 37 heads |
| `orch-fleet-nudge` failing every 10 min since ~17:53 (`refusing to run with an unparseable workboard`) — the autonomy loop is dead | verified |
| The canonical repo sat checked out on **`v2-deprecated` for 29 hours** (08-03 12:40:46 → 08-04 17:52:39) | verified via reflog |
| `main`'s suite is **red**: 599 pass / 1 fail, exit 1 — `compose.test.ts` "real repo check --strict is clean" | verified by direct run |
| The cause is 176 untriaged operator messages in `instance/decisions/inbox.jsonl` — **713 rows, gitignored** | verified |
| That file is **absent from every lane worktree and from `land-main`**, the clone the landing gate runs the suite from | verified |
| V3-2.9's work is intact and landable: patch-id identical to the ACCEPTed content, `GUARD verdict=pass`, exit 0, 660/0 in a fresh checkout | verified |

## The finding that reorders everything

`gate/land.sh` runs the suite from `land-main`. `inbox.jsonl` does not exist there. So the
ledger check has nothing to check and passes trivially — while the same check in the
primary repo fails 176 times.

**The suite is green everywhere it is run and red only where it is true.** Today's green
landings were, on this check, not green; they were unlooked-at. That is a false green,
which Hard Floor 7 forbids by name.

It is the third instance of one class, and the class is what matters more than the bug:
V3-2.8 (a landing-gate test whose verdict depends on mutable host state), V3-0.24 (a
verifier running a different version of the mechanism than the artifact under test), and
now this. In all three, **the measurement depends on where it is taken**. A control plane
whose instrument is checkout-dependent cannot certify its own cutover, which is the whole
job.

## Where the members disagreed, and the ruling

- **haiku, fable** — restore Hard Floor 5 first, then the landing machinery.
- **sonnet** — the binding constraint is one non-blocking `flock` in `gate/land.sh`
  composed with SHA-pinned review artifacts; land the free backlog first, harden the
  lock, run the launcher fix as a parallel track.
- **opus** — the system has no working measurement of its own state; all three of the
  day's worst discoveries were found by a person looking, not by a gate. Launcher and
  measurement govern validity; landing machinery governs throughput.
- **adversary** — the sprint **cannot** reach cutover as currently defined. Measured from
  the system's own `fleet-nudge.log` (107 samples), mean concurrency today was 2.42 lanes
  and `floor=10` was met zero times in 483 firings, so the 170–230 lane-hour estimate was
  converted against a denominator that never existed. At three lanes the sprint buys
  30–36 lane-hours ≈ 13–21% of the road, closing 4–6 rows against a measured filing rate
  of 32/day. **The board will be longer at hour 12, not shorter.**

**Ruling: the adversary is right about the arithmetic, and opus is right about the
cause.** The sprint's goal is therefore changed rather than the sprint being abandoned.
It is not "get close to cutover" — that is not purchasable in 10–12 hours at three lanes,
and planning against it would be planning against a number that does not exist. It is:

> **Make cutover-readiness decidable, and close the three defects that make the current
> answer "no".**

That is purchasable in the window, and it converts an unbounded question into a checklist
the operator can run himself.

## Definition of cutover-ready (the part nobody had written)

Cutover-ready means every one of these exits 0, from a clean clone, with no file from
this host. `UNKNOWN` is not green.

- **A.** A clean clone of `main` at the cutover SHA starts the orchestrator, with
  `orchestrator/runtime.env` renamed away — no break-glass, no `/root/oldorch-breakglass/`.
- **B.** Every path the launcher requires exists in the tree; a test fails if any
  required path is absent.
- **C.** The caller/callee vocabulary agrees — no script calls a `mission-cli` action
  that is not implemented.
- **D.** The meteorite **starts** the orchestrator in the container and asserts it reaches
  a live state, rather than asserting that files copied.
- **E.** The suite returns the same verdict in the primary repo, a lane worktree and
  `land-main`; any check whose inputs are absent reports `UNKNOWN`, never `PASS`.
- **F.** Every piece of non-git host state is enumerated with the command that verifies
  it, and no ACCEPTed work exists only on this host.
- **G.** The runtime models the product depends on come up on the clean server — Whisper
  first, since speech-to-text is on the operator's path every day.

F is currently *closer* than it was this morning: the six stranded branches are pushed.

**G was added after this file was first written**, and not by a consilium member. It came
out of triaging the operator's inbox on his instruction: message 1760 (2026-08-03) says
the clean server must bring Whisper up — *"сервак буде чистий і пустий. мені треба, щоб
все працювало як слід"* — and message 1767 asks, in his words, for an analysis to find
**other** requirements missed the same way, because Whisper was in the requirements and
implemented on both v2 and v3 and was still overlooked.

Both had sat untriaged for two days. That is worth stating plainly: a definition of
cutover-readiness written by five independent members, from the tracked record, missed a
requirement the operator had already given directly — because the place his words land is
not part of the tracked record the members read. **Running the 1767 analysis is therefore
in the programme, at Wave 2**, since the honest assumption is that Whisper is not the only
one.

## The programme — 3 lanes, 10–12 hours

A reviewer **is** a lane (opus). Three lanes therefore means at most two coder lanes with
one review slot, and a Tier-A row on HR-2166's escalated rung consumes two of the three.
Plan against that, not against three coders.

**Hour 0 — orchestrator, zero lanes** (done or doing now): stranded branches pushed;
incident and rulings recorded; this synthesis; `instance/cutover-readiness.md` carrying
gates A–F.

**Wave 1, hours 0–4** — *make HEAD startable and the instrument honest*
- **L1 (coder)** — Gates A/B/C. Restore `preflight-cli-auth.sh` as a tracked file;
  implement `reap` and `lease acquire|renew|release` in `core/mission-cli.ts`; add a
  launcher-path manifest test and a caller/callee vocabulary lock. The lock is the part
  that closes the class — neither side looked wrong alone. ~10–12 lane-hours.
- **L2 (coder)** — Gate E. A check whose inputs are absent must report `UNKNOWN`, not
  `PASS`; the inbox ledger must not silently pass in checkouts where the file does not
  exist. Enumerate the 176 untriaged rows; do not triage them in-lane. ~5–6 lane-hours.
- **L3** — review slot for L1 and L2, in that order.

**Wave 2, hours 4–8** — *close the class, restore autonomy*
- **L1 (coder)** — Gate D: the meteorite starts the orchestrator and asserts liveness.
  Needs its own HR-2224 budget exception or it aborts every landing. ~8–10 lane-hours.
- **L2 (coder)** — bring `/root/.local/bin/orch-fleet-nudge.sh` into git and fix its
  parser (120 lines; the parser is ~25 lines of awk expecting the old row shape). The
  small fix is the parser; the real work is that the script is host-only and would not
  survive the move at all. ~4–5 lane-hours.
- **L3** — review slot.

**Wave 3, hours 8–12** — *drain what is already finished, then measure*
- Orchestrator lands the verified backlog: V3-2.9 (`a0aa099`, re-attestation + meteorite
  needed), V3-0.55 under HR-2285, V3-0.43. Mostly orchestrator time, not lane time.
- **L1** — `tools/check-cutover-readiness.sh`, printing PASS/FAIL/**UNKNOWN** per gate.
- Re-run the hour-12 measurement below.

## What is deliberately cut, and the risk accepted

- **All non-root and privilege-separation work** — HR-2335 removes its premise. Branches
  and evidence retained, not reaped.
- **Most of sprint 05's machinery work**, including V3-0.47 and the `flock` hardening.
  This is the sharpest disagreement with sonnet, who is right that it governs cost. The
  risk accepted: landings stay expensive for another day. It loses to validity because an
  expensive correct landing beats a cheap uncertifiable one, and because at three lanes
  the compounding that justifies paying down that tax is roughly a third of what it was.
- **All V3-3.x features**, quota dashboards, operator-absence handling.
- **Triage of the 176 inbox rows** — enumerated this sprint, triaged next. Flagged for
  operator override: they are his messages, and he may rank them above everything here.
- **Branch/worktree breeding** (Hard Floor 12) — 141 lane worktrees. Nearest thing to a
  floor breach that is being consciously left; cutover makes most of it moot.

## The hour-12 measurement

Falsifiable, single command in spirit:

> Rename `orchestrator/runtime.env` away, clone `main` fresh into a clean container, and
> start the orchestrator. It comes up. The meteorite proves it, not a human.

Plus: gates A–F each report PASS or FAIL rather than UNKNOWN; the suite returns an
identical verdict from all three checkout kinds; sprint landings ≥ sprint filings.

If at hour 12 the answer to the rename test is still "no", the sprint failed regardless of
how many rows closed — and that is the point of defining it this way.

## Member claims that did not survive checking

Recorded because a consilium that only reports its hits is not evidence.

- **haiku** — "the meteorite proof is parked with three blocking findings and one real run
  showing 17 failures." V3-1.5 is **done**, landed `133541c`, run end to end with
  `result: clean`; the 17 failures were the same morning and were closed by `787bb40` and
  `7a28088`. The park record is retained, which is normal practice, not an open park.
- **orchestrator's own, corrected mid-session** — the V3-2.9 lane's spurious `failed` was
  announced as a systemic wrong-repo bug. The wrong-repo failure mode is real and was
  reproduced, but it is **not** what hit that lane: the gate emitted no check steps at
  all, only a usage line, meaning it exited at argument validation. Which argument is
  still unknown; the launcher and gate are byte-identical across both clones and pass
  `--role` correctly. **Open, undiagnosed** — a lane failure not explicable from the
  artifacts the harness records is itself worth a row.
- A supporting tally of 59 failed / 36 valid lanes was produced by a grep that matched the
  word `FAIL` in report prose rather than gate output. The raw counts stand; the
  attribution was withdrawn.
