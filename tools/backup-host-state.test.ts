import { expect, test } from "bun:test";
import { createVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ARCHIVE_MODE,
  ARCHIVE_RE,
  DEST_DIR_MODE,
  MANIFEST,
  PARTIAL_RE,
  PARTIAL_SUFFIX,
  archiveName,
  archiveStamp,
  assertPassphraseOffRepo,
  buildArchive,
  checkRows,
  entryOf,
  LocalTransport,
  makeTransport,
  newestArchive,
  parseInventory,
  parseManifest,
  planPartialSweep,
  planRetention,
  readBackupParams,
  readInventory,
  resolveEncryption,
  resolveInventoryPath,
  resolvePassphraseFile,
  serializeManifest,
  signedAssertion,
  throwawayServiceAccountKey,
  UNENCRYPTED_WARNING,
  uploadArchive,
  verifyArchive,
  type RemoteFile,
  type Row,
} from "./backup-host-state";

// Every fixture below is invented. No path here names a real credential and no
// content here resembles one: the whole point of the row is that a live secret
// must never reach git, a test fixture, or a log, so the suite is written so
// that a leak would have to be typed in deliberately.
const MARKER = "FIXTURE-CONTENT-NOT-A-SECRET";

const TOOL = join(import.meta.dir, "backup-host-state.ts");

// An invented path, never opened: resolveEncryption decides on the PRESENCE of a
// passphrase file, not its content, so the mode locks below need no real file
// and must not be able to read one by accident.
const OFF_REPO_PASSPHRASE = "/fixture/off-repo/passphrase";

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
//
// `encryption` writes instance/params.yaml the way the installation carries it:
// the default is `none` because that is the mode most of these tests exercise,
// and `null` means the key is ABSENT, which the tool must refuse rather than
// default. Nothing here picks the real installation's mode.
// `passphraseFile` gives the fixture its own custody world: the params key and
// the matching inventory row, both invented. The path is a REAL absolute path
// (from `passphrase()`), because the off-repo check resolves it — but it is the
// fixture's own file, so nothing here consults this host's installation.
type FixtureOptions = {
  files?: FixtureFile[];
  dirs?: { path: string; members: string[]; inBackup?: boolean }[];
  encryption?: string | null;
  inventoryName?: string;
  params?: boolean;
  passphraseFile?: string;
};

function fixture(options: FixtureOptions = {}) {
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

  // Enumerated as host state that must NOT ride inside the archive, exactly the
  // shape the real installation's row carries.
  if (options.passphraseFile) {
    lines.push([
      options.passphraseFile,
      "fixture-passphrase",
      "invented fixture passphrase; never inside the archive it opens",
      "600",
      `test -s ${options.passphraseFile}`,
      "no",
    ].join("\t"));
  }

  const inventoryName = options.inventoryName ?? "host-state.tsv";
  writeFileSync(join(repo, "instance", inventoryName), lines.join("\n") + "\n");

  if (options.params !== false) {
    const encryption = "encryption" in options ? options.encryption : "none";
    writeFileSync(
      join(repo, "instance", "params.yaml"),
      ["backup:", `  inventory: instance/${inventoryName}`, "  keep: 10",
        ...(encryption === null || encryption === undefined ? [] : [`  encryption: ${encryption}`]),
        ...(options.passphraseFile ? [`  passphrase_file: ${options.passphraseFile}`] : []), ""].join("\n"),
    );
  }
  return { root, repo, inventory: join(repo, "instance", inventoryName) };
}

// The operator holds the passphrase off-host, so a test one lives outside the
// fixture repository too — the tool refuses a passphrase file under the repo.
function passphrase(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "host-state-key-"));
  const file = join(dir, "passphrase");
  writeFileSync(file, "fixture-passphrase-not-a-real-secret\n", { mode: 0o600 });
  return { dir, file };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
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
  const { dir: keyDir, file: passphraseFile } = passphrase();
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
    cleanup(root, repo, stagingDir, outDir, withKey, withoutKey, keyDir);
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

