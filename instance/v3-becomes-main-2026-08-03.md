# v3 became `main`, old `main` archived as `v2-deprecated` — 2026-08-03

## The Human's instruction

Vova, Telegram 1746 then 1749 (verbatim, after the orchestrator raised an objection
and he reaffirmed):

> так, давай нагадаю тобі один момент. у нас в майстер була стара версія, від якої ми
> відмовляємось. ми ж робимо версію третю, де, як ти сказав, одружуємо першу і другу
> версію, те, що з них працює, і створюємо третю. і в третій я хотів, щоб була пуста
> історія. от тому ми робили такий новий бранч. якщо допоможе, давай його в main
> запихнемо, а main просто бекапнемо, бо мені треба бекап, бо ми ще далі будемо над
> ним працювати і буде потреба дивитись на стару реалізацію. ну і для історії можна
> зберегти.

The orchestrator had objected on the grounds that v3 has fewer files than main. That
objection misread the direction of travel: `main` held the **old** version being
abandoned, and v3 is the deliberate from-scratch third version with empty history
(HR-1718). Being smaller is the point, not a defect. He reaffirmed, so it was done.

## What changed

| ref | before | after |
|---|---|---|
| `main` (local and origin) | `1fef8c8` old implementation | **`99db22d`** — v3 |
| `v2-deprecated` (local and origin) | did not exist | **`08b9855`** — the old `main`, complete |
| `v3` | `99db22d` | unchanged |
| checked-out branch on this host | `main` | **`v2-deprecated`** |

Order of operations, chosen so the running system was never at risk:

1. `v2-deprecated` created at the old `main` tip and **pushed to origin first**, so the
   backup was durable before anything was overwritten.
2. Working tree switched to `v2-deprecated`. Because that branch pointed at the exact
   same commit, **zero files changed** — verified by md5 of `daemon/server.ts` before
   and after (`65799cb2…` both times).
3. `git branch -f main v3`, then `git push origin main --force`
   (`+ 1fef8c8...99db22d main -> main (forced update)`).

## The thing to know about this host

**This machine still RUNS the old implementation.** The checked-out branch is
`v2-deprecated`, not `main`.

That is deliberate. `bpa-telegram-daemon.service` has
`WorkingDirectory=/root/bpa-dev-infrastructure/daemon` and runs `bun run server.ts`
straight from this working tree. v3 carries a different daemon implementation (43
files against 55). Checking out the new `main` here would swap the live Telegram
daemon — the only channel the Human has to the orchestrator — for an implementation
that has never been run. Daemon confirmed `active` after the ref change.

So the branch topology now says what the Human wants — anyone cloning gets v3 as
`main`, and the old implementation is at `v2-deprecated` for reference — while the
host continues on the known-good tree until a deliberate cutover.

## What a cutover on this host still requires

Not yet done, and not to be done opportunistically:

1. v3's daemon proven to start, hold the Telegram channel, and survive a restart.
2. `bootstrap/` — absent from v3. It is the only tracked path that rebuilds this host,
   so until v3 carries an equivalent, Hard Floor 5 is not satisfied by v3 alone.
   `v2-deprecated` currently holds the only copy.
3. The 8 missing system units (HR-1720) deployed from whatever replaces `bootstrap/`.
4. `gate/land.sh --target-branch`, in flight, since landing onto anything other than
   the default branch is impossible today.

## Consequences for existing work

- ~995 local branches and all `refs/archive/2026-08-03/*` descend from the old `main`
  and are therefore unrelated to the new `main`. They remain valid against
  `v2-deprecated`. Any "unmerged" count computed against the new `main` will read as
  the full set, because the histories are disjoint — that is expected, not a regression.
- The candidate lane `worktree-agent-a4bb8550a6a3b1b39` (stable mission identity,
  round 2 in flight) branched from the old `main` and lands to `v2-deprecated`, or
  needs porting to v3. Its subject — `core/state.ts` mission identity — exists on both
  branches, so it is portable.
- The reap evidence, consilium reports, and decision records committed today live on
  `v2-deprecated`. They are repository history for the old line; nothing on the new
  `main` references them yet.
