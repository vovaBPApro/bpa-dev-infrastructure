# Meteorite test — clean Ubuntu Docker rebuild

Date: 2026-07-31. Repository commit under test:
`288aeab99e5342727657d66db9cfd2f3eec7b75d`.

Verdict: **FAIL**. A clean machine can clone the repository, install Bun, run
the source test suites, and build a working Whisper stack. It cannot reproduce
the deployed control plane: the bootstrap reports success while skipping the
runtime dependencies and activation boundary, no portable orchestrator service
exists, the checked-in fleet launcher is an explicitly host-bound transcript,
and the host-supplied inventory is incomplete.

## Commands and observed output, in order

The container had no repository mount and no host files copied into it. It was
started with:

```text
$ docker run -d --name meteorite-test ubuntu:24.04 sleep infinity
63faad64432766db1469b1b52610261111c3bdee3eae69084e9fb479c92229b6

$ docker exec meteorite-test bash -lc 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates openssh-client tmux'
...
2 upgraded, 51 newly installed, 0 to remove and 12 not upgraded.
...
Processing triggers for ca-certificates (20260601~24.04.1) ...

$ docker exec meteorite-test bash -lc 'git clone https://github.com/vovaBPApro/bpa-dev-infrastructure.git /work/source'
Cloning into '/work/source'...

$ docker exec meteorite-test bash -lc 'cd /work/source; git rev-parse HEAD; git remote -v'
288aeab99e5342727657d66db9cfd2f3eec7b75d
origin  https://github.com/vovaBPApro/bpa-dev-infrastructure.git (fetch)
origin  https://github.com/vovaBPApro/bpa-dev-infrastructure.git (push)
```

I then ran the repository bootstrap from that remote clone, with no
`INSTALL_ROOT` override. The command exited zero:

```text
$ cd /work/source && bootstrap/install.sh --no-cron
...
bun was installed successfully to ~/.bun/bin/bun
...
Cloning into '/home/bpa-dev-infrastructure'...
{"missions":[],"lanes":[],"leases":[]}
Hygiene cron skipped: --no-cron.
...
152 pass
1 skip
0 fail
...
14 pass
0 fail
...
14 pass
0 fail
...
8 pass
0 fail
...
workspace tests: PASS
INSTALL GATE: PASS full sweep
User systemd is unavailable; units were rendered only. On a VM with a user session, run:
  systemctl --user daemon-reload
  systemctl --user enable --now bpa-telegram-daemon.service bpa-full-suite.timer orch-morning-report.timer
The watchdog timer stays INERT by ruling; arm it only deliberately with:
  bootstrap/install.sh --arm-watchdog
Activation skipped: no user-systemd session is available.
Bootstrap completed. Run '/work/source/bootstrap/install.sh --verify' after configuring the local token.
EXIT=0
```

The skipped daemon test was the real speech engine boundary:

```text
(skip) REAL-ENGINE TESTS SKIPPED: whisper binary missing: /opt/whisper.cpp/bin/whisper-cli — run tools/whisper/install.sh
```

The repository's verify command also exited zero while the runtime was not
available:

```text
$ cd /work/source && bootstrap/install.sh --verify
STATUS CHECK
------ ------------------------
PASS git
PASS curl
PASS tmux
PASS bun
PASS repository
PASS environment file
PASS environment permissions
SKIP linger                   loginctl command unavailable
PASS state-db
PASS workspace
SKIP hygiene-cron             disabled by --no-cron
PASS gate
SKIP stand                    docker command unavailable
SKIP token configured         token placeholder remains
PASS daemon unit
PASS watchdog service
PASS watchdog timer
PASS full-suite service
PASS full-suite timer
PASS morning service
PASS morning timer
PASS unit Exec paths
SKIP user systemd             no user-systemd session
SKIP daemon enabled           user-systemd unavailable
SKIP watchdog armed           user-systemd unavailable
SKIP full-suite enabled       user-systemd unavailable
SKIP morning enabled          user-systemd unavailable
EXIT=0
```

I checked the deployed-orchestrator boundary explicitly:

```text
$ find /home/bpa-dev-infrastructure/bootstrap/units -maxdepth 1 -type f -printf '%f\n' | sort
bpa-full-suite.service.in
bpa-full-suite.timer.in
bpa-orchestrator-watchdog.service.in
bpa-orchestrator-watchdog.timer.in
bpa-telegram-daemon.service.in
orch-morning-report.service.in
orch-morning-report.timer.in

$ test -f /home/bpa-dev-infrastructure/bootstrap/units/bpa-orchestrator.service.in
EXIT=1

$ test -f /etc/systemd/system/bpa-orchestrator.service
EXIT=1
```

The required external runtime and provider tools were absent after bootstrap:

