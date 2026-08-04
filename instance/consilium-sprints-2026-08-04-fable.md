commit: b5bfce04 (origin/main at time of writing; read-only lane, nothing committed)
verify: git -C /root/.cache/infra-lanes/consilium-sprints-fable log --oneline -1 origin/main
result: clean
secret-scan: clean (no changes produced; no credential read)
remaining: none — this report is the deliverable

# Consilium member (Fable) — sprints 05–07 and the road to cutover

## Manifest consumption check

- orchestrator-playbook  sha256:10dc2e7be7e2  # Orchestrator Playbook
- orchestrator-fallback  sha256:811f13bc3373  # Orchestrator Session Portability
- autonomy-and-capacity  sha256:18c43aaf7e14  # Autonomy and Capacity
- landing-and-merge  sha256:951d9781cffa  # Landing and Merge
- roles  sha256:cd4c40c4e640  # Roles
- instruction-layers  sha256:cd21f4ce0990  # Instruction Layers
- reproducible-from-git  sha256:822d9efe694b  # Reproducible From Git

## Evidence base — what I ran and read, so every number below is traceable

- `instance/workboard.md`, all 246 lines. My own counts: 85 `V3-` row lines; 23
  rows carry only three cells (no state column) by
  `awk -F'|' '/^\| V3-/ {print NF-2}'` — the board's own V3-0.43 figure of 25
  differs by two because unescaped pipes split some rows; both counts say the
  same thing: a quarter of the plan is unreadable for status.
- `git log origin/main --since="2026-08-04 00:00"`: **99 commits, of which 12 are
  `[ORCH] land lane`**, timestamped 00:20 → 10:49 local. This contradicts the
  briefing's "three rows landed" — see §4, it is my answer to "what the
  orchestrator is getting wrong".
- Sprint closes 01 and 03 (`instance/sprints/`): sprint 03 landed 14 rows in 4
  hours on 2026-08-03 evening, before the rebuild gate existed.
- Lane terminal reports read directly (not the board): V3-0.23 r3 `e063afb`
  clean; V3-0.29 r4 `eb82019` clean, one operator decision (F7) outstanding;
  V3-0.30 r5 `a5157ac` NO-GO awaiting Tier-A review; V3-0.40 `8833c92` clean;
  V3-0.28 `dc63527` clean awaiting landing; V3-2.9 `8c9d669` clean; V3-3.8
  `9ad908d` clean; V3-0.43 r2 still in progress.
- `instance/fable-global-review-2026-08-04.md` §§2–5, `instance/decisions/HR-2166.md`
  (the 3+2+2 ladder and its one-day trial window ending 2026-08-05 09:12 UTC),
  HR-2171, HR-2188, `instance/in-flight-2026-08-04.md`, sprint 04 plan.

## 0. Two framing decisions before any sprint

**Close sprint 04 first, then number the next one 05.** Sprint 04 was opened at
`1f81831` and never closed; every row it planned has since terminated (landed,
parked, or superseded). The close is an hour of orchestrator time and it is not
bureaucracy: the sprint closes are the only place this installation records
throughput as re-executed numbers, and the estimates below are built on exactly
those records. A plan whose own measuring instrument stopped being used cannot
ask the operator to trust its estimates.

**The believed chain to cutover is partly wrong, and the correction shortens it.**
The chain as stated: V3-0.23 → V3-0.29 → unpark V3-1.9 → V3-2.9 → V3-2.10 →
backup/restore proven → V3-4.1 → V3-4.2 → V3-4.3.

- **V3-0.23 does not gate the chain.** Its own round-3 lane states plainly: "the
  original harness-level false green did not reproduce, and I could not
  manufacture it" — the third independent party to fail (Fable review §1.7 five
  runs, round-2's reviewer, now the lane itself, under 3 concurrent suites plus
  8 busy workers at load 18). The row's remaining value is real (serialization,
  a watchdog that decides before its runner) and its r3 report is clean — land
  it — but nothing downstream should wait on it, and the rows "blocked by
  V3-0.23" are functionally unblocked already: V3-0.29 r4 produced a clean
  report while V3-0.23 was still open.
- **V3-2.9 is already substantially done** — its lane reports clean with the
  enumeration and a fail-closed drift check; what remains is the restore half,
  which belongs with V3-2.10/HR-2171. The chain document predates this.
