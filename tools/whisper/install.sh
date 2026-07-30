#!/usr/bin/env bash
# tools/whisper/install.sh — idempotent HOST installer for the local
# speech-to-text stack (HR-146 §NI-3: Telegram voice → text, Ukrainian first,
# English required, Polish possible).
#
# What it installs (all HOST state, deliberately OUTSIDE the repo tree —
# the binary and the models are not repo content, only this installer and the
# TS integration in daemon/transcribe.ts live in git):
#
#   $PREFIX/bin/whisper-cli            statically linked whisper.cpp CLI
#   $PREFIX/models/ggml-large-v3-turbo.bin   primary model (multilingual)
#   $PREFIX/models/ggml-medium.bin           documented fallback model
#   $PREFIX/.version                   marker for idempotent rebuild skips
#
# Everything is checksum-verified and the script is safe to re-run: completed
# steps are detected and skipped. Run as root (or with a writable PREFIX).
#
# Env overrides:
#   WHISPER_PREFIX      install root            (default /opt/whisper.cpp)
#   WHISPER_VERSION     whisper.cpp git tag     (default v1.9.1)
#   WHISPER_BUILD_JOBS  parallel build jobs     (default nproc)
#   WHISPER_SKIP_MEDIUM set to 1 to skip the fallback model download
#   WHISPER_NO_APT      set to 1 to never run apt-get (fail instead)
set -euo pipefail

PREFIX="${WHISPER_PREFIX:-/opt/whisper.cpp}"
VERSION="${WHISPER_VERSION:-v1.9.1}"
JOBS="${WHISPER_BUILD_JOBS:-$(nproc)}"
REPO_URL="https://github.com/ggml-org/whisper.cpp"
HF_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Pinned model checksums (sha256, from the ggerganov/whisper.cpp HF repo file
# metadata, fetched 2026-07-30). A mismatch is a hard failure — never run an
# unverified model.
LARGE_V3_TURBO_SHA256="1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
MEDIUM_SHA256="6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"

log() { printf '[whisper-install] %s\n' "$*"; }
die() { printf '[whisper-install] FAIL: %s\n' "$*" >&2; exit 1; }

# ── 1. Dependencies ──────────────────────────────────────────────────────────
need_pkgs=()
command -v git >/dev/null || need_pkgs+=(git)
command -v cmake >/dev/null || need_pkgs+=(cmake)
command -v g++ >/dev/null || need_pkgs+=(build-essential)
command -v make >/dev/null || need_pkgs+=(build-essential)
command -v curl >/dev/null || need_pkgs+=(curl)
command -v sha256sum >/dev/null || need_pkgs+=(coreutils)
# ffmpeg converts Telegram .oga (opus) to the 16 kHz wav whisper needs.
command -v ffmpeg >/dev/null || need_pkgs+=(ffmpeg)
# espeak-ng generates the multilingual test fixtures for daemon/transcribe.test.ts.
command -v espeak-ng >/dev/null || need_pkgs+=(espeak-ng)

if ((${#need_pkgs[@]})); then
  if [[ "${WHISPER_NO_APT:-0}" == "1" ]]; then
    die "missing deps: ${need_pkgs[*]} (WHISPER_NO_APT=1, refusing apt-get)"
  fi
  log "installing missing deps via apt-get: ${need_pkgs[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${need_pkgs[@]}" \
    || die "apt-get install ${need_pkgs[*]} failed"
fi

# ── 2. Build whisper-cli (skipped when the pinned version is already there) ──
mkdir -p "$PREFIX/bin" "$PREFIX/models"

if [[ -x "$PREFIX/bin/whisper-cli" ]] \
  && [[ -f "$PREFIX/.version" ]] \
  && [[ "$(cat "$PREFIX/.version")" == "$VERSION" ]]; then
  log "whisper-cli $VERSION already installed at $PREFIX/bin/whisper-cli — skipping build"
else
  build_dir="$(mktemp -d /tmp/whisper-build.XXXXXX)"
  trap 'rm -rf "$build_dir"' EXIT
  log "cloning $REPO_URL @ $VERSION"
  git clone --depth 1 --branch "$VERSION" "$REPO_URL" "$build_dir/src" \
    || die "git clone failed"
  log "building whisper-cli ($JOBS jobs, static, Release)"
  cmake -S "$build_dir/src" -B "$build_dir/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    >/dev/null || die "cmake configure failed"
  cmake --build "$build_dir/build" -j "$JOBS" --target whisper-cli \
    || die "build failed"
  install -m 0755 "$build_dir/build/bin/whisper-cli" "$PREFIX/bin/whisper-cli"
  printf '%s\n' "$VERSION" >"$PREFIX/.version"
  rm -rf "$build_dir"
  trap - EXIT
  log "installed $PREFIX/bin/whisper-cli ($VERSION)"
fi

# ── 3. Models (checksum-verified, idempotent) ────────────────────────────────
fetch_model() {
  local name="$1" sha="$2" dest="$PREFIX/models/$1"
  if [[ -f "$dest" ]]; then
    local have
    have="$(sha256sum "$dest" | awk '{print $1}')"
    if [[ "$have" == "$sha" ]]; then
      log "model $name already present and verified — skipping download"
      return 0
    fi
    log "model $name exists but checksum mismatch — re-downloading"
    rm -f "$dest"
  fi
  log "downloading $name (~1.5 GB, this takes a while)"
  curl -fsSL --retry 3 -o "$dest.part" "$HF_BASE/$name" \
    || die "download of $name failed"
  local got
  got="$(sha256sum "$dest.part" | awk '{print $1}')"
  [[ "$got" == "$sha" ]] \
    || die "$name sha256 mismatch: got $got want $sha (refusing to install)"
  mv "$dest.part" "$dest"
  log "installed $dest (sha256 verified)"
}

fetch_model "ggml-large-v3-turbo.bin" "$LARGE_V3_TURBO_SHA256"
if [[ "${WHISPER_SKIP_MEDIUM:-0}" != "1" ]]; then
  fetch_model "ggml-medium.bin" "$MEDIUM_SHA256"
fi

# ── 4. Smoke transcription (fail-closed: installer only reports success when
#      a real end-to-end transcription ran) ──────────────────────────────────
smoke_dir="$(mktemp -d /tmp/whisper-smoke.XXXXXX)"
trap 'rm -rf "$smoke_dir"' EXIT
espeak-ng -v en "testing one two three" -w "$smoke_dir/raw.wav" 2>/dev/null \
  || die "espeak-ng fixture generation failed"
ffmpeg -y -loglevel error -i "$smoke_dir/raw.wav" -ar 16000 -ac 1 \
  "$smoke_dir/in16k.wav" || die "ffmpeg 16k conversion failed"
"$PREFIX/bin/whisper-cli" \
  -m "$PREFIX/models/ggml-large-v3-turbo.bin" \
  -f "$smoke_dir/in16k.wav" \
  -l auto -np -otxt -of "$smoke_dir/out" >/dev/null 2>&1 \
  || die "whisper-cli smoke transcription failed"
[[ -s "$smoke_dir/out.txt" ]] || die "smoke transcription produced no text"
log "smoke transcription output: $(tr -s ' \n' ' ' <"$smoke_dir/out.txt")"
log "OK — whisper stack is live at $PREFIX"
