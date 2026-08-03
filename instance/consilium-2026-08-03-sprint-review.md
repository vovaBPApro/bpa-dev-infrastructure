# Consilium report — 2026-08-03 sprint review

Convened by: Vova (Telegram 1702), under orchestrator supervision.
Base SHA: `1fef8c89be9e7215b75e7cdf97db769822980c1a` (main, clean).
Seats: 4 role-diverse sessions (HR-212 / HR-1565), all on sonnet — scarce-provider
justification: Claude quota at 10%, Codex at 20% (Vova, Telegram 1702), so no seat
was raised on a scarce tier.

His questions, verbatim (Telegram 1702):

> нам треба розібратись що в нас тут відбувалось і чого так багато бранчів, чого
> воно вночі все встало і як нам бляха доробляти в3 з такими пріколами

---

## 1. What actually happened overnight

The fleet was **not** idle. 1063 lane-completion events reached the orchestrator
between 23:00 and 08:22 (peaks: 190/h at 02:00, 189/h at 07:00). Work ran all night.

What was idle is **landing**: 67 commits reached `main` in 24h while 1314 branches
did not. The dispatch rate and the landing rate have been decoupled for two days.

Correction to an earlier report to the operator: the 02:24 timestamp is the mtime of
the newest `orchestrator/runtime/*.task.md`, not the last activity. Lanes named
`fill33/34/35-*` finished at 08:08–08:22 with no corresponding task file — dispatch
bookkeeping and lane execution disagree, which is itself a defect.

## 2. Why there are 1314 unmerged branches

Split by tip commit tag: **889 `[REVIEW]`, 403 `[CODER]`, 3 `[ORCH]`**.
Created: 492 on 08-03, 681 on 08-02, 154 on 08-01, 44 on 07-31.

### 2a. The review multiplier (889 branches)

`instructions/review-policy.md` requires three independent lenses (security,
operations, regression) against the **same SHA**, and any rejection parks the item.
A fix produces a new SHA, and no rule carries a prior ACCEPT forward — so all three
lenses re-spawn. There is no round cap and no scope freeze. One item therefore costs
`rounds × 3` branches, unbounded.

Worked example — the `authority` epic: **184 branches** (14% of all unmerged),
rounds r6 through r23, zero landed.
- r19 (`1503a6f`): security REJECT — `test-authority@../foreign.service` crossed the
  namespace boundary (`collect_instances` checked prefix/suffix, not a unit-name
  grammar); the no-mutation lock used `! grep -Eq ...` under `set -e`, which Bash
  does not fail on — a textbook false-green. Operations and regression also REJECT.
- r21 (`bf44830`): a *new* defect class (provenance/topology ancestry mismatch).
  All three lenses reject again, including security, which had no stake in it.
- r22 (`880421d`): security **ACCEPT**; operations and regression REJECT on
  "residue false-green" — again a class not previously audited.
- r23: security and operations re-spawn against yet another candidate.

Verdict: the gate **oscillates rather than converges**. Within one lens, fixed
defects stay fixed — that is real progress. But "all three green at one SHA" is never
reached, because the audit prompt is open-ended prose, so each round discovers a
genuinely new defect class and restarts the lenses that had already passed.

### 2b. Why coder work does not land (403 branches)

Sampled 39 usable `[CODER]` tips. **Zero git conflicts in any sampled branch** — the
bottleneck is not merge friction:

| reason | count | share |
|---|---|---|
| review required by `gate/review-policy.conf`, no `.review.md` ever produced | 16 | 41% |
| lane never produced a terminal report (fails `completion-guard`) | 10 | 26% |
| duplicate/superseded recut (r3/r4/r5/r7/r9 of one mission, olds left in place) | 5 | 13% |
| gate-ready, landing simply never attempted | 4 | 10% |
| reviewed and REJECTED/NO-GO | 3 | 8% |
| empty/phantom branch (0 commits ahead) | 1 | 3% |

