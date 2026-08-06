import { expect, test } from "bun:test";
import { createVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ARCHIVE_RE,
  archiveName,
  archiveStamp,
  buildArchive,
  checkRows,
  LocalTransport,
  makeTransport,
  newestArchive,
  parseInventory,
  parseManifest,
  planRetention,
  readBackupParams,
  serializeManifest,
  signedAssertion,
  throwawayServiceAccountKey,
  UNENCRYPTED_WARNING,
  verifyArchive,
  type Row,
} from "./backup-host-state";

// Every fixture below is invented. No path here names a real credential and no
// content here resembles one: the whole point of the row is that a live secret
// must never reach git, a test fixture, or a log, so the suite is written so
// that a leak would have to be typed in deliberately.
const MARKER = "FIXTURE-CONTENT-NOT-A-SECRET";

const TOOL = join(import.meta.dir, "backup-host-state.ts");

type FixtureFile = { path: string; content: string; mode?: string; inBackup?: boolean; kind?: string };

const DEFAULT_FILES: FixtureFile[] = [
  { path: "/fixture/keys/deploy-key", content: `${MARKER}-deploy-key`, mode: "600" },
  { path: "/fixture/env/service.env", content: `${MARKER}-service-env`, mode: "600" },
  { path: "/fixture/state/state.db", content: `${MARKER}-state-db`, mode: "644" },
  { path: "/fixture/rendered/unit.service", content: `${MARKER}-rendered`, mode: "644", inBackup: false },
];

