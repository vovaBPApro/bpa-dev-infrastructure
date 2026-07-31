#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'git -C "$REPO_DIR" worktree remove --force "$SCRATCH/lanes/proof" >/dev/null 2>&1 || true; git -C "$REPO_DIR" branch -D ag-fleet-launch-proof >/dev/null 2>&1 || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/lanes"

cat >"$SCRATCH/task.md" <<'EOF'
# Dispatch proof

Report the current branch.
EOF
cat >"$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_SYSTEMD_ARGS"
exit 0
EOF
chmod +x "$SCRATCH/bin/"*

PATH="$SCRATCH/bin:$PATH" CODEX_BIN="$SCRATCH/bin/codex" MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-proof \
  >"$SCRATCH/output"

grep -Fq 'launched lane-proof' "$SCRATCH/output"
test -d "$SCRATCH/lanes/proof/.git" || test -f "$SCRATCH/lanes/proof/.git"
grep -Fq '<!-- compose.ts pack v1 role=coder' "$SCRATCH/lanes/lane-proof.prompt.md"
grep -Fq '# Dispatch proof' "$SCRATCH/lanes/lane-proof.prompt.md"
git -C "$SCRATCH/lanes/proof" symbolic-ref --short HEAD | grep -Fxq ag-fleet-launch-proof
grep -Fxq -- '--unit' "$SCRATCH/systemd.args"
grep -Fxq 'lane-proof' "$SCRATCH/systemd.args"
if grep -Fxq -- '--user' "$SCRATCH/systemd.args"; then
  printf 'systemd-run incorrectly used the user manager\n' >&2
  exit 1
fi
grep -Fq -- '--working-directory=' "$SCRATCH/systemd.args"
grep -Fq 'StandardOutput=append:' "$SCRATCH/systemd.args"

printf 'launch-lane dispatch proof: PASS\n'
