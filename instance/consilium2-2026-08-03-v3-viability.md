# Consilium round 2 — can v3 be finished with the current infrastructure?

Convened by Vova (Telegram 1736). Two seats, both sonnet (quota 20% Codex / 10%
Claude). Base SHA `4aaaeec`. Round 1: `instance/consilium-2026-08-03-sprint-review.md`.

His question, verbatim:

> Ой це все погано виглядає…Є якісь прості фікси для поточноі інфри щоб адекватно
> доробити в3? Бо тут дуже багато проблем і ми власне намагаємось їх вирішити у в3.
> Тож тут треба чіткий план дій… можн перепитати щє раз консиліум зі свіжою інфою?

The two seats reached **opposite conclusions**. Both are evidenced, and every
load-bearing claim below was re-verified by the orchestrator before this report — the
seats' word alone was not enough for a finding this consequential.

---

## Finding 1 — `gate/land.sh` cannot land onto `v3` at all

`gate/land.sh:107-122` resolves `default_branch` from `origin/HEAD` and then hard-fails
unless the checked-out branch equals it:

```sh
default_ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD ...)
default_branch=${default_ref#origin/}
current_branch=$(git -C "$repo" branch --show-current)
if [ "$current_branch" != "$default_branch" ]; then
  echo "LAND default-branch expected=$default_branch current=${current_branch:-detached}" >&2
  land_fail default-branch 2
fi
```

Verified: `git symbolic-ref refs/remotes/origin/HEAD` → `refs/remotes/origin/main`.

So checking out `v3` and running the gate fails at the `default-branch` check, every
time. **No candidate can be landed onto `v3` through the landing gate as it exists.**
Not "slowly" — not at all. Every v3 lane that finishes clean work has nowhere to put it.

Fix: a `--target-branch` argument used in place of the derived default for the
current-branch check and the `origin/$target` freshness comparison, defaulting to
today's behaviour when omitted. ~2-3 lane-hours.

## Finding 2 — nothing makes a lane pin its report before its session ends

`gate/completion-guard.ts` is the only tool that checks `commit:` == branch tip, and
it is called **only** from `gate/land.sh` and `gate/land-batch.sh` — no other call
site exists in `orchestrator/`, `daemon/`, or `core/`. Landing happens sessions or
days later, when the lane that could fix its own report is gone.

That is the mechanism behind the measured 6-of-1314
(`instance/landable-candidates-2026-08-03.md`). The enforcement point should be the
lane's own composed prompt, so a lane may not end while the guard exits non-zero.

## Finding 3 — v3 is behind main, and its acceptance gate does not exist

This is the seat that disagrees with the plan, so its claims were verified one by one:

| claim | verification | result |
|---|---|---|
| v3's 55 commits span 95 minutes | `git log v3 --format='%ci'` | 2026-08-02 **14:41:01 → 16:16:56** — confirmed |
| the meteorite gate is absent on v3 | `git ls-tree -r v3` | no `meteorite*` path exists — confirmed |
| main already has meteorite work | `git ls-tree -r main` | `meteorite/run.sh`, `meteorite/meteorite.test.ts`, `bootstrap/units/bpa-meteorite.{service,timer}.in` — confirmed |
| v3's `land.sh` is a frozen copy | sha256 of `main:gate/land.sh` vs `v3:gate/land.sh` | **identical** (`ddd457ca…`) — confirmed |
| v3 lacks gate hardening added after the fork | file count under `gate/` | main **17**, v3 **6** — confirmed |

The consequence is uncomfortable but factual: **v3's stated acceptance bar — the
9-assertion Docker meteorite gate — was never built.** "v3 core ~70%" is therefore
measured against a gate that does not exist, which makes it unfalsifiable rather than
70%. Meanwhile main carries `bootstrap/`, `database/`, `deploy/`, `edge/`, `hygiene/`,
`meteorite/`, `preview/`, `soak/`, `stand/`, `workspace/` and 11 gate files that v3
would have to re-earn from zero, and v3's copy of the landing gate is drifting stale
by construction — it can never receive the hardening tests added to main after the fork.

What v3 genuinely has that main does not: `orchestrator/dispatcher.ts` and
`orchestrator/supervisor.ts` — a real claim-and-fence dispatch primitive with no
equivalent on main. That is the asset worth preserving, and it is two files plus tests.

## Finding 4 — today's reap is not durable

`crontab -l` → **"no crontab for root"**. `hygiene/install-cron.sh` is tracked and was
never invoked. So the reap executed today (1372 → 995 branches, 14 GB of worktrees
still on disk) has nothing preventing regrowth at the measured ~3.5 GB/day. Same shape
as every other finding today: the mechanism is written, tracked, and not running.

Not acted on: installing a cron is host-mechanism deployment, which HR-1720 defers to
v3. Flagged rather than fixed, with the consequence stated.

---

## The decision this puts in front of the Human

The two seats point the same way from opposite directions. Seat A says v3 cannot
receive landed work; seat B says v3 has less than main and no gate to prove otherwise.
Neither is an argument against a rewrite in principle — HR-1718 already settled that
the orphan history is deliberate and the cutover comes last. Both are arguments that
**v3 in its current shape is not yet a working vessel**, and that continuing to pour
lane-hours into it without fixing Finding 1 produces work that can physically never land.

Two coherent options. This is a product-direction call and belongs to him:

**Option A — make v3 a real target.** Fix `--target-branch` (Finding 1), fix lane
report pinning (Finding 2), then build the meteorite gate on v3 so "done" becomes
decidable. Keeps his stated plan intact. Cost: v3 re-earns the ten directories and 11
gate files main already has, and its landing gate stays a stale copy until it is
re-synced.

**Option B — port the asset instead of the branch.** Bring `dispatcher.ts` and
`supervisor.ts` (plus their tests) onto main as a reviewed feature, and keep the
hardening, evidence trail and gate work already there. v3 becomes the design source
rather than the destination. Cost: contradicts the from-scratch intent of HR-1718, and
the orphan history is discarded.

Finding 1 and Finding 2 are worth fixing under **either** option — under A they unblock
v3, under B they unblock everything. That is where the next lane-hours should go
regardless of which he picks.

## Recommendation

Fix Findings 1 and 2 now — they are cheap, they are prerequisites either way, and one
of them means the current setup cannot land a single line onto v3. Put the v3-versus-port
decision to him with the evidence above rather than assuming it, because the honest
measurement contradicts the plan of record, and that is his call to make, not the
orchestrator's.
