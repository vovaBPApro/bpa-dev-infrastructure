#!/usr/bin/env bash
# tools/whisper/install.sh — idempotent HOST installer for the local
# speech-to-text stack (HR-146 §NI-3: Telegram voice → text, Ukrainian first,
# English required, Polish possible). Raised directly by the operator
# (Telegram 1760): a rebuilt server must be able to transcribe voice messages
# without the Human noticing anything changed.
#
# CONTRACT WITH daemon/transcribe.ts — read together, keep the DEFAULTS
# byte-identical if either file moves:
#   daemon/transcribe.ts:resolveWhisperConfig() resolves, unless overridden
#   by its own ORCH_WHISPER_* env vars:
#     bin   = <ORCH_WHISPER_PREFIX>/bin/whisper-cli
#     model = <ORCH_WHISPER_PREFIX>/models/ggml-large-v3-turbo.bin
#     (ORCH_WHISPER_PREFIX defaults to /opt/whisper.cpp)
#   This installer's WHISPER_PREFIX also defaults to /opt/whisper.cpp and
#   installs to exactly $PREFIX/bin/whisper-cli and
#   $PREFIX/models/ggml-large-v3-turbo.bin. The two files use independent env
#   var families (installer: WHISPER_*, runtime: ORCH_WHISPER_*) so that
#   changing where THIS SCRIPT installs never silently changes what the
#   daemon reads, or vice versa — but the unconfigured DEFAULT on both sides
#   must keep pointing at the same path. If you change one default, change
#   the other in the same commit.
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
# Fail-closed by construction: every step is verified, never assumed —
#   - downloaded source is checked against a pinned commit SHA (not the
#     mutable tag) before every build;
#   - downloaded models are checked against a pinned sha256 before install;
#   - the installed binary must itself execute `--version` successfully
#     before the installer trusts it, whether just-built or found already
#     in place from a previous run;
#   - the run only reports OK after a real end-to-end smoke transcription
#     (espeak-ng → ffmpeg → whisper-cli) produces actual text.
# A command exiting 0 is never treated as proof of success by itself.
#
# Idempotent: safe to re-run. A previous successful run (matching version
# marker + a binary that still passes `--version` + models whose checksum
# still matches) is detected and its expensive steps (source fetch, build,
# ~1.5 GB model download) are skipped. A previous run left in a bad state
# (binary missing, corrupted, or checksum mismatch) is repaired, not trusted.
#
# Run as root (or with a writable PREFIX).
#
# Env overrides:
#   WHISPER_PREFIX        install root             (default /opt/whisper.cpp)
#   WHISPER_VERSION       whisper.cpp git tag       (default v1.9.1)
#   WHISPER_COMMIT        pinned source commit      (default: the v1.9.1 SHA
#                         below; REQUIRED when WHISPER_VERSION is overridden)
#   WHISPER_BUILD_JOBS    parallel build jobs       (default nproc)
#   WHISPER_SKIP_MEDIUM   set to 1 to skip the fallback model download
#   WHISPER_NO_APT        set to 1 to never run apt-get (fail instead)
#   WHISPER_HF_BASE       model download base URL   (default the pinned
#                         ggerganov/whisper.cpp Hugging Face repo; override
#                         is for tests/mirrors only, see WHISPER_*_SHA256)
#   WHISPER_LARGE_SHA256  sha256 pin, primary model  (default pinned value
#                         below; override requires the caller to supply the
#                         matching hash, same supply-chain shape as
#                         WHISPER_COMMIT — never trust an unpinned model)
#   WHISPER_MEDIUM_SHA256 sha256 pin, fallback model (default pinned value
#                         below; same override contract as above)
set -euo pipefail