The landing path itself is expensive and manual: `gate/land.sh:88-90` takes an
exclusive `flock`, then `gate/land-lib.sh:41-70` runs `bun build` across all 108
tracked sources plus the **entire** test suite **twice** (pre-merge baseline and
post-merge declared-checks). Nothing calls it on a schedule —
`orchestrator/fleet/land-branch.sh` is a disabled tombstone. Landing happens only
when an orchestrator session spends attention on it. `gate/land-batch.sh` requires
disjoint paths between branches, which most real branches fail because they touch
shared docs.

## 3. Why it went quiet — and the finding that explains two days

**The watchdog has not been running since 2026-08-01 12:35:57Z.** Verified directly:

```
$ ls ~/.config/systemd/user/timers.target.wants/
orch-memory-sweep.timer -> ...          # the ONLY armed timer

$ tail -1 orchestrator/runtime/watchdog.log
2026-08-01T12:35:57Z WATCHDOG restart-suppressed reason=dead since_s=112 \
  cooldown_s=1800 night=0 action=none
```

`orch-runtime-watchdog.timer` exists in `~/.config/systemd/user/` but has no symlink
in `timers.target.wants/` — installed, never armed (`install-watchdog.sh` separates
install from arm by design). Its last recorded act was to suppress a restart of a
**dead** orchestrator because of cooldown, and then it stopped running at all.

Consequence: for over two days nothing checked orchestrator liveness, nothing
restarted it, and nothing escalated to the Human. This is the mechanism behind every
"чого воно встало / чого тиша" complaint since Aug 1.

`instance/params.yaml:54 notify_human_below: 3` is **dead config** — it appears
nowhere in the codebase except its own declaration. The "watchdog messages HIM
directly below 3 lanes" behavior described in that comment does not exist.

The `fatal: invalid reference: <sha>` alerts (00:52, 01:09, 02:04, 02:32, 02:35) are
real git errors from the orchestrator's own dispatch commands, caught by
`terminal-alert.ts:180-188` scraping the pane. By design
(`terminal-alert-delivery.ts:27-32`) they are journaled only, never relayed — correct
in itself, to avoid a feedback loop, but with the watchdog disarmed nobody was
listening on any channel.

The 11:03 reboot was clean and human-initiated (`systemd-logind: "The system will
reboot now!"`), not a crash.

### Deeper cause, found after the consilium closed

The watchdog is not merely unarmed — **its canonical system units were never deployed
to this host at all.** `bootstrap/check-unit-drift.sh` (exit 1, correctly fail-closed)
reports 8 missing units in `/etc/systemd/system/`:

```
DRIFT bpa-orchestrator-watchdog.service   DRIFT bpa-orchestrator-watchdog.timer
DRIFT bpa-deploy-drift-guard.service      DRIFT bpa-deploy-drift-guard.timer
DRIFT bpa-meteorite.service               DRIFT bpa-meteorite.timer
DRIFT agentic-bpa-db-grants.{service,timer}   DRIFT agentic-bpa-staleness.{service,timer}
DRIFT agentic-bpa-stand-verifier.service
```

The user-level copies under `~/.config/systemd/user/` are the *legacy* ones the
2026-08-01 incident already ruled non-canonical, and none is armed —
`timers.target.wants/` holds only `orch-memory-sweep.timer`.

Note what is in that missing list: **`bpa-deploy-drift-guard`**, the timer whose whole
job is to detect exactly this drift. The guard that would have caught the gap is
itself part of the gap, which is why nothing reported it for days. This is a Hard
Floor 5 finding — the repository carries the units, the host does not run them.

`bootstrap/install.sh` is the tracked path that closes this, but it is not a small
act: its plan includes an apt/bun check, a repo fast-forward, the full daemon/core/
gate/stand/workspace test sweep, and an activate step that runs
`systemctl enable --now bpa-orchestrator.service` — i.e. it restarts the live
orchestrator session. It needs a maintenance boundary, not an opportunistic run.

