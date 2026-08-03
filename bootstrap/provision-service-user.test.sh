#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${SERVICE_USER_TEST_IMAGE:-debian:12-slim}"

# The meteorite already supplies the disposable clean container. Requiring a
# second Docker daemon there made the honest environment fail before exercising
# the provisioner. Host runs still create their own disposable container and
# can never touch the host account database.
if [[ "${SERVICE_USER_TEST_ISOLATED:-0}" != 1 ]]; then
  if [[ -f /.dockerenv ]]; then
    exec env SERVICE_USER_TEST_ISOLATED=1 bash "$0"
  fi
  command -v docker >/dev/null || { echo 'ERROR: missing required binary: docker' >&2; exit 1; }
  exec docker run --rm -e PATH=/usr/bin:/bin -e SERVICE_USER_TEST_ISOLATED=1 \
    -v "$repo_root:/src:ro" "$image" /bin/bash /src/bootstrap/provision-service-user.test.sh
fi

if ! command -v useradd >/dev/null || ! command -v loginctl >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends passwd systemd >/dev/null
fi
cd "$repo_root"
  export LANE_PROVISION_STATE_ROOT=/var/lib/provision-test
  cat >/usr/local/bin/loginctl <<"EOF"
#!/bin/bash
set -eu
case "$1" in
  enable-linger) mkdir -p /var/lib/systemd/linger; : >"/var/lib/systemd/linger/$2" ;;
  disable-linger) rm -f "/var/lib/systemd/linger/$2" ;;
  show-user) test -e "/var/lib/systemd/linger/$2" && echo yes || echo no ;;
  *) exit 2 ;;
esac
EOF
  chmod 755 /usr/local/bin/loginctl
  export PATH=/usr/local/bin:/usr/bin:/bin
  cat > /tmp/lane.conf <<EOF
LANE_SERVICE_USER=laneproof
LANE_SERVICE_HOME=/home/laneproof
LANE_REPOSITORY_ROOT=/home/laneproof/repository
LANE_WORKTREES_ROOT=/home/laneproof/worktrees
EOF
  before="$(getent passwd laneproof || true)|$(test -e /home/laneproof && echo present || echo absent)"
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/lane.conf
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/lane.conf
  test "$(getent passwd laneproof | wc -l)" -eq 1
  test "$(loginctl show-user laneproof -p Linger --value)" = yes
  if bash bootstrap/deprovision-service-user.sh /tmp/lane.conf >/tmp/default.out 2>&1; then exit 20; fi
  grep -Fq "without --delete-home" /tmp/default.out
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/lane.conf
  after="$(getent passwd laneproof || true)|$(test -e /home/laneproof && echo present || echo absent)"
  test "$before" = "$after"
  test ! -e /var/lib/systemd/linger/laneproof
  echo "BEFORE=$before"
  echo "AFTER=$after"

  /usr/sbin/useradd --create-home outsider
  cat >/tmp/outsider.conf <<EOF
LANE_SERVICE_USER=outsider
LANE_SERVICE_HOME=/home/outsider
LANE_REPOSITORY_ROOT=/home/outsider/repository
LANE_WORKTREES_ROOT=/home/outsider/worktrees
EOF
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/outsider.conf >/tmp/refusal.out 2>&1; then exit 21; fi
  grep -Fq "creation marker missing" /tmp/refusal.out
  getent passwd outsider >/dev/null
  test -d /home/outsider
  echo "REFUSAL=$(cat /tmp/refusal.out)"

  mkdir /home/unowned-home
  cat >/tmp/unowned-home.conf <<EOF
LANE_SERVICE_USER=unownedhome
LANE_SERVICE_HOME=/home/unowned-home
LANE_REPOSITORY_ROOT=/home/unowned-home/repository
LANE_WORKTREES_ROOT=/home/unowned-home/worktrees
EOF
  if bash bootstrap/provision-service-user.sh /tmp/unowned-home.conf >/tmp/home-refusal.out 2>&1; then exit 23; fi
  grep -Fq "refusing unowned home directory" /tmp/home-refusal.out
  test -d /home/unowned-home
  ! getent passwd unownedhome >/dev/null
  echo "DIRECTORY_REFUSAL=$(cat /tmp/home-refusal.out)"

  mv /usr/sbin/useradd /usr/sbin/useradd.hidden
  if PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/lane.conf >/tmp/missing.out 2>&1; then exit 22; fi
  grep -Fq "missing required binary: useradd" /tmp/missing.out
  ! grep -Fq "command not found" /tmp/missing.out
  echo "MISSING=$(cat /tmp/missing.out)"
printf 'service-user container proof: PASS\n'