// ── A failed upload creates no version (F1) ────────────────────────────────

// Real bytes land and then the transport dies — which is what a full disk, a
// dropped connection and a Drive quota all look like from here. The review
// reproduced this against a 64K tmpfs; this is the same event, hermetic.
class HalfWayTransport extends LocalTransport {
  constructor(private readonly dest: string, private readonly failAt: "upload" | "rename") {
    super(dest);
  }
  async upload(localPath: string, name: string): Promise<RemoteFile> {
    if (this.failAt === "rename") return super.upload(localPath, name);
    mkdirSync(this.dest, { recursive: true });
    const bytes = readFileSync(localPath);
    writeFileSync(join(this.dest, name), bytes.subarray(0, Math.floor(bytes.length / 2)));
    throw new Error("simulated transport failure mid-write");
  }
  async rename(file: RemoteFile, name: string): Promise<RemoteFile> {
    if (this.failAt === "rename") throw new Error("simulated failure publishing the archive");
    return super.rename(file, name);
  }
}

function seedNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => archiveName(`202501${String(i + 1).padStart(2, "0")}T000000Z`, false));
}

async function seedDest(dest: string, payload: string, archives: string[]): Promise<void> {
  const transport = new LocalTransport(dest);
  for (const name of archives) await transport.upload(payload, name);
}

test.each([["mid-write", "upload"], ["while publishing", "rename"]] as const)(
  "an upload that fails %s creates no version and evicts nothing",
  async (_name, failAt) => {
    const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
    const source = mkdtempSync(join(tmpdir(), "host-state-src-"));
    try {
      const payload = join(source, "payload.tar.gz");
      writeFileSync(payload, `${MARKER}-payload-bytes`);
      await seedDest(dest, payload, seedNames(10));
      const before = readdirSync(dest).sort();
      expect(before).toHaveLength(10);

      const doomedName = archiveName("20250201T000000Z", false);
      const flaky = new HalfWayTransport(dest, failAt);
      await expect(uploadArchive(flaky, payload, doomedName)).rejects.toThrow();

      // The review's acceptance, asserted before anything about wording: a
      // failed upload leaves the destination's archive count unchanged.
      const after = readdirSync(dest).sort();
      expect(after.filter((name) => ARCHIVE_RE.test(name))).toHaveLength(10);
      expect(after).toEqual(before);
      expect(after.filter((name) => PARTIAL_RE.test(name))).toEqual([]);
      // Even had it survived, the in-flight name could not have been a version.
      expect(ARCHIVE_RE.test(`${doomedName}${PARTIAL_SUFFIX}`)).toBe(false);

      // And the corpse is named rather than swallowed.
      await expect(uploadArchive(flaky, payload, doomedName)).rejects.toThrow("no version was created");
      await expect(uploadArchive(flaky, payload, doomedName)).rejects.toThrow(
        `incomplete upload ${doomedName}${PARTIAL_SUFFIX} removed`,
      );
    } finally {
      cleanup(dest, source);
    }
  },
);

test("an upload lands under a non-version name and becomes a version only on rename", async () => {
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  const source = mkdtempSync(join(tmpdir(), "host-state-src-"));
  try {
    const payload = join(source, "payload.tar.gz");
    writeFileSync(payload, MARKER);
    const name = archiveName("20250201T000000Z", false);
    const staged = new LocalTransport(dest);
    const inFlight = await staged.upload(payload, `${name}${PARTIAL_SUFFIX}`);
    expect(newestArchive(readdirSync(dest))).toBeNull();
    expect(planRetention(readdirSync(dest), 1)).toEqual([]);

    await staged.rename(inFlight, name);
    expect(readdirSync(dest)).toEqual([name]);
    expect(newestArchive(readdirSync(dest))).toBe(name);
  } finally {
    cleanup(dest, source);
  }
});

