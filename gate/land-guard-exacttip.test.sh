#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
bare="$fixture/origin.git"
repo="$fixture/repo"
git init --bare --initial-branch=main "$bare" >/dev/null
git clone "$bare" "$repo" >/dev/null
git -C "$repo" config user.email guard@example.test
git -C "$repo" config user.name Guard
printf 'base\n' > "$repo/base"
printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
git -C "$repo" add base base.test.ts
git -C "$repo" commit -m base >/dev/null
git -C "$repo" push -u origin main >/dev/null
git -C "$repo" checkout -b ag-stale >/dev/null
printf 'A\n' > "$repo/lane"
git -C "$repo" add lane
git -C "$repo" commit -m A >/dev/null
sha_a=$(git -C "$repo" rev-parse HEAD)
printf 'B\n' >> "$repo/lane"
git -C "$repo" commit -am B >/dev/null
git -C "$repo" checkout main >/dev/null
printf 'commit: %s A\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha_a" > "$fixture/report"
before=$(git -C "$repo" rev-parse main)
if "$root/gate/land.sh" --branch ag-stale --report "$fixture/report" --repo "$repo" --no-push >"$fixture/out" 2>&1; then
  echo "stale report unexpectedly landed" >&2
  exit 1
fi
grep -Fq 'FAIL branch-tip' "$fixture/out"
if grep -Fq 'LAND step=merge status=pass' "$fixture/out"; then exit 1; fi
test "$(git -C "$repo" rev-parse main)" = "$before"

# Interrupt immediately after git has created the merge commit.
git -C "$repo" branch -D ag-stale >/dev/null
git -C "$repo" checkout -b ag-term >/dev/null
printf 'term\n' > "$repo/term"
git -C "$repo" add term
git -C "$repo" commit -m term >/dev/null
term_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
printf 'commit: %s term\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$term_sha" > "$fixture/term-report"
real_git=$(command -v git)
mkdir "$fixture/bin"
sed "s|@REAL_GIT@|$real_git|" > "$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
set -e
if [[ " $* " == *" merge --no-ff "* ]]; then
  "@REAL_GIT@" "$@"
  kill -TERM "$PPID"
  exit 143
fi
exec "@REAL_GIT@" "$@"
EOF
chmod +x "$fixture/bin/git"
if PATH="$fixture/bin:$PATH" "$root/gate/land.sh" --branch ag-term --report "$fixture/term-report" --repo "$repo" >"$fixture/term-out" 2>&1; then
  echo "interrupted landing unexpectedly succeeded" >&2
  exit 1
fi
test "$(git -C "$repo" branch --show-current)" = main
test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"
test ! -e "$(git -C "$repo" rev-parse --git-dir)/MERGE_HEAD"
test "$(git -C "$repo" rev-parse --verify ag-term)" = "$term_sha"
"$root/gate/land.sh" --branch ag-term --report "$fixture/term-report" --repo "$repo" --no-push >"$fixture/retry-out" 2>&1
grep -Fq 'LAND verdict=landed' "$fixture/retry-out"
echo "land exact-tip and interruption locks: pass"
