#!/usr/bin/env bash
# Clean-machine infrastructure rebuild proof for Hard Floor 5.
#
# Expensive by design: this installs prerequisites in a fresh ubuntu:24.04
# container, clones the public repository without mounting or copying host
# files, runs bootstrap, and executes the complete source suite. It is NOT in
# the default `bun test` sweep. Run it explicitly with:
#   bash meteorite/prove-candidate.sh --ref "$(git rev-parse HEAD)"
# Changes to this file, bootstrap/install.sh, bootstrap/check-unit-drift.sh, or
# the rebuild contract require that command as pre-landing evidence. The wrapper
# publishes the exact candidate under a temporary remote ref and removes it even
# when this runner fails.
#
# ── ARTIFACTS ──────────────────────────────────────────────────────────────
# Every run writes TWO files, both outside any checkout (V3-2.7: an artifact in
# the tree makes the next landing refuse a dirty worktree), both replaced
# atomically, and both written on failure as well as success:
#
#   $XDG_STATE_HOME/bpa-dev-infrastructure/evidence/meteorite-latest.md
#       The human/gate-readable report. gate/land-lib.sh's
#       land_validate_meteorite_report() is its consumer. Override: METEORITE_REPORT.
#   $XDG_STATE_HOME/bpa-dev-infrastructure/evidence/meteorite-latest.json
#       The machine-readable result. Override: METEORITE_ARTIFACT.
#
# The JSON is `schema: meteorite-result/v1` and is deliberately minimal, because
# it is an INTERFACE: the cutover-readiness command reads it and nothing else,
# so a reader must never have to parse prose to learn whether the rebuild held.
#
#   schema         "meteorite-result/v1"
#   finished       true only when every declared stage ran to completion. A stage
#                  that kills the run leaves this false, which is the difference
#                  between "the proof says no" and "the proof never got there".
#   result         "clean" | "NO-GO" -- the verdict. `finished: true` with
#                  `result: "NO-GO"` is a complete run that failed its final
#                  check; both fields are required to read the run honestly.
#   blocker        the concrete reason, or "none".
#   requested_sha  what the caller asked to prove.
#   tree_sha       what was actually checked out and proven ("UNMEASURED" before
#                  the clone stage measures it).
#   stages         [{name, verdict}] in execution order, verdict PASS | NO-GO.
#   liveness       {proven: bool, ...} -- the orchestrator-live stage's evidence,
#                  including the substitutions in force and the boundaries a
#                  container structurally cannot cross. {proven:false,
#                  reason:"stage-not-reached"} when the run died earlier.
#                  `liveness_boundary` says HOW MUCH a `proven:true` proved:
#                  `full` (started, handshook, pulsed, tore down) or
#                  `auth-preflight-refusal` (no credential store exists in this
#                  world, so the launch path was proven up to and including the
#                  auth gate and refused there). A reader that treats the two
#                  alike is reading a rebuilt host as a logged-in one; that
#                  choice is the reader's, which is why the field exists.
#   finished_at    UTC ISO-8601 second precision.
#
# ── THE PROOF ANCHOR ───────────────────────────────────────────────────────
# The JSON above is an ordinary file on a host, and anyone who can write that
# path can write a green verdict into it. So every run that measured a tree
# publishes the artifact's digest to the tracked origin, and the reader
# (tools/check-cutover-readiness.ts) treats an artifact without that anchor as
# no evidence at all:
#
#   refs/bpa-meteorite-proofs/<tree_sha>/<sha256>         -> <tree_sha>
#   refs/bpa-meteorite-proof-mirrors/<tree_sha>/<sha256>  -> <tree_sha>
#
# The digest is the ref NAME, so an anchor cannot vouch for bytes it was not
# published for; the ref TARGET is the proven commit, so it cannot be moved onto
# a different tree; the mirror namespace makes a record forged or suppressed on
# one side detectable; and `push --atomic` means a half-published anchor never
# exists. The destination is the URL pinned by `repos.git_remote` in the
# instance/params.yaml of the PROVEN tree -- the same one home gate/land.sh
# reads, taken from tracked content rather than from this host's Git config.
# Both a clean run and a NO-GO run publish: a failed rebuild's artifact is FAIL
# evidence and has to be as readable as a passing one. A publication that does
# not happen makes the run exit non-zero and says so on stderr, because an
# unpublished proof must never be indistinguishable from a proven one.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${METEORITE_IMAGE:-ubuntu:24.04}"
state_home="${XDG_STATE_HOME:-${HOME:?HOME must be set when XDG_STATE_HOME is unset}/.local/state}"
report="${METEORITE_REPORT:-$state_home/bpa-dev-infrastructure/evidence/meteorite-latest.md}"
artifact="${METEORITE_ARTIFACT:-$state_home/bpa-dev-infrastructure/evidence/meteorite-latest.json}"
keep="${METEORITE_KEEP:-0}"
ref=""
repo_url="${METEORITE_REPO_URL:-}"
source_mechanism="${METEORITE_SOURCE_MECHANISM:-tracked-remote}"
donor_sha="${METEORITE_DONOR_SHA:-}"
donor_ref="${METEORITE_DONOR_REF:-}"
cid=""
proof_namespace="refs/bpa-meteorite-proofs"
proof_mirror_namespace="refs/bpa-meteorite-proof-mirrors"
artifact_written=0
tested_sha="UNMEASURED"
result="NO-GO"
blocker="runner did not reach a measured stage"
stages=()
finished=0
live_stage="orchestrator-live"
liveness_line=""
liveness_reason="stage-not-reached"
# The closed set of boundaries the orchestrator-live stage may pass at. Defined
# in meteorite/live-orchestrator-stage.sh; enumerated here because this runner is
# the thing that decides whether a claimed pass counts.
#   full                    the launcher started, handshook, pulsed, tore down.
#   auth-preflight-refusal  no subscription credential store exists in this
#                           world -- and none can exist on a rebuilt host, since
#                           the store is written by a human answering /login --
#                           so the launch path was proven up to and including the
#                           auth gate, which refused there for its own named
#                           reason. Everything past it travels in `unproven=`.
allowed_liveness_boundaries="full auth-preflight-refusal"

