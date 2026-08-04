# Consilium, fifth member — the adversarial read, 2026-08-04 evening

Mandate: attack the sprint, not ratify it. Everything below that is stated as fact was
executed against git or the filesystem in this session and the command is given. Where I
infer, I say **infer**. Where I guess, I say **guess**.

---

## Executive answer — the one paragraph

**The work that Sprint 05 is built to land is not in the repository, and a cutover
performed tomorrow would silently destroy it.** The five rows the handoff calls
"finished, ACCEPTed, blocked on paperwork" — V3-0.55, V3-2.9, V3-0.43, V3-0.28,
V3-0.47 — exist only as local branches inside per-lane *clones* under
`/root/.cache/infra-lanes/`. Four of the seven SHAs the handoff names
(`a0aa099`, `0fe08f0`, `33c11a0`, `fc148e5`) are **not on `origin` in any namespace and
are not objects in this repository at all**; the other three survive only incidentally,
as review-*attempt* refs pushed by the round counter — a bookkeeping mechanism, not a
backup. The only thing standing between that queue and deletion is the operator's ruling
"do not clean `/root/.cache`", which he made on 2026-08-02 for an entirely unrelated
reason. Nobody has filed this. It reframes the whole sprint: the consensus plan spends
10–12 hours improving a control plane whose in-flight output does not survive the move
the sprint exists to enable. And the arithmetic says the sprint cannot reach the stated
goal anyway — under the operator's new **3-lane cap** a 10–12 hour window buys at most
**30–36 lane-hours against a 170–230 lane-hour road: 13–21%**, and on this fleet's
*measured* behaviour (mean 2.42 concurrent lanes, n=107, the system's own instrument,
today) closer to **24–29 lane-hours: 11–17%**. The operator is planning against a number
that does not exist. My recommendation is not "work harder on Sprint 05" but **redefine
cutover-ready as reproducibility rather than board-completion** — a four-item set costing
13–26 lane-hours that fits the window and, as it happens, parallelises across exactly
three lanes.

---

## 1. Attack one — can a 10–12 hour sprint reach cutover readiness?

### 1.1 The arithmetic, using the system's own instrument

The consilium synthesis projects cutover at **170–230 lane-hours** with *zero new
discovery*, and converts that to wall clock "at six concurrent lanes and ~70%
utilisation" — an effective **4.2 lanes**.

That conversion factor was assumed, not measured. It is measurable. The fleet nudge
writes one line per firing to `/root/.cache/infra-lanes/fleet-nudge.log`, recording the
count of running lane units. This is the same counter that workboard row **V3-0.6** marks
**done** with the claim "the fleet counter reports truthfully". By the system's own
accepted instrument, today's distribution over 107 samples at 10-minute intervals:

```
running lanes:  0 → 18 samples
                1 → 32
                2 → 22
                3 →  6
                4 →  5
                5 → 10
                6 →  5
                7 →  7
                8 →  2
mean = 2.42     (n = 107)
```

`grep "^2026-08-04" /root/.cache/infra-lanes/fleet-nudge.log | sed -E 's/.*running=([0-9]+).*/\1/' | awk '{s+=$1;n++} END {print s/n, n}'`

The configured `floor=10` was met **zero times in 483 recorded firings**. The consilium's
4.2 effective lanes is **1.7× the observed mean**. The brief's "assume a fleet of up to
~10 lanes" is **4.1×** it.

Substituting the measured figure:

| assumption | effective lanes | 10–12 h buys | share of 170–230 |
|---|---|---|---|
| brief's original "~10 lanes" | 10 | 100–120 lane-h | 43–70% |
| consilium's 6 @ 70% | 4.2 | 42–50 lane-h | 18–29% |
| **operator's new cap of 3, fully utilised** | **3** | **30–36 lane-h** | **13–21%** |
| **measured, today** | **2.42** | **24–29 lane-h** | **11–17%** |

At the synthesis's own measured unit cost of **5.8 lane-hours per landed row**, 24–36
lane-hours is **4 to 6 rows landed**.

### 1.2 The second term nobody multiplies through

The 170–230 figure is explicitly conditioned on "zero new discovery". The measured
discovery rate is **32 rows filed against 10–12 closed in one day**. The sprint window is
approximately one working day. So the expected state at hour 12, extrapolating the only
data that exists, is:

- rows closed: **4–6** (at the 3-lane ceiling; 4–5 on measured behaviour)
- rows filed: on the order of **15–30** (the synthesis splits sources: ~15 from working,
  9 operator, 8 one-off audit; only the audit stream is non-recurring)

**The most likely single outcome of this sprint is that the board is longer at hour 12
than at hour 0.** That is not a rhetorical flourish; it is what the two measured rates
produce when multiplied.

### 1.3 The 3-lane cap — what it actually changes, and what it does not

The operator has capped the fleet at **3 parallel lanes**, deliberately, to move slower and
have fewer problems. Three things follow, and the second is counterintuitive.

**(a) It barely changes real throughput.** The fleet's measured mean today was **2.42**,
against an uncapped `floor=10` that was met **zero times in 483 firings**. The cap of 3
sits *above* the mean the system actually sustained. Distribution: 72 of 107 samples were
already at 0–2 lanes; only 21 exceeded 3. **The operator has capped something that was
already self-capping** — by CPU, by the orchestrator's serial attention, and by the serial
landing lock. His ruling costs him very little real velocity, and that is a point in its
favour: it is nearly free. This is the rare case where the safer choice is also the cheap
one, and he should be told that rather than being thanked for a sacrifice he did not make.

**(b) It demolishes the *plan's* arithmetic, not the *system's*.** The consilium converted
170–230 lane-hours to "4.5–6 working days" using 6 lanes at 70%. Under the cap that
conversion becomes **170–230 ÷ 3 ≈ 57–77 hours of wall clock at perfect utilisation, or
roughly 8–13 working days** — and at the measured 2.42, **70–95 hours, 10–16 working
days**. The road to cutover roughly **doubles in wall-clock length** the moment the cap is
applied, purely because the plan's denominator was fictional. Nothing about the system got
worse; the estimate got honest.

**(c) It makes Tier-A rows nearly fleet-monopolising.** HR-2166's middle rung raises the
model on **both** sides — "the lane gets further rounds … the same practice a product
coder follows", with a *new reviewer* alongside the coder. So one row at the escalated tier
occupies a coder lane **and** a reviewer lane: **2 of 3 lanes on a single row**. HR-2166
records that three rows are past the cap right now — V3-0.23 (round 3), V3-0.29 (round 4),
V3-0.30 (round 5). Under a 3-lane cap, **any one of those consumes two-thirds of the fleet,
and any two of them consume more fleet than exists.** V3-0.29 has run five rounds. A sprint
that schedules escalated Tier-A work under this cap is a sprint with one lane left over for
everything else.

Point (c) is the one that should change the programme. It is not an argument against the
cap — the cap is fine. It is an argument that **under the cap, the sprint must schedule
work that is cheap to review, and Sprint 05's queue is not that.**

### 1.4 Verdict on attack one

**It survives, and under the 3-lane cap it stops being an argument and becomes
arithmetic.** If "cutover-ready" means "sprints 05–08 are done", a 10–12 hour sprint
delivers **13–21% of it at the cap's ceiling and 11–17% on measured behaviour**, closing
4–6 rows while the measured filing rate opens 15–30, on a road that the cap itself has just
stretched to **8–16 working days**. The operator should be told this in one sentence,
without softening: *this sprint cannot get you to cutover, the cap you just set roughly
doubles the remaining wall clock, and no honest programme built on that definition of
cutover can say otherwise.*

I was asked to say plainly if the cap makes this overwhelming. It does — but I want to be
precise about *why*, because the obvious reading is wrong. The cap did not slow the system
down; the system was already running at 2.42. **The cap removed the plan's ability to
pretend otherwise.** The 170–230 estimate was always going to take 8–16 working days at
this fleet's real behaviour. What changed today is that the number on paper now matches
the number on the host.

But this is an attack on the **definition**, not on the operator's goal. Which is
attack two.

---

## 2. Attack two — is repairing this control plane with itself the cheapest path to V3
on a new server?

### 2.1 The conflation at the centre of the plan

The operator's cutover is: *move everything to a new server, bring it up there, run V3
with all features.* The consilium's 170–230 lane-hours is the cost of **finishing sprints
05–08** — the gate tax, the operator door, the machine's memory, the privilege boundary.

