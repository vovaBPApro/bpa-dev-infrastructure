#!/usr/bin/env bash
# shellcheck disable=SC2016
# SC2016 is silenced file-wide on purpose: every `bash -c '...'` fixture below
# deliberately single-quotes $INSTALLER_PATH so it expands inside the CHILD
# bash from its own inherited environment, not in this shell -- that is the
# whole point of INSTALLER_PATH="$INSTALLER" ... bash -c '...INSTALLER_PATH...'.
#
# Stub-fixture tests for bootstrap/install.sh STAGE 2 (S3-2 / V3-1.1). No
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
EXCLUDED_TOOLS=(git curl tmux flock findmnt envsubst crontab unzip apt-get sudo)
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
# The INSTALL_ROOT default now lives in bootstrap/unit-render-lib.sh, the one
# place any renderer may learn a render variable's name or value. The check
# below is the inverse of the old one on purpose: install.sh must NOT carry a
# default for any render variable. A second copy is not a harmless duplicate
# -- install.sh and check-unit-drift.sh keeping separate lists is V3-2.12,
# and it shipped `OnCalendar=` (a cleared schedule) to a nightly timer.
RENDER_LIB="$SCRIPT_DIR/unit-render-lib.sh"
grep -Fq "[INSTALL_ROOT]='/root/bpa-dev-infrastructure'" "$RENDER_LIB"
# The ERE must match every form a real assignment takes, quoted or not.
# Round-2 review (lens one, F1) found the first version of this guard REQUIRED
# a `$` immediately after `=`, so it could not match the one line it names:
#
#   INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"
#                ^ a double quote lives here, in every assignment in this repo
#
# It was therefore a third "check that quietly does nothing", added by the
# commit that removed two others. `["']?` and the optional `export` prefix
# close that. Deliberately the SAME coverage as the equivalent guard in
# bootstrap/unit-render-lib.test.ts: that one used to match only the quoted
# form and this one only the unquoted, so between them nothing escaped -- by
# accident, not by design. Two guards that each cover the whole form is a
# division; two that each cover half is a coincidence waiting to be edited.
while IFS= read -r render_var; do
  render_default_re="^[[:space:]]*(export[[:space:]]+)?${render_var}=[\"']?\\\$\{${render_var}:-"
  if grep -Eq "$render_default_re" "$INSTALLER"; then
    echo "ERROR: install.sh carries its own default for render variable $render_var" >&2
    echo '       Render variables have one home: bootstrap/unit-render-lib.sh' >&2
    exit 1
  fi
  if grep -Eq "$render_default_re" "$SCRIPT_DIR/check-unit-drift.sh"; then
    echo "ERROR: check-unit-drift.sh carries its own default for render variable $render_var" >&2
    echo '       Render variables have one home: bootstrap/unit-render-lib.sh' >&2
    exit 1
  fi
done < <(bash "$RENDER_LIB" --print-names)
# The guard above is a negative assertion: it passes when it finds nothing,
# which is also what a broken pattern does. Prove the pattern still has teeth
# on every run, against the exact historical line, without editing any tracked
# file -- if this stops matching, the loop above has silently stopped guarding.
render_guard_probe="$(mktemp)"
printf '%s\n' 'INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"' \
  > "$render_guard_probe"
if ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?INSTALL_ROOT=[\"']?\\\$\{INSTALL_ROOT:-" \
  "$render_guard_probe"; then
  echo 'ERROR: the render-default guard no longer matches a real assignment' >&2
  echo '       It would pass over a reintroduced private default in silence.' >&2
  rm -f "$render_guard_probe"
  exit 1
fi
rm -f "$render_guard_probe"
for render_required in FULL_SUITE_ON_CALENDAR ORCH_WATCHDOG_INTERVAL; do
  # The two names the installer omitted. Pinned by name so that shrinking the
  # list back to the four it used to export fails here, not on a rebuilt host
  # with two dead watchdog timers.
  bash "$RENDER_LIB" --print-names | grep -Fxq "$render_required"
done
# Dropped-scope proof: none of the out-of-scope donor surface leaked back in
# as actual CODE. install.sh's own header comments name these on purpose (to
# document why they were left out), so the scan first drops comment-only
# lines and checks only what is left -- code, not prose about code.
installer_code_only="$(grep -v '^[[:space:]]*#' "$INSTALLER")"
for absent in workspace_status activate_units \
  '--verify)' '--arm-watchdog' '--disarm-watchdog' '--no-cron'; do
  if grep -Fq -- "$absent" <<<"$installer_code_only"; then
    echo "ERROR: out-of-scope donor surface present in install.sh CODE: $absent" >&2
    exit 1
  fi
done
echo 'PASS static shape (INSTALL_ROOT default present, out-of-scope surface absent)'

# ── --dry-run / --help / argument validation ─────────────────────────────
dry_run="$($INSTALLER --dry-run)"
for expected in 'PLAN apt' 'PLAN bun' 'PLAN repository' 'PLAN environment' 'PLAN state-db' \
  'PLAN hygiene' 'PLAN test-gate' 'PLAN units'; do
  grep -Fq "$expected" <<<"$dry_run"
done
# Trimmed-scope proof: the donor's later-stage plan rows must NOT appear.
for dropped in 'PLAN workspace' 'PLAN activate'; do
  if grep -Fq "$dropped" <<<"$dry_run"; then
    echo "ERROR: --dry-run printed an out-of-scope plan row: $dropped" >&2
    exit 1
  fi
done
echo 'PASS --dry-run plan (stage-2 rows present, activation absent)'

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
  "$prereq_fixture/bin-missing-flock-no-root" "$prereq_fixture/bin-missing-unzip"
for tool in git curl tmux flock findmnt envsubst crontab unzip; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-complete/$tool"
done
for tool in git curl tmux findmnt envsubst crontab unzip; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-missing-flock/$tool"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-missing-flock-no-root/$tool"
done
for tool in git curl tmux flock findmnt envsubst crontab; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prereq_fixture/bin-missing-unzip/$tool"
done
chmod 700 "$prereq_fixture"/bin-complete/* "$prereq_fixture"/bin-missing-flock/* \
  "$prereq_fixture"/bin-missing-flock-no-root/* "$prereq_fixture"/bin-missing-unzip/*

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

# (b2) Review round 2, defect 2: unzip is a genuine in-scope prerequisite
# (install_bun's real download path needs it, proven separately below), not
# only donor surface for out-of-scope render_units/install_hygiene_cron.
# Restored to the packages map; prove it is actually checked for and, when
# absent, actually drives an apt-get install -- not just present in a
# comment or a dry-run string.
: > "$apt_calls"
cat > "$prereq_fixture/bin-missing-unzip/apt-get" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$apt_calls"
exit 0
EOF
chmod 700 "$prereq_fixture/bin-missing-unzip/apt-get"
PATH="$prereq_fixture/bin-missing-unzip:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALLER_PATH="$INSTALLER" \
  BOOTSTRAP_TEST_EUID=0 \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; ensure_prerequisites'
grep -Fxq 'update' "$apt_calls"
grep -Fxq 'install -y unzip' "$apt_calls"
echo 'PASS ensure_prerequisites: unzip is in the required set (missing -> apt-get install -y unzip)'

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

# (c) Review round 2, defect 2: unzip was dropped from ensure_prerequisites
# on the reasoning that install_bun never needs it -- unverified, and false.
# The real https://bun.sh/install (fetched and read during this review) does
# `command -v unzip >/dev/null || error 'unzip is required to install bun'`
# then `unzip -oqd "$bin_dir" "$exe.zip"`. Proving that against the network
# is neither hermetic nor safe to run unattended, so this fixture's curl
# stub serves a small payload that reproduces exactly that guard (not bun's
# full installer) -- it proves install.sh's own contract (the script it
# pipes into bash must be able to fail loudly on a missing dependency)
# without vendoring third-party code or touching the network.
download_fixture="$FIXTURE_ROOT/bun-download"
install -d -m 700 "$download_fixture/bin"
cat > "$download_fixture/bin/curl" <<'CURLEOF'
#!/usr/bin/env bash
cat <<'PAYLOAD'
#!/usr/bin/env bash
set -e
error() { echo "error: $*" >&2; exit 1; }
command -v unzip >/dev/null || error 'unzip is required to install bun'
mkdir -p "$(dirname "$BUN_BIN")"
printf '%s\n' '#!/usr/bin/env bash' 'echo "bun-fixture 1.3.14"' > "$BUN_BIN"
chmod +x "$BUN_BIN"
echo 'bun installed (fixture)'
PAYLOAD
CURLEOF
chmod 700 "$download_fixture/bin/curl"
absent_bun_bin="$download_fixture/bin/bun-not-installed-yet"
# unzip is excluded from CORE_PATH (see EXCLUDED_TOOLS above), so this PATH
# genuinely lacks it -- no stub needed to prove absence, unlike the
# recording-stub tools.
if download_output="$(PATH="$download_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  BUN_BIN="$absent_bun_bin" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; install_bun' 2>&1)"; then
  echo 'ERROR: install_bun succeeded (via the download branch) without unzip on PATH' >&2
  exit 1
fi
grep -Fq 'unzip is required to install bun' <<<"$download_output"
echo 'PASS install_bun: the real download branch genuinely needs unzip (fixture reproduces bun.sh/install'"'"'s own guard); absent -> fails loudly'

# Positive control: the same fixture with unzip present must reach the
# installer payload's success line, proving the failure above is really
# about unzip and not some other fixture defect.
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$download_fixture/bin/unzip"
chmod 700 "$download_fixture/bin/unzip"
download_ok_output="$(PATH="$download_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  BUN_BIN="$absent_bun_bin" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; install_bun')"
grep -Fq 'bun installed (fixture)' <<<"$download_ok_output"
echo 'PASS install_bun: positive control -- with unzip present, the same download branch succeeds'

# ══════════════════════════════════════════════════════════════════════════
# sync_repository
# ══════════════════════════════════════════════════════════════════════════
sync_fixture="$FIXTURE_ROOT/sync"
install -d -m 700 "$sync_fixture/bin"
git_calls="$sync_fixture/git.calls"
# The stub records every call AND answers `rev-parse --abbrev-ref HEAD` with
# GIT_STUB_BRANCH (default main) -- needed once sync_repository checks which
# branch INSTALL_ROOT is actually on before fetch/pull (review round 2,
# defect 1). Every other invocation still just records and exits 0.
cat > "$sync_fixture/bin/git" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$git_calls"
if [[ "\$*" == "-C "*" rev-parse --abbrev-ref HEAD" ]]; then
  printf '%s\n' "\${GIT_STUB_BRANCH:-main}"
fi
exit 0
EOF
chmod 700 "$sync_fixture/bin/git"

# (a) existing git checkout, already on the expected branch (main, the
# default) -> the branch is checked FIRST, then fetch + pull, never clone.
install -d -m 700 "$sync_fixture/existing-repo/.git"
: > "$git_calls"
PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$sync_fixture/existing-repo" \
  INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository'
grep -Fxq -- "-C $sync_fixture/existing-repo rev-parse --abbrev-ref HEAD" "$git_calls"
grep -Fxq -- "-C $sync_fixture/existing-repo fetch --prune origin" "$git_calls"
grep -Fxq -- "-C $sync_fixture/existing-repo pull --ff-only" "$git_calls"
if grep -Fq clone "$git_calls"; then
  echo 'ERROR: sync_repository cloned over an existing checkout' >&2
  exit 1
fi
# Order matters: the branch check must run BEFORE any fetch/pull, not merely
# alongside it -- that is the whole point of the guard.
rev_parse_line="$(grep -Fn 'rev-parse --abbrev-ref HEAD' "$git_calls" | cut -d: -f1)"
fetch_line="$(grep -Fn 'fetch --prune origin' "$git_calls" | cut -d: -f1)"
if (( rev_parse_line >= fetch_line )); then
  echo 'ERROR: sync_repository fetched before (or without) checking the branch' >&2
  exit 1
fi
echo 'PASS sync_repository: existing checkout on expected branch -> branch checked first, then fetch + pull, never clone'

# (a2) Review round 2, defect 1, HIGH SEVERITY. sync_repository fast-forwarded
# whatever branch happened to be checked out to that branch's OWN upstream,
# never checking it was the target branch at all -- proven by the reviewer
# with a real repo on old-branch tracking origin/old-branch: it fast-forwarded
# old-branch and exited 0, never touching main. This machine right now
# reproduces the exact hazard: /root/bpa-dev-infrastructure is checked out on
# v2-deprecated on purpose while origin/main is v3
# (instance/v3-becomes-main-2026-08-03.md) -- running the pre-fix installer
# here would have reported a clean bootstrap while silently leaving the host
# on the abandoned line.
: > "$git_calls"
if wrong_branch_output="$(PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true \
  INSTALL_ROOT="$sync_fixture/existing-repo" GIT_STUB_BRANCH=old-branch \
  INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository' 2>&1)"; then
  echo 'ERROR: sync_repository fast-forwarded a checkout on the wrong branch' >&2
  exit 1
fi
grep -Fq "on branch 'old-branch'" <<<"$wrong_branch_output"
grep -Fq "expected 'main'" <<<"$wrong_branch_output"
if grep -Fq 'fetch --prune origin' "$git_calls"; then
  echo 'ERROR: sync_repository fetched a checkout on the wrong branch before refusing' >&2
  exit 1
fi
if grep -Fq 'pull --ff-only' "$git_calls"; then
  echo 'ERROR: sync_repository pulled a checkout on the wrong branch before refusing' >&2
  exit 1
fi
echo 'PASS sync_repository: existing checkout on the WRONG branch -> refuses before any fetch/pull, names both branches'

# (a3) The same defect, reproduced with REAL git (no stub) exactly as the
# reviewer did: a bare origin carrying both main and old-branch, a local
# clone sitting on old-branch, and a genuine second commit pushed to
# origin/old-branch so a real fast-forward is actually available. Proves the
# fix against real fetch/pull mechanics, not only against a recorded call.
real_git_fixture="$FIXTURE_ROOT/sync-real-git"
install -d -m 700 "$real_git_fixture"
git init -q --bare "$real_git_fixture/origin.git"
git init -q "$real_git_fixture/seed"
git -C "$real_git_fixture/seed" config user.email test@example.invalid
git -C "$real_git_fixture/seed" config user.name 'Test'
git -C "$real_git_fixture/seed" commit -q --allow-empty -m 'root on main'
git -C "$real_git_fixture/seed" branch -m main
git -C "$real_git_fixture/seed" checkout -q -b old-branch
git -C "$real_git_fixture/seed" commit -q --allow-empty -m 'old-branch commit 1'
git -C "$real_git_fixture/seed" remote add origin "$real_git_fixture/origin.git"
git -C "$real_git_fixture/seed" push -q origin main old-branch
git clone -q -b old-branch "$real_git_fixture/origin.git" "$real_git_fixture/INSTALL_ROOT"
before_head="$(git -C "$real_git_fixture/INSTALL_ROOT" rev-parse HEAD)"
# Advance origin/old-branch for real, so a fast-forward genuinely exists.
git -C "$real_git_fixture/seed" commit -q --allow-empty -m 'old-branch commit 2 (upstream advance)'
git -C "$real_git_fixture/seed" push -q origin old-branch
upstream_head="$(git -C "$real_git_fixture/seed" rev-parse origin/old-branch)"
if [[ "$before_head" == "$upstream_head" ]]; then
  echo 'ERROR: real-git fixture set up no actual fast-forward opportunity' >&2
  exit 1
fi
if real_git_output="$(INSTALL_ROOT="$real_git_fixture/INSTALL_ROOT" \
  REPO_URL="$real_git_fixture/origin.git" BOOTSTRAP_LIB_ONLY=true INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository' 2>&1)"; then
  echo 'ERROR: sync_repository (real git) fast-forwarded a checkout on the wrong branch' >&2
  exit 1
fi
grep -Fq "on branch 'old-branch'" <<<"$real_git_output"
grep -Fq "expected 'main'" <<<"$real_git_output"
after_head="$(git -C "$real_git_fixture/INSTALL_ROOT" rev-parse HEAD)"
after_branch="$(git -C "$real_git_fixture/INSTALL_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$after_head" != "$before_head" ]]; then
  echo "ERROR: real-git INSTALL_ROOT moved from $before_head to $after_head -- it was fast-forwarded" >&2
  exit 1
fi
[[ "$after_branch" == old-branch ]]
printf '%s\n' 'FAIL-BEFORE sync_repository (8998610, reproduced against real git): fetched and fast-forwarded old-branch, exited 0, never checked main'
printf 'REAL GIT before=%s after=%s (unchanged) upstream-old-branch=%s (a real fast-forward existed and was correctly refused)\n' \
  "$before_head" "$after_head" "$upstream_head"
echo 'PASS sync_repository: real git reproduction -- a genuine available fast-forward on the wrong branch is refused, not taken'

# (b) absent INSTALL_ROOT -> clone on the expected branch (REPO_BRANCH,
# default main) explicitly -- never left to the remote's default HEAD.
: > "$git_calls"
PATH="$sync_fixture/bin:$CORE_PATH" BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$sync_fixture/absent-repo" \
  REPO_URL='https://example.invalid/bpa-dev-infrastructure.git' INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; sync_repository'
grep -Fxq -- "clone --branch main https://example.invalid/bpa-dev-infrastructure.git $sync_fixture/absent-repo" "$git_calls"
echo 'PASS sync_repository: absent INSTALL_ROOT -> clone REPO_URL on the expected branch explicitly'

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
# stage 2: hygiene cron, repository gate, and manifest-driven unit rendering
# ══════════════════════════════════════════════════════════════════════════
stage2_fixture="$FIXTURE_ROOT/stage2"
install -d -m 700 "$stage2_fixture/root/hygiene" "$stage2_fixture/bin" \
  "$stage2_fixture/root/bootstrap/units" "$stage2_fixture/root/instance/units" \
  "$stage2_fixture/systemd"
cron_calls="$stage2_fixture/cron.calls"
cat > "$stage2_fixture/root/hygiene/install-cron.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$CRONTAB_CMD" > "$CRON_CALLS"
EOF
chmod 700 "$stage2_fixture/root/hygiene/install-cron.sh"
BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" CRONTAB_CMD=fixture-crontab \
  CRON_CALLS="$cron_calls" INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c \
  'source "$INSTALLER_PATH"; install_hygiene_cron'
grep -Fxq fixture-crontab "$cron_calls"
printf '%s\n' '#!/usr/bin/env bash' 'exit 9' > "$stage2_fixture/root/hygiene/install-cron.sh"
chmod 700 "$stage2_fixture/root/hygiene/install-cron.sh"
if BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; install_hygiene_cron'; then
  echo 'ERROR: install_hygiene_cron accepted a failed cron installer' >&2
  exit 1
fi
echo 'PASS install_hygiene_cron: invokes tracked installer and propagates failure'

cat > "$stage2_fixture/bin/bun" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$stage2_fixture/bun.calls"
printf '%s\n' "\${TMPDIR-unset}" >> "$stage2_fixture/bun.tmpdir"
printf '%s\n' "\${REPO_BRANCH-unset}:\${REPO_URL-unset}:\${INSTALL_ROOT-unset}:\${TEST_GATE_ORIGIN_URL-unset}" >> "$stage2_fixture/bun.env"
# Every exported NAME this child received, so the assertion can be written
# against a list derived from unit-render-lib.sh instead of a list typed here
# -- a second copy of those names is the defect V3-2.12 is about. compgen is a
# bash builtin, so this works on the restrictive fixture PATHs too.
compgen -e > "$stage2_fixture/bun.exported" || true
exit "\${BUN_STUB_EXIT:-0}"
EOF
chmod 700 "$stage2_fixture/bin/bun"
git -C "$stage2_fixture/root" init -q
git -C "$stage2_fixture/root" remote add origin /local-bootstrap-source
BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; run_install_test_gate'
grep -Fxq test "$stage2_fixture/bun.calls"
grep -Fxq unset "$stage2_fixture/bun.tmpdir"
grep -Fxq 'unset:unset:unset:unset' "$stage2_fixture/bun.env"
BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  REPO_BRANCH=fixture-branch REPO_URL=/local-bootstrap-source \
  TEST_GATE_ORIGIN_URL=https://github.com/example/infra.git \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; run_install_test_gate'
[[ "$(git -C "$stage2_fixture/root" remote get-url origin)" == https://github.com/example/infra.git ]]
tail -1 "$stage2_fixture/bun.env" | grep -Fxq 'unset:unset:unset:unset'
if BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  BUN_STUB_EXIT=7 INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c \
  'source "$INSTALLER_PATH"; run_install_test_gate' >/dev/null 2>&1; then
  echo 'ERROR: run_install_test_gate accepted a failed repository suite' >&2
  exit 1
fi
echo 'PASS run_install_test_gate: runs complete repository test command and propagates failure'

# ── No render variable reaches the suite child (V3-2.12 round 4) ───────────
# The strip list was six typed names and forgot the two the installer's own
# usage text documents as render overrides. The meteorite's bootstrap-install
# stage exports FULL_SUITE_ON_CALENDAR and ORCH_WATCHDOG_INTERVAL, so they
# reached the repository suite that install.sh runs itself -- where the
# V3-2.12 fail-before arm reconstructs the historical four-variable renderer
# and needs those names ABSENT to reproduce the defect it locks. The arm saw
# no defect and failed, and only ever inside install.sh, which is why this
# host never saw it.
#
# The list is DERIVED here too. Restating it would put a seventh copy of these
# names in the tree, and "one list that forgot a name" is this row's own
# defect: the guard must fail the day a render variable is added and not
# stripped, without anyone remembering to edit this file.
declare -A leak_env=()
while IFS= read -r render_var; do
  leak_env["$render_var"]="leak-sentinel-$render_var"
done < <(bash "$RENDER_LIB" --print-names)
if ((${#leak_env[@]} == 0)); then
  echo 'ERROR: the render-variable list is empty; this guard would assert nothing' >&2
  exit 1
fi
# Only these two VALUES are real -- run_install_test_gate uses them as inputs.
# The list itself stays derived.
leak_env[INSTALL_ROOT]="$stage2_fixture/root"
leak_env[BUN_BIN]="$stage2_fixture/bin/bun"
leak_args=()
for render_var in "${!leak_env[@]}"; do
  leak_args+=("$render_var=${leak_env[$render_var]}")
done
env "${leak_args[@]}" BOOTSTRAP_LIB_ONLY=true INSTALLER_PATH="$INSTALLER" \
  "$BASH_BIN" -c 'source "$INSTALLER_PATH"; run_install_test_gate' >/dev/null
leaked=()
while IFS= read -r render_var; do
  if grep -Fxq "$render_var" "$stage2_fixture/bun.exported"; then
    leaked+=("$render_var")
  fi
done < <(bash "$RENDER_LIB" --print-names)
if ((${#leaked[@]} > 0)); then
  echo "ERROR: run_install_test_gate handed render variables to the suite child: ${leaked[*]}" >&2
  echo '       Strip every name in bootstrap/unit-render-lib.sh, derived, not typed.' >&2
  exit 1
fi
# Teeth, proven against the exact historical implementation rather than
# asserted: the six-name strip list this replaced leaks precisely the two
# names that broke the rebuild proof. A negative assertion and a broken
# fixture look identical from here without this.
env "${leak_args[@]}" "$BASH_BIN" -c \
  'cd "$1" && env -u BUN_BIN -u TMPDIR -u INSTALL_ROOT -u REPO_URL -u REPO_BRANCH -u TEST_GATE_ORIGIN_URL "$2" test' \
  _ "$stage2_fixture/root" "$stage2_fixture/bin/bun" >/dev/null
historic_leak=()
for render_var in FULL_SUITE_ON_CALENDAR ORCH_WATCHDOG_INTERVAL; do
  if grep -Fxq "$render_var" "$stage2_fixture/bun.exported"; then
    historic_leak+=("$render_var")
  fi
done
if ((${#historic_leak[@]} != 2)); then
  echo 'ERROR: the historical six-name strip list no longer leaks the two render variables' >&2
  echo '       This guard has lost its teeth: it would now pass against the pre-fix code.' >&2
  exit 1
fi
echo 'PASS run_install_test_gate: strips every render variable, derived from the library list'

printf '%s\t%s\n' \
  first.service generic \
  second.timer instance \
  bpa-orchestrator.service generic \
  bpa-orchestrator-watchdog.service generic \
  bpa-orchestrator-watchdog.timer generic > "$stage2_fixture/expected.tsv"
printf '%s\t%s' bpa-telegram-daemon.service generic >> "$stage2_fixture/expected.tsv"
# Fixture templates must be units systemd will actually accept: render_units
# now runs `systemd-analyze verify` over the staged set before publishing it
# (V3-2.12), so a stub that is only a [Unit] section with a Description is no
# longer a stand-in for a unit -- systemd refuses a .service with no
# ExecStart. Keeping them realistic is the point: the render path is being
# proven, and a fixture systemd would reject proves nothing about it.
printf '%s\n' '[Service]' 'ExecStart=${BUN_BIN} ${INSTALL_ROOT}/first.ts' > \
  "$stage2_fixture/root/bootstrap/units/first.service.in"
printf '%s\n' '[Timer]' 'OnCalendar=hourly' > "$stage2_fixture/root/instance/units/second.timer.in"
for unit in bpa-orchestrator.service bpa-orchestrator-watchdog.service \
  bpa-telegram-daemon.service; do
  printf '%s\n' '[Unit]' "Description=$unit" '[Service]' 'Type=oneshot' \
    'ExecStart=/bin/true' > "$stage2_fixture/root/bootstrap/units/$unit.in"
done
printf '%s\n' '[Unit]' 'Description=bpa-orchestrator-watchdog.timer' \
  '[Timer]' 'OnUnitActiveSec=60s' > \
  "$stage2_fixture/root/bootstrap/units/bpa-orchestrator-watchdog.timer.in"
BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$stage2_fixture/systemd" EXPECTED_UNITS_FILE="$stage2_fixture/expected.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units'
grep -Fq "ExecStart=$stage2_fixture/bin/bun $stage2_fixture/root/first.ts" \
  "$stage2_fixture/systemd/first.service"
[[ "$(stat -c '%a' "$stage2_fixture/systemd/second.timer")" == 644 ]]
# grep, not rg: `rg` is not a coreutil and is absent on this host, so
# `if rg ...` exited 127 and the "no systemctl" assertion passed by never
# running -- a check that quietly does nothing, which is the same class as the
# render defect this row fixes. grep -r is always present via CORE_PATH.
if grep -rn 'systemctl' "$stage2_fixture" >/dev/null; then
  echo 'ERROR: render_units invoked or emitted systemctl' >&2
  exit 1
fi
rm "$stage2_fixture/root/instance/units/second.timer.in"
if BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$stage2_fixture/systemd" EXPECTED_UNITS_FILE="$stage2_fixture/expected.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units' >/dev/null 2>&1; then
  echo 'ERROR: render_units accepted a manifest-listed missing template' >&2
  exit 1
fi
printf '%s\t%s\n' \
  bpa-orchestrator.service generic \
  bpa-orchestrator-watchdog.service generic \
  bpa-orchestrator-watchdog.timer generic > "$stage2_fixture/truncated.tsv"
if BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$stage2_fixture/truncated-systemd" \
  EXPECTED_UNITS_FILE="$stage2_fixture/truncated.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units' >/dev/null 2>&1; then
  echo 'ERROR: render_units accepted a manifest missing a required incident unit' >&2
  exit 1
fi
[[ ! -e "$stage2_fixture/truncated-systemd" ]]
echo 'PASS render_units manifest truncation lock: required incident row absence fails before destination creation'

install -d -m 755 "$stage2_fixture/untouched-systemd"
printf '%s\n' preserved > "$stage2_fixture/untouched-systemd/existing.service"
printf '%s\t%s\n' \
  bpa-orchestrator.service generic \
  bpa-orchestrator-watchdog.service generic \
  bpa-orchestrator-watchdog.timer generic \
  bpa-telegram-daemon.service generic \
  malformed.service missing-source > "$stage2_fixture/malformed-later.tsv"
if BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$stage2_fixture/untouched-systemd" \
  EXPECTED_UNITS_FILE="$stage2_fixture/malformed-later.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units' >/dev/null 2>&1; then
  echo 'ERROR: render_units accepted a malformed later manifest row' >&2
  exit 1
fi
if [[ "$(find "$stage2_fixture/untouched-systemd" -mindepth 1 -maxdepth 1 -printf '%f\n')" != existing.service ]]; then
  echo 'ERROR: render_units changed the destination before rejecting a malformed later row' >&2
  find "$stage2_fixture/untouched-systemd" -mindepth 1 -maxdepth 1 -printf 'AFTER_FAILURE_PRESENT=%f\n' >&2
  exit 1
fi
grep -Fxq preserved "$stage2_fixture/untouched-systemd/existing.service"
echo 'PASS render_units preflight lock: a malformed later row leaves the destination untouched'
echo 'PASS render_units: renders both inventories, reads final unterminated row, and rejects manifest deletion'

printf '%s\n' '[Timer]' 'OnCalendar=hourly' > \
  "$stage2_fixture/root/instance/units/second.timer.in"

publication_snapshot() {
  local destination="$1"
  find "$destination" -mindepth 1 -maxdepth 1 -type f -printf '%f %m ' \
    -exec sha256sum {} \; | LC_ALL=C sort
}

run_publication_fault_lock() {
  local fault="$1" fixture output before after rc
  fixture="$stage2_fixture/publication-$fault"
  install -d -m 700 "$fixture/bin" "$fixture/systemd"
  for unit in first.service bpa-orchestrator.service bpa-orchestrator-watchdog.service \
    bpa-orchestrator-watchdog.timer bpa-telegram-daemon.service; do
    printf 'prior-%s\n' "$unit" > "$fixture/systemd/$unit"
  done
  chmod 600 "$fixture/systemd/first.service"
  before="$(publication_snapshot "$fixture/systemd")"
  cat > "$fixture/bin/mv" <<EOF
#!/usr/bin/env bash
count_file='$fixture/mv.count'
count=0
[[ ! -f "\$count_file" ]] || read -r count < "\$count_file"
((count += 1))
printf '%s\n' "\$count" > "\$count_file"
if [[ "\$count" == 2 ]]; then
  if [[ '$fault' == signal || '$fault' == double-signal ]]; then
    kill -TERM "\$PPID"
    sleep 1
  else
    exit 28
  fi
fi
exec /usr/bin/mv "\$@"
EOF
  chmod 700 "$fixture/bin/mv"
  if [[ "$fault" == double-signal ]]; then
    cat > "$fixture/bin/cp" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -p && "${2:-}" == -- && "${3:-}" == */prior/first.service ]]; then
  kill -TERM "$INSTALLER_TEST_PID"
  sleep 1
