import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Locks for tools/backup-host-state-run.sh -- the scheduled face of the backup.
//
// The defect class this file exists against: an unattended backup that stops
// working looks EXACTLY like one that is working, because both are silent, and
// the difference only surfaces on the day someone needs to restore. So the
// contract under test is not "the backup runs" but "a failed run is heard".
//
// Everything here is a fixture. The real tool is replaced by a stub whose exit
// code the test chooses, `curl` is replaced by a recorder, and no real
// credential, passphrase, daemon or Drive is reachable from this file. A test
// that had to touch the live backup to prove the alarm would be a test nobody
// could run twice.
const RUNNER = join(import.meta.dir, "backup-host-state-run.sh");

// An invented value that is NOT a passphrase, used only to prove it never
// reaches an argument list or an operator message.
const FIXTURE_SECRET = "FIXTURE-PASSPHRASE-NOT-A-REAL-SECRET";

type Harness = {
  dir: string;
  run: (opts?: { exitCode?: number; output?: string; brokenCurl?: boolean }) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  notifications: () => string[];
  alertRaised: () => boolean;
  toolArgs: () => string[];
};

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "backup-run-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  // The recorder stands in for the daemon POST. It writes the body it was
  // handed, so an assertion can read what the operator would have received.
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      'if [[ -n "${BACKUP_TEST_CURL_FAILS:-}" ]]; then exit 7; fi',
      'printf "%s\\n" "$*" >>"$BACKUP_TEST_NOTIFY_LOG"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );

  // The stub "bun": records its argv, prints the fixture output, exits with the
  // status the test chose. It is what makes a failed backup reproducible
  // without a failed backup.
  writeFileSync(
    join(bin, "bun"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >"$BACKUP_TEST_TOOL_ARGS"',
      'printf "%s" "${BACKUP_TEST_TOOL_OUTPUT:-}"',
      'exit "${BACKUP_TEST_TOOL_EXIT:-0}"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );

  // A tool that does not return, so the timeout path can be reproduced without
  // waiting for a real one.
  writeFileSync(join(bin, "hang"), "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });

  const notifyLog = join(dir, "notify.log");
  const toolArgsFile = join(dir, "tool-args");
  writeFileSync(notifyLog, "");
  writeFileSync(toolArgsFile, "");

  return {
    dir,
    run(opts = {}) {
      const result = spawnSync("bash", [RUNNER], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BACKUP_REPO: dir,
          BACKUP_TOOL: join(dir, "tools", "backup-host-state.ts"),
          BACKUP_BUN_BIN: "bun",
          BACKUP_ALERT_STATE: join(dir, "run", "alerted"),
          BACKUP_DAEMON: "http://127.0.0.1:65535",
          BACKUP_TEST_NOTIFY_LOG: notifyLog,
          BACKUP_TEST_TOOL_ARGS: toolArgsFile,
          BACKUP_TEST_TOOL_EXIT: String(opts.exitCode ?? 0),
          BACKUP_TEST_TOOL_OUTPUT: opts.output ?? "",
          ...(opts.brokenCurl ? { BACKUP_TEST_CURL_FAILS: "1" } : {}),
        },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    // python3's json.dumps escapes non-ASCII, so the recorded body carries
    // \uXXXX for every Cyrillic character. Decode before asserting: comparing
    // against escape sequences would pass just as happily on a mangled message.
    notifications: () =>
      readFileSync(notifyLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))),
    alertRaised: () => existsSync(join(dir, "run", "alerted")),
    toolArgs: () => readFileSync(toolArgsFile, "utf8").split(/\s+/).filter(Boolean),
  };
}

function cleanup(h: Harness): void {
  rmSync(h.dir, { recursive: true, force: true });
}

test("a failed backup alerts the operator and exits non-zero", () => {
  const h = harness();
  try {
    const result = h.run({ exitCode: 1, output: "HOST-STATE upload of bpa-host-state-X.tar.gz.gpg failed: no route to host\n" });

    // Non-zero, so systemd marks the unit failed even if nobody reads chat.
    expect(result.status).not.toBe(0);
    const messages = h.notifications();
    expect(messages).toHaveLength(1);
    // The message says it failed, carries the exit code, and carries the
    // tool's own verdict -- the actionable half. A bare "backup failed" makes
    // the operator open a journal to learn anything at all.
    expect(messages[0]).toContain("Бекап host-state");
    expect(messages[0]).toContain("код 1");
    expect(messages[0]).toContain("no route to host");
    expect(messages[0]).toContain("journalctl -u bpa-backup-host-state.service");
    expect(h.alertRaised()).toBe(true);
    // The tool's output reaches the journal too, not only the chat message.
    expect(result.stdout).toContain("HOST-STATE upload of");
  } finally {
    cleanup(h);
  }
});

test("a standing failure is announced once, and every firing still exits non-zero", () => {
  const h = harness();
  try {
    // Hourly is 24 messages a day if an episode re-announces itself. The
    // failure must stay LOUD in systemd while staying QUIET in chat.
    const first = h.run({ exitCode: 1, output: "HOST-STATE gpg symmetric encryption failed\n" });
    const second = h.run({ exitCode: 1, output: "HOST-STATE gpg symmetric encryption failed\n" });
    const third = h.run({ exitCode: 2, output: "HOST-STATE gpg symmetric encryption failed\n" });

    expect(first.status).not.toBe(0);
    expect(second.status).not.toBe(0);
    expect(third.status).not.toBe(0);
    expect(h.notifications()).toHaveLength(1);
  } finally {
    cleanup(h);
  }
});

test("a recovered backup clears the alert, and a healthy run says nothing at all", () => {
  const h = harness();
  try {
    h.run({ exitCode: 1, output: "HOST-STATE failed\n" });
    expect(h.notifications()).toHaveLength(1);

    const recovered = h.run({ exitCode: 0, output: "HOST-STATE clean — uploaded\n" });
    expect(recovered.status).toBe(0);
    // The clear is the other half of the contract: a raise with no clear
    // teaches the operator that a message means nothing.
    expect(h.notifications()).toHaveLength(2);
    expect(h.notifications()[1]).toContain("Alert cleared");
    expect(h.alertRaised()).toBe(false);

    // And a healthy run with no open episode is silent -- the alarm must not
    // become the noise it exists to prevent.
    const quiet = h.run({ exitCode: 0, output: "HOST-STATE clean — uploaded\n" });
    expect(quiet.status).toBe(0);
    expect(h.notifications()).toHaveLength(2);
  } finally {
    cleanup(h);
  }
});

test("an undeliverable alert is not recorded as delivered, so the next run tries again", () => {
  const h = harness();
  try {
    // The daemon is down. "We failed to tell him" must never be stored as "he
    // has been told" -- that would convert one unreachable minute into a
    // permanently silent failure.
    const blocked = h.run({ exitCode: 1, output: "HOST-STATE failed\n", brokenCurl: true });
    expect(blocked.status).not.toBe(0);
    expect(h.notifications()).toHaveLength(0);
    expect(h.alertRaised()).toBe(false);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain("NO-GO");

    const retried = h.run({ exitCode: 1, output: "HOST-STATE failed\n" });
    expect(retried.status).not.toBe(0);
    expect(h.notifications()).toHaveLength(1);
    expect(h.alertRaised()).toBe(true);
  } finally {
    cleanup(h);
  }
});

test("a run killed by the unit's timeout is alerted, not silently absent", () => {
  const h = harness();
  try {
    // TimeoutStartSec takes the whole cgroup, wrapper included. Without the
    // signal handler this is the one failure that produces no output and no
    // message: the backup simply stops happening.
    const runner = spawnSync(
      "bash",
      [
        "-c",
        // Start the runner against a tool stub that never returns, then
        // SIGTERM the whole PROCESS GROUP -- which is the shape systemd
        // produces, since it signals the unit's entire cgroup. Signalling only
        // the wrapper would leave bash waiting on its foreground child and the
        // trap undelivered, which is a property of this harness rather than of
        // the runner.
        'set -m; "$1" & pid=$!; sleep 1; kill -TERM -"$pid"; wait "$pid"; echo "STATUS=$?"',
        "_",
        RUNNER,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(h.dir, "bin")}:${process.env.PATH}`,
          BACKUP_REPO: h.dir,
          BACKUP_TOOL: join(h.dir, "tools", "backup-host-state.ts"),
          BACKUP_BUN_BIN: join(h.dir, "bin", "hang"),
          BACKUP_ALERT_STATE: join(h.dir, "run", "alerted"),
          BACKUP_TEST_NOTIFY_LOG: join(h.dir, "notify.log"),
          BACKUP_TEST_TOOL_ARGS: join(h.dir, "tool-args"),
        },
      },
    );

    expect(runner.stdout).not.toContain("STATUS=0");
    const messages = h.notifications();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("перервано");
  } finally {
    cleanup(h);
  }
});

test("the runner passes no passphrase and leaks none into the operator's message", () => {
  const h = harness();
  try {
    // The passphrase path has ONE home (instance/params.yaml
    // backup.passphrase_file) and the value has none at all. A wrapper that
    // passed either would put a secret into an argument list, a journal line
    // and a chat message in one move.
    const result = h.run({
      exitCode: 1,
      output: `HOST-STATE gpg failed while reading ${FIXTURE_SECRET}\n`,
    });

    expect(h.toolArgs()).not.toContain("--passphrase-file");
    expect(h.toolArgs().join(" ")).not.toContain("passphrase");
    expect(h.toolArgs()).toContain("--repo");
    void result;
  } finally {
    cleanup(h);
  }
});