Those are not the same target. Cutover requires the control plane to be **reproducible**.
Sprints 05–08 make it **good**. A mediocre-but-reproducible system can be moved to a new
box this week. An excellent system that only starts via an untracked break-glass **cannot
be moved at all** — which is precisely today's state, and precisely what the incident
record says.

The consensus plan therefore spends 170–230 lane-hours at the *expensive* pre-cutover rate
in order to earn the right to move — when the operator's own premise is that
**development gets cheaper after the move**. If that premise is true, the plan has the
economics backwards: every hour of control-plane improvement done before cutover is
bought at the high price, to enable a move that would have lowered the price.

### 2.2 The narrower path, and its cost

The reproducibility set is small, enumerable, and *already diagnosed* — the incident
record names three of the four items itself. Verified state of each:

| # | item | verified evidence | est. lane-hours |
|---|---|---|---|
| R1 | Restore `orchestrator/preflight-cli-auth.sh` as tracked | `git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` → *does not exist in 'HEAD'*; absent from worktree. Alive at `75411d9` — this is a **recovery**, not a rewrite | 2–4 |
| R2 | Reconcile launcher ↔ CLI vocabulary | `launch.sh` calls `mission_cli reap` (l.466) and `lease acquire\|renew\|release` (ll.143,173,602,630,664); `core/mission-cli.ts:111` usage string is the whole contract: `mission \| manager \| lane \| outbox \| status`. Implements neither | 4–8 |
| R3 | Track the untracked host mechanisms | `/root/.local/bin/orch-fleet-nudge.sh` (5198 b, exists, not in git) + 3 more named in the handoff; `orchestrator/runtime.env` gitignored at `.gitignore:15` | 3–6 |
| R4 | Make the meteorite start the orchestrator | `grep -c "launch.sh" meteorite/run.sh meteorite/prove-candidate.sh` → **0 and 0**. The proof copies files; it never starts the thing | 4–8 |

**Total: 13–26 lane-hours.** The sprint buys 24–36. **The reproducibility set fits inside
this sprint. The consensus sprint does not fit inside this sprint.**

**And it is shaped like exactly three lanes.** This is not a coincidence I am dressing up;
it is a property of the dependency graph. R1 (restore a file from `75411d9`), R2 (reconcile
the launcher/CLI vocabulary) and R3 (track four host scripts) touch disjoint paths and have
no ordering constraint between them — **three lanes, in parallel, hour 0**. R4 (make the
meteorite start the orchestrator) consumes R1 and R2 and must follow them — **one lane,
second half**, with the other two free for review. None of R1–R4 is plausibly Tier-A
escalated work: R1 is a file recovery, R3 is `git add` plus a drift test, R2 and R4 are
bounded and have a written diagnosis already. So the set fits the cap's ceiling *and* stays
off the rung that eats two lanes per row.

Contrast Sprint 05 under the same cap: ~14 rows, several of them Tier-A, at least three
already past the review cap and therefore on the escalated rung at 2 lanes each. That
programme needs a fleet it no longer has.

R2 has a cheap variant worth naming: the break-glass already *proves* the pre-regression
start path works, by pointing `ORCH_STATE_DB` at an absent file so `state_available()`
is false. Making the launcher tolerate an unimplemented verb — or gating that block on the
CLI actually advertising it — is a smaller change than implementing lease semantics
against `DurableStore`, and it is the change that unblocks a new server. Full `reap`/
`lease` can be a post-cutover row. **I flag this as a design opinion, not a measurement.**

### 2.3 The honest counter-argument to my own attack

If the landing machinery is broken, R1–R4 cannot be *landed* either — so Sprint 05 is a
prerequisite, and my reordering is circular.

I checked this rather than assuming it. It does not hold:
`git log origin/main --since="2026-08-04 00:00" | grep -c "land lane"` → **15**. Landing
works. It is *expensive* (~5.8 lane-hours/row), not *broken*. Four reproducibility rows at
that price is ~23 lane-hours — inside the window. Thirty rows at that price is not.

The gate tax is real, and it is on the **throughput** critical path. It is only on the
**cutover** critical path if you intend to do another 170–230 lane-hours of work on this
host before moving. That intention is the thing I am attacking.

### 2.4 Verdict on attack two

