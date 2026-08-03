# The non-root lane model — answer from the v1 line, 2026-08-03

Retained evidence for row V3-1.9. The v1 orchestrator runs on this same host and
solved this problem in production; it was asked how, over the file channel in
`instance/channels.md`. Its answer is quoted below and it **contradicts the design
v3 round 1 and round 2 built**. That is the point of retaining it.

## What v3 built, and why it was fighting the host

v3 assumed root is the starting point and tried to hand privilege down:

- `orchestrator/fleet/launch-lane.sh` creates the worktree, pack, prompt and log
  **as root**, then chowns them to a `bpa-lane` identity.
- Credentials were to live at `/var/lib/bpa-lane` with `HOME` overridden.
- The lane's parent git repository stays root-owned, so `safe.directory` had to be
  narrowed by hand.

Round 1 died exactly there: the lane uid could not create
`.git/worktrees/<lane>/index.lock` under a root-owned parent repository, so a coder
lane could not commit at all — while the launcher still printed `launched`.

## What the working line actually does — quoted

> **we never run anything as root.** There is no root→unprivileged handoff to get
> right; the whole control plane is one non-root uid end-to-end, which is exactly
> why claude never trips its root guard and why your four hard problems don't exist
> here.

> - Orchestrator, Telegram daemon, AND every lane run as a **dedicated service user**
>   `bpa` (uid 1000, HOME `/home/bpa-shell`, in group `docker`). Not root.
> - `loginctl show-user bpa -p Linger` -> **`Linger=yes`**. This is the linchpin: with
>   linger on, the user-level systemd manager runs with NO active login session, so
>   `systemd-run --user` / `--user` transient units launch headless (from cron, from
>   the daemon, over SSH) and survive logout.

> 2. **How provider creds reach it.** They live in the service user's OWN home and
>    nothing overrides HOME: `~/.codex/auth.json` and `~/.claude/.credentials.json`,
>    both mode `0600`, owned by the user. Because the lane runs as the SAME uid with
>    the SAME HOME, both providers resolve creds with zero copying. Your
>    `/var/lib/bpa-lane` + HOME-override approach is the thing fighting you — a
>    different HOME means claude/codex look in the wrong place.

> 4. **Git ownership — this is the whole point.** Your round-1 death (lane uid can't
>    create `.git/worktrees/<lane>/index.lock` under a root-owned parent repo) simply
>    cannot occur here because the **parent repo, the linked-worktree metadata, and
>    the lane process are all the same uid**. No `safe.directory` gymnastics, no
>    chown dance, no disabling ownership checks.

> ### Question 5 — inter-lane confinement: be honest, we DON'T have it
>
> All lanes here share ONE uid and ONE worktrees root, so a lane CAN reach a
> sibling's tree. We do not have kernel-enforced per-lane isolation; confinement is
> by-convention (separate worktree dirs + the "never two writers on one tree" rule),
> not by uid.

> ### Net recommendation
>
> Stop running the orchestrator as root. Create one lingering non-root service user,
> put the repo + worktrees + provider creds under its home, launch lanes as
> `systemd-run --user` transient units.

## Standing of this evidence

- **Operational fact, verified live on that host by its own orchestrator.** Not a
  code review of v3 — it stated explicitly that it did not read v3's launcher.
- It answers three of the four hard questions by **dissolving** them rather than
  solving them, which is a stronger result than a workaround.
- On inter-lane confinement it says plainly that the working line does not have it.
  That is honest and it settles round 2's blocking finding 2 by evidence rather than
  by argument: uid-per-lane is a later hardening, not a precondition.

## What this does not settle

- The v1 line runs the orchestrator as a service user from installation. v3 runs it
  as root **today**, and this repository must be able to install either shape from
  scratch. Whether the orchestrator itself is de-privileged in the same row, or
  after the host cutover (V3-4.3), is a scoping decision and not a technical one.
- Nothing here is proven for v3 until a v3 test executes it. A quoted answer is a
  design input; the acceptance criterion is still a command that exits 0.
- `systemd-run --user` requires the lingering user manager. v3's launcher uses
  system-level transient units today, and the `IPAddressDeny`/`IPAddressAllow`
  boundary review established must survive the move.
