#!/usr/bin/env bash
# shellcheck disable=SC2016
# SC2016 is silenced file-wide on purpose: every `bash -c '...'` fixture below
# deliberately single-quotes $INSTALLER_PATH so it expands inside the CHILD
# bash from its own inherited environment, not in this shell -- that is the
# whole point of INSTALLER_PATH="$INSTALLER" ... bash -c '...INSTALLER_PATH...'.
#
# Stub-fixture tests for bootstrap/install.sh STAGE 1 (S2-3 / V3-1.1). No
# container, no Docker, no network, no writes outside this script's own
# fixtures: every prerequisite/bun/git/apt call below is a recorded stub, and
# INSTALL_ROOT/ENV_FILE/STATE_DB are always fixture paths under mktemp.
#
# Style follows the donor (v2-deprecated bootstrap/bootstrap.test.sh): a
# fixture directory, `exit 0` stub binaries on a scoped PATH, and PASS/FAIL
# assertions against real script output -- not a container.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
REAL_BUN_BIN="$(command -v bun)"
# Absolute, resolved once against the ambient PATH: several fixtures below
# deliberately set a restrictive PATH= prefix for the child bash -c invocation
# that sources install.sh (to control which stub commands ensure_prerequisites
# etc. can see). A prefix VARIABLE=value command applies to the RESOLUTION of
# `command` itself, not only its environment -- `PATH=/empty ls` fails with
# "command not found" even though ls exists on the real PATH -- so the outer
# `bash` invocation must be named by absolute path or every one of those
# fixtures breaks the harness instead of the code under test.
BASH_BIN="$(command -v bash)"

# One root, one trap: every fixture directory below is a subdirectory of this,
# so an assertion failure partway through (set -e exits immediately) never
# leaks a fixture in /tmp -- there is exactly one thing to remove.
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

