#!/usr/bin/env bash
set -euo pipefail
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin"
cat >"$scratch/config" <<EOF
LANE_SERVICE_USER=fixture
LANE_SERVICE_HOME=$scratch/home
LANE_REPOSITORY_ROOT=$scratch/home/repo
LANE_WORKTREES_ROOT=$scratch/home/lanes
EOF
cat >"$scratch/bin/getent" <<EOF
#!/bin/sh
test "\$1" = passwd || exit 1
printf 'fixture:x:1234:1234::%s:/bin/bash\n' '$scratch/home'
EOF
cat >"$scratch/bin/install" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in -d) shift;; -m|-o|-g) shift 2;; *) mkdir -p "$1"; shift;; esac
done
EOF
cat >"$scratch/bin/id" <<'EOF'
#!/bin/sh
test "$1" = -gn && test "$2" = fixture
printf 'fixture-group\n'
EOF
cat >"$scratch/bin/loginctl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>'$scratch/loginctl.calls'
case "\$1" in show-user) printf 'yes\n';; esac
EOF
cat >"$scratch/bin/useradd" <<'EOF'
#!/bin/sh
exit 99
EOF
chmod +x "$scratch/bin/"*
PATH="$scratch/bin:$PATH" bash bootstrap/provision-service-user.sh "$scratch/config" >"$scratch/out"
grep -Fxq 'enable-linger fixture' "$scratch/loginctl.calls"
grep -Fq 'service user provisioned: fixture' "$scratch/out"
test -d "$scratch/home/repo"
test -d "$scratch/home/lanes"
printf 'service-user provisioning proof: PASS\n'