fi
exec /usr/bin/cp "$@"
EOF
    chmod 700 "$fixture/bin/cp"
  fi
  set +e
  output="$(PATH="$fixture/bin:$PATH" BOOTSTRAP_LIB_ONLY=true \
    INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
    SYSTEMD_SYSTEM_DIR="$fixture/systemd" EXPECTED_UNITS_FILE="$stage2_fixture/expected.tsv" \
    INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c \
    'export INSTALLER_TEST_PID=$BASHPID; source "$INSTALLER_PATH"; render_units' 2>&1)"
  rc=$?
  set -e
  [[ "$rc" -ne 0 ]]
  grep -Fq 'verdict=rolled-back' <<<"$output"
  if [[ "$fault" == double-signal ]]; then
    verdict_count="$(grep -Ec 'verdict=(rolled-back|rollback-failed)' <<<"$output")"
    [[ "$verdict_count" -eq 1 ]]
  fi
  after="$(publication_snapshot "$fixture/systemd")"
  [[ "$after" == "$before" ]]
  [[ ! -e "$fixture/systemd/second.timer" ]]
  printf 'FAIL-BEFORE publication-%s: second publication left a mixed old/new destination set at 0a431056b6006886019f6be6e0ba9d156e2821e8\n' "$fault"
  printf 'PASS render_units publication-%s lock: prior bytes, modes, and absences restored\n' "$fault"
}

