#!/usr/bin/env bash
# Fail when a deployed BPA system unit differs from its rendered tracked template,
# fail when a tracked template points at a repository path v3 does not have, and
# fail when a REQUIRED unit's template has gone missing from the tree entirely.
#
# Ported from v2-deprecated (bootstrap/check-unit-drift.sh) for row V3-1.2. The
# reason this exists at all: on 2026-08-03 the host was found missing 8 canonical
# systemd units, including bpa-orchestrator-watchdog and bpa-deploy-drift-guard
# itself -- the guard whose job was to detect exactly this gap was part of the
# gap. See instance/decisions/HR-1720.md.
#
# Three independent checks live here, all fail-closed (Hard Floor 7):
#
#   1. MANIFEST COMPLETENESS (round 2: this is the one that matters most). A
#      loop over "$TEMPLATE_DIR"/*.in can only ever validate templates that
#      happen to exist -- it has no opinion on a template that used to exist
#      and is now gone. That is the 2026-08-01 incident moved one layer up:
#      instead of the HOST silently losing a unit, the REPOSITORY silently
#      loses the template for that unit, and a checker that only enumerates
#      what it finds says nothing. $MANIFEST_FILE is an independent list of
#      every unit basename that MUST have a template somewhere in
#      $TEMPLATE_DIR or $INSTANCE_TEMPLATE_DIR; a manifest entry with no
#      matching .in file is drift, named, non-zero exit.
#
#   2. DEPLOYED-UNIT DRIFT (the donor's original check): does the file at
#      $SYSTEMD_SYSTEM_DIR/<unit> match the template rendered with envsubst?
#      A unit absent from $SYSTEMD_SYSTEM_DIR is DRIFT unless explicitly
#      exempted in $EXEMPTIONS_FILE with a disposition and evidence.
#
#   3. REFERENCED-PATH DRIFT (new in V3-1.2): does every ${INSTALL_ROOT}-anchored
#      path a template names in ExecStart/ExecStartPre/ExecStartPost/ExecStop/
#      WorkingDirectory/Environment/EnvironmentFile actually exist in THIS
#      repository? The donor line's templates point at scripts from the old
#      layout (meteorite/run.sh, orchestrator/full-suite.sh, database/*, ...);
#      a unit whose ExecStart names a file v3 does not have is worse than no
#      unit at all, because it fails at systemd-activation time instead of at
#      review time. A template with a dangling reference is drift unless
#      explicitly exempted in $PATH_EXEMPTIONS_FILE, keyed on the EXACT
#      unit+path pair -- a whole-unit exemption would let an unrelated new
#      dangling reference ride in on an old, unrelated justification (this was
#      round-1 review round-2 defect 2; proven in check-unit-drift.test.ts).
#      An exemption also EXPIRES (V3-2.16): the day the repository carries the
#      path, the reason the entry was granted for is gone, so a row naming a
#      path that now exists is itself a failure -- the same rule V3-2.13
#      settled for the sibling ledger instance/doc-path-exemptions.tsv. Every
#      row names an owner too, because an unowned debt is the one nobody
#      closes.
#
# instance/units/ holds unit templates specific to THIS installation's product
# (currently the three agentic-bpa-* units: db-grants, staleness, and
# stand-verifier). bootstrap/units/ stays generic -- CLAUDE.md's Mission and
# HR-309 rule that hard-coding a product name into the generic mechanism is a
# defect that instance/ exists to absorb. Both directories are checked by all
# three passes above; the manifest records which directory each unit belongs
# in, so the split is enforced, not just documented.
#
# All three exemption/manifest files are read-or-absent, never
# read-or-silently-skip: a file that EXISTS but is not a plain readable file
# (e.g. a directory) is a hard failure (exit 2), not "no exemptions". That
# distinction is the exact defect class an independent reviewer found
# elsewhere in this repository on 2026-08-03: a check that reported clean
# because it could not read its own input file. Every TSV loop here also
# tolerates a final line with no trailing newline -- `while read` alone drops
# it, which is a foot-gun one edit away from silently narrowing a manifest or
# an exemption list.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-$SCRIPT_DIR/units}"
INSTANCE_TEMPLATE_DIR="${INSTANCE_TEMPLATE_DIR:-$SCRIPT_DIR/../instance/units}"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
# INSTALL_ROOT, ENV_FILE, BUN_BIN, BASH_BIN, FULL_SUITE_ON_CALENDAR and
# ORCH_WATCHDOG_INTERVAL come from unit-render-lib.sh, which applies their
# defaults on source and owns the render itself. This script used to keep its
# own six-name list while bootstrap/install.sh kept a four-name one, so the
# deployed units and the units checked here were rendered differently and this
# check could not see it (V3-2.12).
# shellcheck source=bootstrap/unit-render-lib.sh
source "$SCRIPT_DIR/unit-render-lib.sh"
# The path-existence check is deliberately independent of where the unit will
# be deployed (INSTALL_ROOT). It asks "does THIS repository carry the file",
# which is answerable in a plain checkout or a bare test, with no container
# and no host install required.
REPO_ROOT="${REPO_ROOT:-$SCRIPT_DIR/..}"

