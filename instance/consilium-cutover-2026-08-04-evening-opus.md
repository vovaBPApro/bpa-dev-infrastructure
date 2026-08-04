# Consilium member (Opus, deep-reading seat) — the 10–12 hour sprint to cutover readiness

2026-08-04 evening. Written against `HEAD` `2c0499c`, `origin/main` `eba098f`.
Independent: I have not seen the other four members' answers.

Constraint applied mid-flight: the operator has capped the fleet at **3 parallel lanes**.
The programme in §4 is written against that cap, not appended to a 10-lane plan; §4.0
records what the cap changed.

---

## Executive answer

**The single most important thing I found is that this system currently has no working
measurement of its own state, and every one of today's three worst discoveries was made
by a person looking rather than by a gate.** The launcher incident is the known example.
Here are two more that nobody has recorded: (1) the canonical repository
`/root/bpa-dev-infrastructure` was checked out on the abandoned line **`v2-deprecated`
for 29 hours**, from 2026-08-03 12:40 until 17:52 today — verified in `git reflog` — so
the fleet-idle watchdog spent the entire day parsing the *deprecated* workboard and
logging `open_rows=47` (v2's board has exactly 47 open bullet rows; the v3 board has
zero of that shape), and since the checkout returned to `main` at 17:52 that watchdog
has been **failing every ten minutes** and the fleet autonomy loop is dead as I write;
(2) `bun test` on `main` at `HEAD` is **red** — 599 pass / 1 fail — on
`tools/instructions/compose.test.ts`, reporting **176 operator inbox rows untriaged for
more than 24 hours**, in a file (`instance/decisions/inbox.jsonl`, 713 rows) that is
**not tracked in git at all**. Set against that, the previous consilium's priority —
"fix the landing machinery before advancing the chain" — is now **second, not wrong**.
Landing machinery governs *throughput*: how fast the remaining ~170–230 lane-hours get
spent. The launcher/measurement gap governs *validity*: whether the destination is
reachable and whether any number the operator is shown is real. At a 3-lane cap this
sprint buys about **5 rows**, so it cannot reach cutover-readiness and should stop
pretending to. What it can deliver, and what I would spend all 12 hours on, is: **make
the orchestrator startable from git alone with the break-glass removed, make the
meteorite prove that by starting it, and hand the operator one command that prints a
per-gate PASS/FAIL/UNKNOWN table for cutover.** After that the road to cutover is
arithmetic instead of opinion.

---

## 1. State of affairs — what is actually true right now

Everything in this section is marked **[verified]** (I ran the command or opened the
file), **[inferred]** (a strong deduction from verified facts), or **[guess]**.

### 1.1 The two launcher blockers are real, and I re-verified both independently

- `orchestrator/launch.sh` calls `mission_cli reap` (line 466) and `mission_cli lease
  acquire|renew|release` (lines 145, 173, 602, 630, 664). `core/mission-cli.ts`'s usage
  string (line 111) is the whole dispatch vocabulary and contains neither. **[verified]**
- `git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` → *does not exist in
  'HEAD'*; the file is also absent from the working tree. **[verified]**
- `runtime/state.db` **exists** on this host (102 400 bytes, mtime 2026-08-03 15:26, with
  a WAL touched today at 13:16). So `state_available()` is true against the default path
  and blocker 1 is armed right now for any start that does not override
  `ORCH_STATE_DB`. **[verified]**
- `orchestrator/runtime.env` holds exactly five keys: `ORCH_CODEX_MODEL`,
  `ORCH_CODEX_REASONING_EFFORT`, `ORCH_CLAUDE_MODEL`, `ORCH_STATE_DB`,
  `ORCH_AUTH_PREFLIGHT`. Three of those five are load-bearing and none of them is in
  git. `/root/oldorch-breakglass/preflight-cli-auth.sh` exists, 7 990 bytes, created
  today at 18:08. **[verified — I read key names only and touched nothing.]**

The incident record is accurate. I add one thing it does not say: because
`ORCH_STATE_DB` points at an absent path, the running orchestrator is operating **with
its lease and reap machinery disabled entirely** — `state_available()` is false, so
lines 172, 465, 599, 630, 655 and 664 are all skipped. The flock-based singleton in the
tmux command line still holds (I read it in `ps`), so the session is not unprotected,
but the durable lease record is not being written and `runtime/state.db` — which holds
today's mission and lane history — is orphaned from the live session. **[verified for
the skipping; inferred for the consequence.]**

### 1.2 The canonical repository spent 29 hours on the abandoned line

