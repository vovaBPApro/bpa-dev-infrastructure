#!/usr/bin/env bash
# Fail when a deployed BPA system unit differs from its rendered tracked template,
# and fail when a tracked template points at a repository path v3 does not have.
#
# Ported from v2-deprecated (bootstrap/check-unit-drift.sh) for row V3-1.2. The
# reason this exists at all: on 2026-08-03 the host was found missing 8 canonical
# systemd units, including bpa-orchestrator-watchdog and bpa-deploy-drift-guard
# itself -- the guard whose job was to detect exactly this gap was part of the
# gap. See instance/decisions/HR-1720.md.
#
# Two independent checks live here, both fail-closed (Hard Floor 7):
#
#   1. DEPLOYED-UNIT DRIFT (the donor's original check): does the file at
#      $SYSTEMD_SYSTEM_DIR/<unit> match the template rendered with envsubst?
#      A unit absent from $SYSTEMD_SYSTEM_DIR is DRIFT unless explicitly
#      exempted in $EXEMPTIONS_FILE with a disposition and evidence.
#
#   2. REFERENCED-PATH DRIFT (new in V3-1.2): does every ${INSTALL_ROOT}-anchored
#      path a template names in ExecStart/ExecStartPre/ExecStartPost/ExecStop/
#      WorkingDirectory/Environment/EnvironmentFile actually exist in THIS
#      repository? The donor line's templates point at scripts from the old
#      layout (meteorite/run.sh, orchestrator/full-suite.sh, database/*, ...);
#      a unit whose ExecStart names a file v3 does not have is worse than no
#      unit at all, because it fails at systemd-activation time instead of at
#      review time. A template with a dangling reference is drift unless
#      explicitly exempted in $PATH_EXEMPTIONS_FILE with evidence.
#
# Both exemption files are read-or-absent, never read-or-silently-skip: a file
# that EXISTS but cannot be READ is a hard failure (exit 2), not "no
# exemptions". That distinction is the exact defect class an independent
# reviewer found elsewhere in this repository on 2026-08-03: a check that
# reported clean because it could not read its own input file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-$SCRIPT_DIR/units}"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"
# The path-existence check is deliberately independent of where the unit will
# be deployed (INSTALL_ROOT). It asks "does THIS repository carry the file",
# which is answerable in a plain checkout or a bare test, with no container
# and no host install required.
REPO_ROOT="${REPO_ROOT:-$SCRIPT_DIR/..}"
ENV_FILE="${ENV_FILE:-/root/.config/bpa/orchestrator.env}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
BASH_BIN="${BASH_BIN:-/usr/bin/bash}"
FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-*-*-* 03:30:00}"
ORCH_WATCHDOG_INTERVAL="${ORCH_WATCHDOG_INTERVAL:-60}"
EXEMPTIONS_FILE="${EXEMPTIONS_FILE:-$SCRIPT_DIR/../instance/unit-drift-exemptions.tsv}"
PATH_EXEMPTIONS_FILE="${PATH_EXEMPTIONS_FILE:-$SCRIPT_DIR/../instance/unit-path-exemptions.tsv}"
export INSTALL_ROOT ENV_FILE BUN_BIN BASH_BIN FULL_SUITE_ON_CALENDAR ORCH_WATCHDOG_INTERVAL

command -v envsubst >/dev/null 2>&1 || {
  echo 'ERROR: envsubst is required to check unit drift' >&2
  exit 2
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/bpa-unit-drift.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

result=0
template_count=0

# ── Deployed-unit exemptions ────────────────────────────────────────────────
declare -A missing_exemptions=()
if [[ -e "$EXEMPTIONS_FILE" ]]; then
  if [[ ! -f "$EXEMPTIONS_FILE" || ! -r "$EXEMPTIONS_FILE" ]]; then
    # Not a plain, readable file -- e.g. a directory, which `-r` alone would
    # not catch (root can list a directory it cannot usefully "read" here; a
    # `read` against it fails per-line instead of refusing up front, which is
    # exactly the "silently zero exemptions" failure mode this guards).
    printf 'ERROR unit-drift-exemptions unreadable file=%s (refusing to treat as no exemptions)\n' "$EXEMPTIONS_FILE" >&2
    exit 2
  fi
  while IFS=$'\t' read -r unit disposition evidence extra; do
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
declare -A path_exemptions=()
if [[ -e "$PATH_EXEMPTIONS_FILE" ]]; then
  if [[ ! -f "$PATH_EXEMPTIONS_FILE" || ! -r "$PATH_EXEMPTIONS_FILE" ]]; then
    printf 'ERROR unit-path-exemptions unreadable file=%s (refusing to treat as no exemptions)\n' "$PATH_EXEMPTIONS_FILE" >&2
    exit 2
  fi
  while IFS=$'\t' read -r unit evidence extra; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    if [[ -n "${extra:-}" || "$unit" != *.service && "$unit" != *.timer || -z "$evidence" ]]; then
      printf 'ERROR invalid unit-path exemption: %s\n' "$unit" >&2
      exit 2
    fi
    if [[ -n "${path_exemptions[$unit]+x}" ]]; then
      printf 'ERROR duplicate unit-path exemption: %s\n' "$unit" >&2
      exit 2
    fi
    path_exemptions["$unit"]="$evidence"
  done < "$PATH_EXEMPTIONS_FILE"
fi

# Extract every ${INSTALL_ROOT}- or $INSTALL_ROOT-anchored path referenced in a
# RAW (pre-envsubst) template and check it exists in this repository. Operates
# on the raw template, not the rendered one, so the check needs no envsubst
# and is independent of the INSTALL_ROOT value used for deployment rendering.
check_referenced_paths() {
  local template="$1" unit="$2" normalized ref relpath missing=0
  normalized="$scratch/normalized-$unit"
  sed -e 's/\${INSTALL_ROOT}/@@IROOT@@/g' -e 's/\$INSTALL_ROOT/@@IROOT@@/g' "$template" > "$normalized"
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    relpath="${ref#@@IROOT@@}"
    [[ -z "$relpath" ]] && continue
    if [[ ! -e "$REPO_ROOT$relpath" ]]; then
      if [[ -n "${path_exemptions[$unit]+x}" ]]; then
        printf 'PATH-EXEMPT %s: %s not in repo (%s)\n' "$unit" "$relpath" "${path_exemptions[$unit]}"
      else
        printf 'PATH-MISSING %s: %s does not exist under %s\n' "$unit" "$relpath" "$REPO_ROOT" >&2
        missing=1
      fi
    fi
  done < <(grep -oE '@@IROOT@@[^[:space:]"'"'"'<>]*' "$normalized" || true)
  return "$missing"
}

for template in "$TEMPLATE_DIR"/*.in; do
  [[ -f "$template" ]] || continue
  ((template_count += 1))
  unit="$(basename "${template%.in}")"
  deployed="$SYSTEMD_SYSTEM_DIR/$unit"
  expected="$scratch/$unit"
  envsubst < "$template" > "$expected"

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

if ((template_count == 0)); then
  printf 'ERROR: no unit templates found in %s\n' "$TEMPLATE_DIR" >&2
  exit 2
fi

exit "$result"
