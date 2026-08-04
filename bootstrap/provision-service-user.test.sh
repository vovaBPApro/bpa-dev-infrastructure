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
  cleanup() {
    if [[ -e /usr/sbin/useradd.hidden && ! -e /usr/sbin/useradd ]]; then
      mv /usr/sbin/useradd.hidden /usr/sbin/useradd
    fi
    rm -f /usr/local/bin/useradd /usr/local/bin/install
    for test_user in laneproof partialproof outsider unownedhome \
      forgeowner uidvictim legacyproof blastuser swapproof crashproof crashearly \
      strangervictim strangerproof uidrecycle uidproof v2victim resumeproof; do
      getent passwd "$test_user" >/dev/null 2>&1 && /usr/sbin/userdel --force --remove "$test_user" >/dev/null 2>&1 || true
    done
    rm -rf /home/laneproof /home/partialproof /home/outsider /home/unowned-home \
      /home/forgeowner /home/uidvictim /home/legacyproof /home/blastuser /home/swapproof \
      /home/crashproof /home/crashearly /home/strangervictim /home/strangerproof \
      /home/uidrecycle /home/uidproof /home/v2victim /home/resumeproof \
      /tmp/outside-blast /tmp/outside-blast2 /tmp/innocent \
      /var/lib/provision-test
    rm -f /var/lib/rev-attack
  }
  trap cleanup EXIT
  # A clean rebuild intentionally runs the complete suite twice (during
  # install and again as an explicit proof). Recover test-only debris even if
  # the prior invocation was interrupted before its EXIT trap completed.
  cleanup
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

  # The round-2 findings are all about a destructive path, so each of them is
  # locked by executing the PRE-FIX code and watching it do the dangerous
  # thing, then executing the fixed code and watching it refuse. The pre-fix
  # copies are pinned in bootstrap/testdata so red-before stays re-executable
  # at every future SHA instead of living in a filed report.
  R1_PROVISION=bootstrap/testdata/provision-service-user.r1.sh
  R1_DEPROVISION=bootstrap/testdata/deprovision-service-user.r1.sh
  # Round 2 is pinned the same way, because round 3's findings are all about
  # code round 2 introduced. Its library is pinned too: the fixtures source it
  # instead of the fixed one beside them, so the red-before really runs round-2
  # logic and not round-3 logic wearing a round-2 filename.
  R2_PROVISION=bootstrap/testdata/provision-service-user.r2.sh
  R2_DEPROVISION=bootstrap/testdata/deprovision-service-user.r2.sh

  # A pinned fixture that silently drifted would turn every red-before below
  # into a tautology, so the bodies are hashed against 9cd4e7bd here rather
  # than trusted. Excludes only the two documented scaffolding lines.
  fixture_body() { # $1=path $2=first line of the body
    sed -n "/^$2/,\$p" "$1" | grep -v 'service-user-lib' | sha256sum | cut -d' ' -f1
  }
  test "$(fixture_body "$R2_PROVISION" 'SU_TOOL=')" \
    = a23bc7b233949f894c9e6ff9f922fd66d60b64bc2d9ea8b899dd3e8c3ca26078
  test "$(fixture_body "$R2_DEPROVISION" 'SU_TOOL=')" \
    = bf6f76e63cdd9c8ff6485703d147d592abfbb9bca659d504b235e34a272f6645
  test "$(fixture_body bootstrap/testdata/service-user-lib.r2.sh 'su_die() {')" \
    = d9cafbafc5a4c7764046dc479fc6b6509489bd8947d1e74048b789b3e4d67982
  echo "R2_FIXTURES_PINNED=provision, deprovision and library bodies hash-match 9cd4e7bd"

  make_conf() { # $1=user [$2=repository root override]
    cat >"/tmp/$1.conf" <<EOF
LANE_SERVICE_USER=$1
LANE_SERVICE_HOME=/home/$1
LANE_REPOSITORY_ROOT=${2:-/home/$1/repository}
LANE_WORKTREES_ROOT=/home/$1/worktrees
EOF
  }
  # Write a marker the provisioner never wrote. $5 selects the round-1 shape
  # (no version, no uid) or the round-2 shape, so the same forgery can be aimed
  # at both the pinned copy and the fixed script.
  make_marker() { # $1=user $2=uid $3=owner $4=mode $5=r1|v2|v3 [$6=repo override] [$7=created_repo]
    local user="$1" uid="$2" owner="$3" mode="$4" shape="$5"
    local repo="${6:-/home/$1/repository}" created_repo="${7:-no}"
    local file="/var/lib/provision-test/$1.created"
    install -d -m 0700 -o root -g root /var/lib/provision-test
    case "$shape" in
      r1)
        printf 'user=%s\nhome=/home/%s\nrepo=%s\nworktrees=/home/%s/worktrees\ncreated_repo=%s\ncreated_worktrees=no\n' \
          "$user" "$user" "$repo" "$user" "$created_repo" >"$file" ;;
      v2)
        printf 'version=2\nstate=created\nuser=%s\nuid=%s\nhome=/home/%s\nrepo=%s\nworktrees=/home/%s/worktrees\ncreated_repo=%s\ncreated_worktrees=no\ncreated_at=0\n' \
          "$user" "$uid" "$user" "$repo" "$user" "$created_repo" >"$file" ;;
      v3)
        # A syntactically perfect current-format marker whose witness is simply
        # not the one on any account. Every forgery below is aimed at the
        # strongest shape an attacker could write, not at an outdated one.
        printf 'version=3\nstate=created\nuser=%s\nuid=%s\nwitness=00000000000000000000000000000000\nhome=/home/%s\nrepo=%s\nworktrees=/home/%s/worktrees\ncreated_repo=%s\ncreated_worktrees=no\ncreated_at=0\n' \
          "$user" "$uid" "$user" "$repo" "$user" "$created_repo" >"$file" ;;
      *) echo "make_marker: unknown shape $shape" >&2; exit 60 ;;
    esac
    chown "$owner" "$file"
    chmod "$mode" "$file"
  }
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
  # The whole ownership guard rests on the provisioner writing a marker that
  # its own de-provisioner will accept. Lock the shape it writes, not just the
  # shapes it rejects.
  test "$(stat -c %u:%g:%a /var/lib/provision-test/laneproof.created)" = 0:0:600
  test "$(stat -c %u:%a /var/lib/provision-test)" = 0:700
  grep -Fqx 'version=3' /var/lib/provision-test/laneproof.created
  grep -Fqx "uid=$(id -u laneproof)" /var/lib/provision-test/laneproof.created
  # The marker's witness must actually be on the account, because that pairing
  # is the whole authority model: the marker names a shape, the account proves
  # which one. Lock both halves, not just the file.
  grep -Eq '^witness=[0-9a-f]{32}$' /var/lib/provision-test/laneproof.created
  lane_witness="$(sed -n 's/^witness=//p' /var/lib/provision-test/laneproof.created)"
  test "$(getent passwd laneproof | cut -d: -f5)" = "service-user-witness=$lane_witness"
  echo "MARKER_SHAPE=$(stat -c %u:%g:%a /var/lib/provision-test/laneproof.created) witness-bound to the live account"
  if bash bootstrap/deprovision-service-user.sh /tmp/lane.conf >/tmp/default.out 2>&1; then exit 20; fi
  grep -Fq "without --delete-home" /tmp/default.out
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/lane.conf
  after="$(getent passwd laneproof || true)|$(test -e /home/laneproof && echo present || echo absent)"
  test "$before" = "$after"
  test ! -e /var/lib/systemd/linger/laneproof
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/lane.conf
  echo "BEFORE=$before"
  echo "AFTER=$after"

  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/lane.conf
  test "$(getent passwd laneproof | wc -l)" -eq 1
  test "$(loginctl show-user laneproof -p Linger --value)" = yes
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/lane.conf
  test ! -e /home/laneproof
  echo "REPROVISION=working account recreated and removed cleanly"

  cat > /tmp/partial.conf <<EOF