test("retention counts no partial and evicts nothing on a corpse's behalf", () => {
  const partials = seedNames(3).map((name) => `${name}${PARTIAL_SUFFIX}`);
  expect(planRetention([...seedNames(10), ...partials], 10)).toEqual([]);
  expect(partials.every((name) => !ARCHIVE_RE.test(name) && PARTIAL_RE.test(name))).toBe(true);
});

// A concurrent newer run's in-flight upload is not this run's to delete.
test("the sweep takes partials older than this run and leaves newer ones alone", () => {
  const older = `${archiveName("20250101T000000Z", false)}${PARTIAL_SUFFIX}`;
  const newer = `${archiveName("20250301T000000Z", true)}${PARTIAL_SUFFIX}`;
  const swept = planPartialSweep([older, newer, ...seedNames(3), "notes.md"], "20250201T000000Z");
  expect(swept).toEqual([older]);
});

// The whole cost of F1 in one run: ten good versions, one leftover corpse, a
// `--keep 10` backup. Exactly one good archive may be evicted — the reviewed
// defect evicted two and reported `HOST-STATE clean`.
test("a leftover corpse costs no good version and is swept", async () => {
  const { root, repo } = fixture({ encryption: "none" });
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const payload = join(root, "payload.tar.gz");
    writeFileSync(payload, `${MARKER}-payload-bytes`);
    await seedDest(dest, payload, seedNames(10));
    const corpse = `${archiveName("20250105T000000Z", false)}${PARTIAL_SUFFIX}`;
    writeFileSync(join(dest, corpse), "half an upload");

    const backup = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--keep", "10"]);
    expect(backup.code).toBe(0);
    const evicted = backup.stdout.split("\n").filter((line) => line.startsWith("retention: removed ") && !line.includes("incomplete"));
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toContain(seedNames(10)[0]!);
    expect(backup.stdout).toContain(`retention: removed incomplete upload ${corpse}`);
    expect(backup.stdout).toContain("10 archive(s) retained");

    const survivors = readdirSync(dest);
    expect(survivors.filter((name) => ARCHIVE_RE.test(name))).toHaveLength(10);
    expect(survivors.filter((name) => PARTIAL_RE.test(name))).toEqual([]);
    expect(survivors).not.toContain(seedNames(10)[0]!);
    expect(survivors).toContain(seedNames(10)[9]!);
  } finally {
    cleanup(root, repo, dest);
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
    "db:\n  legacy_carry_over: none\n\nbackup:\n  inventory: instance/host-state.tsv\n  drive_folder_id: FOLDER\n"
      + "  service_account_key: /k.json\n  keep: 7\n  encryption: operator-passphrase\n  passphrase_file: /off/repo/pass\n"
      + "\nfleet:\n  keep: 99\n",
  );
  try {
    expect(readBackupParams(repo)).toEqual({
      inventory: "instance/host-state.tsv",
      driveFolderId: "FOLDER",
      serviceAccountKey: "/k.json",
      keep: 7,
      encryption: "operator-passphrase",
      passphraseFile: "/off/repo/pass",
    });
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

// ── The encryption tripwire, recut ─────────────────────────────────────────
//
// The original form asserted `params.encryption` was UNDEFINED, so that landing
// the operator's ruling would go red and force the restore paragraph and the
// custody row to be revisited in the same change. That day came
// (backup_encryption_2026_08_06 = encrypt, operator holds the key), so the
// assertion is recut rather than deleted -- deleting it would retire the guard
// at the exact moment there is finally something to guard.
//
// What it protected then, and still protects now:
//
//   1. an UNSET value fails closed -- the tool never picks a mode for him;
//   2. a value NOBODY DECIDED fails closed -- typing anything into the key is
//      not the same as a decision, and a typo must not degrade to cleartext;
//   3. the decided mode still refuses to run without the operator's passphrase.
//
// What it newly pins: this installation carries HIS value and not some other
// legal one. `none` is a legal mode and a different ruling; a silent flip from
// operator-passphrase to none would ship every credential this host owns to the
// Drive in cleartext and look exactly like a successful run. That is the change
// this test now exists to make loud.
test("the installation carries the operator's decided encryption mode, and an undecided value still fails closed", () => {
  const params = readBackupParams(join(import.meta.dir, ".."));

  // (1) his decision, verbatim from the ruling id cited in params.yaml
  expect(params.encryption).toBe("operator-passphrase");
  expect(resolveEncryption(params.encryption, OFF_REPO_PASSPHRASE)).toBe("operator-passphrase");

  // (2) unset still fails closed, and still names the decision it is waiting on
  expect(() => resolveEncryption(undefined, undefined)).toThrow("backup_encryption_2026_08_06");
  expect(() => resolveEncryption(undefined, OFF_REPO_PASSPHRASE)).toThrow("backup_encryption_2026_08_06");

  // (3) a value nobody decided still fails closed -- it must not fall back to
  //     either legal mode, least of all to cleartext
  expect(() => resolveEncryption("aes256", OFF_REPO_PASSPHRASE)).toThrow("unrecognised backup.encryption");
  expect(() => resolveEncryption("operator_passphrase", OFF_REPO_PASSPHRASE)).toThrow("unrecognised backup.encryption");

  // (4) the decided mode is not self-executing: no passphrase, no backup
  expect(() => resolveEncryption(params.encryption, undefined)).toThrow("no --passphrase-file was given");
});

// The custody half of the same ruling: the passphrase is the one piece of host
// state that must NOT be inside the archive it opens. The chain is params key →
// inventory row → what the archive actually carries, checked end to end rather
// than each link trusted separately — two files agreeing by hand is how a
// passphrase ends up shipped to the Drive inside the thing it decrypts.
//
// The fixture owns its whole world: its own passphrase file, its own params key,
// its own inventory row, its own archive. An earlier form of this test read the
// INSTALLATION's configured path and stat'ed it, which passed here and failed
// instantly inside the meteorite rebuild -- a clean container legitimately has
// no /root/.config/bpa. A test that needs this host's files does not test the
// mechanism, it tests the host; the tracked-content half is split into the next
// test, which is true in any checkout.
test("a configured passphrase is enumerated as host state and stays out of the archive it encrypts", () => {
  const { dir: keyDir, file: passphraseFile } = passphrase();
  const { root, repo, inventory } = fixture({ encryption: "operator-passphrase", passphraseFile });
  const params = readBackupParams(repo);
  const configured = resolvePassphraseFile(params);

  // (1) configured, absolute, and never inside the repository -- one
  //     `git add -A` from a committed secret.
  expect(configured).toBe(passphraseFile);
  expect(isAbsolute(configured!)).toBe(true);
  expect(() => assertPassphraseOffRepo(configured!, repo)).not.toThrow();

  // (2) enumerated as host state the rebuild must be told about, with the
  //     permission contract, and marked out of the backup.
  const { rows, errors } = readInventory(repo, resolveInventoryPath(repo, params));
  expect(errors).toEqual([]);
  const row = rows.find((candidate) => candidate.path === configured);
  expect(row, `${configured} must be enumerated in the host-state inventory`).toBeTruthy();
  expect(row!.inBackup, "the passphrase must never ride inside the archive it encrypts").toBe(false);
  expect(row!.mode).toBe("600");
  // The archive selects on inBackup, so prove the exclusion at the selector and
  // not only at the row: this is the assertion that fails if buildArchive ever
  // stops filtering.
  expect(rows.filter((candidate) => candidate.inBackup).map((candidate) => candidate.path))
    .not.toContain(configured);

  // (3) and prove it against the bytes: build the encrypted archive with that
  //     very passphrase, restore it, and read what actually arrived. The
  //     manifest is the archive's own account of itself, so the key must be
  //     absent from both the manifest and the restored tree.
  const { built, stagingDir, outDir } = build(root, rows, passphraseFile);
  const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
  try {
    expect(built.encrypted).toBe(true);
    expect(built.entries.map((entry) => entry.path)).not.toContain(configured);
    expect(verifyArchive(built.archivePath, { workDir, passphraseFile })).toEqual([]);

    const manifest = parseManifest(readFileSync(join(workDir, "unpacked", MANIFEST), "utf8"));
    expect(manifest.length).toBeGreaterThan(0);
    expect(manifest.map((entry) => entry.path)).not.toContain(configured);
    expect(existsSync(join(workDir, "unpacked", "files", entryOf(row!)))).toBe(false);
  } finally {
    cleanup(root, repo, keyDir, stagingDir, outDir, workDir);
  }
});

// The tracked half of the same contract: THIS repository's two files agree about
// the passphrase. Decided entirely on committed content -- params.yaml and the
// tracked inventory -- so it holds in a bare clone, in the rebuild container, and
// on a host where the passphrase has not been provisioned yet. Whether the file
// itself exists is the row's own verify-command's job (`--check`), not this
// test's; that separation is what the rebuild failure taught.
test("this checkout's tracked config keeps the passphrase off-repo and out of the backup", () => {
  const repo = join(import.meta.dir, "..");
  const params = readBackupParams(repo);
  const configured = resolvePassphraseFile(params);

  expect(configured).toBeTruthy();
  expect(isAbsolute(configured!)).toBe(true);
  // Off-repo decided on the CONFIGURED path rather than on a file that must be
  // present: a fresh clone has no passphrase yet, and this claim is still true
  // there. Compare against the resolved repository root so a `..` or a symlink
  // in either value cannot read as outside.
  expect(resolve(configured!).startsWith(`${resolve(repo)}/`)).toBe(false);

  const { rows, errors } = readInventory(repo, resolveInventoryPath(repo, params));
  expect(errors).toEqual([]);
  const row = rows.find((candidate) => candidate.path === configured);
  expect(row, `${configured} must be enumerated in ${resolveInventoryPath(repo, params)}`).toBeTruthy();
  expect(row!.inBackup, "the passphrase must never ride inside the archive it encrypts").toBe(false);
  expect(row!.mode).toBe("600");
  expect(rows.filter((candidate) => candidate.inBackup).map((candidate) => candidate.path))
    .not.toContain(configured);
});

test("a passphrase path is read from params, overridden by the flag, and refused when relative", () => {
  expect(resolvePassphraseFile({ passphraseFile: "/off/repo/pass" })).toBe("/off/repo/pass");
  expect(resolvePassphraseFile({ passphraseFile: "/off/repo/pass" }, "/other/pass")).toBe("/other/pass");
  expect(resolvePassphraseFile({})).toBeUndefined();
  expect(resolvePassphraseFile({}, "/only/the/flag")).toBe("/only/the/flag");
  // A relative value would resolve inside the repository, which is the one
  // place the passphrase may never live. Refused where it is read, not two
  // steps later where the message would be about something else.
  expect(() => resolvePassphraseFile({ passphraseFile: "instance/pass" })).toThrow("must be an absolute path");
  expect(() => resolvePassphraseFile({}, "relative/pass")).toThrow("must be an absolute path");
});

// F4: the declared key was never read, so editing it changed nothing and the
// file had two meanings — one of which was false.
test("backup.inventory selects the inventory that is actually read", () => {
  const { root, repo } = fixture({ inventoryName: "elsewhere.tsv" });
  try {
    expect(existsSync(join(repo, "instance", "host-state.tsv"))).toBe(false);
    expect(resolveInventoryPath(repo, readBackupParams(repo))).toBe(join(repo, "instance", "elsewhere.tsv"));

    const check = runTool(["--repo", repo, "--check"]);
    expect(check.stdout).toContain("HOST-STATE clean");
    expect(check.code).toBe(0);
    void root;
  } finally {
    cleanup(root, repo);
  }
});

test("--inventory overrides the param, and an absolute param is taken as written", () => {
  const { root, repo, inventory } = fixture({ inventoryName: "elsewhere.tsv" });
  const other = mkdtempSync(join(tmpdir(), "host-state-inv-"));
  try {
    expect(resolveInventoryPath(repo, readBackupParams(repo), "/tmp/explicit.tsv")).toBe("/tmp/explicit.tsv");
    expect(resolveInventoryPath(repo, { inventory: "/abs/host-state.tsv" })).toBe("/abs/host-state.tsv");
    expect(resolveInventoryPath(repo, {})).toBeUndefined();

    // A broken override must be what the tool reads, or the flag is decorative.
    const broken = join(other, "broken.tsv");
    writeFileSync(broken, "/a\tkind\twhat\t600\ttest -e /a\n");
    const result = runTool(["--repo", repo, "--inventory", broken, "--check"]);
    expect(result.stderr).toContain("expected 6 tab-separated columns");
    expect(result.code).toBe(1);
    void inventory;
  } finally {
    cleanup(root, repo, other);
  }
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

// ── Encryption is the operator's decision (F2) ─────────────────────────────

// The mode is read from params and never inferred. Each of these would
// otherwise resolve to "ship it in cleartext and hope", which is exactly the
// failure a warning cannot prevent.
test("resolveEncryption refuses every way of not deciding", () => {
  expect(() => resolveEncryption(undefined, undefined)).toThrow("no backup.encryption");
  expect(() => resolveEncryption(undefined, undefined)).toThrow("backup_encryption_2026_08_06");
  expect(() => resolveEncryption("", "/k")).toThrow("no backup.encryption");
  expect(() => resolveEncryption("aes-maybe", "/k")).toThrow("unrecognised backup.encryption: aes-maybe");
  expect(() => resolveEncryption("operator-passphrase", undefined)).toThrow("no --passphrase-file was given");
  expect(() => resolveEncryption("none", "/k")).toThrow("backup.encryption is none");
  expect(resolveEncryption("none", undefined)).toBe("none");
  expect(resolveEncryption("operator-passphrase", "/k")).toBe("operator-passphrase");
});

// The passphrase is the operator's, held off-host. A copy under the repository
// root is one `git add -A` from being a committed secret that opens an archive
// the same repository tells you how to find.
test("a passphrase file inside the repository is refused", () => {
  const { root, repo } = fixture({ encryption: "operator-passphrase" });
  const inside = join(repo, "passphrase");
  writeFileSync(inside, "fixture-passphrase-not-a-real-secret\n", { mode: 0o600 });
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    expect(() => assertPassphraseOffRepo(inside, repo)).toThrow("must not live inside the repository");
    const result = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--passphrase-file", inside]);
    expect(result.stderr).toContain("must not live inside the repository");
    expect(result.code).toBe(1);
    expect(readdirSync(dest)).toEqual([]);
  } finally {
    cleanup(root, repo, dest);
  }
});

test.each([
  ["no backup.encryption at all", null, "backup_encryption_2026_08_06"],
  ["an unrecognised mode", "aes-maybe", "unrecognised backup.encryption"],
  ["encrypted mode with no passphrase file", "operator-passphrase", "never stored in the repository"],
])("a backup refuses to run and uploads nothing: %s", (_name, encryption, expected) => {
  const { root, repo } = fixture({ encryption });
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const result = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]);
    expect(result.stderr).toContain(expected);
    expect(result.code).toBe(1);
    expect(readdirSync(dest)).toEqual([]);
  } finally {
    cleanup(root, repo, dest);
  }
});

