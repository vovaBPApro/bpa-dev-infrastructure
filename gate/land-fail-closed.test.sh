#!/usr/bin/env bash
set -u
set -o pipefail

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
real_git=$(command -v git)

mkdir -p "$tmp/bin"
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = diff ]; then
    exit 77
  fi
  if [ "$arg" = merge ]; then
    printf '%s\n' merge >> "$LAND_TEST_GIT_LOG"
  fi
done
exec "$LAND_TEST_REAL_GIT" "$@"
SH
chmod +x "$tmp/bin/git"

export LAND_TEST_REAL_GIT="$real_git"
export LAND_TEST_GIT_LOG="$tmp/git.log"
export LAND_DEFAULT_BRANCH=main
export PATH="$tmp/bin:$PATH"

"$real_git" init -q --bare "$tmp/origin.git"
"$real_git" clone -q "$tmp/origin.git" "$tmp/repo"
"$real_git" -C "$tmp/repo" config user.name Test
"$real_git" -C "$tmp/repo" config user.email test@example.invalid
printf 'base\n' > "$tmp/repo/base.txt"
"$real_git" -C "$tmp/repo" add base.txt
"$real_git" -C "$tmp/repo" commit -qm base
"$real_git" -C "$tmp/repo" branch -M main
"$real_git" -C "$tmp/repo" push -qu origin main
"$real_git" --git-dir="$tmp/origin.git" symbolic-ref HEAD refs/heads/main
"$real_git" -C "$tmp/repo" checkout -qb ag-test
printf 'change\n' > "$tmp/repo/change.txt"
"$real_git" -C "$tmp/repo" add change.txt
"$real_git" -C "$tmp/repo" commit -qm change
"$real_git" -C "$tmp/repo" checkout -q main

# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"
report="$tmp/ag-test.md"
printf 'commit: %s test\n' "$("$real_git" -C "$tmp/repo" rev-parse ag-test)" > "$report"
policy="$tmp/policy.conf"
printf 'gate/\n' > "$policy"

failures=0
for guard in review secret payload; do
  case "$guard" in
    review) land_review_check "$tmp/repo" ag-test "$report" "$policy" false ;;
    secret) land_secret_scan "$tmp/repo" ag-test ;;
    payload) land_payload_guard "$tmp/repo" ag-test ;;
  esac
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "FAIL $guard accepted failed git diff"
    failures=$((failures + 1))
  fi
done

mkdir -p "$tmp/fake"
cat > "$tmp/fake/bun" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$tmp/fake/bun"
export BUN_BIN="$tmp/fake/bun"
land_output=$("$root/gate/land.sh" --branch ag-test --report "$report" --repo "$tmp/repo" --no-push 2>&1)
land_status=$?
if [ "$land_status" -eq 0 ] || [ -s "$LAND_TEST_GIT_LOG" ] || printf '%s\n' "$land_output" | grep -Eq 'LAND step=(review|secret-scan|payload-guard) status=pass'; then
  echo "FAIL land.sh did not stop before merge/pass"
  failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || exit 1
echo "PASS failed git diff is rejected by all guards and land.sh"