`git reflog` **[verified]**:

```
d4dee39 HEAD@{08-04 17:52}: checkout: moving from v2-deprecated to main
a2a1ca7 HEAD@{08-03 12:40}: checkout: moving from main to v2-deprecated
```

Between those two entries there is no other checkout. So for the whole of 2026-08-04 up
to 17:52 — the day the handoff describes as "fifteen rows landed" — the working tree at
`/root/bpa-dev-infrastructure` held **v2-deprecated content**, including
`instance/workboard.md`, `CLAUDE.md` and all of `instructions/` (`git diff --stat
v2-deprecated main` over those paths: 9 files, 621 insertions, 435 deletions).
**[verified]**

The orchestrator's tmux session is started with `-c /root/bpa-dev-infrastructure` (read
from `ps`) **[verified]**, so anything it read from its own working tree during that
window returned the deprecated line's version **[inferred — strong: the cwd is the
canonical repo and the tree was on v2]**. Landings were unaffected, because they run in
a *separate clone*, `/root/.cache/infra-lanes/land-main` **[verified]**. How much this
changed the day's decisions I cannot measure. **[guess: modestly — the orchestrator
mostly worked from the land-main clone and from lane reports — but it is exactly the
kind of thing that should never be a guess.]**

### 1.3 The fleet-idle watchdog has been reporting fiction all day, and is now dead

`/root/.local/bin/orch-fleet-nudge.sh` is the only mechanism that wakes the orchestrator
when the fleet goes idle. It is **not in git** (`git ls-files | grep fleet-nudge` →
empty) **[verified]**, runs as root from `orch-fleet-nudge.timer` every ten minutes, and
its own `--verify-deployed` mode compares the deployed script against "the tracked
script" — which does not exist. A drift detector with nothing to diff against.

Its parser expects bullet rows of the form
`- <!-- status: open --> **V3-0.1 — …`. The v3 workboard is a **markdown table**. So:

| fact | evidence |
|---|---|
| every firing today logged `open_rows=47` | `/root/.cache/infra-lanes/fleet-nudge.log`, 107 entries 00:03→17:43 **[verified]** |
| `v2-deprecated:instance/workboard.md` has exactly **47** `status: open` rows | `git show v2-deprecated:instance/workboard.md \| grep -c 'status: open'` → 47 **[verified]** |
| `main:instance/workboard.md` has **0** rows of that shape | same grep on the live file → 0 **[verified]** |
| since 17:53 the service **fails** every firing | `journalctl -u orch-fleet-nudge.service`: `fleet-nudge: no parseable workboard rows`, exit 2 **[verified]** |

So the number the autonomy loop used to decide "is there work left" was read off the
abandoned board, all day; and the moment the tree was corrected, the loop broke. It
fails closed and pings the operator, which is the right direction — but the fleet has
been unattended since 17:53 and is at **0 running lanes** now. **[verified]**

The same log is also the honest record of fleet width today: 107 firings, all below
floor, distributed `running=0` ×18, `1` ×32, `2` ×22, `3` ×6, `4` ×5, `5` ×10, `6` ×5,
`7` ×7, `8` ×2. **Median 2.** **[verified]** The synthesis's road-to-cutover arithmetic
assumes "six concurrent lanes at ~70% utilisation". The measured day was nowhere near
that, and under the new 3-lane ruling it never will be. **Every wall-clock figure in
`consilium-sprints-2026-08-04-synthesis.md` is therefore optimistic by roughly 2×, and
that is now a policy fact, not a scheduling accident.**

### 1.4 `main` is red right now, on the Human-requirements ledger

`bun test` at `HEAD`, run by me on this host **twice**: **599 pass / 3 skip / 1 fail**,
603 tests across 62 files, 173.26 s and 169.16 s, exit 1. Reproduced, not a flake.
**[verified]** Note the runtime: both runs exceed the 120-second lane-harness kill
(V3-0.51), so no lane can obtain this triple in the foreground.

The failure is `tools/instructions/compose.test.ts:430`, "real repo check --strict is
clean (0 FAIL)", which returns **`summary: 176 FAIL, 1 WARN, 0 SKIP, 69 PASS`**. Every
one of the 176 is the same shape: `inbox.jsonl:msg NNNN [ledger] untriaged inbound >24h
with no HR-NNNN.md and no triage verdict`, for message ids from 1101 to 1890.
**[verified]**

Three consequences, and I think all three matter:

1. `instance/decisions/inbox.jsonl` — 713 rows, the captured stream of the operator's
   own messages — is **not tracked in git** (`git ls-files` returns nothing for it).
   **[verified]** The record of what the Human asked for exists only on the host the plan
   intends to wipe. `instructions/human-requirements` is Hard Floor 2 and
   `reproducible-from-git` requires untracked host state to be *enumerated*; this is
   neither tracked nor enumerated.
2. Because the file is untracked, a lane worktree cut from `land-main` does not have it,
   so the check passes there and fails here. The V3-2.9 lane reported `660/0` at 17:58
   **[verified from its report]** while the canonical checkout is red. This is
   **V3-0.21's shape inverted**: green where the gate looks, red where the system lives.
   **[inferred — strong.]**
3. The threshold is `>24h` (`tools/instructions/ledger.ts:25`) **[verified]**, so the
   count grows every day by whatever was not triaged. Today's ~200 messages age in
   tomorrow. This is a red that gets worse while nobody is looking at it.

How many of the 176 are real directives rather than conversation, I do not know.
**[guess: a minority — but "a minority of 176" is still a lot of Human words that Hard
Floor 2 says must be preserved as work.]**

### 1.5 One hundred branches of work exist only on this host

In the lane clone `/root/.cache/infra-lanes/land-main`: 147 local branches, 32
remote-tracking refs, **134 branches with no counterpart on origin**, of which **100
carry commits not reachable from `origin/main`**. **[verified — I enumerated them with
`git rev-list --count origin/main..<branch>`.]** `instance/hygiene-protected-branches.txt`
covers 87 names, and `hygiene/check-retained-branches.ts` (V3-0.27) checks only the
*protected and park-referenced* set — so the other ~100 are unchecked by construction.

V3-0.46 records "108 lane branches, 120 worktrees" as of this morning; it is now **147
branches, 165 worktrees**, i.e. roughly +40 per day. **[verified]** The row is stale and
the trend is the wrong way.

For a project whose next milestone is *wipe the server*, this is the largest silent loss
exposure I found. Most of it is probably superseded work **[guess]** — but "probably" is
not a disposition.

### 1.6 Other record defects, each verified

- `instance/params.yaml:74` says `top_model: claude-fable-5`. **HR-2315 (today,
  binding)** pins `claude-opus-5`, `orchestrator/launch.sh:81` defaults to
  `claude-opus-5`, and the live process is `claude --model claude-opus-5`. params.yaml is
  stale against a same-day binding ruling. **[verified]**
- The incident record `2c0499c` is **committed locally and not pushed**;
  `origin/main` is `eba098f`. The written record of the Hard Floor 5 breach is itself
  host-only. **[verified]**
- `bpa-orchestrator.service` is `loaded inactive dead`; the orchestrator is running from
  a hand-started `tmux new-session`. `orch-morning-report.service` is `failed`. So the
  unit that is supposed to bring the orchestrator up is not what is holding it up.
  **[verified]**
- Workboard shape, measured now: **92** V3 rows; **39** carry `New 2026-08-04` (the
  synthesis said 32 — seven more were filed after it was written); **34** contain
  `**done`; **23** contain `**open`; **22** have only three cells and therefore no state
  column at all; **8** more have 5–7 cells from unescaped pipes. **[verified]** V3-0.43
  is not just open, it is the reason a machine cannot read the plan.
- `meteorite/run.sh` has no stage that starts the orchestrator: its stages are
  `bootstrap-install`, `bootstrap-verify-source`, `unit-drift` (renders templates and
  diffs them — it does not *activate* anything) and the suite. **[verified]** The
  incident's claim that the proof never watches the system come up is exactly right.
- I reproduced **V3-0.40** live and by accident: my first suite run,
  `bun test 2>&1 | tail -25`, returned **exit 0** while the suite had one failure. The
  hole is still open on `main`. **[verified]**

---

## 2. Path travelled — converging or diverging?

**The engineering is converging. The measurement is not. The board is diverging.** I
think all three are true at once and collapsing them into one verdict is what makes this
question feel unanswerable.

**Converging.** Look at what the day actually closed: the 120-second harness axe
(V3-0.51) that had corrupted four rounds of work on V3-0.23; the lane-exit guard's
missing role, which had made **14 of 14** reviewer lanes report `failed`; the operator
door's two self-authorisation paths, found by the escalated tier after three standard
rounds missed them. Those are not feature rows. They are the instruments. A day spent
discovering that your thermometer reads 4 °C low is a good day, and there were several.