# The stage list this runner is CONTRACTUALLY required to have executed, held
# separately from the commands that execute them. A rebuild proof that silently
# stopped starting the orchestrator would otherwise report `clean` over a
# shorter list, which is exactly how a green meteorite coexisted with an
# unstartable launcher through 2026-08-04.
required_stages=(
  container-start
  prerequisites
  clone
  sha-verification
  bootstrap-test-prerequisites
  bootstrap-dry-run
  bootstrap-install
  bootstrap-verify-source
  # Landed on main as V3-5.40 while this contract was in flight. Listed here for
  # the same reason as every other line: a stage that exists in `commands` but
  # not in the contract is a stage whose deletion would still report `clean`,
  # and voice on a rebuilt host is cutover gate G.
  whisper
  test-prerequisites
  full-test-suite
  unit-drift
  orchestrator-live
)

usage() {
  cat <<'EOF'
Usage: meteorite/run.sh --ref <40-character-commit-sha> [--repo-url <url>]

The ref is mandatory: this runner never guesses which candidate is under test.
The default URL is the tracked origin remote; public GitHub SSH syntax is
converted to its credential-free HTTPS equivalent. The requested commit must
be fetchable from that source. A local-only commit therefore fails closed; it
is not remote-clone evidence. Environment: METEORITE_REPORT, METEORITE_IMAGE,
METEORITE_REPO_URL, METEORITE_KEEP.
EOF
}