**It survives, and the 3-lane cap strengthens it rather than weakening it.** The cheapest
path to a working V3 on a new server is not to keep repairing this control plane with
itself. It is to close the four-item reproducibility set, prove it by rebuilding *and
starting* in a container, move, and do the gate-tax work on the new box at the cheaper
rate. **This inverts the consensus ordering**: launcher and reproducibility first, landing
machinery second — not because the landing machinery does not matter, but because it is not
what blocks the move.

On the coordinator's specific question — *does self-hosting still beat a narrower path at
three lanes?* — **no, and the cap is what tips it.** Self-hosting's whole economic argument
is compounding: the orchestrator improves the orchestrator, so each fix pays for itself in
later throughput. That argument is a function of fleet width. At ten lanes, a fix to the
landing machinery is multiplied across ten concurrent consumers and repays quickly. At
three — where one escalated row already occupies two — the multiplier is roughly one, and
the compounding largely disappears. **A control plane that repairs itself three lanes at a
time is, economically, close to a control plane being repaired by hand.** What remains of
self-hosting under the cap is its *risk*, not its leverage: every self-repair still runs
through the same unstartable launcher, the same untracked break-glass, and the same landing
gate it is trying to fix. Narrow the path.

I am not arguing against self-hosting as a design. It is the repository's mission and it is
correct after cutover, on a box that can be rebuilt from git. I am arguing that **at width
3, on a host that cannot currently be rebuilt, self-hosting is paying the full price of the
mechanism and collecting almost none of its return.**

---

## 3. Attack three — the failure the others will miss

All four are reading the same tracked record. The record has been wrong repeatedly. Here
is what the filesystem and git say that the record does not. Four findings, none filed.

### F1 — Sprint 05's entire landing queue lives outside the repository (**critical**)

The handoff's table of five finished-and-ACCEPTed rows names a SHA for each. Checked
against this repository's object store and against every ref on `origin`:

| row | SHA | in repo object store? | on `origin`? |
|---|---|---|---|
| V3-2.9 (final, the in-flight lane's result) | `a0aa099` | **no** | **no — nowhere** |
| V3-2.9 (handoff's recorded SHA) | `0fe08f0` | **no** | **no — nowhere** |
| V3-2.9 (original) | `71d1105` | no | only as `refs/bpa-review-attempts/…` |
| V3-0.55 | `7c9c85f` | no | only as `refs/bpa-review-attempts/…` |
| V3-0.43 | `33c11a0` | **no** | **no — nowhere** |
| V3-0.28 | `bdc96a6` | no | only as `refs/bpa-review-attempts/…` |
| V3-0.47 | `fc148e5` | **no** | **no — nowhere** |

Commands: `git cat-file -t <sha>` → *could not get object info* for every row above.
`git ls-remote --heads origin` → **31 branches, not one of them an s10 or s11 lane**; the
newest lane branches on origin are `ag-s9-5-r3` / `ag-s9-6-r3`. `git ls-remote origin` →
100 refs total, of which 99 are `refs/bpa-review-attempts/*` and their mirrors.

Where the work actually is — verified by inspecting the clones directly:

```
/root/.cache/infra-lanes/v3-2.9-rebase-only        branch ag-s11-4-r6   a0aa099
/root/.cache/infra-lanes/v3-0.43-checker-rebase-r3 branch ag-s11-3-r3   33c11a0
/root/.cache/infra-lanes/v3-0.47-push-fence-r2     branch ag-s11-8-r2   fc148e5
/root/.cache/infra-lanes/v3-0.55-reattest-604      detached HEAD        7c9c85f
```

These are **separate clones with their own object stores** (they do not appear in
`git worktree list`, which shows 22 entries, all s3/s4). 1.8 GB of them.

Three consequences, none of them in the record:

1. **A cutover by cloning the repository loses this queue silently.** That is exactly what
   Hard Floor 5 and the meteorite proof promise as the move procedure.
2. **The queue's survival depends on an operator ruling made for an unrelated reason.**
   "Do not clean Docker or `/root/.cache`" (Telegram 2132/2134) was a resource-management
   instruction. It is currently the sole protection on five rows of independently ACCEPTed
   work. If that ruling were relaxed tomorrow as a cleanup, the loss would be invisible
   until someone tried to land.
3. **Three rows survive on `origin` only by accident.** `refs/bpa-review-attempts/*` is the
   round *counter's* durability mechanism. It happens to pin those SHAs. Treating a
   bookkeeping ref as the backup for accepted work is not a design, and V3-0.54 documents
   that the same namespace is already contended.

The handoff's own recovery instruction — *"If it died mid-turn again, its commits are
still on the branch — check before re-dispatching"* — is **false as written for this
repository**: `git for-each-ref | grep s11` returns nothing. A restarted orchestrator
following that sentence in the control-plane repo finds nothing and may conclude the work
is lost. It is not lost; it is in a clone the sentence does not name.

### F2 — the watchdog that would have caught today's outage was killed by today's recovery

The handoff states: *"`orch-fleet-nudge.timer` is **armed, root, firing every ten
minutes** … It is what drives the fleet nudges the orchestrator acts on."*

The **timer** is armed and firing. The **service** has been dead for the last ~30 minutes
of every 10-minute cycle since **17:53:52 today**:

```
● orch-fleet-nudge.service   Active: failed (Result: exit-code)
  orch-fleet-nudge.sh: fleet-nudge: no parseable workboard rows
  orch-fleet-nudge.sh: fleet-nudge: refusing to run with an unparseable workboard
  Main PID: … (code=exited, status=2)
```

It worked before that: `fleet-nudge.log` holds **483 successful firings, 107 of them
today, the last at `2026-08-04T17:43:49`**. So this is a regression with a timestamp.

**Cause, established from the reflog rather than guessed:**

```
eba098f HEAD@{08-04 17:52:58}: commit
e48b29a HEAD@{08-04 17:52:44}: pull --ff-only: Fast-forward
d4dee39 HEAD@{08-04 17:52:39}: checkout: moving from v2-deprecated to main
```

The nudge reads a fixed path, `/root/bpa-dev-infrastructure/instance/workboard.md`. Until
17:52:39 this repository's main worktree was checked out on **`v2-deprecated`**, so that
path held v2's **bullet-shaped** board (`- **ML-14 — …**`), which the script's awk parser
understands. Recovery checked out `main` at 17:52:39; `main`'s board is a **markdown
table**. The parser matches zero rows → `rows == 0` → fail-closed refusal, exit 2. The
board's mtime is `17:52:44`, matching the pull exactly.

Why this matters more than a broken cron:

The script's own logic (lines ~106) contains the branch
`notify "Оркестратор не запущений, а на дошці $open відкритих рядків. Потрібен
/start_codex або /start_claude."` — **this is the mechanism that tells the operator the
orchestrator has died.** The orchestrator died today. The one automated instrument that
would have paged him about the *next* death was disabled at 17:53 by the recovery that
fixed *this* one. Right now, if the orchestrator stops overnight, nothing notices and
nobody is told.

This is the same defect class as V3-0.43 ("the workboard row shape has no reader") and
V3-0.50 (two-sided contract, sides written separately) — but the affected reader is the
live autonomy safety net, and it is untracked, so no test in this repository can ever see
it. It is also a second, independent instance of the incident's own thesis: the meteorite
stayed green while the launcher was unstartable; the board checker will stay green while
the watchdog that reads the board is dead.

**F2b, corollary:** every one of today's 107 firings logged `open_rows=47`, unchanged all
day. That is v2-deprecated's row count. **The orchestrator's autonomy signal was derived
from the abandoned line's board for the entire working day.** Workboard V3-0.6 is marked
**done** on the strength of the *lane* count being truthful; the *row* count it fed the
orchestrator alongside it was from the wrong document.

### F3 — the incident record is not in the repository it indicts

`git log origin/main..HEAD` → `2c0499c [ORCH] record the launcher being unstartable from
git, and cover the env backup`. `git branch -r --contains 2c0499c` → **empty**. It is on no
remote.

That commit carries two things:

1. `instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md` — the only
   written record of the Hard Floor 5 breach. Per `reproducible-from-git.md`, "not in git
   is never allowed to mean not written down". It is written down *on one host's local
   branch*. If that host dies tonight — the scenario the document is about — the document
   dies with it.
2. The `.gitignore` fix widening `orchestrator/runtime.env` to `orchestrator/runtime.env.*`
   with a `!…example` negation. **On `origin`, that fix does not exist.** I verified
   `git show origin/main:.gitignore` still matches only the exact path. So on the shared
   remote, `orchestrator/runtime.env.bak-oldorch-20260804` — 1540 bytes, mode 0600, a copy
   of the break-glass env, present on disk — remains stageable by `git add -A`. That is
   live Hard Floor 4 exposure in the shared repository, closed locally and not published.
   (I did not open the file; policy classes it as secret-bearing and the constraint holds.)

Against the Report Contract — "the exact commit SHA; the command the Human can run to
verify it" — `2c0499c` is not fetchable by the Human. By the repository's own standard
that is `NO-GO`, not `clean`.

### F4 — the local view of `origin` is stale (minor, but it corrupts hygiene reasoning)

`git branch -r` shows **34** remote-tracking refs; `git ls-remote --heads origin` shows
**31** actual branches, and the sets differ. Several `origin/ag-*` refs name branches that
no longer exist remotely. Any branch-hygiene or Hard Floor 12 reasoning done against the
local remote-tracking view — which is the natural thing to do — is being done against a
stale picture. Related: 16 local branches are ancestors of `origin/main` and still alive,
15 pinned by worktrees (this part *is* filed, as V3-0.46).

---

## 4. What I would tell the operator, if he is wrong about what he is asking for

Plainly, in the order I would say it.

**1. You asked for a sprint that gets you "as close to cutover-ready as possible". You
will get 13–21% of the distance at best, and the board will be longer at the end than at
the start.** That is not pessimism, it is your own measured rates multiplied: 3 lanes ×
12 hours ÷ 5.8 lane-hours per row = 4–6 rows landed, against 32 filed yesterday. If the
plan you approve tomorrow implies otherwise, the plan is lying to you, and the number it is
lying with is the concurrency assumption — 6 lanes at 70%, which your own instrument says
has never happened.

**1b. Your 3-lane cap was nearly free, and you should know that.** Your fleet's measured
mean today was 2.42 lanes; the configured floor of 10 was met zero times in 483 firings.
You capped something that was already self-capping. You lose almost no velocity. What you
*did* do is remove the plan's ability to quote a fictional denominator: the road to cutover
was always 8–16 working days at this fleet's real behaviour, and now the estimate says so.
The one place the cap genuinely bites is the review ladder — HR-2166's escalated rung runs
a raised-model coder **and** a new reviewer, so a single Tier-A row eats two of your three
lanes. You have three rows sitting on that rung right now. **Do not schedule them this
sprint.**

**2. The definition is the bug, not the velocity.** You have been told cutover costs
170–230 lane-hours. That is the cost of making the control plane *good*. Cutover only
requires it to be *reproducible*. Those diverged the moment the launcher stopped starting
from git, and nobody has separated them since. Separate them and the sprint becomes
achievable: the reproducibility set is four items, 13–26 lane-hours, and it fits.

**3. Your instinct that "development gets easier after cutover" is an argument against the
plan you are about to approve.** If it is true, then pre-cutover lane-hours are the
expensive ones, and the consensus plan proposes spending 170–230 of them before moving.
Move earlier, at the lower quality bar that reproducibility actually requires, and buy the
gate-tax fixes at the post-cutover price.

**4. Do not cut over before F1 is closed, whatever else you decide.** Five rows of
finished, independently reviewed work are sitting in `/root/.cache/infra-lanes/` and in no
repository. A clean clone onto the new server loses them without a single error message.
This is a ~1 lane-hour fix — push the four branches — and it is the highest
value-per-minute item anywhere in this document. It should happen tonight, not in the
sprint.

**5. Where you are right, and I want to be explicit about it.** Stopping ordinary
development to look at the state was correct, and the evidence proves it: two of my four
findings (F1, F2) are things that broke *today* and that nobody detected, and one of them
was caused by the recovery itself. Your instinct that something was wrong was better
calibrated than the tracked record. Also right: refusing to spend this sprint on non-root
work, and refusing to take a date.

**6. Where I would push back on your framing itself.** "Move everything to a new server"
is the most expensive possible phrasing of what you want. *Everything* currently includes
1.8 GB of lane clones, ~123 worktrees' worth of history, four untracked host scripts, a
break-glass directory, and a state DB whose existence arms a launcher regression. The
version of this that succeeds is not a migration; it is a **clean rebuild from the
repository plus a named, tracked list of carried state** — which is what the meteorite
already almost does, and would fully do with R4. If you ask for "move everything", you
will get a host that boots and a control plane nobody can prove.

---

## 5. Where my attacks fail, stated honestly

An adversary who cannot say this is useless.

- **Sprint 05's diagnosis is correct.** Three independent members converged on it, and the
  receipts (V3-0.51's 120-second axe, V3-0.44's 14/14 false `failed`, V3-0.39's field-name
  loss) are real measurements. I am attacking its **priority and its budget**, not its
  content. Every row in it should be done. Not all of them before the move.
- **My R2 shortcut may be wrong.** Making the launcher tolerate an unimplemented verb could
  mask a real lease requirement under fleet concurrency. I marked it a design opinion. If a
  reviewer says lease semantics are load-bearing at concurrency >1, my 13–26 lane-hour
  estimate rises and my margin shrinks — though the measured concurrency of 2.42 argues the
  lease is not currently doing much.
- **My concurrency figure counts `lane-*` systemd units.** If lanes also run outside that
  unit pattern, 2.42 undercounts. I used it because it is the system's own instrument and
  because V3-0.6 is marked **done** on the claim that it reports truthfully — if it
  undercounts, that row is wrong and F2b gets worse. Either way the record has a defect.
  Note that the 3-lane cap makes this caveat mostly moot for planning: the ceiling is now
  3 by ruling, so the sprint budget is bounded at 30–36 lane-hours whatever the historical
  instrument says.
- **The cap did not change my conclusion, it sharpened it.** I want to be explicit that I
  did not manufacture a stronger finding to match the new constraint. My pre-cap figure was
  24–29 lane-hours from measured behaviour; the cap's ceiling is 30–36. Those overlap. The
  substantive changes the cap forced are two, and both are in attack two rather than attack
  one: the escalated review rung now costs two-thirds of the fleet per row (§1.3c), and
  self-hosting's compounding return largely vanishes at width 3 (§2.4). If the operator had
  set the cap at 6, attack one would read the same and attack two would be genuinely
  arguable.
- **F1 is a recoverability finding, not a data-loss finding.** The work exists. I checked
  the clones and read the branches. Nothing is lost *today*. The claim is that it is
  unprotected and does not travel — not that it is gone.
- **The 32-filed-vs-12-closed ratio is inflated by a one-time external audit** (8 rows) and
  by operator requirements (9), which are steering, not defects. The defect stream is ~15.
  A fair read is that the *defect* stream might invert within a sprint or two. My
  divergence argument is strongest for the next few days and weakens after that — which is
  itself an argument for moving sooner rather than later.

---

## 6. The measurement I would put at hour 12

Falsifiable, and none of it is a judgement call:

1. `git ls-remote --heads origin` contains a branch for each of the five stuck rows.
   *(Closes F1. Binary.)*
2. `git log origin/main..HEAD` is **empty** at session end, every session.
   *(Closes F3. Binary.)*
3. `git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` exits 0. *(R1. Binary.)*
4. `systemctl is-failed orch-fleet-nudge.service` reports `active`/inactive, not `failed`,
   for three consecutive firings; `fleet-nudge.log` shows an `open_rows` count that matches
   the v3 board. *(Closes F2 and F2b. Binary.)*
5. The meteorite runs `orchestrator/launch.sh start` inside the container and asserts a
   live state, with `ORCH_STATE_DB` pointed at a **present** DB so the regression is armed
   during the proof. *(R4 — and this is the one that turns the incident from a bug into a
   class. `grep -c "launch.sh" meteorite/run.sh` must stop returning 0.)*
6. `orchestrator/runtime.env` can be renamed away and the orchestrator still starts from a
   clean clone. **This is the actual cutover test**, and it is the only item on this list
   that, if green, means the operator can move.

If items 1–4 are green at hour 12, the sprint succeeded at the achievable goal. If item 6
is green, cutover is a scheduling decision rather than an engineering one. If the only
thing green at hour 12 is "more rows landed", the sprint optimised throughput on a machine
that still cannot be rebuilt — which is how today happened.

---

*Read-only session. No code, config, branch, or ref was modified; the break-glass in
`orchestrator/runtime.env` and `/root/oldorch-breakglass/` were not touched or read. The
only write is this file.*