**Diverging.** 39 rows filed today against ~15 landed **[verified]** — and the filing
continued *after* the previous consilium named the ratio as the thing to watch. Seven
new rows appeared between that synthesis and now. At the measured unit cost (~5.8
lane-hours per landed row) and a 3-lane cap, the board grows faster than the fleet can
close it by a factor of roughly two.

**But the ratio is the wrong falsifier, and I want to correct the previous consilium
here.** It proposed tracking "rows filed by working vs rows closed" and treating an
inversion as the signal that a date is honest. That test cannot pass while the system is
still discovering that its instruments are broken, because each such discovery correctly
files a row. Worse, it can be gamed by simply not filing. The honest falsifier is
narrower: **how many rows are found by a gate versus by a human looking?** Today's three
biggest findings — the harness axe (a consilium member), the launcher gap (recovery),
the v2-deprecated checkout (me, an hour ago) — were all found by looking. The gates are
getting steadily better at the failure modes they already know and have caught **zero**
instances of the one class that decides cutover: *the running system is not the tracked
system*. Until something detects that class automatically, the discovery rate cannot
fall, and no total on the board converts to a date.

**The orchestrator's own recorded failure mode is worth restating** because I saw its
signature again in the record: a plausible explanation stated as established. The
handoff's "Live Hard Floor 5 exposure" section says the nudge timer "is armed, root,
firing every ten minutes" and "drives the fleet nudges the orchestrator acts on". Both
halves were true when written and the second half had already been false all day — it
was driving nudges computed from the deprecated board. That is not carelessness; it is
the absence of a check, described in prose that reads like a check.

---

## 3. Definition of cutover-ready

This is the section the previous session never wrote, and I agree that its absence is
why the work diverged: with no decidable target, every open row looks equally like a
blocker, and a board of 92 rows becomes undateable by construction.

**The framing that makes it decidable.** Cutover is not "finish the plan". Cutover is a
*restore-from-backup drill where the backup is the repository*. So cutover-ready is not
a property of the board at all — it is a property of one executed rehearsal. Write the
rehearsal down as gates, each of which is a command with an exit code, and cutover-ready
means: **every gate is green at one SHA, in one run, on a target that is not this host.**

Deliverable form: `instance/cutover-readiness.md` (the gate table, tracked) plus
`tools/check-cutover-readiness.sh` (runs every gate that can be run locally, and prints
`PASS` / `FAIL` / `UNKNOWN` per gate). **`UNKNOWN` is a first-class verdict and it is
not green.** Most of what is wrong today is not a red gate; it is an unmeasured one.

### Gate A — the repository is the whole system

- **A1. No break-glass.** With `orchestrator/runtime.env` moved aside and
  `/root/oldorch-breakglass/` unreadable, `bash orchestrator/launch.sh start` brings the
  orchestrator to a live session. *Today: FAIL — verified, both blockers fire.*
- **A2. Every path the launcher requires is tracked.** A checker extracts every file the
  orchestrator/ scripts and the systemd unit templates reference (`$SCRIPT_DIR/…`,
  sourced files, `ExecStart=`) and asserts each is in `git ls-files` or in the enumerated
  host-state list. Red-before evidence: deleting `orchestrator/preflight-cli-auth.sh`
  makes it red. *Today: FAIL — the checker does not exist and the file is missing.*
- **A3. Caller and callee agree.** A test extracts every `mission_cli <verb>` invocation
  from tracked shell and asserts each names a dispatchable action, mirroring what
  V3-0.15 did for `instructions/`. *Today: FAIL.*
- **A4. No host-only operating mechanism.** Every non-vendor systemd unit and timer,
  every script under `/root/.local/bin`, and root's crontab either resolve to a tracked
  path or appear in a tracked exemption list with a reason. *Today: FAIL — at minimum
  `orch-fleet-nudge.sh` plus the three other fleet scripts the handoff names.*
- **A5. Non-git state is enumerated with a verify command each** (V3-2.9), and the
  enumeration is itself checked — adding a new state path without listing it fails.
  Must include, and today does not: `runtime/state.db`, `orchestrator/runtime.env`,
  **`instance/decisions/inbox.jsonl`**, `$XDG_STATE_HOME/…/evidence`, provider CLI
  credential stores, `/root/.cache/infra-lanes/land-main`. *Today: FAIL.*

### Gate B — the rebuild is proven live, not by file copy

- **B1. The meteorite starts the orchestrator.** After `bootstrap-install`, the proof
  activates the units, starts the orchestrator, and asserts a live state: singleton
  acquired, liveness pulse advancing, `launch.sh model` reporting the pinned model.
  Removing `preflight-cli-auth.sh` from the candidate must make this stage red.
  *Today: FAIL — no such stage exists.*