while (($#)); do
  case "$1" in
    --ref|--repo-url)
      option="$1"
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf 'ERROR: %s requires a value\n' "$option" >&2
        exit 2
      fi
      if [[ "$option" == "--ref" ]]; then ref="$2"; else repo_url="$2"; fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

record() { stages+=("$1|$2"); }

write_report() {
  local dir tmp entry
  dir="$(dirname "$report")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.meteorite-latest.XXXXXX")" || return 1
  {
    printf '# Infrastructure meteorite report\n\n'
    printf -- '- source: `%s`\n' "${repo_url:-UNMEASURED}"
    printf -- '- source mechanism: `%s`\n' "$source_mechanism"
    printf -- '- requested SHA: `%s`\n' "${ref:-UNMEASURED}"
    printf -- '- tested SHA: `%s`\n' "$tested_sha"
    printf -- '- container image: `%s`\n' "$image"
    printf -- '- container isolation: `Docker bridge network; no host mounts or published ports`\n'
    printf -- '- pinned test environment: `FULL_SUITE_ON_CALENDAR=*-*-* 03:30:00; ORCH_WATCHDOG_INTERVAL=60`\n'
    printf -- '- result: %s\n' "$result"
    printf -- '- blocker: %s\n\n' "$blocker"
    printf '## Stages\n\n'
    for entry in "${stages[@]}"; do
      printf -- '- %s: %s\n' "${entry%%|*}" "${entry#*|}"
    done
    printf '\n## Explicitly not proven\n\n'
    printf -- '- unit activation — bootstrap stage 1 renders or activates no systemd units.\n'
    printf -- '- watchdog arm — bootstrap stage 1 has no watchdog arm/disarm boundary.\n'
    printf -- '- Telegram transport — no credential is supplied and no authenticated transport is started.\n'
    printf -- '- shell capability exclusions — the cases pinned in `instance/expected-shell-capability-exclusions.tsv` remain unproven when their named kernel capability is absent.\n'
    if [[ -n "$liveness_line" ]]; then
      printf -- '- orchestrator liveness boundary — `%s`\n' "$liveness_line"
    else
      printf -- '- orchestrator liveness — not measured (%s).\n' "$liveness_reason"
    fi
  } > "$tmp"
  mv "$tmp" "$report"
}

# Minimal JSON string escaping. The stage names and verdicts are controlled
# tokens; the blocker is free text and is the only field that can carry a quote,
# a backslash or a newline, so it is escaped rather than trusted.
json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

# The liveness object. Built from the stage's own evidence line, never from its
# exit status: a stage that exits 0 without producing evidence has proven
# nothing, and this is where that distinction becomes machine-readable.
write_liveness_object() {
  local field key value first=1
  if [[ -z "$liveness_line" ]]; then
    printf '    "proven": false,\n    "reason": "%s"\n' "$(json_escape "$liveness_reason")"
    return
  fi
  printf '    "proven": true'
  # shellcheck disable=SC2086 # deliberate word splitting: the evidence line is
  # a whitespace-separated key=value record validated before it reaches here.
  for field in $liveness_line; do
    [[ "$field" == *=* ]] || continue
    key="${field%%=*}"
    value="${field#*=}"
    [[ "$key" == proven ]] && continue
    printf ',\n    "%s": "%s"' "$(json_escape "$key")" "$(json_escape "$value")"
    first=0
  done
  ((first == 0)) || true
  printf '\n'
}

write_artifact() {
  local dir tmp entry name verdict index=0
  dir="$(dirname "$artifact")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.meteorite-latest-json.XXXXXX")" || return 1
  {
    printf '{\n'
    printf '  "schema": "meteorite-result/v1",\n'
    printf '  "finished": %s,\n' "$( ((finished)) && printf true || printf false )"
    printf '  "result": "%s",\n' "$(json_escape "$result")"
    printf '  "blocker": "%s",\n' "$(json_escape "$blocker")"
    printf '  "requested_sha": "%s",\n' "$(json_escape "${ref:-UNMEASURED}")"
    printf '  "tree_sha": "%s",\n' "$(json_escape "$tested_sha")"
    printf '  "stages": [\n'
    for entry in ${stages[@]+"${stages[@]}"}; do
      name="${entry%%|*}"
      verdict="${entry#*|}"
      ((index == 0)) || printf ',\n'
      printf '    {"name": "%s", "verdict": "%s"}' "$(json_escape "$name")" "$(json_escape "$verdict")"
      index=$((index + 1))
    done
    ((index == 0)) || printf '\n'
    printf '  ],\n'
    printf '  "liveness": {\n'
    write_liveness_object
    printf '  },\n'
    printf '  "finished_at": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '}\n'
  } > "$tmp"
  mv "$tmp" "$artifact"
}

