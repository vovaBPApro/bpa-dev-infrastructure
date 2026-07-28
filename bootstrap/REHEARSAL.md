# Clean Ubuntu Docker rehearsal

This rehearsal uses `ubuntu:24.04` as a throwaway fresh machine. The only host
mount is a read-only Git clone in the required scratchpad; the container clones
that copy again before it runs the installer.

Run from the repository root:

```bash
scratch=/tmp/claude-1000/-home-bpa-shell/c0d3fe14-9341-4751-94a9-07a28e7dd2a7/scratchpad/bootstrap-rehearsal
mkdir -p "$scratch"
rm -rf "$scratch/source"
git clone --no-hardlinks . "$scratch/source"
docker run --rm -v "$scratch/source:/src:ro" ubuntu:24.04 bash -lc '
  set -euo pipefail
  apt-get update >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates tmux >/dev/null
  git config --global --add safe.directory /src/.git
  git clone /src /work/bpa-dev-infrastructure >/dev/null
  cd /work/bpa-dev-infrastructure
  INSTALL_ROOT=/opt/bpa bootstrap/install.sh --dry-run
  INSTALL_ROOT=/opt/bpa REPO_URL=/src bootstrap/install.sh --no-cron
  INSTALL_ROOT=/opt/bpa bootstrap/install.sh --verify
'
```

## Initial failures and fixes

- A root Ubuntu image has no `sudo`. Prerequisite installation now calls
  `apt-get` directly as root, uses `sudo` for a normal sudo-capable user, and
  otherwise stops with a precise error.
- Bun's installer required `unzip`; rendering units required `envsubst`; the
  clean image also lacked `xz`. The installer now installs `unzip`, `xz-utils`,
  and `gettext-base` when their commands are absent.
- `systemctl` can exist in a Docker image without a usable `systemctl --user`
  session. The installer now renders units, prints the VM activation commands,
  and exits successfully. Verification reports those checks as `SKIP` rather
  than a false PASS or failure.
- The generated token placeholder cannot be configured during a secret-free
  rehearsal. Verification reports that condition as `SKIP`.
- A Docker bind mount can trigger Git's dubious-ownership safeguard. The
  harness marks only `/src/.git` as safe before cloning its read-only copy.
- `--no-cron` is the container-safe switch: it avoids installing a cron daemon
  in the throwaway image and records the verification row as a reasoned `SKIP`.
- The installer exports the Bun binary directory before its test gate. This is
  required because gate tests spawn `bun` by name rather than using `BUN_BIN`.

`bootstrap/bootstrap.test.sh` includes a fixture that proves unavailable
user-systemd and an unconfigured token are reported as `SKIP`.

## Latest transcript tail (NO-GO)

```text
PLAN apt          check git, curl, tmux, envsubst, unzip, and xz; install cron unless --no-cron is set
PLAN bun          install Bun 1.3.14 if /root/.bun/bin/bun is absent
PLAN repository   clone or fast-forward update /opt/bpa from REPO_URL
PLAN state-db     initialize /opt/bpa/runtime/state.db with core/mission-cli.ts status
PLAN workspace    make workspace/workspace.sh sync capability available
PLAN hygiene      install hygiene cron unless --no-cron is set
PLAN test-gate    run the full daemon, core, gate, stand, and workspace test sweep
{"missions":[],"lanes":[],"leases":[]}
Hygiene cron skipped: --no-cron.
INSTALL GATE: daemon tests
Ran 21 tests across 2 files. [33.00ms]
INSTALL GATE: core tests
Ran 10 tests across 2 files. [1283.00ms]
INSTALL GATE: gate tests
Ran 7 tests across 1 file. [440.00ms]
INSTALL GATE: stand tests
Ran 8 tests across 2 files. [32.00ms]
INSTALL GATE: workspace tests
workspace tests: PASS
INSTALL GATE: PASS full sweep
User systemd is unavailable; units were rendered only. On a VM with a user session, run:
  systemctl --user daemon-reload
  systemctl --user enable --now bpa-telegram-daemon.service bpa-orchestrator-watchdog.timer
Activation skipped: no user-systemd session is available.
STATUS CHECK
PASS git
PASS curl
PASS tmux
PASS bun
PASS repository
PASS environment file
PASS environment permissions
PASS state-db
PASS workspace
SKIP hygiene-cron             disabled by --no-cron
usage: bun gate/completion-guard.ts --report <file> --repo <path> [--branch <name>] [--run-verify]
FAIL gate
SKIP stand                    docker command unavailable
SKIP token configured         token placeholder remains
PASS daemon unit
PASS watchdog service
PASS watchdog timer
SKIP user systemd             no user-systemd session
SKIP daemon enabled           user-systemd unavailable
SKIP watchdog enabled         user-systemd unavailable
```

The complete install-time test sweep passed in the clean Ubuntu container.
The rehearsal remains `NO-GO`: `gate/completion-guard.ts --help` exits 2,
although HR-04 requires that command to exit 0. This lane is restricted to
`bootstrap/`, so the required gate CLI fix must land in its owning component;
the bootstrap verifier intentionally fails closed until then.

## Real VM-only steps

1. Clone from the actual remote (using its SSH deploy key, if required), not
   the local `/src` rehearsal mirror.
2. Paste the real Telegram token into `INSTALL_ROOT/.env` with mode `0600`.
3. In the logged-in user session, run `systemctl --user daemon-reload` and
   enable the daemon and watchdog timer; user-systemd is intentionally absent
   from this plain Docker container.
