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
  INSTALL_ROOT=/opt/bpa REPO_URL=/src bootstrap/install.sh
  INSTALL_ROOT=/opt/bpa bootstrap/install.sh --verify
  cd /opt/bpa/daemon
  /root/.bun/bin/bun test
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

`bootstrap/bootstrap.test.sh` includes a fixture that proves unavailable
user-systemd and an unconfigured token are reported as `SKIP`.

## Final transcript tail

```text
PLAN apt          check git, curl, tmux, envsubst, unzip, and xz; install missing Ubuntu packages
PLAN bun          install Bun 1.2.20 if /root/.bun/bin/bun is absent
PLAN repository   clone or fast-forward update /opt/bpa from REPO_URL
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
SKIP token configured         token placeholder remains
PASS daemon unit
PASS watchdog service
PASS watchdog timer
SKIP user systemd             no user-systemd session
SKIP daemon enabled           user-systemd unavailable
SKIP watchdog enabled         user-systemd unavailable

bun test v1.2.20
 21 pass
 0 fail
Ran 21 tests across 2 files.
```

## Real VM-only steps

1. Clone from the actual remote (using its SSH deploy key, if required), not
   the local `/src` rehearsal mirror.
2. Paste the real Telegram token into `INSTALL_ROOT/.env` with mode `0600`.
3. In the logged-in user session, run `systemctl --user daemon-reload` and
   enable the daemon and watchdog timer; user-systemd is intentionally absent
   from this plain Docker container.