run_publication_fault_lock failure
run_publication_fault_lock signal
run_publication_fault_lock double-signal

# A rollback child that never returns must be killed by the rollback deadline.
# Publication failure and signal rollback share rollback_unit_publication, so
# this locks the bound on the ordinary failure path as well as the handler path.
stuck_fixture="$stage2_fixture/rollback-stuck"
install -d -m 700 "$stuck_fixture/bin" "$stuck_fixture/systemd"
printf '%s\n' prior > "$stuck_fixture/systemd/first.service"
cat > "$stuck_fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
count_file="${STUCK_FIXTURE}/mv.count"
count=0
[[ ! -f "$count_file" ]] || read -r count < "$count_file"
((count += 1)); printf '%s\n' "$count" > "$count_file"
[[ "$count" != 2 ]] || exit 28
exec /usr/bin/mv "$@"
EOF
cat > "$stuck_fixture/bin/cp" <<'EOF'
#!/usr/bin/env bash
if [[ "${BPA_UNIT_ROLLBACK:-}" == 1 ]]; then
  while :; do sleep 1; done
fi
exec /usr/bin/cp "$@"
EOF
chmod 700 "$stuck_fixture/bin/mv" "$stuck_fixture/bin/cp"
set +e
stuck_output="$(timeout 5 env PATH="$stuck_fixture/bin:$PATH" STUCK_FIXTURE="$stuck_fixture" \
  UNIT_ROLLBACK_TIMEOUT_SECONDS=0.2 UNIT_ROLLBACK_KILL_AFTER_SECONDS=0.2 \
  BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$stuck_fixture/systemd" EXPECTED_UNITS_FILE="$stage2_fixture/expected.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units' 2>&1)"