- **B2. A lane runs on the rebuilt system.** In the same run, dispatch one lane, have it
  write a terminal report the guard accepts, and land nothing. *Today: UNKNOWN.*
- **B3. State restores.** The HR-2171 archive is unpacked into the rebuilt target and
  mission/lane history is intact and readable by `mission-cli status`. *Today: FAIL —
  V3-2.9 not landed.*
- **B4. Executed once on a real second machine, not only in a container.** A container
  does not test unit activation under a real systemd, linger, DNS, the provider CLIs'
  network path, or the operator's Telegram round trip. *Today: UNKNOWN — and this is the
  gate I would most expect to surprise everyone.*

### Gate C — the human steps are a finite, executed runbook

- **C1.** Every credential is named with destination, required scope and a verify
  command that exits non-zero when it is absent or wrong (V3-2.10), and the runbook has
  been executed end to end once. *Today: FAIL.*
- **C2.** The list of irreducibly manual steps (interactive `claude` / `codex` login,
  GitHub key, Telegram token, Drive share) is written, bounded, and **timed** — the
  operator should know whether cutover costs him 20 minutes or two hours of his own
  attention. *Today: UNKNOWN.*

### Gate D — the new host holds itself up

- **D1.** The orchestrator is started by its unit at boot, not by a hand-typed tmux;
  kill it and it returns within the configured interval (V3-2.1). *Today: FAIL —
  `bpa-orchestrator.service` is inactive and the live session is hand-started.*
- **D2.** The idle/autonomy watchdog is tracked, parses the board it is actually given,
  and a corrupted input makes it refuse **and** notify. *Today: FAIL — verified dead
  since 17:53.*
- **D3. Soak.** Two hours unattended on the rehearsal target with at least one lane
  progressing and no human intervention, ending in one landed row. *Today: UNKNOWN.*

### Gate E — the evidence the decision rests on is trustworthy

- **E1.** The full suite is green at the cutover SHA **both on the host and inside the
  rebuild**, each producing a trailing triple. *Today: FAIL — 1 fail on the host.*
- **E2.** No systematically false status signal: reviewer lanes reach `terminal`
  (V3-0.44, landed), and the lane-exit guard's verdict cannot be produced by a pipe
  (V3-0.40/0.48, open). *Today: FAIL.*
- **E3.** The board parses, every row has a state, and no row is open whose item the
  durable counter records as landed (V3-0.43 + V3-0.30). *Today: FAIL — 22 stateless
  rows, 8 malformed.*
- **E4.** `instance/params.yaml` matches the running installation, checked rather than
  asserted. *Today: FAIL — `top_model`.*

### Gate F — there is a way back

- **F1.** The cutover procedure names its point of no return and the rollback from each
  side of it. The cheapest honest form: **the old server is not destroyed until the new
  one has passed A–E and run a defined soak.** That converts the whole exercise from
  irreversible to reversible, which is the only reason it can be attempted at a 3-lane
  cap at all. *Today: UNKNOWN — and it is a decision for the operator, not a lane.*

### Two consequences worth stating plainly

- **V3-4.2's acceptance is wrong** and the previous consilium's Opus member was right to
  say so: "`meteorite/run.sh` green from a fresh clone" has already been satisfied twice
  while the launcher was unstartable. Under this definition V3-4.2 becomes B1+B2+B3, and
  editing that row is a five-minute orchestrator task that should happen before any lane
  is spent on it.
- **The cutover blocker set is small.** Under gates A–F, the blockers are: A1–A5, B1–B4,
  C1–C2, D1–D3, E1–E4, F1. Mapped to the board that is roughly V3-2.9, V3-2.10, V3-2.1,
  V3-4.1, V3-4.2, V3-0.43, V3-0.30, V3-0.40/0.48, plus three rows that do not exist yet
  (the launcher restore, the launcher-path checker, the live meteorite stage). **That is
  a dozen rows out of 92.** Everything else — V3-1.7, V3-1.9/1.9b/1.10, V3-1.11,
  V3-0.34/0.35/0.36/0.46, V3-3.x — is real work that does not stand between here and a
  new server. Saying so out loud is half the value of writing this section.

---

## 4. The programme

### 4.0 What the 3-lane cap changed

I had drafted eleven items against ~70–84 lane-hours. The cap gives **30–36 lane-hours**,
and at the measured ~5.8 lane-hours per landed row that is **five rows, maybe six**. Four
things follow, and I would state all four to the operator because they are not obvious:

1. **A reviewer is a lane.** A Tier-A row needs a coder lane *and* an independent
   reviewer lane. At a cap of 3, one row in flight consumes two thirds of the fleet.
   Operating rule for the sprint: **never run three coder lanes — the third slot is the
   review slot**, or nothing can be reviewed and everything queues.
2. **Merge rows instead of splitting them.** At ten lanes you split work to parallelise;
   at three lanes the per-row overhead (brief, review round, re-attestation, rebase,
   landing) dominates, so fewer larger rows are strictly cheaper. My item 1 below merges
   what I had as three separate rows. This inverts the usual advice deliberately.
3. **The landing lock is not the bottleneck and never was.** 15 landings across ~17.5
   hours at ~10 minutes of lock each is ~19 % lock utilisation **[verified from the
   commit timestamps]**. The bottleneck is review rounds and report re-issues — which is
   what the previous consilium said, and the cap makes it worse, not better.
4. **HR-2166's escalation ladder is now in tension with the cap.** The escalated tier
   needs a *second* reviewer at a raised model. At three lanes, any row that reaches it
   **stops all other work**. The trial expires 09:12 tomorrow, mid-sprint. My
   recommendation in §5.

Cut by the cap, versus my 10-lane draft: V3-0.47 (bookkeeping-vs-landing collisions —
replaced by procedure at zero lane cost), V3-0.43's checker (replaced by a hand repair),
V3-2.10 (replaced by an operator ask), and the standalone fleet-nudge row (folded into
item 3).

### 4.1 The items, in dispatch order

**Item 1 — "the orchestrator starts from git alone."** *One row, merged.*
Restore `orchestrator/preflight-cli-auth.sh` as a tracked file from `75411d9`; implement
`reap` and `lease acquire|renew|release` in `core/mission-cli.ts` against `DurableStore`;
add the two locks that make the class impossible — a launcher-path manifest test (Gate
A2) and a caller/callee vocabulary test (Gate A3).
- *Closes:* Gate A1, A2, A3. Removes the break-glass as a load-bearing component.
- *Why it earns the slot, at the expense of everything in sprint 05:* it is the only item
  on this board whose failure mode is "the system cannot be restarted anywhere". It is
  armed on every host after one lane runs. And it is bounded — the file exists in
  history, the CLI verbs are ordinary `DurableStore` work.
- *Lane-hours:* 12–14 including review. **The row of the sprint.**
- *Parallel:* yes, touches `orchestrator/` and `core/` only.
- *Evidence:* with `runtime.env` moved aside and the break-glass path unreadable,
  `launch.sh start` reaches a live session on this host; deleting the restored file makes
  the manifest test red; renaming a `mission_cli` verb makes the vocabulary test red.

**Item 2 — the meteorite starts the orchestrator and watches it come up.**
- *Closes:* Gate B1, and turns item 1 from a fix into a floor. This is the incident's own
  item 3, "the one that turns this from a bug into a class".
- *Why it earns the slot:* without it, a green meteorite can coexist with an unstartable
  launcher again tomorrow — it already did for two days. V3-0.21's gate already forces
  the proof to run on rebuild-affecting landings, so this stage inherits an executor for
  free. That is a rare bargain on this board.
- *Lane-hours:* 8–10. *Parallel:* yes with item 1; **must land after it**, or it lands red.
- *Evidence:* a `orchestrator-start` stage that asserts singleton acquired, liveness
  pulse advancing, and the pinned model reported; red-before by removing
  `preflight-cli-auth.sh` from the candidate.
- *Named risk, must be in the brief:* the meteorite already costs ~395 s and V3-0.23's
  landing died on `rebuild-proof-timeout` at the 900 s budget. This row **must** ship a
  budget increase under HR-2224's named-exception rule or it will abort every subsequent
  landing.

**Item 3 — the host-mechanism inventory, and nothing lives only on this host.**
*One row, orchestrator-led, one lane.*
Enumerate every non-vendor unit, timer, cron and `/root/.local/bin` script into a tracked
file with tracked-path-or-reason; **track `orch-fleet-nudge.sh` and fix its parser to the
board it actually reads**; enumerate the untracked state paths including
`instance/decisions/inbox.jsonl`; and publish the 100 host-only branches to origin under
a sweepable `refs/lane-archive/*` namespace (not as branches — same pattern as
`refs/meteorite-candidates/*`), or disposition them as disposable in a tracked file.
- *Closes:* Gate A4, part of A5, Gate D2. Removes the single largest silent-loss exposure
  before anyone wipes a server.
