#!/usr/bin/env bash
# The lane cap must FORBID something (workboard V3-5.10).
#
# Until this suite existed, `FLEET_NUDGE_CAP` and `FleetConfig.cap` were only
# ever quoted in messages: nothing in orchestrator/fleet/launch-lane.sh refused a
# lane beyond the configured ceiling, which was held instead by the orchestrator
# counting running units by hand at every dispatch.
#
# Nothing here starts, stops or installs a real lane unit. The census the
# launcher enforces against is `systemctl list-units --state=running 'lane-*'`,
# so the fixture supplies a `systemctl` on PATH that prints exactly that shape —
# the cap is proven against the same number the running fleet would produce,
# driven by a counted fixture source.
#
# RED-BEFORE. The launcher under test is a parameter, so this suite is also the
# red proof of the defect it locks:
#
#   git show <pre-cap-sha>:orchestrator/fleet/launch-lane.sh \
#     >orchestrator/fleet/pre-cap-launch-lane.sh
#   chmod +x orchestrator/fleet/pre-cap-launch-lane.sh
#   LAUNCH_LANE_UNDER_TEST="$PWD/orchestrator/fleet/pre-cap-launch-lane.sh" \
#     bash orchestrator/fleet/launch-lane-cap.test.sh   # -> started the cap+1-th lane
#   rm orchestrator/fleet/pre-cap-launch-lane.sh
#
# The copy must sit BESIDE the real launcher: launch-lane.sh derives its default
# repository from its own path, so a copy in /tmp fails for an unrelated reason
# and proves nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER="${LAUNCH_LANE_UNDER_TEST:-$SCRIPT_DIR/launch-lane.sh}"
SCRATCH="$(mktemp -d)"
# KEEP_SCRATCH retains the fixture tree: every launcher refusal here is proven
# by its stderr, and a failure that deletes that stderr is a failure nobody can
# read. Used by the red-before run in the header comment.
cleanup() { [ -n "${KEEP_SCRATCH:-}" ] && { printf 'fixture retained: %s\n' "$SCRATCH" >&2; return 0; }; rm -rf "$SCRATCH"; }
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/lanes"

fail() { printf 'launch-lane-cap: %s\n' "$*" >&2; exit 1; }

# The launcher composes and validates a real instruction pack, so the fixture
# needs a complete repository — and a disposable one, because a launch that is
# NOT refused creates a worktree and a branch.
git clone --quiet --no-hardlinks "$HOST_REPO" "$SCRATCH/repo"
REPO_DIR="$SCRATCH/repo"

cat >"$SCRATCH/task.md" <<'EOF'
# Cap proof

Report the current branch.
EOF
cat >"$SCRATCH/bin/agent" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
printf '%s\n' "$SCRATCH/bin/agent" >"$SCRATCH/agent.conf"

# The census, from a counted fixture source. `list-units` is the only
# subcommand that answers it; every other call (the launcher's reset-failed)
# stays silent and successful, as the real one is.
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == list-units ]]; then
  if [[ -n "${FIXTURE_CENSUS_FAILS:-}" ]]; then
    printf 'Failed to list units: connection refused\n' >&2
    exit 1
  fi
  n=${FIXTURE_RUNNING_LANES:-0}
  for ((i = 0; i < n; i++)); do
    printf 'lane-fixture-%d.service loaded active running Fixture lane %d\n' "$i" "$i"
  done
fi
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"${MOCK_SYSTEMD_ARGS:-/dev/null}"
exit 0
EOF
chmod +x "$SCRATCH/bin/"*

JOURNAL="$SCRATCH/lanes/fleet-cap.jsonl"

launch() { # lane-name running-lanes [extra args...]
  local lane="$1" running="$2"; shift 2
  PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    FIXTURE_RUNNING_LANES="$running" FIXTURE_CENSUS_FAILS="${CENSUS_FAILS:-}" \
    MOCK_SYSTEMD_ARGS="$SCRATCH/$lane.systemd.args" TMPDIR="$SCRATCH/tmp-parent" \
    "$LAUNCHER" --name "$lane" --role coder --task-file "$SCRATCH/task.md" \
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "ag-cap-$lane" \
    "$@" >"$SCRATCH/$lane.output" 2>"$SCRATCH/$lane.error"
}

no_artifacts() { # lane-name
  local lane="$1"
  for artifact in "$SCRATCH/lanes/$lane" "$SCRATCH/lanes/pack-$lane" \
    "$SCRATCH/lanes/lane-$lane.prompt.md" "$SCRATCH/lanes/lane-$lane.log" \
    "$SCRATCH/lanes/$lane.report.md" "$SCRATCH/lanes/lane-$lane.status" \
    "$SCRATCH/$lane.systemd.args"; do
    [ -e "$artifact" ] && fail "refused launch $lane left an artifact behind: $artifact"
  done
  git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/ag-cap-$lane" &&
    fail "refused launch $lane created branch ag-cap-$lane"
  return 0
}

# The cap is READ from the fixture repository, never retyped here: a suite that
# hard-coded three would keep passing after the operator changed the ruling.
# shellcheck disable=SC1091
CAP=$(. "$SCRIPT_DIR/fleet-params.sh"; fleet_cap "$REPO_DIR") ||
  fail "cannot read fleet.cap from the fixture repository"
DECLARED_BY=$(. "$SCRIPT_DIR/fleet-params.sh"; fleet_declared_by "$REPO_DIR") ||
  fail "cannot read fleet.declared_by from the fixture repository"