# install.sh's OWN machinery (SCRIPT_DIR/SOURCE_ROOT resolution, stat, install,
# chmod, and the #!/usr/bin/env bash shebang every stub below uses) needs real
# coreutils no matter which specific prerequisite a test is proving absent.
# EXCLUDED_TOOLS are the only commands whose presence/absence a fixture PATH
# below is allowed to control; everything else is symlinked in from the real
# system so the harness fails on the thing under test, not on a missing
# `dirname`. First match wins, mirroring ordinary PATH precedence.
CORE_PATH="$FIXTURE_ROOT/core-utils"
mkdir -p "$CORE_PATH"
EXCLUDED_TOOLS=(git curl tmux flock findmnt apt-get sudo)
is_excluded_tool() {
  local candidate="$1" excluded
  for excluded in "${EXCLUDED_TOOLS[@]}"; do
    [[ "$candidate" == "$excluded" ]] && return 0
  done
  return 1
}
for real_dir in /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  [[ -d "$real_dir" ]] || continue
  for real_bin in "$real_dir"/*; do
    [[ -f "$real_bin" || -L "$real_bin" ]] || continue
    base="$(basename "$real_bin")"
    is_excluded_tool "$base" && continue
    [[ -e "$CORE_PATH/$base" ]] && continue
    ln -s "$real_bin" "$CORE_PATH/$base"
  done
done

# ── Static shape checks ──────────────────────────────────────────────────
grep -Fxq 'INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"' "$INSTALLER"
# Dropped-scope proof: none of the out-of-scope donor surface leaked back in
# as actual CODE. install.sh's own header comments name these on purpose (to
# document why they were left out), so the scan first drops comment-only
# lines and checks only what is left -- code, not prose about code.
installer_code_only="$(grep -v '^[[:space:]]*#' "$INSTALLER")"
for absent in workspace_status run_install_test_gate render_units activate_units \
  '--verify)' '--arm-watchdog' '--disarm-watchdog' '--no-cron'; do
  if grep -Fq -- "$absent" <<<"$installer_code_only"; then
    echo "ERROR: out-of-scope donor surface present in install.sh CODE: $absent" >&2
    exit 1
  fi
done
echo 'PASS static shape (INSTALL_ROOT default present, out-of-scope surface absent)'

# ── --dry-run / --help / argument validation ─────────────────────────────
dry_run="$($INSTALLER --dry-run)"
for expected in 'PLAN apt' 'PLAN bun' 'PLAN repository' 'PLAN environment' 'PLAN state-db'; do
  grep -Fq "$expected" <<<"$dry_run"
done
# Trimmed-scope proof: the donor's later-stage plan rows must NOT appear.
for dropped in 'PLAN workspace' 'PLAN hygiene' 'PLAN test-gate' 'PLAN units' 'PLAN activate'; do
  if grep -Fq "$dropped" <<<"$dry_run"; then
    echo "ERROR: --dry-run printed an out-of-scope plan row: $dropped" >&2
    exit 1
  fi
done
echo 'PASS --dry-run plan (stage-1 rows present, later-stage rows absent)'

"$INSTALLER" --help >/dev/null
"$INSTALLER" -h >/dev/null
if "$INSTALLER" --bogus-flag >/dev/null 2>&1; then
  echo 'ERROR: an unknown argument was accepted' >&2
  exit 1
fi
if "$INSTALLER" --verify >/dev/null 2>&1; then
  echo 'ERROR: --verify was accepted; it is out of scope for this row' >&2
  exit 1
fi
if "$INSTALLER" --dry-run --verify-source >/dev/null 2>&1; then
  echo 'ERROR: --dry-run and --verify-source were accepted together' >&2
  exit 1
fi
echo 'PASS argument validation (--help, unknown flag, --verify, combined flags)'

# ══════════════════════════════════════════════════════════════════════════
# ensure_prerequisites
# ══════════════════════════════════════════════════════════════════════════
prereq_fixture="$FIXTURE_ROOT/prereq"
install -d -m 700 "$prereq_fixture/bin-complete" "$prereq_fixture/bin-missing-flock" \
  "$prereq_fixture/bin-missing-flock-no-root"
for tool in git curl tmux flock findmnt; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-complete/$tool"
done
for tool in git curl tmux findmnt; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-missing-flock/$tool"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-missing-flock-no-root/$tool"
done
chmod 700 "$prereq_fixture"/bin-complete/* "$prereq_fixture"/bin-missing-flock/* \
  "$prereq_fixture"/bin-missing-flock-no-root/*

# (a) happy path: nothing missing -- apt-get is not even on PATH, so this
# would blow up with "command not found" if ensure_prerequisites tried to
# call it. A clean PASS here is itself the proof apt-get was never reached.
PATH="$prereq_fixture/bin-complete:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; ensure_prerequisites'
echo 'PASS ensure_prerequisites: complete toolset, apt-get never on PATH, no failure'

# (b) missing + root available: apt-get is a recording stub (real apt-get is
# unreachable -- PATH is exactly this fixture dir, no fallthrough), so the
# real package manager is never touched regardless of this host's actual EUID.
apt_calls="$prereq_fixture/apt.calls"
: > "$apt_calls"
cat > "$prereq_fixture/bin-missing-flock/apt-get" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$apt_calls"
exit 0
EOF
chmod 700 "$prereq_fixture/bin-missing-flock/apt-get"
PATH="$prereq_fixture/bin-missing-flock:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALLER_PATH="$INSTALLER" \
  BOOTSTRAP_TEST_EUID=0 \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; ensure_prerequisites'
grep -Fxq 'update' "$apt_calls"
grep -Fxq 'install -y util-linux' "$apt_calls"
echo 'PASS ensure_prerequisites: missing flock, root available, stub apt-get invoked (never the real one)'

# (c) missing + neither root nor sudo: the donor's fail-closed abort. This is
# the failure path the row brief calls out by name -- prove it aborts with a
# clear message rather than silently continuing or crashing on a raw command-
# not-found. BOOTSTRAP_TEST_EUID forces the non-root branch even though this
# harness itself runs as root, so the real apt-get (which is not on this
# fixture PATH at all) is never a candidate either way.
if noroot_output="$(PATH="$prereq_fixture/bin-missing-flock-no-root:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  INSTALLER_PATH="$INSTALLER" BOOTSTRAP_TEST_EUID=1000 \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; ensure_prerequisites' 2>&1)"; then
  echo 'ERROR: ensure_prerequisites succeeded without root, sudo, or all prerequisites' >&2
  exit 1
fi
grep -Fq 'ERROR: missing prerequisites (util-linux) and neither root nor sudo is available' <<<"$noroot_output"
printf '%s\n' 'FAIL-BEFORE ensure_prerequisites: no such guard exists before this row (bootstrap/install.sh absent on v3)'
grep '^ERROR: missing prerequisites' <<<"$noroot_output"
echo 'PASS ensure_prerequisites: missing flock, no root, no sudo -> clear abort, no apt-get call attempted'

# ══════════════════════════════════════════════════════════════════════════
# install_bun
# ══════════════════════════════════════════════════════════════════════════
bun_fixture="$FIXTURE_ROOT/bun"

# (a) BUN_BIN already present and working: install_bun must not touch curl
# and must export its directory onto PATH for the rest of the run. Proven by
# a POISON curl stub (not by curl's absence -- real curl exists on this host
# and install_bun's own code branch is what must skip it, not a PATH gap):
# any invocation records a marker, and the test asserts that marker was never
# written.
install -d -m 700 "$bun_fixture/bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$bun_fixture/bin/bun"
curl_poison_marker="$bun_fixture/curl-invoked.marker"
cat > "$bun_fixture/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$curl_poison_marker"
exit 1
EOF
chmod 700 "$bun_fixture/bin/bun" "$bun_fixture/bin/curl"
resulting_path="$(PATH="$bun_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  BUN_BIN="$bun_fixture/bin/bun" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; install_bun; printf "%s" "$PATH"')"
grep -Fq "$bun_fixture/bin" <<<"$resulting_path"
if [[ -e "$curl_poison_marker" ]]; then
  echo 'ERROR: install_bun invoked curl even though BUN_BIN already existed' >&2
  exit 1
fi
echo 'PASS install_bun: pre-existing BUN_BIN skips download (curl never invoked) and is exported onto PATH'

# (b) BUN_BIN present but broken: install_bun must abort rather than proceed
# with a non-functional binary silently accepted as "installed".
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$bun_fixture/bin/broken-bun"
chmod 700 "$bun_fixture/bin/broken-bun"
if BOOTSTRAP_LIB_ONLY=true BUN_BIN="$bun_fixture/bin/broken-bun" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; install_bun' >/dev/null 2>&1; then
  echo 'ERROR: install_bun accepted a BUN_BIN that fails --version' >&2
  exit 1
fi
echo 'PASS install_bun: a present-but-broken BUN_BIN aborts rather than being accepted'

# ══════════════════════════════════════════════════════════════════════════
# sync_repository
# ══════════════════════════════════════════════════════════════════════════
sync_fixture="$FIXTURE_ROOT/sync"
install -d -m 700 "$sync_fixture/bin"
git_calls="$sync_fixture/git.calls"
: > "$git_calls"
cat > "$sync_fixture/bin/git" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$git_calls"
exit 0
EOF
chmod 700 "$sync_fixture/bin/git"

# (a) existing git checkout -> fetch + pull, no clone.
install -d -m 700 "$sync_fixture/existing-repo/.git"
: > "$git_calls"
PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$sync_fixture/existing-repo" \
  INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository'
grep -Fxq -- "-C $sync_fixture/existing-repo fetch --prune origin" "$git_calls"
grep -Fxq -- "-C $sync_fixture/existing-repo pull --ff-only" "$git_calls"
if grep -Fq clone "$git_calls"; then
  echo 'ERROR: sync_repository cloned over an existing checkout' >&2
  exit 1
fi
echo 'PASS sync_repository: existing checkout -> fetch + pull, never clone'

# (b) absent INSTALL_ROOT -> clone.
: > "$git_calls"
PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$sync_fixture/absent-repo" \
  REPO_URL='https://example.invalid/bpa-dev-infrastructure.git' INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository'
grep -Fxq -- "clone https://example.invalid/bpa-dev-infrastructure.git $sync_fixture/absent-repo" "$git_calls"
echo 'PASS sync_repository: absent INSTALL_ROOT -> clone REPO_URL'

# (c) INSTALL_ROOT exists but is not a git checkout (a plain file): the
# donor's fail-closed guard against clobbering an unrelated path. Assert the
# clear error AND that git clone was never attempted. REPO_URL is set so
# repository_url() (which always runs first, to resolve a URL the branch
# taken here never ends up using) short-circuits without its own `git remote
# get-url origin` call -- otherwise that unrelated, earlier call would show
# up in git_calls and make a plain "was git called at all" assertion wrong.
: > "$git_calls"
: > "$sync_fixture/not-a-repo"
if not_repo_output="$(PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  INSTALL_ROOT="$sync_fixture/not-a-repo" \
  REPO_URL='https://example.invalid/bpa-dev-infrastructure.git' INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository' 2>&1)"; then
  echo 'ERROR: sync_repository accepted INSTALL_ROOT as a non-git plain file' >&2
  exit 1
fi
grep -Fq "ERROR: INSTALL_ROOT exists but is not a git checkout: $sync_fixture/not-a-repo" <<<"$not_repo_output"
if [[ -s "$git_calls" ]]; then
  echo 'ERROR: sync_repository invoked git against a non-git INSTALL_ROOT' >&2
  exit 1
fi
printf '%s\n' 'FAIL-BEFORE sync_repository: no such guard exists before this row (bootstrap/install.sh absent on v3)'
grep '^ERROR: INSTALL_ROOT exists' <<<"$not_repo_output"
echo 'PASS sync_repository: non-git INSTALL_ROOT (plain file) -> clear abort, no git call'

# (d) INSTALL_ROOT exists as an ordinary directory (no .git) -- same failure
# class, directory-shaped this time, per the row brief's directory-in-place-
# of-file guidance.
: > "$git_calls"
install -d -m 700 "$sync_fixture/plain-directory"
if not_repo_dir_output="$(PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  INSTALL_ROOT="$sync_fixture/plain-directory" \
  REPO_URL='https://example.invalid/bpa-dev-infrastructure.git' INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository' 2>&1)"; then
  echo 'ERROR: sync_repository accepted INSTALL_ROOT as a non-git plain directory' >&2
  exit 1
fi
grep -Fq "ERROR: INSTALL_ROOT exists but is not a git checkout: $sync_fixture/plain-directory" <<<"$not_repo_dir_output"
if [[ -s "$git_calls" ]]; then
  echo 'ERROR: sync_repository invoked git against a non-git plain-directory INSTALL_ROOT' >&2
  exit 1
fi
echo 'PASS sync_repository: non-git INSTALL_ROOT (plain directory) -> clear abort, no git call'

# ══════════════════════════════════════════════════════════════════════════
# render_environment
# ══════════════════════════════════════════════════════════════════════════
env_fixture="$FIXTURE_ROOT/env"

# (a) absent -> created from the template at mode 600.
target="$env_fixture/config/orchestrator.env"
BOOTSTRAP_LIB_ONLY=true ENV_FILE="$target" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_environment'
cmp -s "$target" "$REPO_ROOT/bootstrap/env.template"
[[ "$(stat -c '%a' "$target")" == 600 ]]
[[ "$(stat -c '%a' "$(dirname "$target")")" == 700 ]]
echo 'PASS render_environment: absent -> created from env.template, file 600, parent dir 700'

# (b) already exists, non-default content and loose mode -> content must
# survive untouched; only the mode is enforced. This is the row brief's
# named failure path: "a .env that already exists is not silently
# overwritten and its mode is enforced".
printf 'TELEGRAM_BOT_TOKEN=123456789:realoperatortokenplaceholderxxxxxxxx\n' > "$target"
chmod 644 "$target"
before_content="$(cat "$target")"
before_mode="$(stat -c '%a' "$target")"
[[ "$before_mode" == 644 ]]
BOOTSTRAP_LIB_ONLY=true ENV_FILE="$target" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_environment'
after_content="$(cat "$target")"
after_mode="$(stat -c '%a' "$target")"
[[ "$after_content" == "$before_content" ]]
[[ "$after_mode" == 600 ]]
printf 'BEFORE mode=%s content=%q\n' "$before_mode" "$before_content"
printf 'AFTER  mode=%s content=%q\n' "$after_mode" "$after_content"
printf '%s\n' 'FAIL-BEFORE render_environment: no such guard exists before this row (bootstrap/install.sh absent on v3)'
echo 'PASS render_environment: pre-existing file is not overwritten, mode enforced to 600'

# (c) symlink -> rejected, target never touched.
printf 'unrelated-secret-shaped-value\n' > "$env_fixture/link-target"
ln -s "$env_fixture/link-target" "$env_fixture/symlinked.env"
before_target_content="$(cat "$env_fixture/link-target")"
if symlink_output="$(BOOTSTRAP_LIB_ONLY=true ENV_FILE="$env_fixture/symlinked.env" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_environment' 2>&1)"; then
  echo 'ERROR: render_environment accepted a symlinked ENV_FILE' >&2
  exit 1
fi
grep -Fq "ERROR: environment file must not be a symlink: $env_fixture/symlinked.env" <<<"$symlink_output"
[[ "$(cat "$env_fixture/link-target")" == "$before_target_content" ]]
[[ -L "$env_fixture/symlinked.env" ]]
echo 'PASS render_environment: symlinked ENV_FILE rejected, link target untouched'

# (d) a directory in place of the regular file -- the row brief's guidance on
# exercising an unreadable/wrong-shaped path without relying on chmod 000
# (a no-op as root). A directory is neither a symlink nor a regular file, so
# this exercises the "is not a regular file" guard on its own, distinct from
# the symlink guard above.
install -d -m 755 "$env_fixture/directory-in-place.env"
if directory_output="$(BOOTSTRAP_LIB_ONLY=true ENV_FILE="$env_fixture/directory-in-place.env" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_environment' 2>&1)"; then
  echo 'ERROR: render_environment accepted a directory as ENV_FILE' >&2
  exit 1
fi
grep -Fq "ERROR: environment file is not a regular file: $env_fixture/directory-in-place.env" <<<"$directory_output"
[[ -d "$env_fixture/directory-in-place.env" ]]
echo 'PASS render_environment: directory in place of ENV_FILE rejected ("is not a regular file")'

# ══════════════════════════════════════════════════════════════════════════
# initialize_state_db -- against the REAL bun and this repo's real
# core/mission-cli.ts (no stub: the row brief asks for real output, not a
# stubbed echo), with STATE_DB isolated under mktemp so nothing touches this
# worktree's own runtime/ directory.
# ══════════════════════════════════════════════════════════════════════════
state_fixture="$FIXTURE_ROOT/state"
state_db="$state_fixture/runtime/state.db"

# (a) first call: creates the runtime dir at 700 and the database, and prints
# a real, valid, empty reconstruction.
first_output="$(BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$REPO_ROOT" BUN_BIN="$REAL_BUN_BIN" \
  RUNTIME_DIR="$state_fixture/runtime" INFRA_STATE_DB="$state_db" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; initialize_state_db')"
[[ -f "$state_db" ]]
[[ "$(stat -c '%a' "$state_fixture/runtime")" == 700 ]]
grep -Fq '"missions":[]' <<<"$first_output"
echo 'PASS initialize_state_db: first call creates runtime dir (700) and state db, real empty status'

# (b) idempotent: seed a real mission through the same real mission-cli.ts,
# then re-run initialize_state_db, and prove the existing state survives --
# init must never wipe or fail on an already-initialized database.
seed_output="$(INFRA_STATE_DB="$state_db" "$REAL_BUN_BIN" "$REPO_ROOT/core/mission-cli.ts" \
  mission create idempotency-probe s2-3-acceptance)"
grep -Fq 'MISSION id=' <<<"$seed_output"
second_output="$(BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$REPO_ROOT" BUN_BIN="$REAL_BUN_BIN" \
  RUNTIME_DIR="$state_fixture/runtime" INFRA_STATE_DB="$state_db" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; initialize_state_db')"
grep -Fq 'idempotency-probe' <<<"$second_output"
printf '%s\n' 'FAIL-BEFORE initialize_state_db: no such function exists before this row (bootstrap/install.sh absent on v3)'
echo 'PASS initialize_state_db: second (idempotent) call preserves prior real state, does not wipe the database'

# ══════════════════════════════════════════════════════════════════════════
# --verify-source
# ══════════════════════════════════════════════════════════════════════════
verify_fixture="$FIXTURE_ROOT/verify"
install -d -m 700 "$verify_fixture/root/.git" "$verify_fixture/root/core" "$verify_fixture/bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
for tool in git curl tmux flock findmnt; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$tool"
done
chmod 700 "$verify_fixture/bin"/*
install -m 600 /dev/null "$verify_fixture/root/.env"

good_output="$(PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" BUN_BIN="$verify_fixture/bin/bun" "$INSTALLER" --verify-source)"
for expected in 'PASS git' 'PASS curl' 'PASS tmux' 'PASS flock' 'PASS findmnt' 'PASS bun' \
  'PASS repository' 'PASS environment file' 'PASS environment permissions' 'PASS state-db'; do
  grep -Fq "$expected" <<<"$good_output"
done
echo 'PASS --verify-source: every stage-1 boundary PASSes against a satisfied fixture'

# Fail-closed proof: a single broken boundary (wrong .env mode) must flip the
# overall exit code, not just print one FAIL line lost among PASSes.
chmod 644 "$verify_fixture/root/.env"
if PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" "$INSTALLER" --verify-source >/dev/null 2>&1; then
  echo 'ERROR: --verify-source exited 0 with a loose-mode environment file' >&2
  exit 1
fi
bad_mode_output="$(PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" BUN_BIN="$verify_fixture/bin/bun" "$INSTALLER" --verify-source 2>&1 || true)"
grep -Fq 'FAIL environment permissions' <<<"$bad_mode_output"
chmod 600 "$verify_fixture/root/.env"
echo 'PASS --verify-source: a loose-mode .env FAILs that row and flips the overall exit code'

# A missing prerequisite command must FAIL its named row and flip the exit
# code -- not be silently treated as present.
rm "$verify_fixture/bin/flock"
if PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" "$INSTALLER" --verify-source >/dev/null 2>&1; then
  echo 'ERROR: --verify-source exited 0 with flock missing from PATH' >&2
  exit 1
fi
missing_tool_output="$(PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" BUN_BIN="$verify_fixture/bin/bun" "$INSTALLER" --verify-source 2>&1 || true)"
grep -Fq 'FAIL flock' <<<"$missing_tool_output"
echo 'PASS --verify-source: a missing prerequisite command FAILs its row and flips the overall exit code'

# ── Secret scan over the one tracked template this row adds ────────────────
# instructions/verification-and-locks.md: the pattern has ONE home
# (gate/land-lib.sh's land_secret_scan()); it must be extracted at run time,
# never copied into another file, or this file's own copy would drift from
# the gate and would trip the gate's diff scan on itself.
if [[ -f "$REPO_ROOT/gate/land-lib.sh" ]]; then
  secret_pattern="$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' "$REPO_ROOT/gate/land-lib.sh")"; printf '%s' "$REPLY")"
  if [[ -z "$secret_pattern" ]]; then
    echo 'ERROR: could not extract secret_pattern from gate/land-lib.sh' >&2
    exit 1
  fi
  set +e
  secret_scan_output="$(LC_ALL=C grep -aE "$secret_pattern" "$REPO_ROOT/bootstrap/env.template" \
    "$REPO_ROOT/bootstrap/install.sh" "$SCRIPT_DIR/bootstrap.test.sh" 2>&1)"
  secret_scan_rc=$?
  set -e
  if [ "$secret_scan_rc" -eq 0 ]; then
    echo 'ERROR: secret-like value found in this row'"'"'s tracked files' >&2
    echo "$secret_scan_output" >&2
    exit 1
  elif [ "$secret_scan_rc" -ne 1 ]; then
    echo "ERROR: secret scan command failed with status $secret_scan_rc (fail-closed, not clean)" >&2
    echo "$secret_scan_output" >&2
    exit 1
  fi
  echo 'PASS secret scan: this row'"'"'s tracked files carry no secret-shaped value (pattern extracted from gate/land-lib.sh)'
else
  echo 'ERROR: gate/land-lib.sh is absent; cannot run the canonical secret scan' >&2
  exit 1
fi

# ── Lint, if the local host provides shellcheck (no Docker for this row) ───
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$INSTALLER" "$SCRIPT_DIR/bootstrap.test.sh"
  echo 'PASS shellcheck (local binary, no Docker)'
else
  echo 'SKIP shellcheck: not present on this host'
fi

echo 'PASS bootstrap stage 1: dry-run, argument validation, all five in-scope functions, --verify-source, secret scan'