# One home for "does this repository carry the path a unit names". Both users
# of the predicate -- the REFERENCED-PATH check below and the discharged-
# exemption check that guards it -- MUST answer identically, because they are
# exact inverses: an absent path needs an exemption, and a present path may not
# have one. Two predicates would make a path that one call answers "absent" and
# the other "present" simultaneously required and forbidden in the ledger, and
# no ledger content would pass. So the answer is computed in one place.
#
# The sibling ledger's checker (tools/instructions/paths.ts, V3-2.13) answers
# the same question from `git ls-files` instead, because ITS subject includes
# gitignored and host-only paths whose presence differs per tree. Same rule,
# different predicate, and deliberately so: each expiry check must inherit the
# predicate of the check it guards, not the other one's. The consequence is
# inherited too and is worth naming -- an untracked file present only on this
# host answers "exists" here, which has been true of the REFERENCED-PATH check
# since V3-1.2 and is a property of that predicate, not of the expiry rule.
repo_path_exists() {
  [[ -e "$REPO_ROOT$1" ]]
}

EXEMPTIONS_FILE="${EXEMPTIONS_FILE:-$SCRIPT_DIR/../instance/unit-drift-exemptions.tsv}"
PATH_EXEMPTIONS_FILE="${PATH_EXEMPTIONS_FILE:-$SCRIPT_DIR/../instance/unit-path-exemptions.tsv}"
MANIFEST_FILE="${MANIFEST_FILE:-$SCRIPT_DIR/../instance/expected-units.tsv}"

command -v envsubst >/dev/null 2>&1 || {
  echo 'ERROR: envsubst is required to check unit drift' >&2
  exit 2
}

# A file that exists but is not a plain, readable file (a directory, most
# plausibly) must fail closed rather than be treated as "no entries". `-r`
# alone does not catch a directory: root can list one, but a bash `read`
# against it fails per-line instead of refusing up front -- silently
# collapsing to zero entries instead of an explicit error.
require_readable_or_absent() {
  local file="$1" label="$2"
  if [[ -e "$file" ]] && { [[ ! -f "$file" ]] || [[ ! -r "$file" ]]; }; then
    printf 'ERROR %s unreadable file=%s (refusing to treat as empty)\n' "$label" "$file" >&2
    exit 2
  fi
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/bpa-unit-drift.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

result=0
template_count=0

resolve_template_dir() {
  case "$1" in
    generic) printf '%s\n' "$TEMPLATE_DIR" ;;
    instance) printf '%s\n' "$INSTANCE_TEMPLATE_DIR" ;;
    *) return 1 ;;
  esac
}

# ── Expected-units manifest (independent of any directory listing) ─────────
# This is the fix for the disqualifying round-1 defect: a loop over *.in can
# only ever validate templates that exist. The manifest is a second, separate
# source of truth for what MUST exist, so a template silently deleted from
# the tree is caught here even though the directory-listing loop below would
# have nothing to say about it.
require_readable_or_absent "$MANIFEST_FILE" "expected-units manifest"
if [[ ! -e "$MANIFEST_FILE" ]]; then
  printf 'ERROR expected-units manifest missing file=%s (refusing to check unit-template presence blindly)\n' "$MANIFEST_FILE" >&2
  exit 2