LANE_SERVICE_USER=partialproof
LANE_SERVICE_HOME=/home/partialproof
LANE_REPOSITORY_ROOT=/home/partialproof/repository
LANE_WORKTREES_ROOT=/home/partialproof/worktrees
EOF
  rm -f /tmp/partial.hang
  cat >/usr/local/bin/install <<'EOF'
#!/bin/bash
set -eu
/usr/bin/install "$@"
case " $* " in
  *" /home/partialproof "*) : >/tmp/partial.hang; while :; do sleep 1; done ;;
esac
EOF
  chmod 755 /usr/local/bin/install
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/partial.conf &
  partial_pid=$!
  # Wait for the directory install itself to hang, not merely for the marker to
  # appear: the marker is now written before the account exists, so polling on
  # it would kill the provisioner at an unpredictable point and silently stop
  # covering the post-marker interruption this case is about.
  for _ in $(seq 1 100); do
    test -f /tmp/partial.hang && break
    sleep 0.1
  done
  test -f /tmp/partial.hang
  test -f /var/lib/provision-test/partialproof.created
  grep -Fqx 'state=created' /var/lib/provision-test/partialproof.created
  kill -KILL "$partial_pid"
  wait "$partial_pid" 2>/dev/null || true
  rm -f /usr/local/bin/install
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/partial.conf
  ! getent passwd partialproof >/dev/null
  test ! -e /home/partialproof
  test ! -e /var/lib/systemd/linger/partialproof
  echo "PARTIAL_UNWIND=user, home, managed directories, marker, and linger absent"

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

  # The same account is not adoptable from the provisioning side either.
  if bash bootstrap/provision-service-user.sh /tmp/outsider.conf >/tmp/adopt-refusal.out 2>&1; then exit 24; fi
  grep -Fq "was not created by this provisioner" /tmp/adopt-refusal.out
  test ! -e /var/lib/provision-test/outsider.created
  echo "PROVISION_REFUSAL=$(cat /tmp/adopt-refusal.out)"

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

  # ── O1: a marker anyone can write is not an ownership guard ──────────────
  /usr/sbin/useradd --create-home forgeowner
  make_conf forgeowner
  make_marker forgeowner "$(id -u forgeowner)" forgeowner:forgeowner 0666 r1
  bash "$R1_DEPROVISION" --delete-home /tmp/forgeowner.conf >/tmp/o1-red.out 2>&1
  ! getent passwd forgeowner >/dev/null
  test ! -e /home/forgeowner
  echo "O1_RED_BEFORE=round-1 accepted a marker owned by forgeowner at mode 0666 and deleted the account: $(cat /tmp/o1-red.out)"

  /usr/sbin/useradd --create-home forgeowner
  forge_uid="$(id -u forgeowner)"
  make_marker forgeowner "$forge_uid" forgeowner:forgeowner 0600 v3
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/forgeowner.conf >/tmp/o1-owner.out 2>&1; then exit 30; fi
  grep -Fq "not owned by root" /tmp/o1-owner.out
  getent passwd forgeowner >/dev/null
  test -d /home/forgeowner
  echo "O1_WRONG_OWNER=$(cat /tmp/o1-owner.out)"

  make_marker forgeowner "$forge_uid" root:root 0666 v3
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/forgeowner.conf >/tmp/o1-mode.out 2>&1; then exit 31; fi
  grep -Fq "accessible to group or other" /tmp/o1-mode.out
  getent passwd forgeowner >/dev/null
  test -d /home/forgeowner
  echo "O1_WRONG_MODE=$(cat /tmp/o1-mode.out)"

  make_marker forgeowner "$forge_uid" "root:forgeowner" 0600 v3
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/forgeowner.conf >/tmp/o1-group.out 2>&1; then exit 32; fi
  grep -Fq "not group root" /tmp/o1-group.out
  getent passwd forgeowner >/dev/null
  echo "O1_WRONG_GROUP=$(cat /tmp/o1-group.out)"

  # A root-owned state directory that anyone may write is the same hole one
  # level up: the marker inside it can simply be replaced.
  make_marker forgeowner "$forge_uid" root:root 0600 v3
  chmod 0777 /var/lib/provision-test
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/forgeowner.conf >/tmp/o1-dir.out 2>&1; then exit 33; fi
  grep -Fq "writable by group or other" /tmp/o1-dir.out
  getent passwd forgeowner >/dev/null
  chmod 0700 /var/lib/provision-test
  echo "O1_WRITABLE_STATE_DIR=$(cat /tmp/o1-dir.out)"
  /usr/sbin/userdel --force --remove forgeowner
  rm -f /var/lib/provision-test/forgeowner.created

  # ── O2: a marker must authorise the account it was written for ───────────
  /usr/sbin/useradd --create-home --uid 2101 uidvictim
  make_conf uidvictim
  make_marker uidvictim 1999 root:root 0600 r1
  bash "$R1_DEPROVISION" --delete-home /tmp/uidvictim.conf >/tmp/o2-red.out 2>&1
  ! getent passwd uidvictim >/dev/null
  echo "O2_RED_BEFORE=round-1 marker carried no uid; the uid-2101 replacement of the name was deleted: $(cat /tmp/o2-red.out)"

  /usr/sbin/useradd --create-home --uid 2101 uidvictim
  make_marker uidvictim 1999 root:root 0600 v3
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/uidvictim.conf >/tmp/o2.out 2>&1; then exit 34; fi
  grep -Fq "written for uid 1999 but uidvictim is uid 2101" /tmp/o2.out
  getent passwd uidvictim >/dev/null
  test -d /home/uidvictim
  echo "O2_DIFFERENT_UID=$(cat /tmp/o2.out)"
  /usr/sbin/userdel --force --remove uidvictim
  rm -f /var/lib/provision-test/uidvictim.created

  # A marker written before uid binding existed cannot say which account it
  # meant, so it is refused until the operator explicitly binds it.
  /usr/sbin/useradd --create-home legacyproof
  make_conf legacyproof
  make_marker legacyproof 0 root:root 0600 r1
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/legacyproof.conf >/tmp/legacy.out 2>&1; then exit 35; fi
  grep -Fq "predates uid binding" /tmp/legacy.out
  getent passwd legacyproof >/dev/null
  bash bootstrap/provision-service-user.sh --adopt-legacy-marker /tmp/legacyproof.conf >/tmp/legacy-adopt.out 2>&1
  grep -Fqx "uid=$(id -u legacyproof)" /var/lib/provision-test/legacyproof.created
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/legacyproof.conf
  ! getent passwd legacyproof >/dev/null
  test ! -e /home/legacyproof
  echo "LEGACY_MARKER=refused until explicitly adopted, then reversible: $(cat /tmp/legacy.out)"

  # ── O3: --delete-home may not reach outside what was provisioned ─────────
  mkdir -p /tmp/outside-blast && : >/tmp/outside-blast/keepme
  /usr/sbin/useradd --create-home blastuser
  make_conf blastuser /tmp/outside-blast
  make_marker blastuser "$(id -u blastuser)" root:root 0666 r1 /tmp/outside-blast yes
  bash "$R1_DEPROVISION" --delete-home /tmp/blastuser.conf >/tmp/o3-red.out 2>&1
  test ! -e /tmp/outside-blast
  echo "O3_RED_BEFORE=round-1 deleted /tmp/outside-blast, outside the service home: $(cat /tmp/o3-red.out)"

  mkdir -p /tmp/outside-blast && : >/tmp/outside-blast/keepme
  /usr/sbin/useradd --create-home blastuser
  make_marker blastuser "$(id -u blastuser)" root:root 0600 v3 /tmp/outside-blast yes
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/blastuser.conf >/tmp/o3.out 2>&1; then exit 36; fi
  grep -Fq "must nest under the service home" /tmp/o3.out
  test -f /tmp/outside-blast/keepme
  getent passwd blastuser >/dev/null
  if bash bootstrap/provision-service-user.sh /tmp/blastuser.conf >/tmp/o3-prov.out 2>&1; then exit 37; fi
  grep -Fq "must nest under the service home" /tmp/o3-prov.out
  echo "O3_OUTSIDE_HOME=$(cat /tmp/o3.out)"
  /usr/sbin/userdel --force --remove blastuser
  rm -f /var/lib/provision-test/blastuser.created

  # The same containment has to survive the path being swapped after
  # provisioning, which is the form the attack takes once the marker itself
  # can no longer be forged.
  mkdir -p /tmp/outside-blast2 && : >/tmp/outside-blast2/keepme
  make_conf swapproof
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/swapproof.conf
  rmdir /home/swapproof/repository
  ln -s /tmp/outside-blast2 /home/swapproof/repository
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/swapproof.conf >/tmp/o3b.out 2>&1; then exit 38; fi
  grep -Fq "refusing to delete a symlink" /tmp/o3b.out
  test -f /tmp/outside-blast2/keepme
  getent passwd swapproof >/dev/null
  test -d /home/swapproof
  echo "O3_SYMLINK_SWAP=$(cat /tmp/o3b.out)"

  rm -f /home/swapproof/repository
  mkdir /home/swapproof/repository
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/swapproof.conf >/tmp/o3c.out 2>&1; then exit 39; fi
  grep -Fq "does not own" /tmp/o3c.out
  getent passwd swapproof >/dev/null
  test -d /home/swapproof/repository
  echo "O3_FOREIGN_OWNER=$(cat /tmp/o3c.out)"
  chown swapproof:swapproof /home/swapproof/repository
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/swapproof.conf
  ! getent passwd swapproof >/dev/null
  test ! -e /home/swapproof
  test -f /tmp/outside-blast2/keepme
  echo "O3_CONTAINED_TEARDOWN=service home removed, unrelated /tmp/outside-blast2 intact"

  # ── O4: the pre-marker window ────────────────────────────────────────────
  # Crash immediately after the account reaches the passwd database, which is
  # the exact instant round 1 had no record of it.
  cat >/usr/local/bin/useradd <<'EOF'