test("a passphrase file in `none` mode is a contradiction, not a silent upgrade", () => {
  const { root, repo } = fixture({ encryption: "none" });
  const { dir: keyDir, file: passphraseFile } = passphrase();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const result = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--passphrase-file", passphraseFile]);
    expect(result.stderr).toContain("backup.encryption is none");
    expect(result.code).toBe(1);
    expect(readdirSync(dest)).toEqual([]);
  } finally {
    cleanup(root, repo, dest, keyDir);
  }
});

// «щоб ми не мучились» — the cleartext mode is legitimate but must announce
// itself every single time rather than being a footnote in a document.
test("`none` mode warns loudly and writes a cleartext version", () => {
  const { root, repo } = fixture({ encryption: "none" });
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const plain = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toContain(UNENCRYPTED_WARNING);
    expect(UNENCRYPTED_WARNING).toContain("UNENCRYPTED");
    expect(readdirSync(dest).every((name) => !name.endsWith(".gpg"))).toBe(true);
  } finally {
    cleanup(root, repo, dest);
  }
});

test("`operator-passphrase` mode encrypts, restores with the passphrase, and keeps it out of everything", () => {
  const { root, repo } = fixture({ encryption: "operator-passphrase" });
  const { dir: keyDir, file: passphraseFile } = passphrase();
  const secret = readFileSync(passphraseFile, "utf8").trim();
  const dest = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  try {
    const backup = runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`, "--passphrase-file", passphraseFile]);
    expect(backup.code).toBe(0);
    expect(backup.stderr).not.toContain(UNENCRYPTED_WARNING);
    const uploaded = readdirSync(dest);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.endsWith(".tar.gz.gpg")).toBe(true);

    // The archive is unreadable without the operator's passphrase, and the
    // passphrase itself reaches neither the archive nor the tool's output.
    const bytes = readFileSync(join(dest, uploaded[0]!)).toString("latin1");
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(MARKER);
    expect(backup.stdout + backup.stderr).not.toContain(secret);
    expect(readFileSync(join(repo, "instance", "params.yaml"), "utf8")).not.toContain(secret);

    const verify = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify", "--passphrase-file", passphraseFile]);
    expect(verify.stdout).toContain("restored intact");
    expect(verify.code).toBe(0);

    const blind = runTool(["--repo", repo, "--dest", `local:${dest}`, "--verify"]);
    expect(blind.stdout + blind.stderr).toContain("no --passphrase-file");
    expect(blind.code).toBe(1);
  } finally {
    cleanup(root, repo, dest, keyDir);
  }
});

// ── Permissions (F3) ───────────────────────────────────────────────────────

// The archive holds every credential the installation owns. A world-readable
// copy of them is a different defect from a missing one, not a lesser one.
test("the archive and any destination this tool creates are not world-readable", () => {
  const { root, repo } = fixture({ encryption: "none" });
  const parent = mkdtempSync(join(tmpdir(), "host-state-dest-"));
  const dest = join(parent, "remote");
  try {
    expect(runTool(["--repo", repo, "--root", root, "--dest", `local:${dest}`]).code).toBe(0);
    expect(modeOf(dest)).toBe(DEST_DIR_MODE);
    const archive = join(dest, readdirSync(dest)[0]!);
    expect(modeOf(archive)).toBe(ARCHIVE_MODE);
  } finally {
    cleanup(root, repo, parent);
  }
});

test("an encrypted archive is written 0600 too", () => {
  const { root, repo, inventory } = fixture();
  const { dir: keyDir, file: passphraseFile } = passphrase();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory), passphraseFile);
  try {
    expect(modeOf(built.archivePath)).toBe(ARCHIVE_MODE);
    expect(modeOf(outDir)).toBe(DEST_DIR_MODE);
  } finally {
    cleanup(root, repo, stagingDir, outDir, keyDir);
  }
});

test("a plain archive is written 0600 under a umask that would make it 0644", () => {
  const { root, repo, inventory } = fixture();
  const { built, stagingDir, outDir } = build(root, rowsOf(inventory));
  try {
    expect(modeOf(built.archivePath)).toBe(ARCHIVE_MODE);
  } finally {
    cleanup(root, repo, stagingDir, outDir);
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
