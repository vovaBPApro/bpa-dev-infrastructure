# Consilium member (Opus) — sprints 05/06/07 and the road to cutover

**STATUS: FINAL.** Read-only lane. Nothing committed, no branch created, no landing, no
cleanup, no credential read. Every number below is either something I executed in this lane
(marked *measured*), something I read in a tracked file (cited by path), or a guess (marked
`guess`).

---

## 0. The one measurement that changes the plan

I ran one experiment. It cost two minutes of wall clock and no CPU, and I think it closes
V3-0.23.

**Measured, in this lane:** a foreground command in the lane agent harness is killed at
**exactly 2m00s**, returns **exit 143**, and returns **its partial output with no trailing
lines** — I emitted 140 numbered lines plus a fake `552 pass / 0 fail / Ran 555 tests`
summary; the harness returned lines 1–120 and none of the summary.

Now put that against what the repository already records about the suite runtime, from nine
independent runs by four different agents:

| source | elapsed |
|---|---|
| workboard V3-0.34 | 98s idle, 112.87s at six workers, 115.19s at twelve |
| workboard V3-0.23 | 133s, 126s (fleet quiet, `5a2bc9e`) |
| Fable §1.7 runs 1–3 | 129s, 121s, 126s |
| Fable §1.7, guard-driven | 154.83s, 122.53s |

**The suite takes 98–155 seconds. The lane harness kills at 120 seconds.** The distribution
straddles the axe. And `grep -rn "BASH_DEFAULT_TIMEOUT_MS" .` returns nothing —
*measured*, nothing in this repository configures it, and
`instance/lane-agent-command.conf` launches `claude --print` with no timeout setting. So
every lane in the fleet runs the suite against a 120s default it does not know exists.

That reproduces V3-0.23's exact recorded symptom — *"`bun test` returns exit 0 after ~63
lines with no trailing triple"* — once you add V3-0.40. The kill gives 143, but 143 through
an unguarded pipe (`bun test | tail -3`) becomes **0**, and `gate/completion-guard.ts:131`
uses `spawnSync(command, {shell: true})`, which returns the pipeline's last status. So:

> **V3-0.23 and V3-0.40 are one defect.** The lane runs the suite, the harness kills it at
> 120s, the pipe converts 143 to 0, and the lane sees a green with truncated output and no
> triple. How many lines you see before the axe falls is a function of load — which is
> exactly why the row concluded "concurrency-dependent". It *is* load-dependent, but through
> the timeout, not through fixture contention.

It also explains why nobody could reproduce it. Fable's five runs were 121–155s and all
decided, because a reviewer measuring deliberately raises the timeout; a coder running
`bun test` casually does not. **The defect appears when you are not looking at it and
vanishes when you are.** That is the signature of a harness default, not a race.

What follows for the plan:

- The remaining V3-0.23 scope is **a number and an assertion**, not a concurrency redesign
  of the fixtures. Set an explicit timeout well above the measured p100 (600s is the harness
  maximum and gives 4× headroom); run `verify:` under `pipefail` or refuse unguarded pipes;
  require the trailing triple to be **present**, not merely non-failing. That is one lane of
  perhaps three rounds, not the multi-round concurrency epic it is currently scoped as.
- The fixture work already done under V3-0.23's banner was still worth doing — V3-0.20's
  shared-ref collision was real and landed at `cd0b1c3`. But it was a *different* defect
  wearing the same row's clothes.
- **Four blocked rows unblock the moment this lands**, and the whole chain the orchestrator
  believes in stops waiting behind a phantom.

I did **not** run the full suite to confirm this end to end, and that was a deliberate
choice I want on the record: doing so would have added a twelve-worker load to a shared
12-core host while other lanes were measuring — the precise interference V3-0.23 is about.
Adding a tenth unreproducible data point at the cost of corrupting someone else's round is a
bad trade. The decisive half — what the harness does at 120s — I measured directly, in
isolation, for free.

---

## 1. Calibration: what a row actually costs

Every number in sections 2–4 rests on this. State the assumption or the estimate is fiction.

### Measured throughput

*Measured*, `git log origin/main --merges`:

| day (Europe/Warsaw) | lane landings |
|---|---|
| 2026-08-02 (from 14:41) | 9 |
| 2026-08-03 | 46 |
| 2026-08-04 (00:20 → 10:49) | **12** |

Today's twelve are `7c428e0 2e62608 58fc72d 472df6b ff152de 4988dc4 7cca908 6125296 1e4e0f2
cd0b1c3 c8e52f6 48a59b3`, all `[ORCH] land lane ag-*`. See §5 — this is not the number the
brief gives me.

At 5–8 concurrent lanes over 11.75 hours, call it ~70 lane-hours for 12 landings:

> **Measured unit cost today: ~5.8 lane-hours per landed row**, at the current difficulty
> mix. On 2026-08-03 it was ~1.7 lane-hours per landing, because those were Phase-0
> mechanical rows. The 3.4× degradation is real and is what the remaining board looks like.

### The model I will use

- A review round is 40 minutes of wall clock (the brief says 30–40; I take the top).
- A round consumes one coder lane and one reviewer lane ≈ **1.3 lane-hours**.
- Row classes: **mechanical** 2 rounds (2.6 lh) · **standard** 3–4 rounds (4–5 lh) ·
  **hard** 5–7 rounds (6.5–9 lh).
- **Correction factor 1.4×** applied to every bottom-up total, for two reasons together:
  HR-2166's 3+2+2 ladder adds rounds to exactly the rows that already cost the most, and
  every bottom-up estimate on this board so far has come in low. Sanity check: bottom-up
  ×1.4 lands within 10% of the measured 5.8 lh/row on a comparable mix, so the factor is
  calibrated, not decorative.

### The constraint that fleet size does not relieve

Rounds on one row are **serial** — round *n*+1 needs round *n*'s review. So a 7-round hard
row has a **latency floor of ~4.7 hours that no number of lanes shortens**. The fleet buys
width across rows, never depth within one. Every estimate below is therefore quoted in
lane-hours *and* checked against the wall clock its longest chain implies, because on the
critical path the second number is the one that binds.

---

## 2. Sprint 05 — pay off the gate tax

**Goal in one sentence:** stop the landing machinery charging every remaining row for
defects in the landing machinery.

**Rows:** V3-0.40 + V3-0.38 (one lane — two halves of one defect) · V3-0.23 recut on §0's
finding · V3-0.44 + V3-0.39 (one lane — the reviewer contract read from both ends) ·
V3-0.31 · V3-0.43 · V3-0.33 · V3-0.47 · V3-0.37 · **V3-3.10-minimal** (see below).

**Why these and not others.** This is the only sprint on the board whose rows *return* lane
hours instead of spending them, and the receipts are on the board already, all from a single
day:

- V3-0.39 threw away a **481-line ACCEPT** for V3-1.9a over the field name `identity:` vs
  `reviewer:`. One round destroyed by a string.
- V3-0.31 cost **two review rounds** on V3-0.16 because the guard checks
  `$LANE_REPORT_PATH` and every brief names `<branch>.report.md`.
- V3-0.44: **14 of 14 reviewer lanes** on this installation end `state: failed
  reason: report-invalid`, including two whose ACCEPTs landed. Half the fleet's status
  signal is 100% false.
- V3-0.47 cost **three interruptions** today and forced one complete ten-minute landing
  chain (V3-1.9a) to be repeated after it had already passed merge and meteorite.
- V3-0.25 (now landed) parked V3-1.9 — a row holding **three independent ACCEPTs** — by
  invalidating its report count.
- V3-0.43: the board was committed corrupted with 66 spurious lines and passed the gate,
  because nothing reads `instance/workboard.md`.

Sum that: on one day, gate friction destroyed roughly four review rounds outright and forced
one full landing walk to be re-run. At 1.3 lh/round that is ~6 lane-hours lost in a day, and
it recurs every day, against ~40 rows still to close.

**Arithmetic for front-loading, since the brief asks me to say plainly whether I would:**
**Yes, and harder than the current chain does.** A fix that saves half a lane-hour per
remaining row returns ~20 lane-hours for a ~3 lane-hour spend. Nothing else on the board has
that ratio. V3-0.37 is the strongest single case — Fable is right that it is a multiplier —
because it hit **eight lanes today**, and it hits preferentially the *longest measurements*,
which is an incentive inversion: the evidence gate discards the most valuable evidence.

**The one row I am adding that nobody has proposed: V3-3.10-minimal.** V3-3.10 (HR-2188,
consumption accounting) sits in Phase 4. Pull its cheapest slice forward: **record each
review round's wall-clock start, end, tier and model.** Two timestamps in the review artifact
and the attempt ref. It costs perhaps 2 lane-hours and it is the *only* thing that converts
my 40-minutes-per-round assumption into a measured distribution. After sprint 05 you would
have ~25 timed rounds and every number in this document becomes a forecast instead of an
assumption. See §4 — this same counter is half of what makes cutover dateable at all.

**What it unblocks:** V3-0.29, V3-0.30, V3-1.9 and V3-0.20's four dependants (via §0);
V3-0.45 needs V3-0.41's honest `check`, which needs this sprint's counter work to be
trustworthy; and every subsequent row runs cheaper.

**Estimate.** Bottom-up: 0.40+0.38 standard 4 lh · 0.23 recut standard 4 lh · 0.44+0.39
standard 5 lh · 0.31 mechanical 2.6 lh · 0.43 mechanical 2.6 lh · 0.33 mechanical 2.6 lh ·
0.47 hard 6.5 lh · 0.37 hard 6.5 lh · 3.10-minimal 2 lh = **35.8 lane-hours**. ×1.4 =
**~50 lane-hours**.

> **Sprint 05: 45–55 lane-hours.** Assumption: 6 concurrent lanes at ~70% utilisation
> (landing is serialised, so lanes idle waiting on the queue), no row exceeding 4 rounds,
> and V3-0.23 recut as §0 argues rather than as currently scoped. That is **~1.5 working
> days of wall clock**. Longest serial chain: V3-0.47 at ~4.5h, so wall clock is
> width-bound, not latency-bound — this sprint parallelises well.

---

## 3. Sprint 06 — the operator door, and the circle it sits in

**Goal in one sentence:** give the operator an authorisation path that an agent cannot
forge, which requires first admitting that today it cannot be built.

**Rows:** V3-0.29 **rescoped** · V3-1.9 unpark and land · V3-1.9b · V3-1.10 · V3-0.32 ·
V3-0.41 · V3-0.45 · V3-0.30 round 5.

### The structural problem, which I think is being missed

There is a genuine **bootstrap cycle** on the critical path:

- V3-1.9 is parked; only an operator unpark clears it.
- V3-0.29 is building that unpark. It is at **round 4**, and its round-3 review found four
  blocking defects, of which **F1 is fatal to the whole approach**: the trust root is
  `refs/remotes/origin/<target>`, *a local ref in a common directory shared by ~90 lane
  worktrees*, so the reviewer authorised a park release end to end with a decision file
  origin never held.
- V3-1.10 (HR-2109, the administrator bot) is the operator's own replacement design and
  solves F1 by construction — a record the orchestrator **cannot write**.
- But V3-1.10 requires V3-1.9, because "root-owned" means nothing while every lane is root.

So V3-0.29 is trying to build an **unforgeable** authority in an installation where nothing
else is unforgeable. V3-3.4's own honest text says it: the round counter is
*"tamper-**detecting**, not tamper-proof, until the privilege boundary lands."* V3-2.4 says
the same about the model pin. **V3-0.29's target security property is strictly stronger than
that of the mechanism it protects**, and four rounds of evidence say it cannot be reached
from here. Round 5 would be a fifth attempt to jump a gap whose far side does not exist yet.

**My recommendation, and it is my sharpest disagreement with the current chain:**

1. **Rescope V3-0.29 to a minimal, auditable, tamper-*detecting* unpark** — matching, not
   exceeding, V3-3.4's stated guarantee. The operator's decision is already durably on record
   (`decision:v3_1_9_noprogress_park_2026_08_04=unpark_land`, reaffirmed Telegram 2071). It
   must be recorded against its decision id, must not erase the park history, and must be
   *visible* if forged. It does **not** need to be unforgeable, because on this host nothing
   is. Two rounds, not five.
2. **Then land V3-1.9** on the three ACCEPTs it already holds.
3. **Then V3-1.10** builds the real door, on a host where root now means something.
4. **Only then** is an unforgeable unpark a buildable row — and by that point V3-1.10 has
   made it unnecessary.

Do also fix V3-0.29's F2 in whatever form survives: the aborted landing that strands the
decision forever, because both unpark authorities run *after* the attempt-ref replay loop
whose first line dies on `item.park`. That one is an ordering bug and is cheap regardless of
which design wins.

**Why the counter rows (V3-0.32, V3-0.41, V3-0.45) belong here and not in 05.** HR-2166's
proving phase is an operator ruling and it is currently unimplementable: V3-0.32 means a
rejection charges no round, so the counter cannot see the rounds a proving phase must count,
and V3-0.41 means `check` answers from a cache that is wrong for precisely the parked items.
V3-0.45 depends on both. Grouping them keeps one mission chain rather than three.

**Estimate.** V3-0.29 rescoped 2.6 lh · V3-1.9 land 2.6 lh · V3-1.9b standard 5 lh ·
V3-1.10 hard/new subsystem 9 lh · V3-0.32 hard 6.5 lh · V3-0.41 mechanical 2.6 lh · V3-0.45
standard 5 lh · V3-0.30 r5 standard 4 lh = **37.3 lane-hours** ×1.4 = **~52**. I widen the
top because V3-1.10 is a **new two-process subsystem with a privilege boundary**, the
category that has burned the most rounds on this board (V3-1.9: 3 rounds, no ACCEPT;
V3-1.9a: 3 rounds; V3-2.4: 3 rounds, parked).

> **Sprint 06: 55–75 lane-hours ≈ 2 working days at 6 lanes.** Assumptions: V3-0.29 is
> rescoped as above (if it is not, add 15–20 lane-hours and it may still park); V3-1.10
> takes 7 rounds under the HR-2166 ladder; and **the operator is reachable for V3-1.9b's
> credential minting**, which is interactive by design and which no fleet size shortens.
> Longest serial chain: V3-0.29 → V3-1.9 → V3-1.10 ≈ **11 hours of pure latency**, so unlike
> sprint 05 this one is latency-bound and adding lanes will not compress it.

---

## 4. Sprint 07 — the machine's memory

**Goal in one sentence:** make a rebuilt host remember what it was doing, so that Hard Floor
5 is discharged for the installation and not merely for the repository.

**Rows:** V3-2.9 (enumerate + restore, proven into the meteorite container) · V3-2.10
(credential runbook) · V3-1.1 stage 2 recut · V3-2.1 · V3-2.3 · V3-4.4 · V3-1.12.

**Why these.** I agree with Fable's §3.1 ranking and will restate why in one line: the
meteorite proves the *repository* rebuilds a host; the operator's milestone is *"почищу
сервак і з нуля почнемо"*, and a host that comes back with no mission history, no lane
record and no durable evidence has not come back. `instructions/reproducible-from-git.md`
already binds this — *"not in git is never allowed to mean not written down"* — and it is
undischarged.

V3-1.1 stage 2 is in this sprint and is easy to overlook: it is **PARKED at the HR-1726
cap** with a named blocker (`unit_publication_signal` resets HUP/INT/TERM before rollback
begins), and **V3-2.1 and V3-2.3 both depend on it** — nothing gets armed by a bootstrap
path that cannot install units. It must be recut here or sprint 07 does not close.

**Estimate.** V3-2.9 hard 8 lh · V3-2.10 standard 4 lh · V3-1.1 s2 recut hard 8 lh · V3-2.1
hard 6.5 lh · V3-2.3 standard 5 lh · V3-4.4 standard 5 lh · V3-1.12 standard 4 lh =
**40.5 lane-hours** ×1.4 = **~57**.

> **Sprint 07: 55–70 lane-hours ≈ 2 working days at 6 lanes**, **plus unbounded operator
> latency on V3-2.10.** Assumption: V3-2.9's restore is proven by restoring into the existing
> meteorite container rather than building new proof infrastructure. **V3-2.10 is the row I
> would not put a wall-clock number on at all** — it needs credentials only he can provision
> and he is not always at a computer (V3-1.12, Telegram 2103). Its *fleet* cost is ~4
> lane-hours; its *calendar* cost is however long he takes. Dispatch it first in the sprint
> so its latency overlaps everything else, and treat V3-1.12 as the row that defines what the
> fleet does while waiting.

---

## 5. The road to cutover, and the honest answer about a date

### What remains after sprint 07

**Sprint 08 — cutover rehearsal.** V3-4.1 finish (in review now, round 2, blocked on whether
the proof exercises the production daemon or a 30-line fixture) · V3-4.2 re-proven *with*
V3-2.9's state restore · a full dress rehearsal (rebuild → restore state → dispatch a real
lane → Telegram round trip) · then V3-4.3, his go.
**≈ 25–35 lane-hours.**

**A correction on V3-4.2 that shortens this.** V3-4.2's acceptance is literally
*"`meteorite/run.sh` green from a fresh clone"*. That has already been executed green twice:
by the orchestrator at `e17f629` (`result: clean`, clean `ubuntu:24.04`, credential-free
clone from GitHub, no file from this host — V3-1.5) and again at `ff152de` (`[meteorite]
clean: ff152ded…`, exit 0 — V3-0.21). It is now *gate-enforced* at every rebuild-affecting
landing. **V3-4.2 as written is arguably already satisfied, and nobody knows, because it is
one of the 23 rows with no state cell** (*measured*: `grep -n '^| V3-4.2'` returns three
cells). Fable says V3-4.2 is meaningless before V3-2.9 — I half agree: the *acceptance
command* is satisfied, the *milestone* is not. So the correct move is not to re-do V3-4.2, it
is to **rewrite its acceptance** to include state restore. That is a five-minute edit that
someone should make before anyone spends a lane on it.

**Not cutover blockers, and I would say so explicitly rather than let them drift into the
chain:** V3-1.7 (three-level hierarchy — a capability he wants, not a precondition for
wiping a server), V3-1.11 (hardware negotiation — cutover targets the same hardware),
V3-3.1/3.3/3.5/3.7, V3-0.24/0.26/0.34/0.35/0.36/0.42/0.46. V3-3.2 (Spark routing) becomes
free once V3-1.9 lands. Each of these is real work; none of it stands between here and a
wiped server. Say so out loud, because "everything open blocks cutover" is how a board with
85 rows becomes undateable by construction rather than by evidence.

### The total

| | lane-hours |
|---|---|
| Sprint 05 | 45–55 |
| Sprint 06 | 55–75 |
| Sprint 07 | 55–70 |
| Sprint 08 | 25–35 |
| **Total, zero new discovery** | **180–235** |

At 6 concurrent lanes and ~70% utilisation that is **43–56 hours of wall clock ≈ 4.5–6
working days** — *if nothing else is discovered*.

### Why I will not give that as a date

Nothing else being discovered is contradicted by every day of measurement so far.

*Measured*, `grep -c 'New 2026-08-04'` → **32 rows filed today**, against ~10–12 closed.
Their sources split three ways and only one of the three responds to engineering:

| stream | rows today | decays with engineering? |
|---|---|---|
| operator requirements (HR-2088/2109/2115/2120/2126/2166/2188, Tg 2093/2113) | **9** | **No.** Unbounded, and healthy — it is him steering. |
| one external audit (Fable) | 8 | One-time. Recurs only when another is commissioned. |
| found by the fleet's own operation | 15 | **Yes** — and these cluster into ~4 repeating classes. |

That third stream is the encouraging one, because it is not random. It repeats:

- **two writers on one piece of git state** — V3-0.7, V3-0.20, V3-0.25, V3-0.47
- **a contract whose two halves were written separately and never executed against each
  other** — V3-0.31, V3-0.38, V3-0.39, V3-0.44
- **a correct mechanism with no executor** — V3-0.28's five instances
- **evidence pointing one step away from the property it claims** — V3-0.30's own words

Attack the class and the tail dies. Attack instances and discovery never decays. Sprint 05
is built to attack classes 1 and 2; V3-0.28 (which I place in sprint 06, not 05 — see §6)
attacks class 3.

But stream one does not decay, and it is the largest single input today. So:

> **Cutover cannot be honestly dated today, and the reason is not engineering — it is that
> the requirement stream is open and the closure rate has never been measured against it.**
>
> **What would make it dateable, precisely:** two counters that do not exist and cost ~4
> lane-hours together.
>
> 1. **Rows filed vs rows closed per day**, taken from a *real* sprint close (re-execute each
>    acceptance at the landed SHA, the way sprints 01–03 were closed), with the filed rows
>    tagged by stream. Cutover becomes dateable on the **second consecutive day** the
>    3-day-trailing filing rate is below the closing rate. Not before, and any date given
>    before that is a wish.
> 2. **Per-round wall-clock cost by tier and model** — V3-3.10-minimal from §2. This replaces
>    the 40-minutes-per-round assumption that every number above rests on.
>
> Give me those two counters running for **three days** and I will give a date with a real
> confidence interval instead of a bracket built on my own assumption.

**Conditional forecast, which is the most I can honestly offer, and the lever is his:**

- If he **freezes new requirements** during sprints 05–07: **5–6 working days.**
- If his requirement stream continues at **half** today's rate (~4–5 rows/day, ~20 lane-hours
  of new work per day against ~35–40 lane-hours/day of capacity): **7–10 working days.**
- If it continues at **today's** rate (9/day): the board does not converge and **no date
  exists.** That is not a criticism of him — steering is his job — but the arithmetic is not
  negotiable and he asked for the truth.

**On the sprint numbering, since I was asked to decide.** Continue at **05**, and close 04
first — but close it by **measurement**, not by narrative. Sprints 01–03 were each closed by
re-executing every row's acceptance command at its landed SHA, and that discipline is exactly
what is missing from today's estimate. Writing a retrospective prose close for sprint 04
would be manufacturing a record; re-executing its eight rows' acceptances costs ~2
lane-hours and produces the throughput baseline this entire document had to reconstruct from
`git log`. **Do not skip it to save two hours — the two hours are the reason §5 below
happened.**

---

## 6. The risk most likely to break this plan

Not the operator's requirement stream — that one is visible, and I have already priced it.

**The risk is that HR-2166's round economics are 2× worse than every estimate here assumes,
and nothing is measuring it.**

The ladder is 3 standard rounds, then 2 with the model raised on both coder and reviewer,
then 2 requiring **a running system and real logs**. Every number in sections 2–4 prices a
round at 40 minutes. Rounds 6 and 7 are not 40-minute rounds — they are container builds,
live daemons, meteorite proofs. The gate's own meteorite proof is measured at ~3m40s *while
holding the serial landing lock* (V3-0.21), and that is the cheap one.

If a hard row's true cost is 7 rounds averaging 70 minutes instead of 40, every estimate here
inflates by **~1.8×**, sprints 06 and 07 roughly double, and the 180–235 lane-hour total
becomes 320–420. The plan would not fail loudly; it would just quietly take three times as
long as it said, which is the failure mode that destroys trust in an estimate.

Compounding it: HR-2166 was adopted on the reasoning (V3-0.45, and the evidence is genuinely
good) that rounds spent proving convert parks into lands. That may well be true. But it makes
the ladder's *cost* the untested half of a ruling whose *benefit* is well argued — and the
untested half is the one every schedule depends on.

**What detects it early, cheaply:** V3-3.10-minimal from §2. Two timestamps per round, tagged
with the ladder stage. After sprint 05 you have ~25 measured rounds; after one hard row
completes the full ladder you have the first real 6-and-7 measurement. **Trip wire: if the
measured mean for ladder stages 2–3 exceeds 60 minutes, re-estimate sprints 06 and 07 before
dispatching them, and take the re-estimate back to him rather than absorbing it silently.**

Second-place risk, named because it is nearly as likely and much cheaper to fix: **V3-0.37**.
It hit eight lanes today and it destroys work in proportion to how long the measurement was —
so it lands hardest on exactly the rows sprints 06 and 07 are made of. Fable calls it a
multiplier and Fable is right. It is in sprint 05 for that reason.

---

## 7. One thing the orchestrator is getting wrong

**It believes the fleet landed three rows today. It landed twelve.**

The brief given to this consilium states, as the load-bearing premise of the entire estimate:

> *"Landed today: V3-0.20 `cd0b1c3`, V3-0.15 `c8e52f6`, V3-1.9a `48a59b3`. That is the real
> throughput number for a day at 5–8 concurrent lanes: **three rows landed**."*

*Measured*, `git log origin/main --merges --date=format:'%m-%d %H:%M'`:

```
48a59b3 08-04 10:49   c8e52f6 08-04 10:20   cd0b1c3 08-04 09:01
1e4e0f2 08-04 07:00   6125296 08-04 06:46   7cca908 08-04 04:10
4988dc4 08-04 03:44   ff152de 08-04 02:38   472df6b 08-04 02:03
58fc72d 08-04 01:13   7c428e0 08-04 00:45   2e62608 08-04 00:20
```

Twelve `[ORCH] land lane ag-*` merges dated 2026-08-04, spanning 00:20 to 10:49. The three in
the brief are the **most recent three**. The orchestrator counted the last ~3 hours and
called it a day.

Mapping them to rows against the board's own state cells: V3-3.4 (`7c428e0`), V3-0.21
(`2e62608` then `ff152de`), V3-3.6 (`472df6b`), V3-2.7 (`7cca908`), V3-0.27 (`6125296`),
V3-0.28 (`1e4e0f2`), V3-0.20, V3-0.15, V3-1.9a, plus V3-0.25 — **at least ten distinct rows
closed today**, two of the twelve I could not attribute without opening more lanes than this
is worth.

**Why this is the thing worth naming rather than a nitpick.** It is off by 4×, in the
pessimistic direction, and it is the denominator of every number the operator was about to be
given. Build a plan on 3 rows/day and 40 remaining rows reads as thirteen days; build it on
the measured rate and it reads as three to four. Those are different conversations, and he
asked for the truth rather than a comfortable number — a number that is *uncomfortable in the
wrong direction* is just as false.

**And the cause is structural, not arithmetic.** The brief says it itself: *"Sprint 04 was
opened 2026-08-03 and never closed; all of today's work ran outside any sprint."* Sprints
01–03 each ended with a measured close — commits, landings, suite counts, worktrees, every
acceptance re-executed at its landed SHA. Sprint 04 has no close, so there is no measured
baseline, so the orchestrator estimated its own throughput **from recall** — and recall
reaches back about three hours.

That is precisely the failure V3-0.30 exists for. That row says the board, the counter and
`origin/main` disagree and *"none of them checked the others."* The orchestrator applied that
insight to dispatch decisions and filed a row for it. It did not apply it to its own
productivity, where the durable record — `git log`, one command — was equally available and
equally unconsulted.

A related, smaller instance of the same thing, offered because it is cheap to fix: I counted
the board three ways and got three answers. The brief says 27 done / 28 open / 25 stateless.
`grep -c '^| V3-.*\*\*done\*\*'` gives **34**; `grep -c '^| V3-.*\*\*open'` gives **16**;
counting cells by `|` gives **23** stateless, not 25, because two rows contain *escaped*
pipes that fool the count. All three readings are defensible and none agrees. **The board
cannot currently be counted by two independent readers**, which is V3-0.43's second defect —
and it means the "85 rows, 27 done, 28 open" framing the operator is about to receive is
itself an estimate, not a measurement. V3-0.43 is in sprint 05 for this reason and should be
dispatched in its first wave, not its last.

---

## 8. Where I disagree with the Fable review

I was asked to decide for myself rather than inherit it. Fable's §4 is good and I have kept
most of it. Three changes:

1. **V3-0.28 belongs in sprint 06, not first.** Fable ranks the reachability checker as
   "Sprint B — repair the detector before trusting anything it certified", on the argument
   that a wrong green retires a question. That argument is correct and I do not dispute the
   finding — `text.includes(needle)` accepting a code comment as an executor is real and the
   mutation proof is clean. But I rank by **lane-hours returned per lane-hour spent**, and
   V3-0.28 returns none. It prevents a future wrong *belief*; it does not make any remaining
   row cheaper. V3-0.44 (14 of 14 reviewer lanes falsely `failed`) and V3-0.47 (one landing
   walk repeated today) both do. Fix the tax first, then the epistemics.
2. **Fable's A1 is right and its reasoning is incomplete.** It recommends re-measuring
   V3-0.23 and suspects "a deadline set below the measured runtime" — correct, and it could
   not find the deadline because *it is not in the repository*, it is the harness default
   (§0). Fable also states that a deadline below runtime "gives `Terminated` and exit 143 or
   124 — a loud failure, not a false green." I measured 143 too. What Fable missed is that
   V3-0.40 — **its own finding, four sections earlier** — converts that 143 into a 0. The two
   findings compose into the explanation, and the review reports them separately.
3. **Fable's §3.7 (disk and log growth) is not worth a sprint slot yet.** *Measured*:
   `/` is 35% used with 251G free, `/root/.cache/infra-lanes` is **1.7G** after two days,
   across 387 lane directories against 131 registered worktrees. At that rate disk is years
   away. File the row so it is not lost, price it at zero, and do not let it into a sprint
   ahead of anything above. (V3-0.46's branch/worktree pinning is a different matter and is
   real — *measured*: 118 local branches and 131 worktrees now, against the 108/120 the row
   records a few hours ago. It is growing at ~2–3/hour and it is a correctness problem for
   the reaper, not a capacity one.)

---

## Manifest consumption check

- `orchestrator-playbook` sha256:10dc2e7be7e2 — *Orchestrator Playbook*
- `orchestrator-fallback` sha256:811f13bc3373 — *Orchestrator Session Portability*
- `autonomy-and-capacity` sha256:18c43aaf7e14 — *Autonomy and Capacity*
- `landing-and-merge` sha256:951d9781cffa — *Landing and Merge*
- `roles` sha256:cd4c40c4e640 — *Roles*
- `instruction-layers` sha256:cd21f4ce0990 — *Instruction Layers*
- `reproducible-from-git` sha256:822d9efe694b — *Reproducible From Git*

Instance facts consumed: `phase=sole-mission`, `active_scope=instruction-mechanics-only`,
`capture.mode=manual`, `operator.language=uk`.

---

```text
commit: none — read-only consilium lane, nothing authored
verify: git log origin/main --merges --date=format:'%m-%d %H:%M' --pretty='%h %ad %s' | head -12
result: clean
secret-scan: clean (no file written inside the repository; this report is at $LANE_REPORT_PATH, outside the worktree)
remaining: none — sections 1–8 complete
```

### What I executed, so a reader can re-run it

| claim | command |
|---|---|
| harness kills at 120s, exit 143, partial output, no trailing summary | a 140-line/140-second emitter run in the foreground |
| no timeout is configured anywhere | `grep -rn "BASH_DEFAULT_TIMEOUT_MS\|BASH_MAX_TIMEOUT_MS" .` → no hits |
| lanes launch `claude --print` with no timeout setting | `cat instance/lane-agent-command.conf` |
| 12 landings today, 46 on 08-03, 9 on 08-02 | `git log origin/main --merges --date=short --pretty='%ad' \| sort \| uniq -c` |
| 32 rows filed today, 8 from the Fable review | `grep -c 'New 2026-08-04'` · `grep -c 'from the Fable global review'` |
| board counts disagree three ways | `grep -c '^\| V3-.*\*\*done\*\*'` · `grep -c '^\| V3-.*\*\*open'` · cell count by `\|` |
| V3-4.2 has no state cell | `grep -n '^\| V3-4.2' instance/workboard.md` → 3 cells |
| 118 branches, 131 worktrees, 387 lane dirs, 1.7G, 35% disk | `git branch \| wc -l` · `git worktree list \| wc -l` · `du -sh` · `df -h /` |
| host: 12 cores, load 3.25, 251G RAM | `nproc` · `/proc/loadavg` · `free -g` |

Where I did **not** execute: I did not run the full `bun test` suite, deliberately (§0);
I did not attempt any landing, push or ref creation; I read no credential. My §0 conclusion
about V3-0.23 is an inference from two executed measurements plus nine recorded runtimes —
strong, but the confirming run belongs to a lane that can safely take the host to twelve
workers. I would dispatch that lane before writing another round of V3-0.23.
