# docker/whisper-proof.Dockerfile — clean-machine proof harness for
# tools/whisper/install.sh (sprint 02 row S2-2, closing V3-1.3's deferred
# container proof: a real Hugging Face model download with its checksum, a
# genuine non-stubbed transcription, and the apt-get dependency branch —
# none of which tools/whisper/install.test.ts can prove, by design: that
# suite stubs the build and redirects network I/O on purpose so it can run
# without a container. See docker/whisper-proof-run.sh for what actually
# builds this image, runs the installer inside it, and tears the container
# down.
#
# Deliberately NOT routed through bootstrap/install.sh — that is a separate
# sprint row (S2-3) with its own stub-fixture proof, and folding it in here
# would make this row untestable on its own.
#
# Base: oven/bun:1-debian — a Debian (trixie) base with bun preinstalled.
# bun is not a dependency of tools/whisper/install.sh itself; it is needed
# only so docker/whisper-proof-run.sh can exercise the REAL production
# integration point, daemon/transcribe.ts, from inside the same container,
# rather than re-implementing its whisper-cli invocation by hand.
FROM oven/bun:1-debian

# The only two things a genuinely freshly-imaged host would already carry
# that tools/whisper/install.sh's own apt-get branch depends on: a live
# package index, and TLS trust roots for the https:// fetches the installer
# makes itself (git ls-remote/fetch, curl). Proven by hand against this exact
# base image that both are required and absent: `apt-get install -y git`
# with no prior `apt-get update` fails closed with "E: Unable to locate
# package git". Do NOT `rm -rf /var/lib/apt/lists/*` afterwards the way a
# normal image-slimming RUN would — tools/whisper/install.sh's own apt-get
# branch runs later, at container-run time, and needs that same index still
# present; deleting it here would make the apt-get branch fail for a reason
# that has nothing to do with the installer.
#
# Everything else the installer needs — git, cmake, g++, make, curl,
# coreutils, ffmpeg, espeak-ng — is deliberately left ABSENT from this image
# so that tools/whisper/install.sh's own need_pkgs/apt-get install branch is
# the thing that installs them, and so this proof is void if that branch
# ever breaks.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /tmp/*

WORKDIR /repo

# Only the files this proof actually exercises: the installer under test,
# the runtime module it hands off to (daemon/transcribe.ts, whose
# resolveWhisperConfig() defaults this proof relies on matching the
# installer's own WHISPER_PREFIX default — see the contract comment at the
# top of install.sh), the independent verification script, and a package.json
# so bun resolves the repo root correctly. Nothing else from the repository
# is required inside the image.
COPY package.json package.json
COPY tools/whisper/install.sh tools/whisper/install.sh

# Tried and deliberately reverted: baking the model into this layer at build
# time with `bun -e 'await Bun.write(dest, (await fetch(url)))'` so repeated
# runs on the same machine would reuse Docker's build cache instead of
# re-fetching ~1.5 GB every time. Measured result: bun 1.3.14's fetch()
# resolves the response headers in under a second (status 200, correct
# content-length), but streaming that ~1.55 GB body into Bun.write() spins
# one CPU core at 100% and writes ZERO bytes for 15+ minutes — verified by
# `docker exec`-ing into the build container and finding no TCP connections
# open at all while the process burned CPU, and separately by running the
# same fetch+Bun.write in isolation and finding no output file after 15s.
# That is a real bug in this bun build on a large streamed response, not a
# slow-but-working transfer, so this Dockerfile does NOT attempt to cache
# the model — see docker/whisper-proof-run.sh's header and this row's report
# for the resulting default-bun-test-sweep / opt-in judgment instead. The
# real download-and-checksum path is still fully exercised, every run, by
# tools/whisper/install.sh itself via curl at container-run time (proven:
# see the report evidence for this row).
COPY daemon/transcribe.ts daemon/transcribe.ts
COPY docker/whisper-proof-verify.ts docker/whisper-proof-verify.ts

# No custom ENTRYPOINT/CMD: the base image's own entrypoint
# (/usr/local/bin/docker-entrypoint.sh) already execs whatever command the
# runner passes (`docker run ... sleep infinity`, `docker exec ... bash ...`)
# directly — proven by hand; overriding it to a bare ["bash"] here made
# `docker run image sleep infinity` invoke `bash sleep infinity` (bash
# trying to source a script file named "sleep") instead of running sleep,
# and the container exited immediately instead of staying up.