- *Why it earns the slot:* it is the inventory the cutover has to carry. Without it the
  cutover plan is a guess. And it restores the autonomy loop, which is currently dead —
  at three lanes an unattended overnight with a dead watchdog costs more than it does at
  ten.
- *Lane-hours:* 5–6. *Parallel:* yes — `instance/`, `tools/`, plus ref publication.
- *Evidence:* the checker is red when a host mechanism is absent from the list;
  `orch-fleet-nudge.sh --count-open instance/workboard.md` returns a number; `git
  ls-remote origin` shows an archive ref for every host-only branch carrying unique work.

**Item 4 — V3-0.52: "work complete, landing blocked on an artifact I may not produce."**
- *Closes:* a whole lane round from every Tier-A row. Unsticks V3-0.30 r5 and V3-2.9 today.
- *Why it earns the slot under the cap, and why I kept the *only* gate-tax row I kept:*
  at three lanes a wasted round is a third of the fleet for hours. If three or more rows
  land after it, it pays for itself inside the sprint. It is also the cheapest item on
  the previous consilium's sprint 05.
- *Lane-hours:* 4–5. *Parallel:* yes — `gate/`.
- *Evidence:* drive one row from review-pending to landed with no re-issue; a genuinely
  incomplete row still refused.

**Item 5 — orchestrator only, no lane: write the gate table.**
`instance/cutover-readiness.md` (§3 above, as tracked acceptance) plus
`tools/check-cutover-readiness.sh` printing PASS/FAIL/**UNKNOWN** per gate; rewrite
V3-4.2's acceptance to B1+B3; correct `params.yaml:74` to HR-2315; push `2c0499c`;
hand-repair the 22 stateless and 8 malformed workboard rows from landing evidence (never
guessed).
- *Why it earns a slot:* **it costs zero lane-hours**, which under the cap is exactly why
  it survives. It is also the sprint's headline deliverable: at hour 12 the operator runs
  one command and sees where he stands.
- *Orchestrator-hours:* 2–3, interleaved with dispatch.

### 4.2 Schedule against three lanes

| hour | lane A | lane B | lane C |
|---|---|---|---|
| 0 | item 1 (launcher) | item 4 (V3-0.52) | item 3 (inventory) |
| ~3 | item 1 cont. | **review of item 4** → land | item 3 cont. |
| ~4–5 | item 1 → review | item 2 (meteorite) | **review of item 3** → land |
| ~7 | **review of item 1** → land | item 2 cont. | slack / recut |
| ~9 | slack / recut | item 2 → review | **review of item 2** → land |
| 10–12 | landings, gate table run, report | | |

Two slack windows are deliberate: at the measured rejection rate one of these four rows
will need a second round, and a programme with no slack at a 3-lane cap simply fails
silently. Orchestrator work (item 5) runs continuously and never occupies a lane.

---

## 5. What I deliberately cut, and the risk I accept

- **All of sprint 06 — the operator door and the privilege boundary** (V3-0.29 at round
  5, V3-1.9, V3-1.9b, V3-1.10). The operator's stay-on-root ruling removes the
  precondition, and V3-0.29 is explicitly open-ended. *Risk accepted:* the orchestrator
  can still forge its own authorisations and the model pin stays tamper-**detecting**,
  not tamper-proof. On a root box the operator is personally running, that is a risk he
  already holds knowingly.
- **Most of sprint 05.** I keep exactly one gate-tax row (V3-0.52) and drop V3-0.47,
  V3-0.40/0.48, V3-0.43's checker, V3-0.49, V3-0.53, V3-0.54, V3-0.31, V3-0.39, V3-0.44
  follow-ups. *Risk accepted:* the per-row tax stays roughly where it is, so the road
  after this sprint stays ~5 working days rather than shrinking. **This is the sharpest
  disagreement I have with the previous consilium**, and I want it recorded as a
  disagreement: their sprint 05 was correct for a ten-lane fleet where paying tax down
  first compounds across many parallel rows. At three lanes the compounding is a third as
  strong, while the launcher gap's blast radius is unchanged. The economics flipped when
  the cap landed.
  - *Mitigation at zero cost:* V3-0.47 becomes a procedure, not a row — the orchestrator
    does not push bookkeeping while a landing is in flight, and waits on the lock with
    `until flock -n …; do sleep; done` rather than testing it. Both are already recorded
    operating rules; they just need obeying.
- **The 176 untriaged inbox rows.** I file the finding, enumerate the file as untracked
  state (item 3), and do **not** spend a lane triaging. *Risk accepted:* Hard Floor 2 stays
  breached for another day and the count grows. I judge the enumeration more urgent than
  the triage because the file being untracked is what makes the backlog *unrecoverable*;
  the backlog itself is merely large. **The operator should overrule me if any of those
  messages contains a requirement he expects to be honoured.**
- **V3-0.46 / V3-0.49 — branch and worktree breeding** (147 branches, 165 worktrees,
  +40/day). *Risk accepted:* it keeps growing. My reasoning for cutting it is that
  **cutover makes it moot** — the new host starts clean — which is an argument for doing
  cutover sooner, not for fixing it now. Item 3 handles the only part that is
  irreversible: not losing the work.
- **V3-1.11 (hardware negotiation), V3-1.12, V3-3.x, V3-3.9, V3-3.10, V3-4.4, V3-1.7.**
  *Risk accepted on V3-1.11 specifically, and I flag it because the previous consilium
  dismissed it on a premise that is now wrong:* it said "cutover targets the same
  hardware", but the operator's framing today is *a new server*. Every constant in this
  repository — fleet floor 10, suite deadlines, concurrency — travels unchanged.
  **[guess: a comparable box makes this harmless]**, but Gate E4 should at least record
  the constants and their derivation so the mismatch is visible rather than silent.
- **The HR-2166 ladder trial measurement.** The trial expires 09:12 tomorrow, mid-sprint.
  I would **extend it rather than measure it**, and say why: this sprint's rows are
  narrow and mechanical, which is the least informative possible sample for a ladder
  designed for hairy rows — and at three lanes the escalated tier consumes the whole
  fleet, so a measurement taken now would be dominated by the cap, not by the ladder.

---

## 6. The measurement — what must be true at hour 12

Falsifiable, in the order I would check them:

1. **`bash orchestrator/launch.sh start` brings the orchestrator up with
   `orchestrator/runtime.env` moved aside and `/root/oldorch-breakglass/` unreadable.**
   Binary. If this is not true, the sprint failed at its main job regardless of what else
   landed.
2. **`bash tools/check-cutover-readiness.sh` exists, runs, and prints a verdict for every
   gate in §3, with zero `UNKNOWN`.** A gate may legitimately be `FAIL`; none may be
   unmeasured. This is the deliverable the operator actually holds at the end.
3. **The meteorite at the final SHA reaches an `orchestrator-start` stage that observes a
   live orchestrator, and the recorded red-before shows that stage failing when
   `preflight-cli-auth.sh` is removed from the candidate.**
4. **`git ls-remote origin` covers every branch in the lane clone carrying commits not on
   `main` — host-only-unique-work count is 0, down from 100.**
5. **`bun test` at the final SHA on this host is green** (599/1 → 600/0 or better), and
   the run produces a trailing triple. If the inbox check is still red, the sprint must
   say so as `NO-GO` and not relabel it.
6. **Rows landed ≥ 4.** Below four, the 5.8-lane-hour unit cost is wrong by more than 2×
   under the cap, and every road-to-cutover total on the board must be re-derived before
   the operator is given any estimate at all.
7. **Rows filed during the sprint < rows closed during the sprint** — and, the sharper
   test I proposed in §2, **at least one row filed during the sprint was filed by a gate
   rather than by a person looking.** If the second is still zero at hour 12, the
   discovery rate has no reason to fall and no date is honest yet. That is the number I
   would put in front of the operator at hour 12, above the row count.

---

### Sources I opened, for the record

`CLAUDE.md` · `instance/workboard.md` (all 252 lines) ·
`instance/in-flight-2026-08-04-evening.md` ·
`instance/consilium-sprints-2026-08-04-synthesis.md` · `-opus.md` (§5) ·
`instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md` ·
`instructions/reproducible-from-git.md` · `instance/params.yaml` ·
`instance/decisions/HR-2315.md` · `orchestrator/launch.sh` · `core/mission-cli.ts` ·
`meteorite/run.sh` · `/root/.local/bin/orch-fleet-nudge.sh` ·
`/root/.cache/infra-lanes/fleet-nudge.log` ·
`/root/.cache/infra-lanes/v3-2.9-rebase-only.report.md` · `git reflog` · `git worktree
list` in both `/root/bpa-dev-infrastructure` and `/root/.cache/infra-lanes/land-main` ·
`systemctl` units and timers · one full `bun test` run.

Nothing was modified. No commit, push, dispatch or landing was performed. The break-glass
in `orchestrator/runtime.env` and `/root/oldorch-breakglass/` was read for key names only
and left untouched.