```text
$ docker version
bash: line 1: docker: command not found
EXIT=127

$ codex login status
bash: line 1: codex: command not found
EXIT=127

$ claude --version
bash: line 1: claude: command not found
EXIT=127

$ test -x /opt/whisper.cpp/bin/whisper-cli
EXIT=1
```

The read-only status surface worked, but the first operational tick could not
authenticate. Notice that `watchdog.sh` nevertheless returned zero:

```text
$ cd /home/bpa-dev-infrastructure && orchestrator/status.sh
Fleet status

Missions / lanes / leases
counts     missions=0 lanes=0 leases=0
missions   SKIP no open missions
...
EXIT=0

$ cd /home/bpa-dev-infrastructure && orchestrator/watchdog.sh
refusing unproven subscription auth: /root/.codex/auth.json is missing; run 'codex login' and choose ChatGPT (subscription) login
EXIT=0
```

The morning check likewise declared bootstrap ready while all runtime boundaries
were skipped:

```text
$ cd /home/bpa-dev-infrastructure && orchestrator/morning.sh --dry-run
...
PASS — bootstrap verify (bootstrap/install.sh --verify)
...
SKIP — stand smoke (docker command unavailable)
SKIP — user systemd (no user-systemd session)
...
EXIT=0
```

I invoked the only checked-in wave entry point that includes the current
onboarding work. It is not runnable after the documented install:

```text
$ cd /home/bpa-dev-infrastructure && orchestrator/fleet/as-run-wave9.sh
orchestrator/fleet/as-run-wave9.sh: line 5: bun: command not found
EXIT=127
```

That script also fixes `REPO=/root/bpa-dev-infrastructure`,
`LANES=/root/.cache/infra-lanes`, named pre-existing worktrees, system units,
and `HOME=/root`; those resources do not exist in this rebuild and contradict
the bootstrap's `/home/bpa-dev-infrastructure` default.

Finally I followed the committed Whisper installer for real, skipping only the
documented optional fallback model to avoid an unrelated second model download:

```text
$ cd /home/bpa-dev-infrastructure && WHISPER_SKIP_MEDIUM=1 WHISPER_BUILD_JOBS=2 tools/whisper/install.sh
[whisper-install] installing missing deps via apt-get: cmake build-essential build-essential ffmpeg espeak-ng
...
353 newly installed, 2 upgraded, 0 to remove and 10 not upgraded.
...
[whisper-install] fetching https://github.com/ggml-org/whisper.cpp @ pinned commit f049fff95a089aa9969deb009cdd4892b3e74916 (tag v1.9.1)
[whisper-install] source verified at pinned commit f049fff95a089aa9969deb009cdd4892b3e74916
[whisper-install] building whisper-cli (2 jobs, static, Release)
...
[100%] Built target whisper-cli
[whisper-install] installed /opt/whisper.cpp/bin/whisper-cli (v1.9.1@f049fff95a089aa9969deb009cdd4892b3e74916)
[whisper-install] downloading ggml-large-v3-turbo.bin (~1.5 GB, this takes a while)
[whisper-install] installed /opt/whisper.cpp/models/ggml-large-v3-turbo.bin (sha256 verified)
[whisper-install] smoke transcription output:  Testing 1, 2, 3.
[whisper-install] OK — whisper stack is live at /opt/whisper.cpp
EXIT=0
```

This refutes Whisper as a missing mechanism: its committed installer works from
a clean clone. It is, however, omitted from `bootstrap/install.sh` and the main
migration sequence, so a survivor must discover and run it separately.

## Numbered gap list

1. **The bootstrap's success verdict is false-green at the deployment boundary.**
   It exits zero with Docker absent, token unconfigured, no systemd session, no
   enabled daemon, and no enabled timers. `morning.sh` then converts that into
   `PASS — bootstrap verify`. Fix `bootstrap/install.sh` so production verify
   has a fail-closed mode in which required runtime rows cannot be `SKIP`, and
   make `orchestrator/morning.sh` use that mode. Keep a separately named
   container/source-test mode for intentionally unsupported boundaries.

2. **The committed installer does not reproduce the deployed system-unit
   architecture.** It renders user units under root's user config and skips
   activation because there is no user bus, while the as-built host uses system
   units. Fix `bootstrap/install.sh`, add portable templates/install logic under
   `bootstrap/units/`, and reconcile the intended account/root in
   `instance/migration-day.md` and `instance/params.yaml`.

3. **There is no portable `bpa-orchestrator.service` template or install step.**
   Only `instance/as-built-units/bpa-orchestrator.service` records the live
   artifact; the fresh container had no orchestrator service at all. Add the
   desired template to `bootstrap/units/`, render/install it in
   `bootstrap/install.sh`, and verify its enablement and live status.