# Extract the pinned origin URL from an instance/params.yaml stream: the first
# `git_remote:` value with any trailing ` # comment` stripped. Identical to
# gate/land.sh's land_origin_pin() by construction -- both are readers of the
# one home, instance/params.yaml, not second copies of the value.
meteorite_origin_pin() {
  sed -n 's/^[[:space:]]*git_remote:[[:space:]]*//p' | head -n 1 | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//'
}

# Bind the finalized artifact to a durable, origin-visible anchor. Runs after
# the artifact's atomic replace and never touches it again: the digest is of the
# exact bytes a reader will read, so any later write to that file -- including
# one by this runner -- would be a different artifact with no anchor.
publish_proof_anchor() {
  local pin digest leaf ref mirror persisted persisted_mirror
  if ((artifact_written == 0)); then
    printf 'ERROR: [meteorite] no artifact was written, so no proof anchor was published\n' >&2
    return 1
  fi
  # Before the clone stage measures the tree there is no commit for an anchor to
  # name or to point at. Such a run is already NO-GO with tree_sha UNMEASURED;
  # it is reported here too so that "unanchored" is never a silent state.
  if [[ ! "$tested_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'ERROR: [meteorite] no measured tree (tree_sha=%s); the artifact is unanchored and is not evidence\n' "$tested_sha" >&2
    return 1
  fi
  if ! git -C "$repo_root" rev-parse --verify -q "$tested_sha^{commit}" >/dev/null 2>&1; then
    printf 'ERROR: [meteorite] the measured tree %s is not a commit in %s; the artifact is unanchored and is not evidence\n' "$tested_sha" "$repo_root" >&2
    return 1
  fi
  pin="$(git -C "$repo_root" show "$tested_sha:instance/params.yaml" 2>/dev/null | meteorite_origin_pin)" || pin=""
  if [[ -z "$pin" ]]; then
    printf 'ERROR: [meteorite] the proven tree %s tracks no repos.git_remote pin; the artifact is unanchored and is not evidence\n' "$tested_sha" >&2
    return 1
  fi
  if ! digest="$(sha256sum "$artifact")"; then
    printf 'ERROR: [meteorite] could not digest the artifact: %s\n' "$artifact" >&2
    return 1
  fi
  digest="${digest%% *}"
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'ERROR: [meteorite] artifact digest is not a sha256: %s\n' "$digest" >&2
    return 1
  fi
  leaf="$tested_sha/$digest"
  ref="$proof_namespace/$leaf"
  mirror="$proof_mirror_namespace/$leaf"
  if ! git -C "$repo_root" push --atomic "$pin" "$tested_sha:$ref" "$tested_sha:$mirror" >/dev/null; then
    printf 'ERROR: [meteorite] proof anchor NOT published to %s: %s; the artifact on this host is unanchored and is not evidence\n' "$pin" "$ref" >&2
    return 1
  fi
  # Read back from the same URL that was written, exactly as gate/land.sh does
  # with its attempt refs: a push that reported success and left the remote
  # without both refs has published nothing a reader can find.
  persisted="$(git -C "$repo_root" ls-remote --refs "$pin" "$ref" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  persisted_mirror="$(git -C "$repo_root" ls-remote --refs "$pin" "$mirror" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  if [[ "$persisted" != "$tested_sha" || "$persisted_mirror" != "$tested_sha" ]]; then
    printf 'ERROR: [meteorite] proof anchor did not persist at %s: %s found=%s mirror=%s expected=%s\n' \
      "$pin" "$ref" "${persisted:-missing}" "${persisted_mirror:-missing}" "$tested_sha" >&2
    return 1
  fi
  printf '[meteorite] proof anchor: %s -> %s (%s)\n' "$ref" "$tested_sha" "$pin"
  printf '[meteorite] proof mirror: %s\n' "$mirror"
  return 0
}

teardown() {
  local status=$?
  if [[ -n "$cid" ]]; then
    if [[ "$keep" == "1" ]]; then
      printf '[meteorite] METEORITE_KEEP=1; container retained: %s\n' "$cid"
    else
      docker stop -t 5 "$cid" >/dev/null 2>&1 || true
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  fi
  if write_report; then
    printf '[meteorite] report: %s\n' "$report"
  else
    printf 'ERROR: could not write report: %s\n' "$report" >&2
  fi
  if write_artifact; then
    artifact_written=1
    printf '[meteorite] artifact: %s\n' "$artifact"
  else
    printf 'ERROR: could not write artifact: %s\n' "$artifact" >&2
  fi
  # The last act of every run, success and failure alike. A run that cannot
  # anchor its artifact does not get to exit 0 -- otherwise the one difference
  # between a proof and a file someone wrote would be invisible to its caller.
  if ! publish_proof_anchor; then
    ((status != 0)) || status=1
  fi
  return "$status"
}
trap teardown EXIT

fail() {
  local stage="$1" message="$2"
  record "$stage" "NO-GO"
  blocker="$message"
  printf '[meteorite] NO-GO %s: %s\n' "$stage" "$message" >&2
  return 1
}

require_publisher_input() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    fail "input-validation" "required input $name is unset or empty; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>" || true
    exit 2
  fi
}

if ! command -v git >/dev/null 2>&1; then
  fail "preflight" "git not found on PATH" || true
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  fail "preflight" "docker not found on PATH" || true
  exit 1
fi
if [[ -z "$ref" ]]; then
  fail "ref-validation" "an explicit 40-character commit SHA is required" || true
  exit 2
fi
if [[ -z "$repo_url" ]]; then
  repo_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null)" || {
    fail "remote-resolution" "cannot read the tracked origin URL" || true
    exit 1
  }