#!/bin/bash
set -eu
/usr/sbin/useradd "$@"
kill -KILL "$PPID"
EOF
  chmod 755 /usr/local/bin/useradd
  make_conf crashproof
  o4_red_rc=0
  PATH=/usr/bin:/bin bash "$R1_PROVISION" /tmp/crashproof.conf >/tmp/o4-red.out 2>&1 || o4_red_rc=$?
  getent passwd crashproof >/dev/null
  test ! -e /var/lib/provision-test/crashproof.created
  if bash "$R1_DEPROVISION" --delete-home /tmp/crashproof.conf >/tmp/o4-red2.out 2>&1; then exit 40; fi
  grep -Fq "creation marker missing" /tmp/o4-red2.out
  getent passwd crashproof >/dev/null
  echo "O4_RED_BEFORE=rc=$o4_red_rc account=present marker=absent rollback=refused: $(cat /tmp/o4-red2.out)"
  /usr/sbin/userdel --force --remove crashproof

  o4_rc=0
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/crashproof.conf >/tmp/o4.out 2>&1 || o4_rc=$?
  test "$o4_rc" -ne 0
  getent passwd crashproof >/dev/null
  grep -Fqx 'state=creating' /var/lib/provision-test/crashproof.created
  grep -Fqx "uid=$(id -u crashproof)" /var/lib/provision-test/crashproof.created
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/crashproof.conf
  ! getent passwd crashproof >/dev/null
  test ! -e /home/crashproof
  test ! -e /var/lib/provision-test/crashproof.created
  echo "O4_GREEN=rc=$o4_rc marker=state=creating with the reserved uid; account, home and marker removed"

  # Crash before useradd runs at all: the reservation is stale, no account was
  # created, and the rollback must clear the record without inventing one.
  cat >/usr/local/bin/useradd <<'EOF'