stuck_rc=$?
set -e
[[ "$stuck_rc" -eq 125 ]]
[[ "$(grep -Ec 'verdict=(rolled-back|rollback-failed)' <<<"$stuck_output")" -eq 1 ]]
grep -Fq 'verdict=rollback-failed' <<<"$stuck_output"
if grep -Fq 'verdict=rolled-back' <<<"$stuck_output"; then
  echo 'ERROR: timed-out restoration claimed a proven rollback' >&2
  exit 1
fi
if grep -Fxq prior "$stuck_fixture/systemd/first.service"; then
  echo 'ERROR: stuck restoration fixture unexpectedly completed restoration' >&2
  exit 1
fi
echo 'PASS render_units rollback-timeout lock: stuck restoration terminates with one truthful failed verdict'

# Make restoration itself fail after publication has begun. The verdict must
# remain different from an ordinary, proven rollback.
rollback_fixture="$stage2_fixture/rollback-failed"
install -d -m 700 "$rollback_fixture/bin" "$rollback_fixture/systemd"
printf '%s\n' prior > "$rollback_fixture/systemd/first.service"
cat > "$rollback_fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
count_file="${ROLLBACK_FIXTURE}/mv.count"
count=0
[[ ! -f "$count_file" ]] || read -r count < "$count_file"
((count += 1)); printf '%s\n' "$count" > "$count_file"
[[ "$count" != 2 ]] || exit 28
exec /usr/bin/mv "$@"
EOF
cat > "$rollback_fixture/bin/cp" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -p && "${3:-}" == */prior/first.service ]]; then exit 31; fi
exec /usr/bin/cp "$@"
EOF
chmod 700 "$rollback_fixture/bin/mv" "$rollback_fixture/bin/cp"
set +e
rollback_output="$(PATH="$rollback_fixture/bin:$PATH" ROLLBACK_FIXTURE="$rollback_fixture" \
  BOOTSTRAP_LIB_ONLY=true INSTALL_ROOT="$stage2_fixture/root" BUN_BIN="$stage2_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$rollback_fixture/systemd" EXPECTED_UNITS_FILE="$stage2_fixture/expected.tsv" \
  INSTALLER_PATH="$INSTALLER" "$BASH_BIN" -c 'source "$INSTALLER_PATH"; render_units' 2>&1)"