// A temp tree plus an inventory that describes it. `path` stays fixture-absolute
// so the --root seam is what maps it onto disk, which is the same code path the
// real run uses with root "/".
function fixture(options: { files?: FixtureFile[]; dirs?: { path: string; members: string[]; inBackup?: boolean }[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-state-fixture-"));
  const repo = mkdtempSync(join(tmpdir(), "host-state-repo-"));
  mkdirSync(join(repo, "instance"), { recursive: true });
  const lines: string[] = ["# fixture inventory"];

  for (const file of options.files ?? DEFAULT_FILES) {
    const onDisk = join(root, file.path);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, file.content, { mode: Number.parseInt(file.mode ?? "600", 8) });
    lines.push([
      file.path,
      file.kind ?? "fixture",
      "invented fixture row",
      file.mode ?? "600",
      `test -s ${onDisk}`,
      file.inBackup === false ? "no" : "yes",
    ].join("\t"));
  }
  for (const dir of options.dirs ?? []) {
    const onDisk = join(root, dir.path);
    mkdirSync(onDisk, { recursive: true });
    for (const member of dir.members) writeFileSync(join(onDisk, member), `${MARKER}-${member}`);
    lines.push([dir.path, "fixture-dir", "invented fixture directory", "700", `test -d ${onDisk}`, dir.inBackup === false ? "no" : "yes"].join("\t"));
  }

  writeFileSync(join(repo, "instance", "host-state.tsv"), lines.join("\n") + "\n");
  return { root, repo, inventory: join(repo, "instance", "host-state.tsv") };
}

function rowsOf(inventoryPath: string): Row[] {
  const { rows, errors } = parseInventory(readFileSync(inventoryPath, "utf8"));
  expect(errors).toEqual([]);
  return rows;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function runTool(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", TOOL, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// ── Inventory parsing ──────────────────────────────────────────────────────

test("a well-formed inventory parses and separates the in-backup set", () => {
  const { root, repo, inventory } = fixture();
  try {
    const rows = rowsOf(inventory);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.inBackup).map((row) => row.path)).toEqual([
      "/fixture/keys/deploy-key",
      "/fixture/env/service.env",
      "/fixture/state/state.db",
    ]);
  } finally {
    cleanup(root, repo);
  }
});

// Absence is open and unknown is a FAIL: each of these would otherwise be a
// silently skipped line, which is a credential silently not backed up.
test.each([
  ["wrong column count", "/a\tkind\twhat\t600\ttest -e /a", "expected 6 tab-separated columns"],
  ["empty cell", "/a\tkind\t\t600\ttest -e /a\tyes", "empty cell"],
  ["relative path", "a\tkind\twhat\t600\ttest -e a\tyes", "path must be absolute"],
  ["non-octal mode", "/a\tkind\twhat\trw-\ttest -e /a\tyes", "mode must be octal"],
  ["unknown in-backup value", "/a\tkind\twhat\t600\ttest -e /a\tmaybe", "in-backup must be yes or no"],
])("a malformed row is an error, not a skipped line: %s", (_name, line, expected) => {
  const { errors } = parseInventory(`# header\n${line}\n`);
  expect(errors.join("\n")).toContain(expected);
});

test("a duplicate path is refused", () => {
  const line = "/a\tkind\twhat\t600\ttest -e /a\tyes";
  const { errors } = parseInventory(`${line}\n${line}\n`);
  expect(errors.join("\n")).toContain("duplicate path /a");
});

test("an inventory with no rows is an error rather than an empty success", () => {
  const { rows, errors } = parseInventory("# only a comment\n\n");
  expect(rows).toHaveLength(0);
  expect(errors.join("\n")).toContain("enumerates nothing");
});

// ── The tracked inventory itself ───────────────────────────────────────────

test("the repository's own instance/host-state.tsv is well-formed", () => {
  const tracked = join(import.meta.dir, "..", "instance", "host-state.tsv");
  const { rows, errors } = parseInventory(readFileSync(tracked, "utf8"));
  expect(errors).toEqual([]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((row) => row.inBackup)).toBe(true);
  // Cutover gate F reads the same file and requires at least three non-empty
  // columns per row; this pins that contract from our side too.
  for (const line of readFileSync(tracked, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
    const cells = line.split("\t");
    expect(cells.length).toBeGreaterThanOrEqual(3);
    expect(cells.every((cell) => cell.trim().length > 0)).toBe(true);
  }
});

// ── Row verification (--check, the executable half of gate F) ──────────────

test("checkRows runs each row's own command and reports the failing one", () => {
  const { root, repo, inventory } = fixture();
  try {
    const rows = rowsOf(inventory);
    expect(checkRows(rows).every((result) => result.ok)).toBe(true);

    rmSync(join(root, "/fixture/state/state.db"));
    const afterLoss = checkRows(rows);
    expect(afterLoss.filter((result) => !result.ok).map((result) => result.row.path)).toEqual(["/fixture/state/state.db"]);
  } finally {
    cleanup(root, repo);
  }
});

// ── Retention ──────────────────────────────────────────────────────────────

function names(count: number, encrypted = false): string[] {
  return Array.from({ length: count }, (_, i) => archiveName(`202608${String(10 + i).padStart(2, "0")}T000000Z`, encrypted));
}

test("retention keeps the newest N and deletes exactly the rest", () => {
  const doomed = planRetention(names(12), 10);
  // Returned newest-first, so the two oldest are the tail of the sort.
  expect(doomed).toEqual([
    "bpa-host-state-20260811T000000Z.tar.gz",
    "bpa-host-state-20260810T000000Z.tar.gz",
  ]);
});

test("retention deletes nothing while at or under the keep count", () => {
  expect(planRetention(names(10), 10)).toEqual([]);
  expect(planRetention(names(3), 10)).toEqual([]);
  expect(planRetention([], 10)).toEqual([]);
});

// The retention rule is a delete loop pointed at the operator's Drive. Anything
// it cannot recognise as its own output must be untouchable, or a retention pass
// becomes a destructive cleanup without an exact target.
test("retention never proposes deleting a file this tool did not write", () => {
  const foreign = ["notes.md", "bpa-host-state-latest.tar.gz", "bpa-host-state-2026-08-10.tar.gz", "backup.tar.gz"];
  expect(planRetention([...foreign, ...names(12)], 1)).toEqual(
    names(12).slice(0, 11).sort((a, b) => (a < b ? 1 : -1)),
  );
  for (const name of foreign) expect(ARCHIVE_RE.test(name)).toBe(false);
});

test("encrypted and plain archives age on one timeline", () => {
  const mixed = [...names(6), ...names(6, true).slice(3)];
  const doomed = planRetention(mixed, 4);
  expect(doomed).toHaveLength(mixed.length - 4);
  expect(newestArchive(mixed)).toBe("bpa-host-state-20260815T000000Z.tar.gz.gpg");
});

test("a keep count below one is refused rather than deleting everything", () => {
  expect(() => planRetention(names(3), 0)).toThrow("--keep must be a positive integer");
  expect(() => planRetention(names(3), -1)).toThrow("--keep must be a positive integer");
});

test("the stamp is sortable and matches the name pattern the tool searches for", () => {
  const stamp = archiveStamp(new Date("2026-08-06T09:04:05.123Z"));
  expect(stamp).toBe("20260806T090405Z");
  expect(ARCHIVE_RE.test(archiveName(stamp, false))).toBe(true);
  expect(ARCHIVE_RE.test(archiveName(stamp, true))).toBe(true);
});

// ── Build and restore ──────────────────────────────────────────────────────

function build(root: string, rows: Row[], passphraseFile?: string) {
  const stagingDir = mkdtempSync(join(tmpdir(), "host-state-stage-"));
  const outDir = mkdtempSync(join(tmpdir(), "host-state-out-"));
  const built = buildArchive(rows, { root, stagingDir, outDir, stamp: "20260806T090000Z", passphraseFile });
  return { built, stagingDir, outDir };
}

test("an archive round-trips: every in-backup row restores at its recorded size", () => {
  const { root, repo, inventory } = fixture({ dirs: [{ path: "/fixture/evidence", members: ["one.md", "two.md"] }] });
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    expect(built.entries.map((entry) => entry.path)).toEqual([
      "/fixture/keys/deploy-key",
      "/fixture/env/service.env",
      "/fixture/state/state.db",
      "/fixture/evidence",
    ]);
    expect(built.entries.find((entry) => entry.path === "/fixture/evidence")).toMatchObject({ files: 2 });
    expect(built.encrypted).toBe(false);
    expect(verifyArchive(built.archivePath, { workDir })).toEqual([]);
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

test("a row marked in-backup: no stays out of the archive", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  try {
    expect(built.entries.map((entry) => entry.path)).not.toContain("/fixture/rendered/unit.service");
  } finally {
    cleanup(root, repo, stagingDir, outDir);
  }
});

// Half a backup is worse than none: it costs the same, it reports success, and
// it is discovered by the restore nobody gets to retry.
test("a missing or empty in-backup source aborts the whole archive", () => {
  const { root, repo, inventory } = fixture();
  try {
    const rows = rowsOf(inventory);
    rmSync(join(root, "/fixture/env/service.env"));
    expect(() => build(root, rows)).toThrow("missing source for in-backup row: /fixture/env/service.env");

    writeFileSync(join(root, "/fixture/env/service.env"), "");
    expect(() => build(root, rows)).toThrow("empty source for in-backup row: /fixture/env/service.env");
  } finally {
    cleanup(root, repo);
  }
});

test("verify refuses to unpack into a directory that already holds files", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    writeFileSync(join(workDir, "left-over.txt"), "from a previous restore");
    expect(verifyArchive(built.archivePath, { workDir }).join("\n")).toContain("work directory is not empty");
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

// The three ways an archive can lie about itself. Each is produced by rebuilding
// the tar from a tampered staging tree, so the archive really does carry the
// defect rather than the verifier being told about it.
function repack(archivePath: string, mutate: (unpackedDir: string) => void): string {
  const scratch = mkdtempSync(join(tmpdir(), "host-state-repack-"));
  Bun.spawnSync(["tar", "-xzf", archivePath, "-C", scratch]);
  mutate(scratch);
  const repacked = join(scratch, "repacked.tar.gz");
  Bun.spawnSync(["tar", "-czf", repacked, "-C", scratch, "manifest.tsv", "files"]);
  return repacked;
}

test("verify catches an entry that vanished from the archive", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    const tampered = repack(built.archivePath, (dir) => rmSync(join(dir, "files/fixture/env/service.env")));
    expect(verifyArchive(tampered, { workDir }).join("\n")).toContain("missing from archive: /fixture/env/service.env");
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

test("verify catches an entry that arrived empty", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    const tampered = repack(built.archivePath, (dir) => writeFileSync(join(dir, "files/fixture/state/state.db"), ""));
    expect(verifyArchive(tampered, { workDir }).join("\n")).toContain("restored empty: /fixture/state/state.db");
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

test("verify catches an entry that arrived truncated", () => {
  const { root, repo, inventory } = fixture({ dirs: [{ path: "/fixture/evidence", members: ["one.md", "two.md"] }] });
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    const tampered = repack(built.archivePath, (dir) => rmSync(join(dir, "files/fixture/evidence/two.md")));
    expect(verifyArchive(tampered, { workDir }).join("\n")).toContain("restored short: /fixture/evidence");
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

test("an archive with no manifest cannot be verified into a pass", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    const tampered = repack(built.archivePath, (dir) => rmSync(join(dir, "manifest.tsv")));
    expect(verifyArchive(tampered, { workDir }).join("\n")).toContain("carries no manifest.tsv");
  } finally {
    cleanup(root, repo, stagingDir, outDir, workDir);
  }
});

test("a manifest round-trips through its own serializer", () => {
  const entries = [{ path: "/a", kind: "k", entry: "a", bytes: 12, files: 1 }];
  expect(parseManifest(serializeManifest(entries))).toEqual(entries);
});

// ── Encryption ─────────────────────────────────────────────────────────────

test("an encrypted archive restores with the passphrase and is refused without it", () => {
  const { root, repo, inventory } = fixture();
  const passphraseFile = join(repo, "passphrase");
  writeFileSync(passphraseFile, "fixture-passphrase-not-a-real-secret\n", { mode: 0o600 });
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory), passphraseFile);
  const withKey = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  const withoutKey = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    expect(built.name.endsWith(".tar.gz.gpg")).toBe(true);
    expect(built.encrypted).toBe(true);
    // The plaintext tarball must not survive beside the encrypted one.
    expect(readdirSync(outDir)).toEqual([built.name]);
    expect(verifyArchive(built.archivePath, { workDir: withKey, passphraseFile })).toEqual([]);
    expect(verifyArchive(built.archivePath, { workDir: withoutKey }).join("\n")).toContain("no --passphrase-file");
  } finally {
    cleanup(root, repo, stagingDir, outDir, withKey, withoutKey);
  }
});

// ── Transports ─────────────────────────────────────────────────────────────

test("LocalTransport uploads, lists, downloads and removes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  const source = mkdtempSync(join(tmpdir(), "host-state-src-"));
  try {
    const local = join(source, "payload.tar.gz");
    writeFileSync(local, MARKER);
    const transport = new LocalTransport(join(dir, "remote"));
    const uploaded = await transport.upload(local, "bpa-host-state-20260806T090000Z.tar.gz");
    expect((await transport.list()).map((file) => file.name)).toEqual([uploaded.name]);

    const back = join(source, "roundtrip.tar.gz");
    await transport.download(uploaded, back);
    expect(readFileSync(back, "utf8")).toBe(MARKER);

    await transport.remove(uploaded);
    expect(await transport.list()).toEqual([]);
  } finally {
    cleanup(dir, source);
  }
});

test("makeTransport refuses an unrecognised destination and a Drive one with no key", () => {
  expect(() => makeTransport("s3://bucket", {})).toThrow("unrecognised --dest");
  expect(() => makeTransport("local:", {})).toThrow("requires a directory");
  expect(() => makeTransport("drive:folder", {})).toThrow("no backup.service_account_key");
  expect(makeTransport("drive:folder", { serviceAccountKey: "/nowhere/key.json" }).describe()).toBe("drive:folder");
});

test("the Drive assertion is a real RS256 JWT over the claim it says it is", () => {
  const key = throwawayServiceAccountKey("fixture@example.invalid");
  const assertion = signedAssertion(key, "https://www.googleapis.com/auth/drive", 1_754_400_000);
  const [header, claim, signature] = assertion.split(".");
  expect([header, claim, signature].every((part) => part && /^[A-Za-z0-9_-]+$/.test(part))).toBe(true);

  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
  expect(decode(claim)).toEqual({
    iss: "fixture@example.invalid",
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_754_400_000,
    exp: 1_754_403_600,
  });
  const verifier = createVerify("RSA-SHA256").update(`${header}.${claim}`);
  expect(verifier.verify(key.private_key, Buffer.from(signature!, "base64url"))).toBe(true);
});

// ── Instance parameters ────────────────────────────────────────────────────

test("readBackupParams reads the backup block and stops at the next top-level key", () => {
  const repo = mkdtempSync(join(tmpdir(), "host-state-params-"));
  mkdirSync(join(repo, "instance"), { recursive: true });
  writeFileSync(
    join(repo, "instance", "params.yaml"),
    "db:\n  legacy_carry_over: none\n\nbackup:\n  drive_folder_id: FOLDER\n  service_account_key: /k.json\n  keep: 7\n\nfleet:\n  keep: 99\n",
  );
  try {
    expect(readBackupParams(repo)).toEqual({ driveFolderId: "FOLDER", serviceAccountKey: "/k.json", keep: 7 });
  } finally {
    cleanup(repo);
  }
});

test("the repository's own params.yaml names a Drive folder and a key path", () => {
  const params = readBackupParams(join(import.meta.dir, ".."));
  expect(params.driveFolderId).toBeTruthy();
  expect(params.serviceAccountKey?.startsWith("/")).toBe(true);
  expect(params.keep).toBe(10);
});

// ── The CLI, end to end, over LocalTransport ───────────────────────────────

test("--check reports clean on a satisfied inventory and fails on a lost path", () => {
  const { root, repo, inventory } = fixture();
  try {
    const clean = runTool(["--repo", repo, "--check"]);
    expect(clean.stdout).toContain("HOST-STATE clean");
    expect(clean.code).toBe(0);

    rmSync(join(root, "/fixture/keys/deploy-key"));
    const broken = runTool(["--repo", repo, "--check"]);
    expect(broken.stdout).toContain("FAIL /fixture/keys/deploy-key");
    expect(broken.stdout).toContain("1 of 4 row(s) failed verification");
    expect(broken.code).toBe(1);
  } finally {
    cleanup(root, repo);
    void inventory;
  }
});

test("a backup uploads, then --verify proves the uploaded archive restores", async () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const backup = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]);
    expect(backup.code).toBe(0);
    expect(backup.stdout).toContain("HOST-STATE clean");
    const uploaded = readdirSync(dest);
    expect(uploaded).toHaveLength(1);
    expect(ARCHIVE_RE.test(uploaded[0]!)).toBe(true);

    const verify = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify"]);
    expect(verify.stdout).toContain("restored intact");
    expect(verify.code).toBe(0);
  } finally {
    cleanup(root, repo, dest);
  }
});