## 4. Telegram: what "delivered" means

`delivered` is honest. `daemon/history-logger.ts`'s `applyOutboundHistory` is a global
grammY transformer (`daemon/server.ts:536`) that writes `delivered` only after
`await prev(...)` returns — the Bot API accepted the call. It never means "enqueued".

Two things nonetheless destroyed the operator's signal:

1. **A naming collision.** The 1063 `autonomy nudge delivered` journal lines come from
   `daemon/autonomy-keepalive.ts:47-63` — a **tmux paste into the orchestrator's own
   pane**. They never touch `bot.api` and never reach Telegram. Reading the journal
   for "delivered" conflates two unrelated channels.
2. **What he did receive was noise.** The 00:55–04:25 stream was a genuine send to his
   chat, but every message was an identical 123 bytes at a 10-minute cadence — an
   automated stall alert re-firing (`daemon/server.ts:4090-4134`, `evaluateStall`),
   not a progress report. No orchestrator-authored report was sent in that window at
   all. That is why "він регулярно казав що щось робиться" while nothing was reported:
   the cadence was a machine, not a status.

The watchdog auto-relay (`daemon/server.ts:1854-1943`) is real Telegram traffic but
carries `disable_notification: true` (line 1907) — silent by design, and it fired only
3 times in the stall window, ~90 min apart.

Open item, not fully pinned: the exact call site of the 123-byte sender. The
10-minute cadence matches `watchdog_interval_seconds: 600`, but the watchdog process
was provably not running, so attribution rests on `evaluateStall` re-firing under a
fresh `alertKey` per doomed mission attempt.

## 5. v3 — orphan by design, not by accident

**Operator correction (Vova, Telegram 1718, 2026-08-03), verbatim:**

> гілка v3 — orphan так це норм, я і хотів щоб там почали з пустої історіі бо це
> абсолютно нова версія яку ми в майстер поки не мержимо, поки треба допилити це в
> цій гілці і тоді вже будемо тустувати розгортати і вже в самому кінці перенесемо
> її в мейн

This supersedes the framing below. The orphan history is deliberate: v3 is a
from-scratch rewrite that is intentionally NOT merged into `main` until it is
finished, tested and deployed; the move to `main` is the last step, not a missed one.
"0% integrated" is therefore **not a defect and not a progress measure** — the only
meaningful measure of v3 is progress against v3's own acceptance bar (the meteorite
gate), which is how the table below should be read. The measurements are unchanged
and still correct; only the interpretation was wrong.

The verified facts:

```
$ git merge-base main v3
                                  # empty — no common ancestor at all
$ git ls-tree main orchestrator/ | grep -E 'dispatcher|supervisor'
                                  # ABSENT on main
$ git ls-tree v3   orchestrator/ | grep -E 'dispatcher|supervisor'
orchestrator/dispatcher.ts  orchestrator/dispatcher.test.ts
orchestrator/supervisor.ts  orchestrator/supervisor.test.ts
```

55 commits sit on `v3`. The hierarchy engine — dispatcher and supervisor — exists
**only** there. `main`, which is what actually runs today, has neither file — as
intended, until v3 is finished and cut over.

Per `reports/v3-plan-2026-08-02.md`, v3's acceptance bar is a 9-assertion Docker
"meteorite" gate (`scripts/meteorite.sh`) from a clean clone, after which a D1–D7
runway still stands between it and production. That plan's own terminal line already
says v3 is NO-GO for cutover.

### Honest progress, measured against `main`