fi
case "$repo_url" in
  git@github.com:*) repo_url="https://github.com/${repo_url#git@github.com:}" ;;
  ssh://git@github.com/*) repo_url="https://github.com/${repo_url#ssh://git@github.com/}" ;;
esac
if [[ ! "$ref" =~ ^[0-9a-fA-F]{40}$ ]]; then
  fail "ref-validation" "ref must be a 40-character commit SHA" || true
  exit 2
fi
require_publisher_input "METEORITE_DONOR_SHA" "$donor_sha"
require_publisher_input "METEORITE_DONOR_REF" "$donor_ref"
if [[ ! "$donor_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  fail "input-validation" "METEORITE_DONOR_SHA must be a 40-character commit SHA; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>" || true
  exit 2
fi
if [[ ! "$donor_ref" =~ ^refs/meteorite-candidates/[0-9]+-[0-9]+-[0-9a-fA-F]{40}/v2-deprecated$ ]]; then
  fail "input-validation" "METEORITE_DONOR_REF has an unsupported shape; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>" || true
  exit 2
fi
if [[ ! "$repo_url" =~ ^[A-Za-z0-9._~:/@%+=,-]+$ ]]; then
  fail "argument-validation" "repository URL contains unsupported characters" || true
  exit 2
fi
case "$repo_url" in
  /*|./*|../*|file://*)
    fail "source-validation" "local sources are not remote-clone evidence" || true
    exit 2
    ;;
esac

# The orchestrator-live stage is judged on the EVIDENCE it emits, not on its
# exit status. `substitutions=provider` is the exact, complete set a rebuilt
# container forces (no credentials, no provider CLI); anything larger means a
# launcher mechanism was replaced by a stand-in, and a rebuild proof that
# accepted that would be proving the fixture rather than the repository.
validate_liveness_evidence() {
  local output="$1" matches
  matches="$(printf '%s\n' "$output" | grep -cE '^METEORITE-LIVENESS ' || true)"
  if [[ "$matches" != 1 ]]; then
    liveness_reason="evidence-line-count-$matches"
    fail "$live_stage" "the live-orchestrator stage emitted $matches METEORITE-LIVENESS lines; exactly one is required"
    return 1
  fi
  local line
  line="$(printf '%s\n' "$output" | grep -E '^METEORITE-LIVENESS ' | head -n 1)"
  if [[ "$line" != *" proven=yes "* ]]; then
    liveness_reason="$(printf '%s' "$line" | sed -n 's/.*reason=\([^ ]*\).*/\1/p')"
    [[ -n "$liveness_reason" ]] || liveness_reason="not-proven"
    fail "$live_stage" "the orchestrator did not reach a live state: $liveness_reason"
    return 1
  fi
  if [[ "$line" != *" substitutions=provider "* ]]; then
    liveness_reason="unexpected-substitutions"
    fail "$live_stage" "the live-orchestrator stage ran with substituted launcher mechanisms: $(printf '%s' "$line" | sed -n 's/.*\(substitutions=[^ ]*\).*/\1/p')"
    return 1
  fi
  # WHICH boundary the stage passed at is part of the evidence, not a footnote.
  # A credential-free rebuild cannot cross its own auth gate, so `proven=yes`
  # alone no longer says how much was proven -- and a reader deciding policy on
  # this artifact (gate D) must be able to tell the two apart without parsing
  # prose. The vocabulary is closed here so that inventing a third boundary is a
  # change to this file, reviewed, rather than a string a stage can mint for
  # itself; an undeclared boundary is refused for the same reason.
  local boundary
  boundary="$(printf '%s' "$line" | sed -n 's/.* liveness_boundary=\([^ ]*\).*/\1/p')"
  if [[ -z "$boundary" ]]; then
    liveness_reason="liveness-boundary-undeclared"
    fail "$live_stage" "the live-orchestrator stage passed without declaring a liveness_boundary; a PASS whose boundary is unstated cannot be read"
    return 1
  fi
  case " $allowed_liveness_boundaries " in
    *" $boundary "*) ;;
    *)
      liveness_reason="unknown-liveness-boundary"
      fail "$live_stage" "the live-orchestrator stage declared an unknown liveness boundary: $boundary (known: $allowed_liveness_boundaries)"
      return 1
      ;;
  esac
  liveness_line="$line"
  liveness_reason=""
  return 0
}

