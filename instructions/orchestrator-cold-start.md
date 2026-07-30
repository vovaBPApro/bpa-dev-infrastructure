---
id: orchestrator-cold-start
layer: L1
status: binding
audience: orchestrator
tags: [orchestrator, playbook, landing, review]
summary: Exact cold-start path from a durable mission through dispatch, review, gated landing, and the final report.
---

# Orchestrator Cold Start

This is the shortest operational path. The governing rules remain in
`instructions/orchestrator-playbook.md`, `instructions/lane-lifecycle.md`,
`instructions/review-policy.md`, `instructions/landing-and-merge.md`, and
`instructions/verification-and-locks.md`.

## 0. Start clean

Run on the orchestrator host from the infrastructure repository's clean
`main`. Bun, Git, tmux, the configured provider CLI, and provider
authentication must already be available.

```sh
cd /path/to/bpa-dev-infrastructure
git switch main
git fetch origin
git merge --ff-only origin/main
test -z "$(git status --porcelain)"
./orchestrator/launch.sh status || ./orchestrator/launch.sh start
./orchestrator/status.sh
```

`launch.sh start` acquires the singleton orchestrator lease when
`runtime/state.db` exists and runs the configured provider in tmux. A held
lease, failed authentication preflight, or unavailable provider is a stop, not
a warning.

Set the values used below:

```sh
REPO="$(pwd)"
CORRELATION_ID='replace-with-durable-correlation-id'
LANE_ID='replace-with-lane-id'
BRANCH="ag-$LANE_ID"
LANE_DIR="/absolute/path/to/lanes/$LANE_ID"
EVIDENCE_DIR="/absolute/path/to/evidence"
PROMPT_FILE="$EVIDENCE_DIR/$LANE_ID.prompt.md"
REPORT_FILE="$EVIDENCE_DIR/$BRANCH.report.md"
mkdir -p "$EVIDENCE_DIR"
```

## 1. Create or load the mission

The CLI has no separate `load` action. Inspect durable state; create exactly
once when the correlation ID is absent, then retain the emitted mission ID.

```sh
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" status
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" mission create "$CORRELATION_ID"
MISSION_ID='paste-the-emitted-mission-id'
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" mission transition "$MISSION_ID" running
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" lane create "$MISSION_ID" "$LANE_ID"
```

The durable mission artifact must hold the verbatim Human requirement, scope,
acceptance rows, tier, routing, evidence destination, correlation ID, and
rollup owner as required by `instructions/lane-lifecycle.md`.

## 2. Prepare and dispatch the coder lane

Create one branch and worktree from current `origin/main`:

```sh
git -C "$REPO" fetch origin
git -C "$REPO" worktree add -b "$BRANCH" "$LANE_DIR" origin/main
```

Render the coder baseline and requested instruction tags, then append the
mission-specific prompt after the generated pack:

```sh
bun "$REPO/tools/instructions/compose.ts" \
  --role coder \
  --tags orchestrator \
  --repo "$REPO" > "$PROMPT_FILE"
printf '\n%s\n' 'Append the verbatim mission requirement and lane-local scope here.' >> "$PROMPT_FILE"
```

Validate before launch:

```sh
"$REPO/orchestrator/dispatch-lane.sh" "$PROMPT_FILE"
```

`dispatch-lane.sh` is currently gate-only unless an external launcher is
supplied. When one is configured, dispatch through the supported tail; the
script runs `exec <launcher> [launcher-args...] "$PROMPT_FILE"`, so the
launcher receives its own arguments first and the prompt file path as its final
positional argument:

```sh
"$REPO/orchestrator/dispatch-lane.sh" "$PROMPT_FILE" -- /absolute/path/to/launcher --launcher-option
```

Do not replace `/absolute/path/to/launcher` with a guessed command. Record the
actual configured launcher and transition the lane with the real CLI as its
state changes:

```sh
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" lane transition "$LANE_ID" running
```

## 3. Route review

Classify the exact diff using `instructions/review-policy.md`; uncertainty is
Tier A. Tier A goes to an independent, preferably cross-vendor implementation
review. Tier B goes to an independent executable lock review. Paths matching
`gate/review-policy.conf` require the gate-readable artifact
`$EVIDENCE_DIR/$BRANCH.review.md`.

The review record identifies reviewer and independence, tier, exact SHA and
diff, commands and evidence inspected, findings, rollback posture, and a
verdict. For a gate-routed `ACCEPT`, these four fields must each occur once at
column 1:

```text
verdict: ACCEPT
reviewer: Reviewer Name <reviewer@example.invalid>
reviewed-sha: 0123456789012345678901234567890123456789
independence: independent session and author
```

Replace the example identity and SHA with real values. `REJECT`, `NO-GO`,
missing evidence, self-review, or a SHA different from the report commit blocks
landing.

## 4. Land through a disposable canonical clone

First require the coder's column-1 report at `$REPORT_FILE`:

```text
commit: <40-character SHA> <title>
verify: <runnable command>
result: clean
secret-scan: clean
remaining: none
```

Push the accepted lane branch before landing. Then use a fresh clone as the
canonical integration tree, fetch the fixed branch, copy no worktree state
into it, and invoke the gate with its actual flags:

```sh
git -C "$LANE_DIR" push -u origin "$BRANCH"
LAND_ROOT="$(mktemp -d /tmp/bpa-land.XXXXXX)"
LAND_REPO="$LAND_ROOT/repo"
ORIGIN_URL="$(git -C "$REPO" remote get-url origin)"
git clone "$ORIGIN_URL" "$LAND_REPO"
git -C "$LAND_REPO" fetch origin "$BRANCH:$BRANCH"
"$LAND_REPO/gate/land.sh" \
  --branch "$BRANCH" \
  --report "$REPORT_FILE" \
  --repo "$LAND_REPO" \
  --run-verify
```

Keep the review artifact adjacent to the report under the exact name
`$BRANCH.review.md`. The gate checks freshness, the report contract, required
review, the complete incoming-range secret scan, exact branch tip, and payload;
then it creates a no-fast-forward merge, reruns the report's verification on
the merged tree, pushes the default branch, and deletes its local lane branch.
Do not use `--no-push` for a real landing. `--skip-review <reason>` is audited
break-glass, not normal routing.

After a successful gate verdict, remove the original accepted worktree and
local branch:

```sh
git -C "$REPO" worktree remove "$LANE_DIR"
git -C "$REPO" branch -d "$BRANCH"
```

If any gate or cleanup step fails, retain evidence and report the exact
verdict. Do not call it clean.

## 5. Close and report

Capture the pushed merge SHA from the gate's `LAND verdict=landed` output,
verify it from a fresh `main`, and only then close durable state:

```sh
git -C "$REPO" fetch origin
git -C "$REPO" switch main
git -C "$REPO" merge --ff-only origin/main
MERGE_SHA="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" show "$MERGE_SHA" --stat
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" lane transition "$LANE_ID" succeeded
INFRA_STATE_DB="$REPO/runtime/state.db" bun "$REPO/core/mission-cli.ts" mission transition "$MISSION_ID" succeeded
./orchestrator/status.sh
```

Report the exact merge SHA, the verification command actually run at that SHA,
and `result: clean` only when every condition in
`instructions/verification-and-locks.md` is satisfied:

```text
commit: <40-character merge SHA> <title>
verify: <command actually run at that SHA>
result: clean
secret-scan: clean
remaining: none
```

Otherwise report `result: NO-GO`, the concrete blocker, and the next bounded
action. Never infer completion from lane output, partial verification, or a
gate attempt without `LAND verdict=landed`.