rollback_rc=$?
set -e
[[ "$rollback_rc" -eq 125 ]]
grep -Fq 'verdict=rollback-failed' <<<"$rollback_output"
if grep -Fq 'verdict=rolled-back' <<<"$rollback_output"; then
  echo 'ERROR: failed restoration also claimed a proven rollback' >&2
  exit 1
fi
echo 'PASS render_units rollback-failed lock: incomplete restoration is explicit and distinguishable'

# ══════════════════════════════════════════════════════════════════════════
# --verify-source
# ══════════════════════════════════════════════════════════════════════════
verify_fixture="$FIXTURE_ROOT/verify"
install -d -m 700 "$verify_fixture/root/.git" "$verify_fixture/root/core" \
  "$verify_fixture/root/bootstrap" "$verify_fixture/bin" "$verify_fixture/systemd"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [[ "${1:-}" == -l ]]; then echo "# BEGIN bpa-dev-infrastructure hygiene"; fi' \
  'exit 0' > "$verify_fixture/bin/crontab"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/bootstrap/check-unit-drift.sh"
chmod 700 "$verify_fixture/root/bootstrap/check-unit-drift.sh"
for tool in git curl tmux flock findmnt; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$tool"
done
chmod 700 "$verify_fixture/bin"/*
install -m 600 /dev/null "$verify_fixture/root/.env"

good_output="$(PATH="$verify_fixture/bin:$CORE_PATH" INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" BUN_BIN="$verify_fixture/bin/bun" \
  CRONTAB_CMD="$verify_fixture/bin/crontab" SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd" \
  "$INSTALLER" --verify-source)"
for expected in 'PASS git' 'PASS curl' 'PASS tmux' 'PASS flock' 'PASS findmnt' 'PASS bun' \
  'PASS repository' 'PASS environment file' 'PASS environment permissions' 'PASS state-db' \
  'PASS hygiene-cron' 'PASS rendered units'; do
  grep -Fq "$expected" <<<"$good_output"
done
echo 'PASS --verify-source: every stage-2 boundary PASSes against a satisfied fixture'

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
    "$REPO_ROOT/bootstrap/install.sh" "$SCRIPT_DIR/unit-render-lib.sh" \
    "$SCRIPT_DIR/bootstrap.test.sh" 2>&1)"
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
  # -x so the `# shellcheck source=` directive on install.sh's
  # unit-render-lib.sh line is followed instead of reported as SC1091. The
  # library is linted here too: it is the one place the render variables live,
  # so it is the last file in this subsystem that should go unchecked.
  shellcheck -x "$INSTALLER" "$SCRIPT_DIR/unit-render-lib.sh" "$SCRIPT_DIR/bootstrap.test.sh"
  echo 'PASS shellcheck (local binary, no Docker)'
else
  echo 'SKIP shellcheck: not present on this host'
fi

echo 'PASS bootstrap stage 2: dry-run, all eight in-scope functions, failure locks, --verify-source, secret scan'
