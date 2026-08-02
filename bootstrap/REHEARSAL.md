# Clean Ubuntu Docker rehearsal

This rehearsal proves the bootstrap's clean-source boundary and, critically,
that production verification cannot report success when a container lacks the
real host activation boundary. The deployment contract is root-owned SYSTEM
units under `/root/bpa-dev-infrastructure`; `systemd --user` is not used.

Run from the repository root. The only host input is a read-only, commit-only
clone; the container clones that input again, so ignored files and host build
outputs cannot help it pass.

```bash
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git clone --no-hardlinks . "$scratch/source"
docker run --rm -v "$scratch/source:/src:ro" ubuntu:24.04 bash -lc '
  set -euo pipefail
  apt-get update >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git curl ca-certificates tmux util-linux gettext-base unzip xz-utils >/dev/null
  git config --global --add safe.directory /src/.git
  git clone /src /work/source >/dev/null
  cd /work/source

  test "$(git status --porcelain)" = ""
  test "$(sed -n '\''s/^INSTALL_ROOT="${INSTALL_ROOT:-\([^}]*\)}"/\1/p'\'' bootstrap/install.sh)" \
    = /root/bpa-dev-infrastructure
  test -f bootstrap/units/bpa-orchestrator.service.in
  grep -Fxq "User=root" bootstrap/units/bpa-orchestrator.service.in
  grep -Fxq "WantedBy=multi-user.target" bootstrap/units/bpa-orchestrator.service.in

  # Source verification may name unsupported host boundaries as SKIP, but it
  # still fails here because real runtime dependencies are absent.
  set +e
  bootstrap/install.sh --verify-source > /tmp/source-verify.log 2>&1
  source_rc=$?
  bootstrap/install.sh --verify > /tmp/production-verify.log 2>&1
  production_rc=$?
  set -e
  test "$source_rc" -ne 0
  test "$production_rc" -ne 0
  grep -F "FAIL docker" /tmp/production-verify.log
  grep -F "FAIL codex login" /tmp/production-verify.log
  grep -F "FAIL claude" /tmp/production-verify.log
  grep -F "FAIL whisper" /tmp/production-verify.log
  grep -F "FAIL orchestrator unit" /tmp/production-verify.log
  grep -F "FAIL system systemd" /tmp/production-verify.log
  if grep -Fq "Bootstrap completed and deployment verification passed." \
      /tmp/production-verify.log; then
    echo "production verification emitted a false success" >&2
    exit 1
  fi
  printf "CLEAN-CONTAINER PASS source_rc=%s production_rc=%s root=%s manager=SYSTEM\n" \
    "$source_rc" "$production_rc" /root/bpa-dev-infrastructure
'
```

This is intentionally not a substitute for the real-host activation check.
`bootstrap/install.sh --verify` is the deployment verdict and returns nonzero
until Docker, authenticated provider CLIs, Whisper, the configured token, all
rendered units, and the SYSTEM manager activation state are present. On the
target host, run:

```bash
bootstrap/install.sh
bootstrap/install.sh --verify
```

The first command installs repository-owned dependencies, renders SYSTEM units,
activates them, and immediately runs the same strict verification. It cannot
print its completion line unless every required row passes. The watchdog timer
is the sole deliberate inactive exception and requires `--arm-watchdog`.

## Latest clean-container transcript

```text
FAIL docker
FAIL codex login
FAIL claude
FAIL whisper
FAIL orchestrator unit
FAIL system systemd
CLEAN-CONTAINER PASS source_rc=1 production_rc=1 root=/root/bpa-dev-infrastructure manager=SYSTEM
```

The exact command above produced this transcript from a fresh Ubuntu 24.04
container. Variable command spacing is omitted; the assertions match the named
rows and both nonzero exit statuses.
