#!/usr/bin/env bash
# Fail closed when a Human decision record exists on the donor line but not here.
#
# The v3 rewrite copied a file tree, not a ledger. Fourteen HR-*.md records ruled
# between 2026-08-02 and 2026-08-03 -- after the fork snapshot -- were absent from
# this line until they were ported, so directives the Human had already given were
# invisible to any session reading only this branch. Whisper's missing installer was
# the same failure class: the requirement survived, the mechanism did not.
#
# bootstrap/check-unit-drift.sh already applies this idea to systemd units. This
# applies it to the decision ledger, so the ledger audits itself instead of relying
# on someone remembering to re-read old chat.
#
# A record may be legitimately absent only if it is explicitly dispositioned in the
# exceptions file, one `HR-<id> <reason>` per line. Absence with no disposition is a
# failure, never a pass (Hard Floor 7).
set -uo pipefail

DONOR="${LEDGER_DONOR_REF:-v2-deprecated}"
LEDGER_DIR="${LEDGER_DIR:-instance/decisions}"
EXCEPTIONS="${LEDGER_EXCEPTIONS:-instance/decisions/ported-exceptions.txt}"

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root" || exit 2

if git rev-parse --verify --quiet "$DONOR" >/dev/null; then
  donor_resolved="$DONOR"
elif git rev-parse --verify --quiet "origin/$DONOR" >/dev/null; then
  donor_resolved="origin/$DONOR"
else
  # A missing donor ref must not silently pass. If the donor line is gone the check
  # can no longer prove anything, and proving nothing is not the same as being clean.
  printf 'LEDGER-DRIFT donor-ref-missing ref=%s (cannot verify; refusing to pass)\n' "$DONOR" >&2
  exit 2
fi

donor_list=$(git ls-tree "$donor_resolved" --name-only "$LEDGER_DIR/" | sed 's|.*/||' | grep -E '^HR-.*\.md$' | sort)
here_list=$(git ls-tree HEAD --name-only "$LEDGER_DIR/" | sed 's|.*/||' | grep -E '^HR-.*\.md$' | sort)

missing=$(comm -23 <(printf '%s\n' "$donor_list") <(printf '%s\n' "$here_list"))

status=0
undispositioned=0
for name in $missing; do
  id=${name%.md}
  if [ -r "$EXCEPTIONS" ] && grep -qE "^${id}([[:space:]]|$)" "$EXCEPTIONS"; then
    reason=$(grep -E "^${id}([[:space:]]|$)" "$EXCEPTIONS" | head -1 | sed -E "s/^${id}[[:space:]]*//")
    printf 'DISPOSITIONED %s: %s\n' "$id" "${reason:-<no reason given>}"
    if [ -z "$reason" ]; then
      printf 'LEDGER-DRIFT empty-disposition %s (a disposition needs a reason)\n' "$id" >&2
      status=1
    fi
  else
    printf 'LEDGER-DRIFT missing %s: present on %s, absent here, no disposition\n' "$id" "$DONOR" >&2
    undispositioned=$((undispositioned + 1))
    status=1
  fi
done

total_donor=$(printf '%s\n' "$donor_list" | grep -c . || true)
total_here=$(printf '%s\n' "$here_list" | grep -c . || true)
printf 'ledger: donor=%s here=%s undispositioned-missing=%s\n' "$total_donor" "$total_here" "$undispositioned"
exit "$status"
