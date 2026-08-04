#!/usr/bin/env bash
# Real systemd regression lock for V3-2.1. Runs only in a disposable container;
# it never addresses the host manager. The service is rendered from the tracked
# production template; only RestartSec is shortened by an explicit test drop-in.
# Activation is performed by bootstrap/install.sh's real activate_units function.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${SYSTEMD_TEST_IMAGE:-bpa-runtime-loopback-ubuntu2404:r6}"
NAME="bpa-systemd-recovery-${BASHPID}"
FIXTURE="$(mktemp -d)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/root/bootstrap" "$FIXTURE/root/orchestrator" \
  "$FIXTURE/systemd/bpa-orchestrator.service.d"
cp "$SCRIPT_DIR/install.sh" "$FIXTURE/root/bootstrap/install.sh"
: > "$FIXTURE/root/.env"
INSTALL_ROOT=/fixture/root ENV_FILE=/fixture/root/.env \
  envsubst < "$SCRIPT_DIR/units/bpa-orchestrator.service.in" > \
  "$FIXTURE/systemd/bpa-orchestrator.service"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "${1:-}" == supervise || "${1:-}" == stop ]]' \
  '[[ "${1:-}" != stop ]] || exit 0' \
  'state=/run/bpa-orchestrator-generation' \
  'generation=0; [[ ! -f "$state" ]] || read -r generation < "$state"' \
  '((generation += 1)); printf "%s\n" "$generation" > "$state"' \
  'printf "%s %s\n" "$generation" "$BASHPID" >> /run/bpa-orchestrator-starts' \
  '[[ ! -e /run/bpa-force-failure ]] || exit 42' \
  'exec sleep infinity' > "$FIXTURE/root/orchestrator/launch.sh"
chmod 755 "$FIXTURE/root/orchestrator/launch.sh"

printf '%s\n' \
  '[Service]' \
  'RestartSec=1' > \
  "$FIXTURE/systemd/bpa-orchestrator.service.d/recovery-test.conf"
printf '%s\n' \
  '[Unit]' \
  'Description=Disposable armed watchdog timer' \
  '[Timer]' \
  'OnBootSec=1' \
  'OnUnitActiveSec=2' \
  '[Install]' \
  'WantedBy=timers.target' > "$FIXTURE/systemd/bpa-orchestrator-watchdog.timer"
printf '%s\n' '[Service]' 'Type=oneshot' 'ExecStart=/bin/true' > \
  "$FIXTURE/systemd/bpa-orchestrator-watchdog.service"

docker run -d --name "$NAME" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock \
  -v "$FIXTURE:/fixture:ro" "$IMAGE" /sbin/init >/dev/null

for _ in {1..50}; do
  docker exec "$NAME" systemctl is-system-running --wait >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$NAME" bash -c \
  'cp -R /fixture/systemd/* /etc/systemd/system/; export BOOTSTRAP_LIB_ONLY=true SYSTEMCTL_CMD=systemctl; source /fixture/root/bootstrap/install.sh; activate_units'
[[ "$(docker exec "$NAME" systemctl show -p ExecStart --value bpa-orchestrator.service)" == \
  *'/fixture/root/orchestrator/launch.sh supervise'* ]]
docker exec "$NAME" systemctl is-enabled --quiet bpa-orchestrator.service
docker exec "$NAME" systemctl is-enabled --quiet bpa-orchestrator-watchdog.timer
docker exec "$NAME" systemctl is-active --quiet bpa-orchestrator-watchdog.timer

old_pid="$(docker exec "$NAME" systemctl show -p MainPID --value bpa-orchestrator.service)"
started_ms="$(date +%s%3N)"
docker exec "$NAME" kill -KILL "$old_pid"
new_pid="$old_pid"
for _ in {1..50}; do
  new_pid="$(docker exec "$NAME" systemctl show -p MainPID --value bpa-orchestrator.service)"
  [[ "$new_pid" != 0 && "$new_pid" != "$old_pid" ]] && break
  sleep 0.1
done
elapsed_ms="$(( $(date +%s%3N) - started_ms ))"
[[ "$new_pid" != 0 && "$new_pid" != "$old_pid" ]]
(( elapsed_ms <= 3000 ))
printf 'PASS SIGKILL recovery old_pid=%s new_pid=%s elapsed_ms=%s configured_ms=1000\n' \
  "$old_pid" "$new_pid" "$elapsed_ms"

docker exec "$NAME" touch /run/bpa-force-failure
docker exec "$NAME" kill -KILL "$new_pid"
for _ in {1..80}; do
  state="$(docker exec "$NAME" systemctl is-failed bpa-orchestrator.service 2>/dev/null || true)"
  [[ "$state" == failed ]] && break
  sleep 0.1
done
[[ "$state" == failed ]]
starts="$(docker exec "$NAME" sh -c 'wc -l < /run/bpa-orchestrator-starts')"
(( starts >= 3 && starts <= 5 ))
sleep 2
[[ "$(docker exec "$NAME" sh -c 'wc -l < /run/bpa-orchestrator-starts')" -eq "$starts" ]]
printf 'PASS persistent-failure state=failed starts=%s stable_after_s=2\n' "$starts"
printf 'PASS activation observed orchestrator=enabled watchdog_timer=enabled+active\n'