run_exec_stage() {
  local stage="$1" command="$2"
  printf '[meteorite] stage: %s\n' "$stage"
  if [[ "$stage" == "$live_stage" ]]; then
    # Captured rather than streamed: this stage's verdict is carried in its
    # stdout, and a stage whose evidence went only to the terminal is a stage
    # whose evidence does not exist. stderr still streams live.
    local output status=0
    output="$(docker exec "$cid" bash -lc "$command")" || status=$?
    printf '%s\n' "$output"
    if ((status != 0)); then
      liveness_reason="$(printf '%s\n' "$output" | sed -n 's/^METEORITE-LIVENESS proven=no reason=\([^ ]*\).*/\1/p' | head -n 1)"
      [[ -n "$liveness_reason" ]] || liveness_reason="stage-command-failed"
      fail "$stage" "$stage command failed: $liveness_reason"
      return 1
    fi
    validate_liveness_evidence "$output" || return 1
    record "$stage" "PASS"
    return 0
  fi
  if docker exec "$cid" bash -lc "$command"; then
    record "$stage" "PASS"
    if [[ "$stage" == "clone" ]]; then
      tested_sha="$(docker exec "$cid" git -C /work/source rev-parse HEAD 2>/dev/null)" || {
        fail "sha-verification" "source checkout SHA could not be measured"
        return 1
      }
      if [[ "${tested_sha,,}" != "${ref,,}" ]]; then
        fail "sha-verification" "checked-out SHA $tested_sha differs from requested SHA $ref"
        return 1
      fi
      tested_sha="${tested_sha,,}"
      record "sha-verification" "PASS"
    fi
    return 0
  fi
  fail "$stage" "$stage command failed"
}

if ! cid="$(docker run -d --rm --network bridge "$image" sleep infinity)"; then
  fail "container-start" "docker could not start $image" || true
  exit 1
fi
if [[ -z "$cid" ]]; then
  fail "container-start" "docker returned an empty container id" || true
  exit 1