4. **The install-root/account contract is internally split.** Bootstrap and
   the migration runbook target `/home/bpa-dev-infrastructure` and a normal
   user. The deployed units and fleet scripts require
   `/root/bpa-dev-infrastructure`, `/root/.cache/infra-lanes`, and root system
   units. Fix the instance parameter/runbook/bootstrap inputs so one declared
   choice drives every rendered path; remove literal host paths from generic
   mechanisms.

5. **The lane fan-out mechanism is captured evidence, not a rebuildable fleet
   launcher.** `orchestrator/fleet/README.md` says “NOT yet productized”; the
   wave scripts require pre-existing named worktrees and historical branches,
   and the tested invocation failed before dispatch because Bun was unavailable
   on the non-interactive PATH. Replace the as-run waves with a parameterized,
   tested entry point that creates/reserves worktrees and lane resources from a
   mission description, resolves Bun explicitly, launches a disposable lane,
   and proves teardown on a clean target.

6. **Bun installation is not available to non-interactive fleet scripts by
   command name.** The installer puts Bun at `/root/.bun/bin/bun` and edits
   `.bashrc`; a later `bash -lc` still produced `bun: command not found`.
   Fleet code also constrains transient-unit PATH to
   `/usr/local/bin:/usr/bin:/bin`. Fix fleet/installation code to use the
   configured absolute `BUN_BIN` consistently (or install a versioned system
   executable) and add a fresh-shell regression check.

7. **Docker is documented but not bootstrapped or fail-closed.** The migration
   runbook asks the human to install it, while `bootstrap/install.sh --verify`
   merely skips the stand and exits zero. Add a pre-bootstrap/recovery script or
   make Docker a hard, verified prerequisite in `bootstrap/install.sh`; the
   production verification must execute a real stand rather than only
   `docker --version`.

8. **Codex and Claude are manual, interactive, and cannot be proven in Docker.**
   The runbook enumerates installer/login commands and availability checks, but
   neither CLI exists after bootstrap; consequently no lane can launch. Add a
   committed provider-CLI installation/preflight mechanism (version policy,
   executable checks, and explicit browser-login stop), then make onboarding
   resume with `codex login status`, `claude --version`, and
   `orchestrator/preflight-cli-auth.sh` evidence. Authentication itself remains
   a legitimate human-provisioned boundary.

9. **The host-supplied secret/config inventory is incomplete.** The Telegram
   token is documented at `/home/bpa-dev-infrastructure/.env` with mode `0600`
   and bootstrap verification. Codex and Claude credential paths are named in
   `orchestrator/runtime.env.example` and structurally checked by
   `preflight-cli-auth.sh`, but their required permissions are not enumerated.
   The known `access.json`, GCP/service-account key, and deployed
   `orchestrator/runtime.env` are not enumerated in the onboarding runbook with
   all four required fields (purpose, exact path, permissions, non-secret
   verification command). Add one explicit host-supplied-items table to
   `instance/migration-day.md` (or a linked instance onboarding document). Do
   not add values.

10. **Whisper is reproducible but not in the main rebuild path.** Its installer
    built, checksum-verified the model, and passed a real transcription smoke.
    Neither bootstrap nor the numbered migration sequence invokes it, and the
    main install gate accepts the missing real engine as a skipped test. Add the
    committed `tools/whisper/install.sh` step and its executable/model/smoke
    verification to `instance/migration-day.md`; make the configured production
    readiness check fail when voice transcription is required but absent.

11. **`watchdog.sh` masks an authentication refusal with exit zero.** The clean
    run printed a fail-closed refusal for missing Codex auth but returned `0`, so
    supervisors and onboarding smoke cannot distinguish an operating watchdog
    from one that did nothing. Fix `orchestrator/watchdog.sh` to propagate the
    failed preflight (or emit a separately machine-checked terminal status) and
    add a regression lock for missing subscription credentials.

12. **The checked-in rehearsal does not execute the survivor clone path it
    claims to prove.** `bootstrap/REHEARSAL.md` mounts a host-created repository
    clone at `/src`, then clones that mount. It also substitutes fake `codex`
    and `systemd-run`, and directly starts the daemon instead of proving the
    installed service. Fix the rehearsal to clone the actual remote or a bare
    mirror of it, label source-only simulation separately, and add a privileged
    VM/container phase that verifies the real service manager and provider
    preflight. This test showed the HTTPS remote is currently publicly
    cloneable, so no repository credential was needed for recovery at this SHA.

## How far the stack came up

The source checkout, Bun runtime, state database, daemon dependencies, unit/core/
gate/stand-structure/workspace tests, read-only status command, and Whisper
engine all worked. Rendered **user** unit files existed only in root's user
configuration directory. No service was activated; no Telegram daemon health
route was started; no orchestrator process or system service existed; Docker,
Codex, Claude, and their auth were absent; no lane launched. Therefore the
repository alone did **not** bring the control plane back.