test("--verify fails when the newest archive is corrupt, instead of trusting the upload", () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    expect(runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]).code).toBe(0);
    const archive = join(dest, readdirSync(dest)[0]!);
    writeFileSync(archive, "not a gzip stream at all");

    const verify = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify"]);
    expect(verify.stdout + verify.stderr).toContain("NO-GO");
    expect(verify.code).toBe(1);
  } finally {
    cleanup(root, repo, dest);
  }
});

test("--verify on an empty destination is a failure, not a vacuous pass", () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const verify = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify"]);
    expect(verify.stderr).toContain("no archive to verify");
    expect(verify.code).toBe(1);
  } finally {
    cleanup(root, repo, dest);
  }
});

test("repeated backups are pruned to --keep, newest kept", async () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    // Five archives named as five different days; only the tool's own retention
    // decides which survive.
    const transport = new LocalTransport(dest);
    const scratch = join(root, "payload.tar.gz");
    writeFileSync(scratch, MARKER);
    for (const day of ["01", "02", "03", "04"]) {
      await transport.upload(scratch, archiveName(`202608${day}T000000Z`, false));
    }
    const backup = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--keep", "3"]);
    expect(backup.code).toBe(0);
    expect(backup.stdout).toContain("retention: removed bpa-host-state-20260801T000000Z.tar.gz");

    const survivors = readdirSync(dest).sort();
    expect(survivors).toHaveLength(3);
    expect(survivors).not.toContain("bpa-host-state-20260801T000000Z.tar.gz");
    expect(survivors).not.toContain("bpa-host-state-20260802T000000Z.tar.gz");
    expect(survivors).toContain("bpa-host-state-20260804T000000Z.tar.gz");
  } finally {
    cleanup(root, repo, dest);
  }
});