fi
record "container-start" "PASS"

commands=(
  "prerequisites|apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential ca-certificates cmake curl espeak-ng ffmpeg git gettext-base strace tmux unzip util-linux"
  "clone|git clone --no-checkout '$repo_url' /work/source && git -C /work/source fetch --depth 1 origin '$ref' && git -C /work/source checkout --detach FETCH_HEAD && git -C /work/source branch meteorite-target HEAD"
  # bootstrap/install.sh runs the complete suite itself. Materialize its donor
  # dependency before that first suite, in the source repository that it clones,
  # rather than accidentally relying on a donor ref already present on the host.
  "bootstrap-test-prerequisites|test -n '$donor_sha' && test -n '$donor_ref' && ln -sfn /root/.bun/bin/bun /usr/local/bin/bun && git -C /work/source fetch origin '$donor_ref':refs/heads/v2-deprecated && test \"\$(git -C /work/source rev-parse refs/heads/v2-deprecated)\" = '$donor_sha'"
  "bootstrap-dry-run|cd /work/source && bash bootstrap/install.sh --dry-run"
  "bootstrap-install|cd /work/source && INSTALL_ROOT=/work/install REPO_URL=/work/source REPO_BRANCH=meteorite-target TEST_GATE_ORIGIN_URL='$repo_url' ENV_FILE=/work/config/orchestrator.env BUN_BIN=/root/.bun/bin/bun RUNTIME_DIR=/work/runtime INFRA_STATE_DB=/work/runtime/state.db FULL_SUITE_ON_CALENDAR='*-*-* 03:30:00' ORCH_WATCHDOG_INTERVAL=60 bash bootstrap/install.sh"
  "bootstrap-verify-source|cd /work/source && INSTALL_ROOT=/work/install ENV_FILE=/work/config/orchestrator.env BUN_BIN=/root/.bun/bin/bun RUNTIME_DIR=/work/runtime INFRA_STATE_DB=/work/runtime/state.db bash bootstrap/install.sh --verify-source"
  # Voice/speech-to-text on a rebuilt host (V3-5.40, cutover gate G). bootstrap
  # runs tools/whisper/install.sh; this stage measures the RESULT, and it asks
  # the daemon's own resolver rather than restating the layout: the paths under
  # test are whatever daemon/transcribe.ts resolves with an empty environment,
  # so moving the installer's destination or the daemon's default apart from
  # each other fails here on the rebuilt host, not silently on the first voice
  # message. The binary is then executed, because a file that exists is not a
  # binary that runs.
  #
  # Deliberately no pipeline: a bare pipeline reports only its LAST command's
  # status, so a failed resolver feeding a successful filter would report
  # success (`instructions/verification-and-locks.md`, "a kill is not a pass").
  # The resolver's status is taken by the assignment, and the binary it named
  # is then executed as its own command.
  "whisper|test -f /work/install/tools/whisper/install.sh && cd /work/install && whisper_bin=\"\$(/root/.bun/bin/bun -e 'import { resolveWhisperConfig, whisperAvailable } from \"./daemon/transcribe.ts\"; const cfg = resolveWhisperConfig({}); if (!whisperAvailable(cfg)) { console.error(\"METEORITE-WHISPER unresolved bin=\" + cfg.bin + \" model=\" + cfg.model); process.exit(1); } console.error(\"METEORITE-WHISPER resolved bin=\" + cfg.bin + \" model=\" + cfg.model); console.log(cfg.bin);')\" && test -n \"\$whisper_bin\" && \"\$whisper_bin\" --version >/dev/null"
  "test-prerequisites|test -n '$donor_sha' && test -n '$donor_ref' && test -x /usr/local/bin/bun && test \"\$(git -C /work/install rev-parse refs/remotes/origin/v2-deprecated)\" = '$donor_sha'"
  "full-test-suite|cd /work/install && PATH=/root/.bun/bin:\$PATH /root/.bun/bin/bun test"
  # Gate D of the cutover consilium: START the orchestrator on the rebuilt
  # machine and assert it reaches a live state, rather than asserting that files
  # copied. Runs last, against the fully installed tree and the state database
  # bootstrap/install.sh created -- the lease/reap branch of the launcher is
  # guarded by that database's existence, and it is where the 2026-08-04
  # unstartable-launcher regression lived. Contract and boundaries:
  # meteorite/live-orchestrator-stage.sh.
  "unit-drift|install -d /work/rendered-units && for template in /work/install/bootstrap/units/*.in /work/install/instance/units/*.in; do test -f \"\$template\" || continue; INSTALL_ROOT=/root/bpa-dev-infrastructure ENV_FILE=/root/.config/bpa/orchestrator.env BUN_BIN=/usr/local/bin/bun BASH_BIN=/usr/bin/bash FULL_SUITE_ON_CALENDAR='*-*-* 03:30:00' ORCH_WATCHDOG_INTERVAL=60 envsubst < \"\$template\" > \"/work/rendered-units/\$(basename \"\${template%.in}\")\"; done && cd /work/install && SYSTEMD_SYSTEM_DIR=/work/rendered-units bash bootstrap/check-unit-drift.sh"
  "orchestrator-live|cd /work/install && PATH=/root/.bun/bin:\$PATH METEORITE_LIVE_INSTALL_ROOT=/work/install METEORITE_LIVE_RUNTIME_DIR=/work/runtime/orchestrator METEORITE_LIVE_STATE_DB=/work/runtime/state.db bash meteorite/live-orchestrator-stage.sh"
)