| block | operator's number (msg 1642) | defensible number | why |
|---|---|---|---|
| v3 core | ~70% | ~70% against v3's own bar | measured on the `v3` branch, which is where v3 is *supposed* to live until the end (Telegram 1718); the meteorite gate is the bar, not merge-into-main |
| authority / W-48 | ~45% | **~15–20%** | 1 of 6 V3-GAPs landed (GAP-5); GAP-1/2/4/6 only rejected rounds; GAP-3 untouched |
| provider boundary | ~25% | **unverifiable** | no tracked workboard row or acceptance criterion exists |
| checkpoint/recovery | ~35% | ~35% | matches W-31 (blocked on W-37) and W-38 (Tier-A + rehearsal NO-GO) |
| landing/recovery | ~80% | ~80% | the most honest number — the gate is real and 67 commits prove it works |
| sprint-close | ~30% | **~0%** | 44 commits, 39 of them REJECT/NO-GO — a false-green chase that never landed |

## 6. Disk

`/root/.cache/infra-lanes`: 6382 dirs, 14 GB, growing ~3.5 GB/day since Jul 29.
1393 registered worktrees. Disk is fine today — 244 G free of 407 G, 37% used, 60+
days of runway — but `hygiene/reap.sh` is report-only by default
(`instructions/lane-lifecycle.md:22`) and is wired into **nothing** except
`soak/chaos.sh`, a test. Growth has no automatic backstop.

---

## Recommendations, ranked

Ordered by operator-visible pain removed per unit of work. Items 1–3 cost almost no
model quota, which matters at 20% Codex / 10% Claude.

1. **Arm the watchdog** — `orchestrator/install-watchdog.sh arm`. One command.
   Restores liveness, restart and escalation coverage absent since Aug 1. Without
   this, every other fix can silently stop again tonight.
2. **Wire or delete `notify_human_below`** (`instance/params.yaml:54`). Config that
   promises Human escalation and delivers nothing is worse than no config.
3. **Reap.** Classify all 1314 unmerged refs into landed-ancestor (delete),
   protected/in-review (keep with a tracked one-line reason), abandoned (park with
   reason). Delete the ~13% duplicate recut chains, keeping only the highest-r branch
   per mission id, and the 3 REJECTED branches. Pure git, zero model quota. Then
   schedule `hygiene/reap.sh` on a timer so worktrees self-bound.
4. **Bound the review gate** — the single highest-leverage code change:
   - a hard round cap (3) in `review-policy.md`; beyond it escalate to design-reset or
     Human instead of spawning r(n+1);
   - carry forward a lens's ACCEPT when the new diff does not touch that lens's
     surface, so only rejecting lenses re-review the delta;
   - replace the free-text per-round audit prompt with one committed, versioned lock
     suite, so ACCEPT means "this fixed suite is green", not "the reviewer found
     nothing new this round".
5. **Make landing cheap and automatic** — scope `land_run_declared_checks` to the
   branch's changed files instead of the whole repo and drop the redundant pre-merge
   baseline run (`gate/land-lib.sh:41-93`); add a serial `gate/land-sweep.sh` plus
   timer that iterates ready branches until none remain. Regression-lock both.
6. **Recover, then stop starting.** Roughly 16–20% of the 403 coder branches are worth
   landing once (5) is in. Do not re-dispatch the 26% with no terminal report.

### Stop-doing list

- Fleet-floor-10 overnight waves until landing throughput matches dispatch rate.
- The sprint-close round loop (39 rejects, 0 landings) — do not dispatch r8+.
- New V3-GAP work before GAP-1/2/4/6 have a landed candidate.
- New PR-* product work — none of it is v3-gated and it competes for scarce quota.

### Estimate

Under our own parallel infrastructure (per his Telegram 1494, not a single-threaded
estimate): with branches reaped and dispatch capped at ~5 well-scoped lanes,
V3-GAP-1/2/4/6 are 1–2 focused lane+review cycles each — roughly **3 working days**
of disciplined parallel dispatch. The assumption that makes it true is the bounded
review gate in (4); the specific thing that breaks it is dispatching another
floor-10 wave before the reap.

### Decisions for the Human

The recommendations above are the consilium's; none has been executed. Arming the
watchdog (1) and the reap (3) are the two that change host state and should be
confirmed before they run.