test("--dry-run builds and reports but uploads and deletes nothing", () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const result = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([]);
  } finally {
    cleanup(root, repo, dest);
  }
});

// «щоб ми не мучились» — the default is plain, so the default must announce
// itself every single time rather than being a footnote in a document.
test("an unencrypted run warns loudly, and an encrypted one does not", () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  const passphraseFile = join(repo, "passphrase");
  writeFileSync(passphraseFile, "fixture-passphrase-not-a-real-secret\n", { mode: 0o600 });
  try {
    const plain = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]);
    expect(plain.stderr).toContain(UNENCRYPTED_WARNING);
    expect(UNENCRYPTED_WARNING).toContain("UNENCRYPTED");

    const encrypted = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--passphrase-file", passphraseFile]);
    expect(encrypted.code).toBe(0);
    expect(encrypted.stderr).not.toContain(UNENCRYPTED_WARNING);
    expect(readdirSync(dest).some((name) => name.endsWith(".gpg"))).toBe(true);
  } finally {
    cleanup(root, repo, dest);
  }
});

// Hard Floor 4 from the other direction: the mechanism must not become the leak.
test("neither the manifest nor the tool's output ever carries file content", () => {
  const { root, repo } = fixture();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    const backup = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]);
    expect(backup.stdout + backup.stderr).not.toContain(MARKER);

    const verify = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify"]);
    expect(verify.stdout + verify.stderr).not.toContain(MARKER);

    // And inside the archive: the manifest names paths and sizes only.
    const archive = join(dest, readdirSync(dest)[0]!);
    Bun.spawnSync(["tar", "-xzf", archive, "-C", workDir]);
    const manifest = readFileSync(join(workDir, "manifest.tsv"), "utf8");
    expect(manifest).not.toContain(MARKER);
    expect(manifest).toContain("/fixture/keys/deploy-key");
  } finally {
    cleanup(root, repo, dest, workDir);
  }
});

test("a malformed inventory stops every mode before anything is uploaded", () => {
  const repo = mkdtempSync(join(tmpdir(), "host-state-repo-"));
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  mkdirSync(join(repo, "instance"), { recursive: true });
  writeFileSync(join(repo, "instance", "host-state.tsv"), "/a\tkind\twhat\t600\ttest -e /a\n");
  try {
    for (const args of [["--check"], ["--verify"], []]) {
      const result = runTool(["--repo", repo, "--dest", `local:${dest}`, ...args]);
      expect(result.stderr).toContain("expected 6 tab-separated columns");
      expect(result.code).toBe(1);
    }
    expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([]);
  } finally {
    cleanup(repo, dest);
  }
});

test("a repository with no inventory at all fails closed", () => {
  const repo = mkdtempSync(join(tmpdir(), "host-state-repo-"));
  try {
    const result = runTool(["--repo", repo, "--check"]);
    expect(result.stderr).toContain("no host-state inventory");
    expect(result.code).toBe(1);
  } finally {
    cleanup(repo);
  }
});