#!/bin/bash
set -eu
kill -KILL "$PPID"
EOF
  chmod 755 /usr/local/bin/useradd
  make_conf crashearly
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/crashearly.conf >/tmp/o4b.out 2>&1 || true
  ! getent passwd crashearly >/dev/null
  grep -Fqx 'state=creating' /var/lib/provision-test/crashearly.created
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/crashearly.conf
  test ! -e /var/lib/provision-test/crashearly.created
  ! getent passwd crashearly >/dev/null
  echo "O4_MARKER_ONLY=stale reservation cleared, no account created"
  rm -f /usr/local/bin/useradd

  # ── F1: a state=creating marker must not authorise deleting a stranger ────
  # The round-2 reviewer's exact T0-T4 sequence. Round 2 closed round 1's
  # pre-marker window by writing the marker BEFORE useradd — but every field
  # such a marker can hold is predicted, and allocate_uid predicts the UID by
  # mirroring useradd's own policy. So a stranger who later takes the name
  # lands on the reserved UID and the recorded home and satisfies every check.
  crash_before_useradd() {
    cat >/usr/local/bin/useradd <<'EOF'
#!/bin/bash
set -eu
kill -KILL "$PPID"
EOF
    chmod 755 /usr/local/bin/useradd
  }

  # T0: kill the provisioner in the window between the marker and useradd.
  crash_before_useradd
  make_conf strangervictim
  PATH=/usr/bin:/bin bash "$R2_PROVISION" /tmp/strangervictim.conf >/tmp/f1-red-t0.out 2>&1 || true
  rm -f /usr/local/bin/useradd
  ! getent passwd strangervictim >/dev/null
  grep -Fqx 'state=creating' /var/lib/provision-test/strangervictim.created
  echo "F1_RED_T0=$(tr '\n' ';' </var/lib/provision-test/strangervictim.created)"
  # T1: an unrelated admin creates their own account holding that name.
  /usr/sbin/useradd --create-home strangervictim
  : >/home/strangervictim/STRANGER_DATA
  echo "F1_RED_T1=$(getent passwd strangervictim)"
  # T2: the operator re-runs the provisioner, the natural recovery.
  bash "$R2_PROVISION" /tmp/strangervictim.conf >/tmp/f1-red-t2.out 2>&1
  grep -Fqx 'state=created' /var/lib/provision-test/strangervictim.created
  # T3: the tracked rollback, for a provisioning that never happened.
  bash "$R2_DEPROVISION" --delete-home /tmp/strangervictim.conf >/tmp/f1-red-t3.out 2>&1
  # T4: the stranger's account and data are gone.
  ! getent passwd strangervictim >/dev/null
  test ! -e /home/strangervictim/STRANGER_DATA
  echo "F1_RED_BEFORE=round-2 laundered creating->created ($(cat /tmp/f1-red-t2.out)) then deleted the stranger: $(cat /tmp/f1-red-t3.out) account=DELETED data=DESTROYED"

  # The same sequence at this SHA. The reservation now carries a witness that
  # only this provisioner's useradd could have stamped on the account, so a
  # stranger holding the name fails the one check that was ever an observation.
  crash_before_useradd
  make_conf strangerproof
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/strangerproof.conf >/tmp/f1-t0.out 2>&1 || true
  rm -f /usr/local/bin/useradd
  ! getent passwd strangerproof >/dev/null
  grep -Fqx 'state=creating' /var/lib/provision-test/strangerproof.created
  grep -Eq '^witness=[0-9a-f]{32}$' /var/lib/provision-test/strangerproof.created
  /usr/sbin/useradd --create-home strangerproof
  : >/home/strangerproof/STRANGER_DATA
  stranger_uid="$(id -u strangerproof)"
  # The prediction really did come true: the stranger holds the reserved UID.
  # That is the point — matching it proves nothing, and must no longer suffice.
  grep -Fqx "uid=$stranger_uid" /var/lib/provision-test/strangerproof.created
  echo "F1_PREDICTION_HELD=marker reserved uid $stranger_uid and the stranger's plain useradd landed on it"
  # T2 must refuse rather than launder the record.
  if bash bootstrap/provision-service-user.sh /tmp/strangerproof.conf >/tmp/f1-t2.out 2>&1; then exit 50; fi
  grep -Fq "does not carry the provisioning witness" /tmp/f1-t2.out
  grep -Fqx 'state=creating' /var/lib/provision-test/strangerproof.created
  echo "F1_NO_LAUNDERING=$(cat /tmp/f1-t2.out)"
  # T3 must refuse. Because T2 refused, the marker is still state=creating, so
  # this is also the reviewer's variant that skips the re-run entirely: the
  # rollback aimed straight at a stale reservation.
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/strangerproof.conf >/tmp/f1-t3.out 2>&1; then exit 51; fi
  grep -Fq "does not carry the provisioning witness" /tmp/f1-t3.out
  # T4: intact.
  getent passwd strangerproof >/dev/null
  test -f /home/strangerproof/STRANGER_DATA
  echo "F1_GREEN=stale reservation refused at both ends: $(cat /tmp/f1-t3.out)"
  echo "F1_T4=account=$(getent passwd strangerproof >/dev/null && echo present) data=$(test -f /home/strangerproof/STRANGER_DATA && echo intact)"

  # Silence is not an option for a stale reservation, so there is a named way
  # out that touches nothing but this provisioner's own record.
  bash bootstrap/deprovision-service-user.sh --forget-record /tmp/strangerproof.conf >/tmp/f1-forget.out 2>&1
  test ! -e /var/lib/provision-test/strangerproof.created
  getent passwd strangerproof >/dev/null
  test -f /home/strangerproof/STRANGER_DATA
  echo "F1_FORGET_RECORD=$(tr '\n' ';' </tmp/f1-forget.out)"
  /usr/sbin/userdel --force --remove strangerproof

  # ── F2: the default replacement case, which the round-2 lock missed ───────
  # Round 2's uid lock used an explicitly different UID (2101). With the
  # default allocation the replacement reuses the freed UID, and the binding
  # goes silent.
  make_conf uidrecycle
  PATH=/usr/bin:/bin bash "$R2_PROVISION" /tmp/uidrecycle.conf >/dev/null 2>&1
  recycle_uid="$(id -u uidrecycle)"
  /usr/sbin/userdel --force --remove uidrecycle
  /usr/sbin/useradd --create-home uidrecycle
  : >/home/uidrecycle/STRANGER_DATA
  test "$(id -u uidrecycle)" = "$recycle_uid"
  bash "$R2_DEPROVISION" --delete-home /tmp/uidrecycle.conf >/tmp/f2-red.out 2>&1
  ! getent passwd uidrecycle >/dev/null
  test ! -e /home/uidrecycle/STRANGER_DATA
  echo "F2_RED_BEFORE=round-2 uid $recycle_uid reused by the replacement; binding silent; account DELETED data DESTROYED: $(cat /tmp/f2-red.out)"

  make_conf uidproof
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/uidproof.conf >/dev/null 2>&1
  proof_uid="$(id -u uidproof)"
  /usr/sbin/userdel --force --remove uidproof
  /usr/sbin/useradd --create-home uidproof
  : >/home/uidproof/STRANGER_DATA
  test "$(id -u uidproof)" = "$proof_uid"
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/uidproof.conf >/tmp/f2.out 2>&1; then exit 52; fi
  grep -Fq "does not carry the provisioning witness" /tmp/f2.out
  getent passwd uidproof >/dev/null
  test -f /home/uidproof/STRANGER_DATA
  echo "F2_SAME_UID_REPLACEMENT=uid $proof_uid reused and still refused: $(cat /tmp/f2.out)"
  /usr/sbin/userdel --force --remove uidproof
  rm -f /var/lib/provision-test/uidproof.created

  # ── The fix must not be "refuse everything" ──────────────────────────────
  # A crash AFTER useradd is the case the reservation exists for. The witness
  # makes it decidable, so this one resumes with no operator flag at all.
  cat >/usr/local/bin/useradd <<'EOF'
