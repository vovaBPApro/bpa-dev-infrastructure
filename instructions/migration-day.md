# Migration day: VM wipe and re-initialization

This runbook is for a fresh Ubuntu 24.04 VM. Run it as the normal operator
account, not as root. The installed control plane lives at
`/home/bpa-dev-infrastructure`; do not choose another root unless the
bootstrap environment is deliberately overridden.

1. Before the wipe, keep only the following offline references. Do not commit
   any of them or put them in this repository.

   - Save `~/.ssh/id_ed25519` (and preferably its `.pub` file), or plan to add a new public key to GitHub.
   - Optionally save local `.env` files as offline reference only; never put them in git.
   - Optionally download Telegram history JSONLs.
   - Everything else is either recoverable (the BotFather token and provider-console access) or disposable (all pre-production databases).

2. On fresh Ubuntu, Docker is the only required runtime dependency that
   `bootstrap/install.sh` does not install. The bootstrap itself installs its
   missing `git`, `curl`, `tmux`, `envsubst`, `unzip`, `xz`, and `cron`
   packages using `sudo`. Install and enable Docker, then make the operator a
   member of the Docker group. Log out and back in before continuing so the
   group change is active.

   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"
   ```

   After the new login, verify the non-root Docker access:

   ```bash
   docker version
   ```

3. Restore GitHub SSH access. Restore the saved key with mode `0600`, or make
   a new key and add its public half to GitHub. Confirm the account prompt, then
   clone the repository at the bootstrap's canonical installation root.

   ```bash
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/id_ed25519
   ssh -T git@github.com
   git clone git@github.com:vovaBPApro/bpa-dev-infrastructure.git /home/bpa-dev-infrastructure
   cd /home/bpa-dev-infrastructure
   ```

4. Install both interactive coding CLIs and complete their browser logins; the
   OAuth state on the wiped VM no longer exists. These are the official Linux
   installer commands. Do not set API-key environment variables: the local
   runtime preflight rejects them.

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   curl -fsSL https://chatgpt.com/codex/install.sh | sh
   claude
   codex login
   ```

   Finish the interactive login in each command, then leave the CLI with its
   normal exit command and confirm both executables are available:

   ```bash
   claude --version
   codex login status
   ```

5. Run the bootstrap once to install Bun, create the local environment file,
   initialize state, install the test dependencies, render the units, and run
   its full install gate.

   ```bash
   cd /home/bpa-dev-infrastructure
   bootstrap/install.sh
   ```

   The successful install gate ends with `INSTALL GATE: PASS full sweep`. At
   this point the Telegram token is still a placeholder, so the daemon and
   watchdog are intentionally not enabled yet.

6. Configure Telegram in `/home/bpa-dev-infrastructure/.env`. This is the
   exact `EnvironmentFile` used by the rendered daemon, watchdog, and
   full-suite units. Replace the three values below in a local editor; keep the
   angle brackets out of the final values. `TELEGRAM_BOUND_CHAT_ID` is the
   daemon's single-chat allowlist (the legacy alias is `TELEGRAM_CHAT_ID`).

   ```dotenv
   TELEGRAM_BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
   TELEGRAM_BOUND_CHAT_ID=<TELEGRAM_CHAT_ID>
   INFRA_STATE_DB=/home/bpa-dev-infrastructure/runtime/state.db
   ```

   Lock down the file, rerun bootstrap so it activates the configured units,
   install the separately managed morning-report timer, and keep user services
   running after logout.

   ```bash
   chmod 600 /home/bpa-dev-infrastructure/.env
   cd /home/bpa-dev-infrastructure
   bootstrap/install.sh
   loginctl enable-linger "$USER"
   systemctl --user daemon-reload
   systemctl --user enable --now bpa-telegram-daemon.service bpa-orchestrator-watchdog.timer bpa-full-suite.timer
   orchestrator/install-morning-timer.sh install
   ```

   Current source limitation: the rendered
   `bpa-orchestrator-watchdog.service` runs
   `/home/bpa-dev-infrastructure/daemon/orchestrator-watchdog.sh`, but that
   file is not present; the real watchdog is
   `/home/bpa-dev-infrastructure/orchestrator/watchdog.sh`. Enabling the timer
   is an accurate bootstrap command, but its service will fail until that unit
   wiring is fixed in a normal mission. Use the direct watchdog tick below only
   as a diagnostic; do not mask the failed service.

7. Verify the install. The heading is `STATUS CHECK`; a healthy configured VM
   has `PASS` lines for `git`, `curl`, `tmux`, `bun`, `repository`,
   `environment file`, `environment permissions`, `state-db`, `workspace`,
   `gate`, all five rendered unit files, and the enabled daemon/watchdog/full
   suite. `stand` is also `PASS` when Docker is available. Treat any `FAIL` as
   a stop condition; `SKIP token configured` means the token is still a
   placeholder.

   ```bash
   cd /home/bpa-dev-infrastructure
   bootstrap/install.sh --verify
   ```

8. Run one smoke pass. `full-suite.sh` records red suites in its log and still
   completes its one-shot tick; inspect the final `FULL-SUITE` summary for
   `fail=0`. The morning dry run may print `SKIP FULL-SUITE summary log absent`
   before the one-shot suite has made its first summary.

   ```bash
   cd /home/bpa-dev-infrastructure
   orchestrator/status.sh
   orchestrator/watchdog.sh
   orchestrator/morning.sh --dry-run
   orchestrator/full-suite.sh
   tail -n 1 orchestrator/runtime/full-suite.log
   ```

9. Do the focused daemon restart-recovery spot check described by the
   rehearsal: kill the supervised daemon, wait for its health route to return,
   then start and inspect the tmux-hosted orchestrator. This mirrors the
   rehearsal's `kill -9` / health / `launch.sh start` sequence on a real VM.

   ```bash
   daemon_pid="$(systemctl --user show --property=MainPID --value bpa-telegram-daemon.service)"
   test "$daemon_pid" -gt 0
   kill -9 "$daemon_pid"
   for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:4822/health && break; sleep 1; done
   curl -fsS http://127.0.0.1:4822/health
   /home/bpa-dev-infrastructure/orchestrator/launch.sh start
   /home/bpa-dev-infrastructure/orchestrator/launch.sh status
   ```

   If the orchestrator was already running, `launch.sh start` correctly exits
   with `session already exists`; use `launch.sh status` as the proof instead.

10. Next phase: clone the three old product repositories alongside this one.
    Product-specific lessons are preserved in bpa-master at
    `docs/ops/PRODUCT_LESSONS_PRE_WIPE_2026-07-28.md` on the
    `rescue/vm-final-20260728` branch. Transfer functionality into the new
    repositories only through the normal mission/lane flow.