fi
manifest_count=0
while IFS=$'\t' read -r unit source extra || [[ -n "${unit:-}" ]]; do
  [[ -z "$unit" || "$unit" == \#* ]] && continue
  if [[ -n "${extra:-}" || ( "$unit" != *.service && "$unit" != *.timer ) || ( "$source" != generic && "$source" != instance ) ]]; then
    printf 'ERROR invalid expected-units entry: %s\n' "$unit" >&2
    exit 2
  fi
  ((manifest_count += 1))
  dir=$(resolve_template_dir "$source") || { printf 'ERROR invalid expected-units source: %s\n' "$source" >&2; exit 2; }
  if [[ ! -f "$dir/$unit.in" ]]; then
    printf 'MANIFEST-MISSING %s: no template at %s/%s.in (source=%s)\n' "$unit" "$dir" "$unit" "$source" >&2
    result=1
  fi
done < "$MANIFEST_FILE"
if ((manifest_count == 0)); then
  printf 'ERROR expected-units manifest empty file=%s\n' "$MANIFEST_FILE" >&2
  exit 2
fi

# ── Deployed-unit exemptions ────────────────────────────────────────────────
declare -A missing_exemptions=()
require_readable_or_absent "$EXEMPTIONS_FILE" "unit-drift-exemptions"
if [[ -e "$EXEMPTIONS_FILE" ]]; then
  while IFS=$'\t' read -r unit disposition evidence extra || [[ -n "${unit:-}" ]]; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    if [[ -n "${extra:-}" || "$unit" != *.service && "$unit" != *.timer || "$disposition" != deliberately-absent || -z "$evidence" ]]; then
      printf 'ERROR invalid unit-drift exemption: %s\n' "$unit" >&2
      exit 2
    fi
    if [[ -n "${missing_exemptions[$unit]+x}" ]]; then
      printf 'ERROR duplicate unit-drift exemption: %s\n' "$unit" >&2
      exit 2
    fi
    missing_exemptions["$unit"]="$evidence"
  done < "$EXEMPTIONS_FILE"
fi

# ── Referenced-path exemptions ──────────────────────────────────────────────
# Keyed on unit+path together (round-2 defect 2 fix), never on unit alone: a
# per-unit exemption would silently license ANY future dangling reference
# added to that template, wearing the original, unrelated justification. The
# key separator (US, 0x1F) cannot appear in a TSV field or a systemd path.
#
# Every entry also carries an OWNER, and the parser refuses one that does not
# (V3-2.16). An exemption is a debt, and a debt with nobody's name on it is the
# one nobody closes: two rows in this repository's own ledger recorded "no
# workboard row yet" and stayed that way. The evidence column therefore begins
# with `owner=<id>;` -- a tracking id, or the literal `none` when the entry
# deliberately needs no row, in which case the prose after the `;` is the
# statement of WHY none is needed. What an id looks like is this installation's
# business, not bootstrap/'s (CLAUDE.md Mission, HR-309), so this pattern
# matches the FIELD and never a row-id shape.
OWNER_FIELD='^owner=[^[:space:];]+;[[:space:]]*[^[:space:]]'
KEY_SEP=$'\x1f'
declare -A path_exemptions=()
declare -A path_exemption_lines=()
declare -a path_exemption_keys=()
require_readable_or_absent "$PATH_EXEMPTIONS_FILE" "unit-path-exemptions"
if [[ -e "$PATH_EXEMPTIONS_FILE" ]]; then
  path_exemption_line=0
  while IFS=$'\t' read -r unit relpath evidence extra || [[ -n "${unit:-}" ]]; do
    ((path_exemption_line += 1))
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    if [[ -n "${extra:-}" || "$unit" != *.service && "$unit" != *.timer || "$relpath" != /* || -z "$evidence" ]]; then
      printf 'ERROR invalid unit-path exemption: %s\n' "$unit" >&2
      exit 2
    fi
    if [[ ! "$evidence" =~ $OWNER_FIELD ]]; then
      printf 'ERROR unit-path exemption without an owner: %s %s (line %d: evidence must start with owner=<id>; or owner=none; followed by the reason)\n' \
        "$unit" "$relpath" "$path_exemption_line" >&2
      exit 2
    fi
    key="$unit$KEY_SEP$relpath"
    if [[ -n "${path_exemptions[$key]+x}" ]]; then
      printf 'ERROR duplicate unit-path exemption: %s %s\n' "$unit" "$relpath" >&2
      exit 2
    fi
    path_exemptions["$key"]="$evidence"
    path_exemption_lines["$key"]="$path_exemption_line"
    path_exemption_keys+=("$key")
  done < "$PATH_EXEMPTIONS_FILE"
fi

# ── Discharged exemptions (V3-2.16) ─────────────────────────────────────────
# An exemption excuses a unit for naming a path this repository does not carry.
# The day the repository carries it, the reason the entry was granted for is
# gone -- and until now nothing re-tested that, so `bpa-meteorite.service` kept
# an exemption for `/meteorite/run.sh` for the whole of the row that built it
# (V3-1.5, landed 133541c). It suppressed a check that would have passed, which
# is harmless in itself and proves the ledger could not tell a live debt from a
# discharged one.
#
# This is the rule V3-2.13 already settled for the sibling ledger
# instance/doc-path-exemptions.tsv (tools/instructions/paths.ts: "a row naming a
# path that now exists FAILS, so an exemption cannot outlive the reason it was
# granted"). Deliberately the SAME rule and not a second design -- two ledgers
# disagreeing about one discipline is itself the defect.
#
# The ledger is checked on its own terms, not only for the rows a template
# happens to reference, so a row that has quietly stopped applying cannot hide
# behind the fact that nothing consults it any more. This expires DISCHARGED
# debt; a row whose path is still absent is live debt and is left alone.
for key in ${path_exemption_keys[@]+"${path_exemption_keys[@]}"}; do
  exempt_unit="${key%%"$KEY_SEP"*}"
  exempt_path="${key#*"$KEY_SEP"}"
  if repo_path_exists "$exempt_path"; then
    printf 'PATH-EXEMPT-STALE %s: %s now exists in this repository -- the reason for this exemption is discharged; remove line %s of %s (was: %s)\n' \
      "$exempt_unit" "$exempt_path" "${path_exemption_lines[$key]}" "$PATH_EXEMPTIONS_FILE" "${path_exemptions[$key]}" >&2
    result=1
  fi
done

# Extract every ${INSTALL_ROOT}- or $INSTALL_ROOT-anchored path referenced in a
# RAW (pre-envsubst) template and check it exists in this repository. Operates
# on the raw template, not the rendered one, so the check needs no envsubst
# and is independent of the INSTALL_ROOT value used for deployment rendering.
check_referenced_paths() {
  local template="$1" unit="$2" normalized ref relpath missing=0 key
  normalized="$scratch/normalized-$unit"
  sed -e 's/\${INSTALL_ROOT}/@@IROOT@@/g' -e 's/\$INSTALL_ROOT/@@IROOT@@/g' "$template" > "$normalized"
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    relpath="${ref#@@IROOT@@}"
    [[ -z "$relpath" ]] && continue
    if ! repo_path_exists "$relpath"; then
      key="$unit$KEY_SEP$relpath"
      if [[ -n "${path_exemptions[$key]+x}" ]]; then
        printf 'PATH-EXEMPT %s: %s not in repo (%s)\n' "$unit" "$relpath" "${path_exemptions[$key]}"
      else
        printf 'PATH-MISSING %s: %s does not exist under %s\n' "$unit" "$relpath" "$REPO_ROOT" >&2
        missing=1
      fi
    fi
  done < <(grep -oE '@@IROOT@@[^[:space:]"'"'"'<>]*' "$normalized" || true)
  return "$missing"
}

for dir in "$TEMPLATE_DIR" "$INSTANCE_TEMPLATE_DIR"; do
  for template in "$dir"/*.in; do
    [[ -f "$template" ]] || continue
    ((template_count += 1))
    unit="$(basename "${template%.in}")"
    deployed="$SYSTEMD_SYSTEM_DIR/$unit"
    expected="$scratch/$unit"
    # Shared with bootstrap/install.sh, byte for byte. A template that renders
    # to an empty value or keeps a residual `$` is refused here rather than
    # silently becoming the "expected" bytes a deployed unit is compared
    # against -- a broken render matching a broken deployment is not a MATCH.
    if ! unit_render_template "$template" "$expected" "$unit"; then
      printf 'RENDER-REJECTED %s: template did not render to a usable unit\n' "$unit" >&2
      result=1
      continue
    fi

    if ! check_referenced_paths "$template" "$unit"; then
      result=1
    fi

    if [[ ! -f "$deployed" ]]; then
      if [[ -n "${missing_exemptions[$unit]+x}" ]]; then
        printf 'EXEMPT %s: deliberately absent (%s)\n' "$unit" "${missing_exemptions[$unit]}"
      else
        printf 'DRIFT %s: deployed unit missing at %s\n' "$unit" "$deployed" >&2
        result=1
      fi
    elif ! cmp -s "$expected" "$deployed"; then
      printf 'DRIFT %s: deployed unit differs from rendered template\n' "$unit" >&2
      diff -u --label "deployed/$unit" --label "tracked/$unit" "$deployed" "$expected" >&2 || true
      result=1
    else
      printf 'MATCH %s\n' "$unit"
    fi
  done
done

if ((template_count == 0)); then
  printf 'ERROR: no unit templates found in %s or %s\n' "$TEMPLATE_DIR" "$INSTANCE_TEMPLATE_DIR" >&2
  exit 2
fi

exit "$result"