PREFIX="${WHISPER_PREFIX:-/opt/whisper.cpp}"
VERSION="${WHISPER_VERSION:-v1.9.1}"
# Supply-chain pin: the exact commit the v1.9.1 release tag pointed at when
# this installer was written. Provenance (verified 2026-07-30, three ways):
#   (a) `git ls-remote https://github.com/ggml-org/whisper.cpp refs/tags/v1.9.1
#       'refs/tags/v1.9.1^{}'` → f049fff95a089aa9969deb009cdd4892b3e74916
#       (lightweight tag — the ref points straight at the commit);
#   (b) a fresh `git fetch origin <that SHA>` checks out a tree whose
#       CMakeLists.txt declares `project("whisper.cpp" VERSION 1.9.1)`;
#   (c) the whisper-cli binary built from that tree embeds "1.9.1" and
#       "f049fff" in its build info.
# The source below is fetched BY THIS SHA, not by the tag — git content
# addressing makes the SHA the identity of the code. A moved or deleted tag
# cannot substitute different code: on every invocation it trips the moved-tag
# check before install-state handling, and a fresh build also retains the
# post-checkout rev-parse check.
DEFAULT_COMMIT="f049fff95a089aa9969deb009cdd4892b3e74916"
COMMIT="${WHISPER_COMMIT:-}"
if [[ -z "$COMMIT" ]]; then
  [[ "$VERSION" == "v1.9.1" ]] || {
    printf '[whisper-install] FAIL: WHISPER_VERSION=%s overridden without WHISPER_COMMIT — refusing to build an unpinned ref\n' "$VERSION" >&2
    exit 1
  }
  COMMIT="$DEFAULT_COMMIT"
fi
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  printf '[whisper-install] FAIL: WHISPER_COMMIT must be a full 40-hex commit SHA (got: %s)\n' "$COMMIT" >&2
  exit 1
}
JOBS="${WHISPER_BUILD_JOBS:-$(nproc)}"
REPO_URL="https://github.com/ggml-org/whisper.cpp"
HF_BASE="${WHISPER_HF_BASE:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"

# Pinned model checksums (sha256, from the ggerganov/whisper.cpp HF repo file
# metadata, fetched 2026-07-30). A mismatch is a hard failure — never run an
# unverified model. Overridable only for tests/mirrors, and only together with
# WHISPER_HF_BASE — see the header comment.
LARGE_V3_TURBO_SHA256="${WHISPER_LARGE_SHA256:-1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69}"
MEDIUM_SHA256="${WHISPER_MEDIUM_SHA256:-6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208}"

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
# espeak-ng generates the multilingual test fixtures for daemon/transcribe.test.ts
# and for this installer's own end-of-run smoke test (step 5 below).
command -v espeak-ng >/dev/null || need_pkgs+=(espeak-ng)