# The contract is compared in BOTH directions, and this is the direction that
# was missing. The loop further down catches a stage DELETED from `commands`.
# Nothing caught a stage that was never ADDED to `required_stages` -- and that is
# precisely a stage whose later deletion would still report `clean`, which is the
# one failure the contract exists to prevent. It is not hypothetical: `whisper`
# arrived exactly that way and it took human attention during a rebase to
# notice. A contract that only refuses what someone remembered to add to it is a
# comment that happens to be inside an array.
#
# Checked before any stage runs, because it is a property of this file and
# waiting fifteen minutes to be told about a typo helps nobody.
uncontracted_stages=()
for entry in "${commands[@]}"; do
  stage="${entry%%|*}"
  contracted=0
  for required in "${required_stages[@]}"; do
    [[ "$required" == "$stage" ]] && contracted=1 && break
  done
  ((contracted)) || uncontracted_stages+=("$stage")
done
if ((${#uncontracted_stages[@]})); then
  fail "stage-contract" "stage(s) executed but absent from required_stages: $(IFS=,; printf '%s' "${uncontracted_stages[*]}")" || true
  exit 1
fi

for entry in "${commands[@]}"; do
  stage="${entry%%|*}"
  command="${entry#*|}"
  if ! run_exec_stage "$stage" "$command"; then
    exit 1
  fi
done

# The executed list is compared against the contract, not assumed to match it.
# Deleting a stage from `commands` above would otherwise produce a green report
# for a proof that no longer performs the check the stage existed to perform.
missing_stages=()
for stage in "${required_stages[@]}"; do
  passed=0
  for entry in ${stages[@]+"${stages[@]}"}; do
    [[ "$entry" == "$stage|PASS" ]] && passed=1 && break
  done
  ((passed)) || missing_stages+=("$stage")
done
if ((${#missing_stages[@]})); then
  fail "stage-contract" "required stage(s) not executed: $(IFS=,; printf '%s' "${missing_stages[*]}")" || true
  exit 1
fi

# Every declared stage ran to completion. The verdict below is a separate
# question: a finished run can still refuse.
finished=1

installed_sha="$(docker exec "$cid" git -C /work/install rev-parse HEAD 2>/dev/null)" || {
  fail "sha-verification" "installed checkout SHA could not be measured" || true
  exit 1
}
if [[ "$installed_sha" != "$tested_sha" ]]; then
  fail "sha-verification" "installed SHA $installed_sha differs from fetched SHA $tested_sha" || true
  exit 1
fi
result="clean"
blocker="none"
printf '[meteorite] clean: %s\n' "$tested_sha"
