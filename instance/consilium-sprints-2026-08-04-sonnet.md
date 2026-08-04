# Consilium member report — Sonnet, 2026-08-04

Read-only. No commits, branches, landings, or pushes were made. Everything below is
based on: a full read of `instance/workboard.md` (245 lines, all 85 rows) at its
current on-disk state; `instance/fable-global-review-2026-08-04.md` in full;
`instance/decisions/HR-2166.md`, `HR-2171.md`, `HR-2188.md` in full;
`instance/sprints/sprint-04-2026-08-03.md`; `instance/params.yaml`; `git log
--oneline --since="2026-08-04 00:00" origin/main` (99 commits, 12 of them `land
lane`, with timestamps); `git worktree list` (132 worktrees); and
`systemctl list-units --all` filtered to lane units (9 active lane services at the
moment I looked, three of which are the three consilium read-only lanes including
this one — so ~6 real coder/reviewer lanes were running while I wrote this).
Where I could not verify something, I say "guess."

## Where I disagree with the frame I was handed

The chain in the brief (`V3-0.23 → V3-0.29 → unpark V3-1.9 → V3-2.9 → V3-2.10 →
meteorite → V3-4.1 → V3-4.2 → V3-4.3`) is close to right but understates a fourth
category of blocking work that isn't on that chain at all: **the evidence layer
itself is currently lying in at least six distinct, executed ways**, all found
today (V3-0.38, V3-0.40, V3-0.41, V3-0.43, V3-0.44, V3-0.47). None of these block
V3-0.23 or V3-1.9 directly. All of them mean that when a row elsewhere on the
chain reports `done`, the report is not fully trustworthy yet. I treat closing
these as Sprint 05, ahead of the chain's own next link, for a reason stated
plainly in the board's own text: of 73 review artifacts audited by the Fable
review, the process itself is sound (§1.12) — but the guard that turns a report
into a landed, trusted `done` has holes a sound review process cannot see,
because the holes are below the review, in the mechanical acceptance path.

## Sprint 05 — make "done" trustworthy again

**Goal, one sentence**: close the six evidence-layer holes found today so that a
`done` verdict from here on can be trusted without re-deriving it by hand.

**Rows**: V3-0.40 + V3-0.38 (one chain, the board says land them together — the
`verify:` pipe hole and the Bun-indent regex that pushes authors into it),
V3-0.44 (reviewer lanes report `failed` 14/14, so the fleet has no working
signal for half its own traffic), V3-0.41 (`check` answers `admissible round=0`
for a row that is genuinely parked, which is precisely wrong for the six items
that matter most), V3-0.43 (the workboard has no self-check — it already
silently absorbed a 66-line self-inflicted corruption once today; a lane is
already running against this, `ag-s11-3-r2`), V3-0.47 (the orchestrator's own
bookkeeping pushes aborted or forced a re-run of at least two landings today —
this is a self-inflicted cost, not a hostile one).

**Why these and not others**: every one was found by an outside reviewer (Fable)
or by the orchestrator itself, today, by execution rather than reading. Four of
the six are already "top of the queue" or in flight per the board's own words, so
dispatching the rest is finishing a start, not opening new fronts. None require
the operator. None require a design decision — every one already has a stated
fail-before reproduction in the board or the Fable review, which under HR-2166's
own logic (every rejection recorded so far was for missing evidence, not a wrong
idea) means these should clear fast.

**What it unblocks**: HR-2166's escalation ladder becomes a real mechanism
instead of orchestrator bookkeeping — the board says this outright: V3-0.32,
V3-0.41 and V3-0.44 are named as the three things that must land before "the
ladder's position is orchestrator bookkeeping" stops being true. It also makes
V3-0.30's board-reconciliation fix worth something (a board that can still
silently duplicate its own header, per V3-0.43, is not evidence regardless of
what V3-0.30 does to it).