if ((${#need_pkgs[@]})); then
  if [[ "${WHISPER_NO_APT:-0}" == "1" ]]; then
    die "missing deps: ${need_pkgs[*]} (WHISPER_NO_APT=1, refusing apt-get)"
  fi
  log "installing missing deps via apt-get: ${need_pkgs[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${need_pkgs[@]}" \
    || die "apt-get install ${need_pkgs[*]} failed"
fi

# ── 2. Verify release provenance on every invocation ─────────────────────────
# Query both the tag and its peeled form. git prints the peeled annotated-tag
# row last for these two patterns, while lightweight tags have only one row, so
# awk END preserves the required "prefer peeled commit" semantics.
tag_sha="$(git ls-remote "$REPO_URL" "refs/tags/$VERSION" "refs/tags/$VERSION^{}" | awk 'END{print $1}')"
[[ -n "$tag_sha" ]] || die "cannot resolve tag $VERSION on $REPO_URL"
[[ "$tag_sha" == "$COMMIT" ]] \
  || die "tag $VERSION moved: remote says $tag_sha, pinned $COMMIT — refusing to build"

# ── 3. Build whisper-cli (skipped only when the pinned version is already
#      installed AND the installed binary still proves itself alive) ────────
mkdir -p "$PREFIX/bin" "$PREFIX/models"

# The marker records tag AND commit: changing the pin (same tag) must trigger
# a rebuild, never a silent skip. Pre-pin installs recorded only "v1.9.1" and
# will rebuild once on the next run — the installed binary is then provably
# from the pinned commit.
MARKER="$VERSION@$COMMIT"
needs_build=1
if [[ -x "$PREFIX/bin/whisper-cli" ]] \
  && [[ -f "$PREFIX/.version" ]] \
  && [[ "$(cat "$PREFIX/.version")" == "$MARKER" ]]; then
  # A matching marker is only a claim. Never trust it without re-proving the
  # binary still executes — a truncated, corrupted, or platform-mismatched
  # file can stay `-x` and keep a stale marker forever otherwise.
  if "$PREFIX/bin/whisper-cli" --version >/dev/null 2>&1; then
    log "whisper-cli $MARKER already installed and verified ($PREFIX/bin/whisper-cli --version) — skipping build"
    needs_build=0
  else
    log "whisper-cli $MARKER marker present but the installed binary failed --version — rebuilding"
  fi
fi

if [[ "$needs_build" == "1" ]]; then
  build_dir="$(mktemp -d /tmp/whisper-build.XXXXXX)"
  trap 'rm -rf "$build_dir"' EXIT

  # Fetch BY the pinned SHA (not the tag) and verify the checkout matches it.
  log "fetching $REPO_URL @ pinned commit $COMMIT (tag $VERSION)"
  git init -q "$build_dir/src" || die "git init failed"
  git -C "$build_dir/src" remote add origin "$REPO_URL"
  git -C "$build_dir/src" fetch -q --depth 1 origin "$COMMIT" \
    || die "git fetch of pinned commit $COMMIT failed"
  git -C "$build_dir/src" checkout -q "$COMMIT" \
    || die "checkout of pinned commit $COMMIT failed"
  actual_sha="$(git -C "$build_dir/src" rev-parse HEAD)"
  [[ "$actual_sha" == "$COMMIT" ]] \
    || die "checked-out source is $actual_sha, pinned $COMMIT — refusing to build"
  log "source verified at pinned commit $COMMIT"

  log "building whisper-cli ($JOBS jobs, static, Release)"
  cmake -S "$build_dir/src" -B "$build_dir/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    >/dev/null || die "cmake configure failed"
  cmake --build "$build_dir/build" -j "$JOBS" --target whisper-cli \
    || die "build failed"
  [[ -x "$build_dir/build/bin/whisper-cli" ]] \
    || die "build reported success but $build_dir/build/bin/whisper-cli is missing or not executable"
  install -m 0755 "$build_dir/build/bin/whisper-cli" "$PREFIX/bin/whisper-cli"
  # Never trust a successful build/install command by itself: prove the
  # installed binary actually runs before writing the marker that future
  # invocations will rely on to skip the build.
  "$PREFIX/bin/whisper-cli" --version >/dev/null 2>&1 \
    || die "installed binary failed to execute: $PREFIX/bin/whisper-cli --version (build produced a broken binary)"
  printf '%s\n' "$MARKER" >"$PREFIX/.version"
  rm -rf "$build_dir"
  trap - EXIT
  log "installed and verified $PREFIX/bin/whisper-cli ($MARKER)"
fi

# ── 4. Models (checksum-verified, idempotent) ────────────────────────────────
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
  rm -f "$dest.part"
  if ! curl -fsSL --retry 3 -o "$dest.part" "$HF_BASE/$name"; then
    rm -f "$dest.part"
    die "download of $name failed"
  fi
  local got
  got="$(sha256sum "$dest.part" | awk '{print $1}')"
  if [[ "$got" != "$sha" ]]; then
    rm -f "$dest.part"
    die "$name sha256 mismatch: got $got want $sha (refusing to install)"
  fi
  mv "$dest.part" "$dest"
  log "installed $dest (sha256 verified)"
}

fetch_model "ggml-large-v3-turbo.bin" "$LARGE_V3_TURBO_SHA256"
if [[ "${WHISPER_SKIP_MEDIUM:-0}" != "1" ]]; then
  fetch_model "ggml-medium.bin" "$MEDIUM_SHA256"
fi

# ── 5. Smoke transcription (fail-closed: installer only reports success when
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
