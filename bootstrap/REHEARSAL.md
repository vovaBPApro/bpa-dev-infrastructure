# Clean Ubuntu Docker rehearsal

This is a throwaway fresh-machine rehearsal. It installs with no `INSTALL_ROOT`
override, so the installer must clone to `/home/bpa-dev-infrastructure`. The
only host mount is a read-only clone; the container clones it again before the
installer runs. The checks use `grep`, coreutils, Docker, and Bun—never Python
or `rg`.

Run from the repository root:

```bash
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git clone --no-hardlinks . "$scratch/source"
docker run --rm -v "$scratch/source:/src:ro" ubuntu:24.04 bash -lc '
  set -euo pipefail
  apt-get update >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates tmux >/dev/null
  git config --global --add safe.directory /src/.git
  git clone /src /work/source >/dev/null
  cd /work/source

  # No INSTALL_ROOT override: this proves the canonical production root.
  REPO_URL=/src bootstrap/install.sh --no-cron
  bootstrap/install.sh --verify
  test -d /home/bpa-dev-infrastructure/.git
  legacy_root="/home/bpa-""shell"
  install_root=/home/bpa-dev-infrastructure
  if grep -RInF --exclude=bootstrap.test.sh "$legacy_root" \
    "$install_root/bootstrap" "$install_root/core" "$install_root/daemon" \
    "$install_root/gate" "$install_root/hygiene" "$install_root/orchestrator" \
    "$install_root/stand" "$install_root/workspace"; then
    echo "legacy root found in installed runtime surface" >&2
    exit 1
  fi

  install -d -m 700 /rehearsal/bin /rehearsal/runtime
  cat > /rehearsal/bin/systemd-run <<"EOF"
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == -* ]]; do shift; done
exec "$@"
EOF
  cat > /rehearsal/bin/codex <<"EOF"
#!/usr/bin/env bash
exec sleep 3600
EOF
  chmod 700 /rehearsal/bin/systemd-run /rehearsal/bin/codex
  export PATH="/rehearsal/bin:/root/.bun/bin:$PATH"
  export INFRA_STATE_DB=/home/bpa-dev-infrastructure/runtime/state.db
  cli=(/root/.bun/bin/bun /home/bpa-dev-infrastructure/core/mission-cli.ts)

  mission_id="$("${cli[@]}" mission create restart-recovery | sed -n "s/^MISSION id=\\([^ ]*\\).*/\\1/p")"
  "${cli[@]}" lane create "$mission_id" restart-lane
  sleep 3600 & dead_owner_pid=$!
  dead_owner="rehearsal-owner:$dead_owner_pid"
  first_lease="$("${cli[@]}" lease acquire "$dead_owner" orchestrator 1000)"
  first_token="$(sed -n "s/.* token=\\([1-9][0-9]*\\)$/\\1/p" <<<"$first_lease")"

  daemon_start() {
    TELEGRAM_BOT_TOKEN=rehearsal-token \
      TELEGRAM_STATE_DIR=/rehearsal/telegram-state \
      TELEGRAM_DAEMON_PORT=4829 \
      /root/.bun/bin/bun /home/bpa-dev-infrastructure/daemon/server.ts \
      >/rehearsal/daemon.log 2>&1 &
    daemon_pid=$!
    for _ in $(seq 1 40); do
      curl -fsS http://127.0.0.1:4829/health >/dev/null 2>&1 && return 0
      sleep 1
    done
    cat /rehearsal/daemon.log >&2
    return 1
  }
  daemon_start
  curl -fsS http://127.0.0.1:4829/health

  # Simulate abrupt loss of both independently supervised processes.
  kill -9 "$daemon_pid" "$dead_owner_pid"
  wait "$daemon_pid" 2>/dev/null || true
  wait "$dead_owner_pid" 2>/dev/null || true
  sleep 2

  # The dead owner is visibly reaped before launch.sh acquires its replacement.
  reap="$("${cli[@]}" reap)"
  printf "%s\\n" "$reap"
  grep -Fq "owner=$dead_owner" <<<"$reap"
  daemon_start
  export ORCH_CONFIG_FILE=/rehearsal/no-runtime.env
  export ORCH_RUNTIME_DIR=/rehearsal/runtime ORCH_STATE_DB="$INFRA_STATE_DB"
  export ORCH_SESSION=restart-recovery ORCH_PROVIDER=codex
  export ORCH_AUTH_PREFLIGHT=/home/bpa-dev-infrastructure/orchestrator/preflight-cli-auth.sh
  /home/bpa-dev-infrastructure/orchestrator/launch.sh start
  second_token="$(sed -n "s/^token=//p" /rehearsal/runtime/orchestrator.lease)"
  test "$second_token" -gt "$first_token"
  curl -fsS http://127.0.0.1:4829/health
  status="$("${cli[@]}" status)"
  printf "%s\\n" "$status"
  grep -Fq "restart-recovery" <<<"$status"
  grep -Fq "restart-lane" <<<"$status"
  /home/bpa-dev-infrastructure/orchestrator/launch.sh stop
  kill "$daemon_pid"
  wait "$daemon_pid" 2>/dev/null || true
  printf "RESTART-RECOVERY PASS first-token=%s second-token=%s\\n" "$first_token" "$second_token"
'
```

## Restart recovery

The direct daemon command in the container is equivalent to the rendered
`bpa-telegram-daemon.service` `ExecStart`; Docker deliberately has no usable
user-systemd. On a VM, `Restart=on-failure` restarts that daemon and the
documented orchestrator recovery path is:

```bash
/home/bpa-dev-infrastructure/orchestrator/launch.sh start
```

The rehearsal first creates a mission, lane, and lease through `mission-cli`.
It then kills the direct daemon and the sleeping lease-owner with `kill -9`,
waits for expiry, reaps the precise dead owner, restarts the daemon, and invokes
that `launch.sh start` path. It fails unless `/health` returns again, the new
fencing token is strictly greater, and `mission-cli status` still contains the
pre-crash mission and lane. The grep sweep covers every installed deployable
runtime directory; historical migration and instruction documents are not runtime
inputs, and the bootstrap test fixture is explicitly excluded.

## Latest transcript tail

```text
INSTALL GATE: PASS full sweep
Bootstrap completed. Run '/work/source/bootstrap/install.sh --verify' after configuring the local token.
STATUS CHECK
PASS state-db
PASS daemon unit
PASS watchdog service
PASS watchdog timer
SKIP user systemd             no user-systemd session
REAP key=orchestrator owner=rehearsal-owner:<pid> token=1
started: restart-recovery (codex)
{"status":"ok","bot":"starting","connected":false,"alive":false,"buffered":0,"pid":<pid>}
{"missions":[{"correlationId":"restart-recovery"}],"lanes":[{"id":"restart-lane"}],"leases":[{"key":"orchestrator","fencingToken":2}]}
stopped: restart-recovery
RESTART-RECOVERY PASS first-token=1 second-token=2
```

The token and process identifiers are intentionally variable; the command above
asserts their ordering and the exact dead owner rather than matching fixture
values.

## Real VM-only steps

1. Clone the actual remote and run `bootstrap/install.sh` without an
   `INSTALL_ROOT` override.
2. Paste the real Telegram token into `/home/bpa-dev-infrastructure/.env` with
   mode `0600`.
3. In the logged-in user session, run `systemctl --user daemon-reload` and
   enable `bpa-telegram-daemon.service` plus
   `bpa-orchestrator-watchdog.timer`.