# ── 1. The happy path at cap-1 still launches ───────────────────────────────
# A fail-closed defect here stops the whole system: the orchestrator dispatches
# every lane with this script, so "refuses too much" is a worse outcome than the
# defect being fixed.
launch under-cap "$((CAP - 1))" || fail "the launcher refused a lane at cap-1"
grep -Fq 'launched lane-under-cap' "$SCRATCH/under-cap.output" ||
  fail "a launch under the cap did not report the unit"
test -f "$SCRATCH/lanes/under-cap/.git" || fail "a launch under the cap created no worktree"

# ── 2. The cap+1-th lane is refused ─────────────────────────────────────────
# `CAP` lanes are already running, so this one would be the cap+1-th.
if launch over-cap "$CAP"; then
  fail "the launcher started the cap+1-th lane with $CAP already running"
fi
grep -Fq "refusing to launch over-cap: $CAP lane(s) already running and the cap is $CAP" \
  "$SCRATCH/over-cap.error" || { cat "$SCRATCH/over-cap.error" >&2; fail "the refusal did not name the census and the cap"; }
grep -Fq "$DECLARED_BY" "$SCRATCH/over-cap.error" ||
  fail "the refusal did not cite the ruling that declares the cap"
grep -Fq -- '--allow-over-cap' "$SCRATCH/over-cap.error" ||
  fail "the refusal did not name the declared exception"
no_artifacts over-cap

# Refusal happens before anything is created, and is journaled.
grep -Fq '"decision":"refused-at-cap"' "$JOURNAL" ||
  { cat "$JOURNAL" >&2; fail "the refusal was not journaled"; }
grep -Fq "\"cap\":$CAP" "$JOURNAL" || fail "the journal did not record the cap"
grep -Fq "\"running\":$CAP" "$JOURNAL" || fail "the journal did not record the census"

# ── 3. Well past the cap is refused too ─────────────────────────────────────
if launch far-over-cap "$((CAP + 4))"; then
  fail "the launcher started a lane with $((CAP + 4)) already running"
fi
no_artifacts far-over-cap

# ── 4. The declared exception: over the cap deliberately, and journaled ─────
# The operator has ordered exactly this once ("екстра лейн поверх ліміту"), so
# refusal is the default rather than the only possibility.
REASON='екстра лейн поверх ліміту'
launch extra "$CAP" --allow-over-cap "$REASON" ||
  { cat "$SCRATCH/extra.error" >&2; fail "--allow-over-cap did not launch past the cap"; }
grep -Fq 'launched lane-extra' "$SCRATCH/extra.output" ||
  fail "the over-cap launch did not report the unit"
grep -Fq '"decision":"over-cap-override"' "$JOURNAL" ||
  { cat "$JOURNAL" >&2; fail "the override was not journaled"; }
grep -Fq "\"reason\":\"$REASON\"" "$JOURNAL" ||
  { cat "$JOURNAL" >&2; fail "the override journal did not carry the stated reason"; }
grep -Fq "$REASON" "$SCRATCH/extra.error" ||
  fail "the override was silent on stderr; a deliberate exception must be visible"

# An exception with no reason is not a declared exception.
if launch reasonless "$CAP" --allow-over-cap ''; then
  fail "--allow-over-cap accepted an empty reason"
fi
grep -Fq 'requires a reason' "$SCRATCH/reasonless.error" ||
  fail "the empty-reason refusal did not say why"
no_artifacts reasonless

# ── 5. A census that cannot be taken is a refusal, not a zero ───────────────
# The launcher cannot show it is under the ceiling, so it must not launch; the
# watchdog's failure direction is the opposite (it nudges) and that asymmetry is
# deliberate.
CENSUS_FAILS=1
if launch blind 0; then
  fail "the launcher launched against a census it could not take"
fi
grep -Fq 'cannot count running lanes' "$SCRATCH/blind.error" ||
  fail "the census refusal did not name the census"
no_artifacts blind
grep -Fq '"decision":"refused-census-unavailable"' "$JOURNAL" ||
  fail "the census refusal was not journaled"
# ...and the declared exception still works when the census is blind.
launch blind-extra 0 --allow-over-cap 'census down, deliberate launch' ||
  { cat "$SCRATCH/blind-extra.error" >&2; fail "--allow-over-cap did not survive a blind census"; }
CENSUS_FAILS=

# ── 6. The enforced number comes from params.yaml, not from this file ───────
# The drift lock: change the parameter in the fixture repository and the refusal
# threshold moves with it. A launcher carrying its own literal passes every
# assertion above and fails this one.
sed -i 's/^  cap: [0-9]*/  cap: 1/' "$REPO_DIR/instance/params.yaml"
[ "$(. "$SCRIPT_DIR/fleet-params.sh"; fleet_cap "$REPO_DIR")" = 1 ] ||
  fail "the fixture repository's cap was not lowered"
if launch derived 1; then
  fail "the launcher did not follow the cap down to 1 — it is not reading instance/params.yaml"
fi
grep -Fq 'and the cap is 1' "$SCRATCH/derived.error" ||
  fail "the refusal quoted a cap other than the parameter file's"
no_artifacts derived
launch derived-ok 0 || fail "a lane below the lowered cap was refused"

# An unreadable cap is a refusal: an unknown ceiling is not an absent one.
sed -i 's/^  cap: [0-9]*/  cap: not-a-number/' "$REPO_DIR/instance/params.yaml"
if launch unreadable 0; then
  fail "the launcher launched against an unreadable cap"
fi
grep -Fq 'cannot read fleet.cap' "$SCRATCH/unreadable.error" ||
  fail "the unreadable-cap refusal did not name the parameter"
no_artifacts unreadable

printf 'launch-lane cap enforcement: PASS\n'