**Estimate: 4–5 hours wall clock, ≈25–30 lane-hours.** Assumption: these six
items behave like today's narrowly-scoped, fail-before-driven fixes (V3-0.21,
V3-0.25, V3-0.27 — each closed in 1–3 rounds, not the harder V3-0.29-style
design fights), so I assume **2 rounds average** at ~35 minutes/round (the
number given in the brief), run mostly in parallel across ~5 lanes, but
landing is serialized (`landing-and-merge.md`: "Landing is serialized on the
canonical tree") — I add ~20 minutes of queued gate time per row for that
serialization. This is a genuinely different assumption from Fable's implicit
one; if any of these six turns out to be a design fight instead of a proof
fight (V3-0.29 looked like a proof fight at round 3 and turned out to need a
redesign at round 4), the estimate roughly doubles for that row alone.

## Sprint 06 — clear the operator-gated chain without cutting corners on it

**Goal, one sentence**: land the mechanism that lets the operator release his own
park (V3-0.29), then spend it on V3-1.9, without treating V3-0.29's round-3
findings as bureaucracy — they are real security holes in the gate's trust
boundary.

**Rows**: V3-0.29 (currently round 4, `ag-s10-1-r4`), V3-1.9 unpark once V3-0.29
lands, V3-1.9b (live Claude/Codex proof under the non-root model), V3-0.46 (the
reaper is correct and frees nothing because every branch is pinned by a
worktree nobody releases on non-landing exit — 108 branches, 120 worktrees
measured today, growing roughly two per row in flight), V3-2.10 (credential
runbook — the Drive service-account key already exists per HR-2171's
correction, so this is mostly writing down what's already true plus a
verification command, not new provisioning).

**Why these and not others**: V3-0.29 is not cosmetic. Its round-3 review found
four **blocking** findings, all executed, not argued: a lane can self-author its
own unpark with one local `git update-ref` because the trust root resolves a
local ref shared by ~90 worktrees; an aborted landing strands the authorized
decision forever because both authorities run after the attempt-ref replay
loop's own early exit; `-c core.quotepath=false` is missing so a quoted decision
filename is never checked; and one bad decision file on `main` bricks the gate
for every item with no repair path. These are exactly the shape of bug that, if
shipped, would let a compromised or buggy lane forge its own park release — I
would not accept a fast round-4 fix that only patches the reproduction case
without re-deriving the trust root. V3-0.46 matters because 108 unreapable
branches today, growing at roughly two per landed row, is not a rounding error —
at the current rate it reaches several hundred before Sprint 07 finishes, and
`hygiene/reap.sh` cannot free them until a non-landing terminal state also
releases the worktree.

**What it unblocks**: V3-1.10 (the administrator bot, the operator's own stated
recovery path for a wedged orchestrator, "without touching the machine") is
flatly gated on V3-1.9 ("root-owned means nothing until lanes are non-root," in
the board's own words). It also removes the single highest-review-cost item
currently on the board — three ACCEPTs already earned by V3-1.9's underlying
work, sitting idle because of a mechanism gap, not a code gap.

**Estimate: 5–7 hours wall clock if V3-0.29 clears on the HR-2166 ladder's
level 2 (raised model both sides), open-ended by hours-to-days if it does
not.** Assumption: V3-0.29 needs 2 more rounds at the escalated tier (~45–60
min/round, slower model, real security re-derivation, not just a patch) ≈ 2
hours critical path; V3-1.9 unpark + V3-1.9b ≈ 1.5 hours once the mechanism
exists; V3-0.46 ≈ 1 hour (similar shape to V3-2.7); V3-2.10 ≈ 1.5 hours to
draft and prove against a fixture identity, **excluding operator round-trip
time for anything that still needs his hand** — on today's evidence (HR-1962's
provisioning question was answered within the same working session) I'd guess
that's hours, not days, but I have one data point and I flag it as a guess.

## Sprint 07 — non-git state, so a rebuild doesn't erase the system's memory

**Goal, one sentence**: give Hard Floor 5 the enumeration and backup/restore path
it has always required in text (`reproducible-from-git.md`: "not in git is never
allowed to mean not written down") and never had in practice, now that the
operator has put numbers on it (HR-2171).

**Rows**: V3-2.9 (already in flight, `ag-s11-4` — enumerate non-git state with a
verification command per item), the backup/restore mechanism HR-2171 actually
specifies (5-minute cadence to Google Drive via the already-provisioned
`bpa-dev-orch@bpapro-agents.iam.gserviceaccount.com` service account, rotate the
last 10 versions, restore proven inside the meteorite container), V3-0.42 (the
mechanism-inventory-diff checker — same drift class the ledger already has a
checker for, and it is the direct, generalized fix for the specific failure
V3-0.28 was reopened over today), V3-1.12 (bounded wait / safe-idle behavior for
a row blocked on the operator, since three critical-path rows — V3-1.9,
V3-1.7, V3-4.3 — all share this single point of failure and none of them has a
defined timeout today).

**Why these and not others**: this is the Fable review's own top-ranked gap
("the largest gap on the board... he can rebuild the machine and still lose the
record of what it was doing"), and unlike most of the Fable review's §3 list it
now carries an operator ruling with concrete numbers attached (HR-2171) rather
than being an open question — which under Hard Rule 14/15 makes it the
orchestrator's job to build, not to ask about.

**What it unblocks**: V3-4.2 stops being a rehearsal that discards the system's
memory. The operator's own words in HR-2171 describe V3-4.2's real acceptance
criterion better than the board's current one-line acceptance does: startup
should be able to *ask* whether backup files exist and restore from them, not
just prove the repository clones and boots empty.

**Estimate: 5–6 hours wall clock, ≈20–22 lane-hours.** Assumption: V3-2.9 is
close to done (~1 hour remaining, already running). The backup/restore path
touches a live external API and Hard Rule 11 requires runtime evidence for
that, not a stub — I assume 2–3 rounds (~2–2.5 hours) plus a separate restore-
into-meteorite-container proof (~40 minutes, similar order to V3-2.7). V3-0.42
≈ 1 hour (it is structurally the same checker as the ledger-drift one it is
modeled on, which took one row to build). V3-1.12 is a genuine design row — what
counts as "safe idle" for a blocked mission is a judgment call, not just a
proof — I assume at least 2 rounds (~1.5 hours) and flag that the actual bounded-
wait number (an hour? a day?) is a **guess** with zero evidence behind it either
way; it may need an explicit operator ruling rather than an orchestrator
invention, given Hard Rule 16 (preserve Human words that define work) and the
pattern today of the operator correcting invented numbers (the two-tier
retention HR-2171 amendment, rejected as "navisco you complicate this").

## The road to cutover, and why I will not give it one total

**After sprint 07**: V3-4.1 needs a recut (round 1 was rejected because the proof
restarted a 30-line fixture daemon instead of the production one — a real gap,
not a technicality; assume 2 rounds, ~1.5 hours). V3-4.2 becomes meaningful once
Sprint 07 lands; assume 1–2 hours to execute, **plus an unknown second pass**,
because Hard Floor 5 has already regressed twice in one evening through green
landings (V3-0.21's own history) — I budget for finding one more surprise, not
zero. V3-1.7 (the three-level agent hierarchy) is blocked purely on the operator
restating his own model; it has been open since 2026-08-03 with zero fleet-hours
spent and zero movement, and nothing in this repository can shorten that. V3-1.10
(admin bot) needs V3-1.9 (sprint 06) plus the operator setting up a second
Telegram bot and chat; guess under a day based on his response pattern today, but
it is a guess. Then V3-4.3: his explicit go, zero engineering hours, unknown
human-paced latency.

**I will not turn that into a number, and here is the measurement, not a
feeling, behind refusing to:** the workboard grew from 69 rows to 85 rows
today — a 23% increase — while 12 rows landed in the same window. That is
discovery outrunning closure on a day the fleet was fully staffed (00:20 to
10:49 UTC, twelve landings, roughly one every 50 minutes including review time).
Ten of the sixteen new rows came from a single Fable review that "took a couple
of hours." The newest row on the board, V3-0.43, was found by the orchestrator
"while filing the rows above" — meaning defects are still being discovered
*inside the act of recording other defects*, which is not a curve that has
started to flatten. Any total I gave you right now would be built by assuming
that curve bends downward starting tomorrow, and I have no evidence for that
assumption — the honest label for a number built that way is a guess wearing
arithmetic as a costume.

**What would make it dateable**: track filed-vs-landed rows per day explicitly —
the board cannot currently even reconcile itself against what landed (V3-0.30,
V3-0.43), let alone trend itself over time, so this doesn't exist yet and is
cheap to add (a few lines against the same git history I read to write this
report). Once that ratio holds below 1 (fewer new rows filed than closed) for
two or three consecutive days, a total stops being a guess. Separately, HR-2166's
own trial ends 2026-08-05 09:12 UTC with a pre-committed measurement (did the
proving-phase ladder help or "create more mess") — that verdict changes the
round economics for every hard row still ahead (V3-0.29, V3-4.1, and whatever
Sprint 07's backup mechanism turns out to need), so I would not commit to a
total before that verdict lands regardless of anything else.

## The risk most likely to break this plan

**The repository keeps re-discovering one generative defect and fixing each
instance as if it were new**, rather than fixing the thing that generates them.
V3-0.44's own text names this directly: "fourth instance in two days of one
class — a contract whose two halves were written separately and never executed
against each other." The instances on the board today are V3-0.16 (two report
contracts), V3-0.31 (report path has two names), V3-0.38 (the count regex versus
Bun's actual output), V3-0.39 (the review artifact field name), V3-0.40 (the
`verify:` pipe), and V3-0.44 (the reviewer contract) — six rows, six separate
review rounds, one root cause each time: something is specified in two places
(a brief and a checker, a launcher and a guard, a doc and a parser) and nothing
ever runs both halves against each other before a real lane hits the gap. Sprint
05 patches the current six instances. Nothing on the board yet stops a seventh
from appearing next week in a part of the gate nobody has stress-tested yet
(review artifact schema, workboard row schema, and the lane-report schema are
the three shapes I'd bet on next — guess). **Detection**: the same
filed-vs-landed tracker that would make cutover dateable would also show this —
tag each new row with whether it is forward progress on the plan or a defect in
the mechanism that measures the plan, and watch whether the second category's
share is shrinking. Today it is not: of the sixteen rows filed, roughly ten are
mechanism defects (V3-0.28 reopened, V3-0.30 through V3-0.47) and six are
forward progress or requirements (V3-1.11, V3-1.12, V3-2.9, V3-2.10, V3-3.9,
V3-3.10, V3-4.4) — mechanism defects outnumber forward progress on the busiest
day this project has had.

## One thing the orchestrator is currently getting wrong

**It is dispatching each new instance of the two-halves-never-executed-together
defect as an independent row at the same priority as forward-progress work,
instead of treating the pattern itself as the thing to fix.** This is not the
same claim as "Phase 0 isn't done" (which is also true, and which the board
already half-admits by calling V3-0.28 reopened) — it's a claim about triage.
Six rows, six review rounds, six lanes, when a single row — "enumerate every
declared two-sided contract in this repository (report shape, review-artifact
shape, verify-command shape, workboard-row shape, lane-exit-role shape) and add
one shared schema plus a round-trip test for each, instead of a parser per side"
— would very likely have caught at least four of today's six in one pass,
because they share the exact same shape the board's own text names four times.
This is not hindsight: V3-0.44's text says "fourth instance" *before* the fifth
and sixth (V3-0.40, and V3-0.44 itself counted once more) were filed, and
nothing changed in how the next one was handled. I would fold this into Sprint
05 as one row instead of the six separate ones I listed above, if I trusted a
single row to actually be scoped tightly enough not to become another V3-0.29 —
which is the real tension: generalizing too early risks a design fight where a
narrow proof fight would have worked, and that tension is exactly what HR-2166
was built to resolve for individual rows, not for a pattern across rows. My
actual recommendation, stated plainly rather than hedged: dispatch the six
narrow fixes as planned (Sprint 05 above, because they're already this far
along and stopping now to re-scope would waste the work), but file the
generalized "contract audit" as one new row *before* the seventh instance
appears rather than after, since the seventh is very likely already coming.