#!/bin/bash
set -eu
/usr/sbin/useradd "$@"
kill -KILL "$PPID"
EOF
  chmod 755 /usr/local/bin/useradd
  make_conf resumeproof
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/resumeproof.conf >/tmp/resume0.out 2>&1 || true
  rm -f /usr/local/bin/useradd
  getent passwd resumeproof >/dev/null
  grep -Fqx 'state=creating' /var/lib/provision-test/resumeproof.created
  PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/resumeproof.conf >/tmp/resume1.out 2>&1
  grep -Fq "resumed an interrupted provisioning" /tmp/resume1.out
  grep -Fqx 'state=created' /var/lib/provision-test/resumeproof.created
  bash bootstrap/deprovision-service-user.sh --delete-home /tmp/resumeproof.conf
  ! getent passwd resumeproof >/dev/null
  test ! -e /home/resumeproof
  echo "RESUME_OBSERVED=crash after useradd still resumes unattended and rolls back: $(cat /tmp/resume1.out)"

  # ── A round-2 marker cannot authorise anything either ─────────────────────
  # Its binding is exactly the one F1 and F2 broke, so it is refused rather
  # than upgraded in place.
  /usr/sbin/useradd --create-home v2victim
  make_conf v2victim
  make_marker v2victim "$(id -u v2victim)" root:root 0600 v2
  if bash bootstrap/deprovision-service-user.sh --delete-home /tmp/v2victim.conf >/tmp/v2.out 2>&1; then exit 53; fi
  grep -Fq "predates witness binding" /tmp/v2.out
  getent passwd v2victim >/dev/null
  test -d /home/v2victim
  echo "V2_MARKER_REFUSED=$(cat /tmp/v2.out)"
  /usr/sbin/userdel --force --remove v2victim
  rm -f /var/lib/provision-test/v2victim.created

  # ── F3: the state-root trust check must precede the mutation it gates ─────
  mkdir -p /tmp/innocent
  chown root:root /tmp/innocent
  chmod 0755 /tmp/innocent
  ln -sfn /tmp/innocent /var/lib/rev-attack
  echo "F3_INNOCENT_BEFORE=$(stat -c %u:%g:%a /tmp/innocent)"
  if LANE_PROVISION_STATE_ROOT=/var/lib/rev-attack PATH=/usr/bin:/bin \
     bash "$R2_PROVISION" /tmp/lane.conf >/tmp/f3-red.out 2>&1; then exit 54; fi
  grep -Fq "not a real directory" /tmp/f3-red.out
  test "$(stat -c %u:%g:%a /tmp/innocent)" = 0:0:700
  echo "F3_RED_BEFORE=round-2 refused the symlinked state root but had already chmodded the target: $(stat -c %u:%g:%a /tmp/innocent)"
  chmod 0755 /tmp/innocent
  if LANE_PROVISION_STATE_ROOT=/var/lib/rev-attack PATH=/usr/bin:/bin \
     bash bootstrap/provision-service-user.sh /tmp/lane.conf >/tmp/f3.out 2>&1; then exit 55; fi
  grep -Fq "not a real directory" /tmp/f3.out
  test "$(stat -c %u:%g:%a /tmp/innocent)" = 0:0:755
  echo "F3_GREEN=refused before touching the target: $(stat -c %u:%g:%a /tmp/innocent) $(cat /tmp/f3.out)"
  rm -f /var/lib/rev-attack

  # The pinned pre-fix copies must stay unrunnable outside this container.
  if SERVICE_USER_TEST_ISOLATED=0 bash "$R1_DEPROVISION" --delete-home /tmp/lane.conf >/tmp/fixture-guard.out 2>&1; then exit 41; fi
  grep -Fq "refuses to run outside the disposable test container" /tmp/fixture-guard.out
  echo "FIXTURE_GUARD=$(cat /tmp/fixture-guard.out)"
  if SERVICE_USER_TEST_ISOLATED=0 bash "$R2_DEPROVISION" --delete-home /tmp/lane.conf >/tmp/fixture-guard2.out 2>&1; then exit 56; fi
  grep -Fq "pinned round-2 fixture refuses to run outside the disposable test container" /tmp/fixture-guard2.out
  echo "FIXTURE_GUARD_R2=$(cat /tmp/fixture-guard2.out)"

  mv /usr/sbin/useradd /usr/sbin/useradd.hidden
  if PATH=/usr/bin:/bin bash bootstrap/provision-service-user.sh /tmp/lane.conf >/tmp/missing.out 2>&1; then exit 22; fi
  grep -Fq "missing required binary: useradd" /tmp/missing.out
  ! grep -Fq "command not found" /tmp/missing.out
  echo "MISSING=$(cat /tmp/missing.out)"
cleanup
trap - EXIT
printf 'service-user container proof: PASS\n'
