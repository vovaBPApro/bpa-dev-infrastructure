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
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_CODEX_ARGS"
touch "$MOCK_CODEX_EXECUTED"
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
while (($#)); do
  case "$1" in
    --collect) shift ;;
    --unit) shift 2 ;;
    --setenv=*) export "${1#--setenv=}"; shift ;;
    --working-directory=*) cd "${1#--working-directory=}"; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
exec "$@"
EOF
chmod +x "$SCRATCH/bin/"*

PATH="$SCRATCH/bin:$PATH" CODEX_BIN="$SCRATCH/bin/codex" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_CODEX_ARGS="$SCRATCH/codex.args" \
  MOCK_CODEX_EXECUTED="$SCRATCH/codex.executed" \
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
grep -Fxq -- '--property=IPAddressDeny=localhost' "$SCRATCH/systemd.args"
if grep -Fxq -- '--user' "$SCRATCH/systemd.args"; then
  printf 'systemd-run incorrectly used the user manager\n' >&2
  exit 1
fi
grep -Fq -- '--working-directory=' "$SCRATCH/systemd.args"
if grep -Fq 'StandardOutput=append:' "$SCRATCH/systemd.args"; then
  printf 'lane output bypassed the masking sink\n' >&2
  exit 1
fi
grep -Fq 'daemon/mask-stream.ts' "$SCRATCH/systemd.args"
test -f "$SCRATCH/codex.executed"
grep -Fxq 'exec' "$SCRATCH/codex.args"
grep -Fxq -- '--dangerously-bypass-approvals-and-sandbox' "$SCRATCH/codex.args"
grep -Fq '# Dispatch proof' "$SCRATCH/codex.args"

# Refusal lock: make the real marker gate reject after composition. No worktree,
# SYSTEM-manager call, or Codex payload may occur after that refusal.
REAL_BUN="${BUN_BIN:-$(command -v bun)}"
cat >"$SCRATCH/bin/refusing-bun" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == */dispatch-check.ts ]]; then
  printf 'injected marker refusal\n' >&2
  exit 17
fi
exec "$REAL_BUN" "\$@"
EOF
chmod +x "$SCRATCH/bin/refusing-bun"
rm -f "$SCRATCH/systemd.args" "$SCRATCH/codex.executed" "$SCRATCH/codex.args"
if PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/refusing-bun" \
  CODEX_BIN="$SCRATCH/bin/codex" MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" \
  MOCK_CODEX_ARGS="$SCRATCH/codex.args" MOCK_CODEX_EXECUTED="$SCRATCH/codex.executed" \
  "$SCRIPT_DIR/launch-lane.sh" --name refused --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-refused \
  >"$SCRATCH/refused.output" 2>"$SCRATCH/refused.error"; then
  printf 'marker-gate refusal incorrectly dispatched the lane\n' >&2
  exit 1
fi
grep -Fq 'injected marker refusal' "$SCRATCH/refused.error"
test ! -e "$SCRATCH/lanes/refused"
test ! -e "$SCRATCH/systemd.args"
test ! -e "$SCRATCH/codex.executed"

printf 'launch-lane dispatch proof: PASS\n'
