#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

assert() {
  if ! "$@"; then
    echo "assertion failed: $*" >&2
    exit 1
  fi
}

assert_not() {
  if "$@"; then
    echo "unexpected success: $*" >&2
    exit 1
  fi
}

make_fixture() {
  name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "$bare" "$repo" >/dev/null
  git -C "$repo" config user.email land@example.test
  git -C "$repo" config user.name Land
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
}

make_lane() {
  repo="$1"
  lane="$2"
  git -C "$repo" checkout -b "$lane" >/dev/null
  printf 'lane\n' > "$repo/lane.txt"
  git -C "$repo" add lane.txt
  git -C "$repo" commit -m lane >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

report() {
  path="$1"
  sha="$2"
  printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" > "$path"
}

make_fixture good
good_sha=$(make_lane "$fixture_root/good-repo" ag-good)
report "$fixture_root/good-report.md" "$good_sha"
"$land" --branch ag-good --report "$fixture_root/good-report.md" --repo "$fixture_root/good-repo" --run-verify
assert git -C "$fixture_root/good-repo" merge-base --is-ancestor "$good_sha" HEAD
assert test "$(git -C "$fixture_root/good-repo" rev-list --parents -n 1 HEAD | wc -w)" -eq 3
assert_not git -C "$fixture_root/good-repo" show-ref --verify --quiet refs/heads/ag-good
assert test "$(git --git-dir="$fixture_root/good-origin.git" rev-parse main)" = "$(git -C "$fixture_root/good-repo" rev-parse HEAD)"

make_fixture bad-sha
make_lane "$fixture_root/bad-sha-repo" ag-bad-sha >/dev/null
report "$fixture_root/bad-sha-report.md" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if "$land" --branch ag-bad-sha --report "$fixture_root/bad-sha-report.md" --repo "$fixture_root/bad-sha-repo"; then exit 1; fi
assert test "$(git -C "$fixture_root/bad-sha-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/bad-sha-repo" rev-parse main)"
assert git -C "$fixture_root/bad-sha-repo" show-ref --verify --quiet refs/heads/ag-bad-sha

make_fixture secret
secret_sha=$(make_lane "$fixture_root/secret-repo" ag-secret)
secret_prefix=$(printf '%s%s' 'gh' 'p_')
secret_suffix=$(printf 'x%.0s' $(seq 1 36))
printf '%s%s\n' "$secret_prefix" "$secret_suffix" > "$fixture_root/secret-repo/secret.txt"
git -C "$fixture_root/secret-repo" checkout ag-secret >/dev/null
git -C "$fixture_root/secret-repo" add secret.txt
git -C "$fixture_root/secret-repo" commit -m secret >/dev/null
secret_sha=$(git -C "$fixture_root/secret-repo" rev-parse HEAD)
git -C "$fixture_root/secret-repo" checkout main >/dev/null
report "$fixture_root/secret-report.md" "$secret_sha"
if "$land" --branch ag-secret --report "$fixture_root/secret-report.md" --repo "$fixture_root/secret-repo"; then exit 1; fi
assert test "$(git -C "$fixture_root/secret-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/secret-repo" rev-parse main)"

make_fixture no-push
no_push_sha=$(make_lane "$fixture_root/no-push-repo" ag-no-push)
report "$fixture_root/no-push-report.md" "$no_push_sha"
origin_before=$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)
"$land" --branch ag-no-push --report "$fixture_root/no-push-report.md" --repo "$fixture_root/no-push-repo" --no-push
assert test "$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)" = "$origin_before"

echo "land tests: pass"