- **V3-2.10's human latency is real and must be moved, not absorbed.** The row
  needs the operator to enumerate/verify credentials interactively. The correct
  response to unbounded human latency is to file the ask on day one and overlap
  it with fleet work — not to sequence it late, where it becomes the critical
  path exactly when everything else is finished. Same for HR-2171's Google
  Drive access, the V3-0.29 F7 disposition, and the V3-1.7 restatement. **All
  four asks should go to the operator at sprint 05 open, batched, via the async
  decision channel.**
- The Fable review's argument that V3-4.2 is meaningless before non-git state is
  enumerated and restorable is correct, and I adopt it: V3-4.2 sits after
  sprint 07, not before.

## 1. The three sprints

### Sprint 05 — "land what is finished, and stop the machinery from eating rounds"

**Goal in one sentence:** every clean report that exists today is landed or
carries a recorded refusal, and the four defects that measurably destroy rounds
and landings are fixed so later sprints run at full width.

**Rows — the landing queue (work already done, cost is review + gate only):**
V3-0.28 (`dc63527`), V3-0.40+V3-0.38 (`8833c92`), V3-2.9 (`8c9d669`), V3-3.8
(`9ad908d`), V3-0.23 r3 (`e063afb`) with an explicit orchestrator decision on
its +395 s landing-cost trade, V3-0.29 r4 (`eb82019`) after Tier-A review,
V3-0.30 r5 (`a5157ac`) after review, V3-0.43 r2 to completion.

**Rows — new coder work, all chosen because their cost is measured, not argued:**
- V3-0.44 — reviewer lanes: 14 of 14 report `failed`; half the fleet's status
  signal is dead. Cheap, restores what supervision and the nudge read.
- V3-0.31 — report has two names; already cost two review rounds (V3-0.16) and
  every lane launched before the note lands `state: failed`.
- V3-0.47 — bookkeeping pushes killed one ten-minute landing and stalled two
  more *today*. The round-4 lane already demonstrated the decidable
  content-neutrality test; this row is designed, it just needs building.
- V3-0.37 — eight lanes in one day lost committed work by ending mid-
  measurement. Every sprint below contains long measurements; the Fable review
  is right that this is a multiplier.

**Why these and not others:** nothing else on the board has per-day measured
cost. Gate-and-contract friction is currently taxing every row: two wasted
review rounds per naming collision, one aborted landing per bookkeeping push,
one lost lane per long measurement. Fixing the chain-advancing rows first while
this tax runs is paying it on every one of them.

**What it unblocks:** V3-0.29 landed → the operator's standing
`unpark_land` decision becomes executable → sprint 06. Also: trustworthy lane
states, reviews that cannot be discarded over field names, landings that
bookkeeping cannot abort.

**Estimate: 35–45 fleet-hours; ~1 working day of wall clock.** Assumption that
produces it: the eight queue rows average ≤2 further review rounds each
(defensible — six already carry clean reports and executed evidence), reviews
run in parallel on reviewer lanes (~40 min each), and the serialized gate stays
at ~15 min/landing (12 landings ≈ 3 h of lock time — this is the floor, which
is why V3-0.47 is in this sprint). If the V3-0.23 +395 s trade is accepted,
add ~1.5 h across the sprint's landings.

### Sprint 06 — "the operator door, then the privilege boundary"

**Goal in one sentence:** execute the operator's standing V3-1.9 decision and
land non-root lanes, and make the HR-2166 ladder mechanical instead of
orchestrator bookkeeping.

**Rows:** unpark V3-1.9 via the landed V3-0.29 mechanism citing HR-2149; land
the retained `ag-s8-3-r6` evidence where still valid; recut V3-1.9 on the
settled single-service-user model (the account exists — V3-1.9a landed
`48a59b3` — and the park record enumerates the exact locks round 3 deleted, so
the recut starts with its acceptance list written); V3-1.9b as
refuse-with-named-blocker, since `IPAddressDeny` is proven silently ineffective
under the user manager — confinement that cannot be had must be a visible
refusal, not a serialized lie; V3-0.32 + V3-0.41 (a rejection charges a round;
`check` reconstructs from attempt refs) — without these the 3+2+2 ladder's
position lives in the orchestrator's head, which HR-2166 itself names as the
thing to remove; V3-0.45 (the proving phase as mechanism) once 0.32/0.41 give
it a real counter. Mechanical Sonnet-tier filler if capacity allows: V3-0.33,
V3-0.46.

