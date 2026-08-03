#!/usr/bin/env bash
# docker/whisper-proof-run.sh — builds docker/whisper-proof.Dockerfile, runs
# tools/whisper/install.sh inside a container on that clean image, verifies
# the resulting whisper-cli independently ($WHISPER_BIN --version), proves a
# real transcription with real content via docker/whisper-proof-verify.ts,
# and ALWAYS tears the container down — including on failure. Nothing here
# touches this host: /opt/whisper.cpp on the host is untouched, and the
# container's own /opt/whisper.cpp dies with the container.
#
# Usage: bash docker/whisper-proof-run.sh
# Env:
#   WHISPER_PROOF_IMAGE   image tag to build/use (default bpa-whisper-proof:local)
#   WHISPER_PROOF_KEEP    set to 1 to skip teardown for debugging (default 0)
#
# Deliberately expensive — measured end-to-end (apt-get installing the whole
# build toolchain, a real whisper.cpp compile from source, a genuine
# 1,624,555,275-byte Hugging Face model download, checksum verify, and this
# row's own independent transcription proof): ~4m40s-5m15s wall time per
# run, entirely network- and compile-bound. NOT part of the default
# `bun test` sweep and NOT swept by gate/land-lib.sh's declared-check glob
# (that glob only matches *.test.{js,ts,...}; this file and
# docker/whisper-proof-verify.ts do not, and package.json's
# "test:whisper-proof" script is deliberately not named "test" or "lint",
# the only two script names that glob auto-runs). Running this on every
# landing across every lane in this repository would be a multi-minute,
# multi-gigabyte tax on unrelated work — an expensive check nobody could
# afford to run is exactly as bad as one nobody runs.
#
# How it still gets run, concretely, so it cannot silently rot:
#   1. On demand: `bun run test:whisper-proof` (or this script directly).
#   2. Required before landing any change to tools/whisper/install.sh,
#      daemon/transcribe.ts's whisper config surface, or the files under
#      docker/whisper-proof.* — a lane touching any of those cites this
#      script's output as evidence in its terminal report.
#   3. Already required, verbatim, by this sprint's own close condition
#      (instance/sprints/sprint-02-2026-08-03.md): `docker build -f
#      docker/whisper-proof.Dockerfile . && <run + teardown>; echo $?`.
#   4. Recommended follow-up, NOT done in this row on purpose: once
#      .github/workflows/ci.yml exists (sprint row S2-1, a concurrent Tier-A
#      row touching .github/ this same sprint), add a separate scheduled +
#      path-triggered workflow calling this script, so upstream drift (a
#      moved tag, a changed model checksum) is caught even when nobody
#      remembers to run it by hand. Deliberately not wired here to avoid
#      colliding with S2-1's exclusive .github/ scope this sprint.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${WHISPER_PROOF_IMAGE:-bpa-whisper-proof:local}"
keep="${WHISPER_PROOF_KEEP:-0}"

log() { printf '[whisper-proof-run] %s\n' "$*"; }
die() { printf '[whisper-proof-run] FAIL: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

log "building $image from docker/whisper-proof.Dockerfile"
docker build -f "$repo_root/docker/whisper-proof.Dockerfile" -t "$image" "$repo_root" \
  || die "docker build failed"

log "starting container from $image"
cid="$(docker run -d --rm "$image" sleep infinity)" \
  || die "docker run failed to start a container"
[[ -n "$cid" ]] || die "docker run produced no container id"
log "container id: $cid"

# Teardown MUST run on every exit path — success, a failing installer step,
# a failing verification step, or this script being killed by a signal —
# never only on the happy path. A `trap ... EXIT` fires regardless of how
# the script exits under `set -e` (an explicit `exit`, a failing command, or
# falling off the end), which is why teardown is registered here via trap
# and not appended as a final "&& cleanup" step anywhere below.
teardown() {
  local status=$?
  if [[ "$keep" == "1" ]]; then
    log "WHISPER_PROOF_KEEP=1 — leaving container $cid running for inspection"
    return "$status"
  fi
  log "tearing down container $cid"
  docker stop -t 5 "$cid" >/dev/null 2>&1 || true
  # --rm on the original `docker run -d --rm` already removes the container
  # once it stops; `docker rm -f` here is a belt-and-braces second attempt in
  # case stop alone did not trigger removal (e.g. the daemon was busy), so a
  # crashed teardown attempt still leaves nothing running.
  docker rm -f "$cid" >/dev/null 2>&1 || true
  return "$status"
}
trap teardown EXIT

whisper_bin="/opt/whisper.cpp/bin/whisper-cli"

log "running tools/whisper/install.sh inside the container (real apt-get branch, real build, real model download)"
# WHISPER_SKIP_MEDIUM=1: the primary model (ggml-large-v3-turbo, the one
# resolveWhisperConfig() actually uses) is still downloaded and
# checksum-verified for real; skipping the medium fallback only trims a
# second, redundant ~1.5 GB download that nothing below exercises. No other
# override — WHISPER_PREFIX is left at its default (/opt/whisper.cpp) on
# purpose, so this proves the real, unconfigured contract between
# install.sh and daemon/transcribe.ts's resolveWhisperConfig() default, not
# a path chosen to make the test convenient.
docker exec -e WHISPER_SKIP_MEDIUM=1 "$cid" bash /repo/tools/whisper/install.sh \
  || die "tools/whisper/install.sh failed inside the container"

log "independently verifying \$WHISPER_BIN --version (not install.sh's own self-report)"
# An explicit existence check first, kept separate from --version: a missing
# binary and a present-but-broken binary are different failures, and a
# checker that only ever tries to execute something can conflate "does not
# exist" with "exists but fails" in its diagnostics. Both still fail this
# script closed either way.
docker exec "$cid" test -x "$whisper_bin" \
  || die "$whisper_bin does not exist or is not executable after install.sh ran"
docker exec "$cid" "$whisper_bin" --version \
  || die "$whisper_bin --version exited non-zero"

log "running the independent, content-asserting transcription proof"
verify_output="$(mktemp "${TMPDIR:-/tmp}/whisper-proof-verify.XXXXXX")"
if ! docker exec "$cid" bun run /repo/docker/whisper-proof-verify.ts >"$verify_output" 2>&1; then
  cat "$verify_output" >&2
  rm -f "$verify_output"
  die "docker/whisper-proof-verify.ts failed — see output above"
fi
cat "$verify_output"
transcript="$(grep -m1 '^WHISPER_PROOF_TRANSCRIPT: ' "$verify_output" || true)"
rm -f "$verify_output"
[[ -n "$transcript" ]] \
  || die "verify script exited 0 but printed no WHISPER_PROOF_TRANSCRIPT line — treating as a failure, not a pass"

log "OK — $transcript"
log "OK — tools/whisper/install.sh proven end-to-end in a clean container"
