# The orchestrator could not start from the repository, 2026-08-04

Recorded because this is the first measured, live failure of the meteorite test on the
mechanism the whole control plane depends on: **the launcher itself**. It was found by
recovery, not by any gate, and it is currently worked around by a file that is not in git.

## What happened

The orchestrator session died and did not come back. Every `/start_claude` and
`/start_codex` failed. Recovery (the previous orchestrator, operating under the
operator's direct order, Telegram 11986) found two independent blockers on `HEAD`
`eba098f` and unblocked the start **without changing any code**, by adding two lines to
`orchestrator/runtime.env`.

Both blockers were re-verified independently by the restarted orchestrator before this
record was written. Neither is a hypothesis.

### Blocker 1 — the launcher calls actions that were never implemented

`orchestrator/launch.sh` calls `mission_cli reap` (line 466) and
`mission_cli lease acquire|release` (lines 143, 173, 602). `core/mission-cli.ts`
implements none of them: its dispatch vocabulary is `mission | manager | lane | outbox |
status` (the usage string at `core/mission-cli.ts:111` is the whole contract). The call
therefore dies on `unknown action: reap`.

This did not fire on a fresh box, which is why it was never seen. The block is guarded by
`state_available()`, i.e. it runs only once the default `runtime/state.db` exists. A fresh
host has no such file, so the orchestrator started fine; **lane activity created it**, and
from that moment every start died. The regression was armed by ordinary successful work.

### Blocker 2 — the launcher requires a file that is not in the repository

`orchestrator/launch.sh` requires `$SCRIPT_DIR/preflight-cli-auth.sh`, the
subscription-only auth gate, and returns 2 when it is absent. **It is absent from the
tree and from `HEAD`.** It exists in history — last alive at `75411d9` (2026-08-02,
`[CODER] allow Claude CLI OAuth auto-refresh`) — and survives only inside `.cache` CI
clones on this host.

`git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` → `does not exist in 'HEAD'`.

## The part that matters most, and that recovery did not name

`orchestrator/runtime.env` is **gitignored** (`.gitignore:15`).

Both workarounds live in it:

- `ORCH_STATE_DB` → a deliberately absent path, so `state_available()` is false and the
  unimplemented `reap`/`lease` block is skipped, restoring the pre-regression start path.
- `ORCH_AUTH_PREFLIGHT` → `/root/oldorch-breakglass/preflight-cli-auth.sh`, a stable copy
  of the *same* subscription gate. Recovery deliberately did **not** point this at
  `/bin/true`; the no-API-keys protection is intact. That judgement was correct and is
  recorded here so a later cleanup does not undo it by accident.

So the orchestrator is running **only** because of two lines in an untracked file, which
point at a script in an untracked directory (`/root/oldorch-breakglass/`), standing in for
a file that is missing from git.

This is a Hard Floor 5 breach with a live blast radius, and it is not academic: it is
exactly the failure that would end the operator's cutover. Rebuilding this system on the
new server from the repository alone **cannot work today** — the launcher's required
auth gate is not in the repo, the `reap`/`lease` regression is still armed and will fire
as soon as lane activity creates a state DB, and the workaround that hides both does not
travel with the repository.

The meteorite proof did not catch this, because it proves the repository rebuilds a host;
it does not start the orchestrator and watch it come up. That gap is the reason a
green meteorite coexisted with an unstartable launcher.

## Disposition

Not fixed here. This record exists so the state is written down rather than absent, which
is the standing obligation in `instructions/reproducible-from-git.md` ("not in git is
never allowed to mean not written down"). The break-glass is left **in place and
untouched** — removing it stops the orchestrator.

The real fixes are three, and they are lane work, not orchestrator work:

1. Implement `reap` and `lease acquire|renew|release` in `core/mission-cli.ts` against
   `DurableStore`, with tests that fail when the launcher's vocabulary and the CLI's
   diverge. A test that locks *the caller and the callee agreeing* is the one that would
   have caught this; neither side alone is wrong-looking.
2. Restore `orchestrator/preflight-cli-auth.sh` as a tracked file, with a test asserting
   every path the launcher requires exists in the tree.
3. Make the meteorite proof start the orchestrator and assert it reaches a live state, so
   "the repository rebuilds the host" stops meaning "the files copy across".

Item 3 is the one that turns this from a bug into a class. Until it exists, the meteorite
proof can stay green through exactly this failure again.