**Why these and not others:** V3-1.9 is the linchpin by the operator's own
design — HR-2109's administrator bot and "root-owned means nothing" both hang
off it — and it is the oldest operator decision still unexecuted. The round-
accounting pair is in this sprint because the HR-2166 trial verdict lands
2026-08-05 09:12 UTC, inside this sprint's window, and grading the trial with a
counter that cannot see rejections would be an unmeasured subject (Hard
Floor 7).

**What it unblocks:** Claude-provider lanes without `IS_SANDBOX=1` root
workarounds; V3-1.10 (administrator bot); V3-2.4's honest "structurally
impossible" scope; every future park/unpark without hand-counting.

**Estimate: 30–45 fleet-hours; 1.5–2 days wall.** Assumption: the V3-1.9 recut
reaches ACCEPT within the three standard rounds *because* the design questions
are settled and the lock list is written — its three failed rounds were all
pre-settlement. If it enters the ladder anyway, each further round is ~40 min
wall plus coder time on the raised model: add ~4 h per level. Guess flagged:
I cannot know round count in advance; the stated assumption is the estimate.

### Sprint 07 — "a rebuild that keeps its memory"

**Goal in one sentence:** the meteorite stops proving only the repository:
non-git state is backed up off-host hourly, restorable into the container, and
the credential path is a runbook someone has actually executed.

**Rows:** V3-2.10 (credential runbook — the operator's answers were requested
at sprint 05 open, so his latency has been running in parallel for days by
now); HR-2171 backup (file the row — it currently exists only as a decision:
hourly Google Drive backup, ~10 versions, restore-on-startup interview);
restore-into-meteorite proof (extends V3-2.9's enumeration into V3-4.2's
precondition); V3-4.1 round 2 — the round-1 REJECT was for proving a 30-line
fixture daemon instead of the production one, so the work is respecification,
not rescue; V3-1.1 stage 2 recut (bootstrap `render_units`/cron arming — V3-4.2
needs it); V3-1.3 container proof rides the same container work.

**Why these and not others:** everything here is an existing Hard Floor 5
obligation ("not in git is never allowed to mean not written down"), and the
Fable review ranked the state gap the largest on the board. Nothing in Phase 3
product features belongs here.

**What it unblocks:** V3-4.2 becomes meaningful rather than a rebuild that
loses the system's memory.

**Estimate: 25–35 fleet-hours; 2–4 days wall — wall is operator-latency-
dominated, not fleet-limited.** Assumption: operator turnaround ≤24 h per ask
*because the asks were filed at sprint 05 open*. If they were not front-loaded,
this sprint's wall clock is unbounded and that is the plan's own fault, not his.

## 2. The road to cutover, after sprint 07

**Sprint 08 — supervision armed:** V3-2.1 (unattended restart), V3-2.3 (drift
guard), V3-2.8 + V3-2.4 unpark (model pin, host-independent test), V3-4.4
(daemon failure modes beyond restart — decide first which units HR-1720 means
to be running on this host today), V3-1.12 (operator-absence bounded wait —
now cheap because V3-0.29's park semantics exist), V3-3.9 (quota exhaustion as
a detected event; its detector comes with HR-2188's recording). ~40–55
fleet-hours, ~2 days wall.

**Then V3-4.2** — clean-machine rehearsal including state restore — one day
including the fix cycle it will surface. **Then V3-4.3 on his explicit go.**

**Explicitly not cutover-blocking, and the operator should be asked to confirm
this list rather than have it assumed:** V3-3.1, V3-3.2, V3-3.3, V3-3.5, V3-3.7
(OCR), V3-3.10/HR-2188 (quota graph), V3-1.10 (admin bot — wanted, but the
manual Telegram channel exists), V3-1.11 (hardware negotiation), V3-0.36
(squash), V3-0.42, V3-1.7 (awaits his restatement by his own instruction).
These land after cutover on the same machinery. If he rules any of them
blocking, add its estimate to the total; that ruling is a product decision and
is legitimately his (CLAUDE.md rule 14).

**Total, and the honesty condition on it.** Sprints 05–08 plus rehearsal:
~130–185 fleet-hours; calendar **6–8 working days**, putting V3-4.3's go at
**2026-08-11 … 2026-08-13** — *conditional*, and I will not pretend otherwise:

1. **Discovery must decay.** The board grew 69→85 rows (+16) against 12
   landings on 2026-08-04 — net +4. An estimate that ignores this is fiction;
   equally, extrapolating it flat is fiction in the other direction, because
   ten of those sixteen rows came from a deliberate one-time outside audit.
   **The measurement that makes cutover dateable:** rows-filed vs rows-landed
   per day, published as two numbers in each sprint close. When closure exceeds
   discovery for two consecutive days, the remaining count divides honestly by
   the measured daily rate and the date above firms up; until then the date is
   a projection and must be reported as one.
2. The 23–25 no-state rows must be triaged in the sprint-04 close (most will
   re-derive to done or duplicate from landing evidence; any that re-derive to
   open add to the count above).
3. Operator turnaround ≤24 h on the four front-loaded asks.

If the operator wants one number today: **the truthful answer is "8 August is
impossible, 11–13 August is achievable if condition 1 is met, and condition 1
is measurable by 6 August."** He asked for the truth over a comfortable number;
that is the truth.

## 3. The risk most likely to break the plan, and its early detector

**The serialized landing-and-review pipeline saturating while the fleet
produces faster than the gate can accept.** Evidence, not intuition: at this
moment eight rows carry clean terminal reports while three landed all morning;
the gate holds its lock ~10–15 min per landing plus ~3m40s of meteorite when
rebuild paths are touched; V3-0.23's fix proposes +395 s more; HR-2166 adds up
to four extra rounds per hard row, with level 2 running the *expensive* model
on both sides; and V3-0.47 means the orchestrator's own bookkeeping competes
with the queue for the same ref. The failure mode is quiet: lanes keep
finishing, the queue ages, reviews go stale against a moving `main`
(V3-0.25's class), and throughput numbers still look busy because commits keep
happening. Discovery-outrunning-closure is the visible risk; this is the one
that would make it permanent.

**Early detector:** publish, in every sprint close, the median age from
`result: clean` in a lane report to `verdict=landed` — today I measure it in
hours; if that median grows sprint over sprint, the pipeline is saturating and
fleet width should be cut in favor of gate throughput (V3-0.47, batch landings,
and rejecting default-on additions to gate wall time) before any new row is
dispatched.

## 4. One thing the orchestrator is currently getting wrong

**It is measuring its own throughput on the wrong window, and the error is 4×
in the pessimistic direction — which corrupts the exact estimate the operator
asked for.** The consilium briefing states: "Landed today: V3-0.20, V3-0.15,
V3-1.9a. That is the real throughput number for a day at 5–8 concurrent
lanes: three rows landed." Ran against origin/main:
`git log --since="2026-08-04 00:00" --oneline | grep -c "land lane"` → **12**,
timestamped 00:20 → 10:49 (2e62608, 7c428e0, 58fc72d, 472df6b, ff152de,
4988dc4, 7cca908, 6125296, 1e4e0f2, cd0b1c3, c8e52f6, 48a59b3). "Three" counts
only the ~4 morning hours during which the orchestrator was simultaneously
absorbing the Fable review and filing ten rows — a denominator chosen at the
day's least representative stretch. An orchestrator whose own hard rule is
"report capacity as NUMBERS, not intent" fed the consilium a number off by a
factor of four; every member that inherits it will pad its sprint estimates
~4× and the operator will be told cutover is weeks away when the measured
cadence says days. (Second instance of the same shape, for the pattern file:
the briefing's chain still lists V3-0.23 as gating V3-0.29, when V3-0.29 r4
produced a clean report with V3-0.23 unlanded and V3-0.23's own lane has
refuted the gating premise. The board is not evidence; neither is the
briefing — the lane reports and origin/main are.)

## Where I am guessing, marked as required

- Review-round counts per future row: **guess**, bounded by the measured 1–5
  historical range; stated as assumptions inside each estimate.
- Discovery decay after the one-time audit spike: **guess**, testable within
  two days by the filed-vs-landed metric defined above.
- Operator turnaround ≤24 h: **guess** about a human; mitigated by
  front-loading, not by hoping.
- Fleet-hour figures assume the host stays CPU-bound at 5–6 effective lanes
  (V3-0.34's measurement); if V3-0.34 lands a derived budget sooner, re-divide
  wall clock by the new effective width.
