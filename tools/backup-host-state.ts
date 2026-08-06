#!/usr/bin/env bun
// Archive the host state the repository cannot rebuild, and put it somewhere a
// meteorite cannot reach.
//
// Why this file exists (workboard V3-5.33, operator order Telegram 2734):
// `instructions/reproducible-from-git.md` proves the REPOSITORY rebuilds a host.
// It proves nothing about the GitHub deploy key, the provider credentials, the
// Telegram token, the state database or the mission history -- none of which are
// in git, and all of which a rebuilt server needs. The operator asked for the
// backup in those terms: «щоб я потім хоч десяток серверів міг підняти». His
// earlier design (HR-2171, HR-2446) fixes the rest of the shape -- keep writing
// locally, copy off-host periodically, retain about ten versions, and be able to
// find and read them again from the rules alone.
//
// ── What this tool does ────────────────────────────────────────────────────
//
//   --check    run every verify-command in instance/host-state.tsv. This is the
//              executable half of cutover gate F: the readiness command reads
//              the same file but judges only its SHAPE, and a row that names a
//              path which stopped existing passes a shape check unharmed.
//   (default)  stage every `in-backup: yes` row, write a manifest, tar it,
//              optionally encrypt it, upload it, then apply keep-N retention.
//   --verify   download the newest archive into an EMPTY directory, unpack it,
//              and check every manifest entry against the size it was recorded
//              with. Restore proof, not upload hope -- an upload that returns
//              200 and a truncated archive are the same event from here.
//
// ── The transport, and why it is written by hand ───────────────────────────
//
// This host has no rclone, no gcloud and no gsutil, and provisioning new
// credentials was out of scope. What it does have is the service-account key at
// instance/params.yaml `backup.service_account_key`, so DriveTransport signs a
// RS256 JWT with it, exchanges that for an access token, and speaks the Drive v3
// REST API directly. `supportsAllDrives` is set on every call because the
// destination (HR-2407) is a SHARED drive, where the default parameters silently
// return an empty file list rather than an error.
//
// ── What is NOT covered ────────────────────────────────────────────────────
//
// The Drive transport is exercised against the real API only by an operator run;
// the tests here drive LocalTransport over fixture files and never touch the
// network, because the alternative is a test suite that needs a live credential
// to be green. The JWT assertion is unit-tested against a locally generated key,
// which covers the signing shape but not Google's acceptance of it.
//
// Nothing here schedules itself. HR-2171 asks for an hourly rhythm; that is a
// timer, a unit and an activation row, and it is deliberately not smuggled in
// with the mechanism.

import { createSign, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const INVENTORY = join("instance", "host-state.tsv");
export const PARAMS = join("instance", "params.yaml");
export const MANIFEST = "manifest.tsv";
export const DEFAULT_KEEP = 10;

// Names are the index. A stamp that sorts lexicographically is the whole reason
// retention can be decided without asking the remote for timestamps it may not
// report consistently -- and it is also what HR-2171 means by the installation
// being able to find its own backups from the written rule alone.
export const ARCHIVE_PREFIX = "bpa-host-state-";
export const ARCHIVE_RE = /^bpa-host-state-(\d{8}T\d{6}Z)\.tar\.gz(\.gpg)?$/;

export type Row = {
  path: string;
  kind: string;
  what: string;
  mode: string;
  verify: string;
  inBackup: boolean;
};

export type ManifestEntry = {
  path: string;
  kind: string;
  entry: string;
  bytes: number;
  files: number;
};

export type RemoteFile = { id: string; name: string };

export interface Transport {
  describe(): string;
  list(): Promise<RemoteFile[]>;
  upload(localPath: string, name: string): Promise<RemoteFile>;
  download(file: RemoteFile, destPath: string): Promise<void>;
  remove(file: RemoteFile): Promise<void>;
}

// ── Inventory ──────────────────────────────────────────────────────────────

// Fail-visible, never fail-hidden: a malformed row is an error rather than a
// skipped line. A row silently dropped here is a credential silently not backed
// up, and the loss is invisible until the host is already gone.
export function parseInventory(text: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("#")) continue;
    const where = `${INVENTORY}:${i + 1}`;
    const cells = line.split("\t");
    if (cells.length !== 6) {
      errors.push(`${where}: expected 6 tab-separated columns, found ${cells.length}`);
      continue;
    }
    const [path, kind, what, mode, verify, inBackup] = cells.map((cell) => cell.trim());
    if ([path, kind, what, mode, verify, inBackup].some((cell) => !cell)) {
      errors.push(`${where}: empty cell; an unknown value is a FAIL, never a blank`);
      continue;
    }
    if (!path.startsWith("/")) errors.push(`${where}: path must be absolute: ${path}`);
    if (!/^[0-7]{3,4}$/.test(mode)) errors.push(`${where}: mode must be octal, found ${mode}`);
    if (inBackup !== "yes" && inBackup !== "no") {
      errors.push(`${where}: in-backup must be yes or no, found ${inBackup}`);
      continue;
    }
    if (seen.has(path)) errors.push(`${where}: duplicate path ${path}`);
    seen.add(path);
    rows.push({ path, kind, what, mode, verify, inBackup: inBackup === "yes" });
  }
  if (rows.length === 0 && errors.length === 0) errors.push(`${INVENTORY} enumerates nothing`);
  return { rows, errors };
}

export function readInventory(repo: string, inventoryPath?: string): { rows: Row[]; errors: string[] } {
  const path = inventoryPath ?? join(repo, INVENTORY);
  if (!existsSync(path)) return { rows: [], errors: [`no host-state inventory at ${path}`] };
  return parseInventory(readFileSync(path, "utf8"));
}

export type CheckResult = { row: Row; ok: boolean; detail: string };

// Runs the row's own command rather than re-deriving what it should assert. The
// inventory is tracked and reviewed; re-implementing its checks here would give
// the file two meanings and let them drift.
export function checkRows(rows: Row[]): CheckResult[] {
  return rows.map((row) => {
    const run = Bun.spawnSync(["sh", "-c", row.verify], { stdout: "pipe", stderr: "pipe" });
    const ok = run.exitCode === 0;
    const stderr = run.stderr.toString().trim().split("\n")[0] ?? "";
    return { row, ok, detail: ok ? "verify-command exit 0" : `verify-command exit ${run.exitCode}${stderr ? `: ${stderr}` : ""}` };
  });
}

// ── Archive ────────────────────────────────────────────────────────────────

export function archiveStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function archiveName(stamp: string, encrypted: boolean): string {
  return `${ARCHIVE_PREFIX}${stamp}.tar.gz${encrypted ? ".gpg" : ""}`;
}

export function sourceOf(row: Row, root: string): string {
  return root === "/" ? row.path : join(root, row.path);
}

export function entryOf(row: Row): string {
  return row.path.replace(/^\/+/, "");
}

// Bytes AND file count, because either one alone can be satisfied by a broken
// restore: a directory can arrive with the right total and half the files if a
// single large member survived, and it can arrive with the right count and no
// content at all.
export function measure(path: string): { bytes: number; files: number } {
  const info = statSync(path);
  if (info.isFile()) return { bytes: info.size, files: 1 };
  if (!info.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const child of readdirSync(path)) {
    const inner = measure(join(path, child));
    bytes += inner.bytes;
    files += inner.files;
  }
  return { bytes, files };
}

function run(argv: string[], what: string): void {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim().split("\n").slice(-3).join("; ");
    throw new Error(`${what} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`);
  }
}

export function serializeManifest(entries: ManifestEntry[]): string {
  const header = "# path\tkind\tentry\tbytes\tfiles\n";
  return header + entries.map((e) => [e.path, e.kind, e.entry, e.bytes, e.files].join("\t")).join("\n") + "\n";
}

export function parseManifest(text: string): ManifestEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [path, kind, entry, bytes, files] = line.split("\t");
      if (!path || !kind || !entry || bytes === undefined || files === undefined) {
        throw new Error(`malformed manifest row: ${line}`);
      }
      return { path, kind, entry, bytes: Number(bytes), files: Number(files) };
    });
}

export function encryptArchive(plain: string, encrypted: string, passphraseFile: string): void {
  if (!existsSync(passphraseFile)) throw new Error(`passphrase file not found: ${passphraseFile}`);
  run(
    ["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--symmetric", "--cipher-algo", "AES256",
      "--passphrase-file", passphraseFile, "--output", encrypted, plain],
    "gpg symmetric encryption",
  );
}

export function decryptArchive(encrypted: string, plain: string, passphraseFile: string): void {
  if (!existsSync(passphraseFile)) throw new Error(`passphrase file not found: ${passphraseFile}`);
  run(
    ["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", passphraseFile,
      "--output", plain, "--decrypt", encrypted],
    "gpg decryption",
  );
}

export type BuildResult = { archivePath: string; name: string; entries: ManifestEntry[]; encrypted: boolean };

// A missing or empty source aborts the whole archive. Half a backup is the worst
// of the three outcomes: it costs the same to make, it reports success, and it
// is discovered only by the restore nobody gets to retry.
export function buildArchive(
  rows: Row[],
  opts: { root: string; stagingDir: string; outDir: string; stamp: string; passphraseFile?: string },
): BuildResult {
  const selected = rows.filter((row) => row.inBackup);
  if (selected.length === 0) throw new Error(`${INVENTORY} marks nothing as in-backup`);

  const filesDir = join(opts.stagingDir, "files");
  mkdirSync(filesDir, { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const row of selected) {
    const source = sourceOf(row, opts.root);
    if (!existsSync(source)) throw new Error(`missing source for in-backup row: ${row.path}`);
    const entry = entryOf(row);
    const dest = join(filesDir, entry);
    mkdirSync(dirname(dest), { recursive: true });
    run(["cp", "-a", source, dest], `copy ${row.path}`);
    const { bytes, files } = measure(dest);
    if (files === 0 || bytes === 0) throw new Error(`empty source for in-backup row: ${row.path}`);
    entries.push({ path: row.path, kind: row.kind, entry, bytes, files });
  }
  writeFileSync(join(opts.stagingDir, MANIFEST), serializeManifest(entries));

  mkdirSync(opts.outDir, { recursive: true });
  const plainName = archiveName(opts.stamp, false);
  const plainPath = join(opts.outDir, plainName);
  run(["tar", "-czf", plainPath, "-C", opts.stagingDir, MANIFEST, "files"], "tar");

  if (!opts.passphraseFile) return { archivePath: plainPath, name: plainName, entries, encrypted: false };
  const encryptedName = archiveName(opts.stamp, true);
  const encryptedPath = join(opts.outDir, encryptedName);
  encryptArchive(plainPath, encryptedPath, opts.passphraseFile);
  rmSync(plainPath, { force: true });
  return { archivePath: encryptedPath, name: encryptedName, entries, encrypted: true };
}

// The restore proof. `workDir` must be EMPTY on entry: unpacking over a
// directory that already holds a previous restore is how a verify passes on
// files the archive never contained.
export function verifyArchive(
  archivePath: string,
  opts: { workDir: string; passphraseFile?: string },
): string[] {
  const errors: string[] = [];
  if (!existsSync(archivePath)) return [`archive not found: ${archivePath}`];
  if (!existsSync(opts.workDir)) mkdirSync(opts.workDir, { recursive: true });
  if (readdirSync(opts.workDir).length !== 0) return [`verify work directory is not empty: ${opts.workDir}`];

  let tarPath = archivePath;
  if (archivePath.endsWith(".gpg")) {
    if (!opts.passphraseFile) return [`archive is encrypted but no --passphrase-file was given: ${basename(archivePath)}`];
    tarPath = join(opts.workDir, "decrypted.tar.gz");
    try {
      decryptArchive(archivePath, tarPath, opts.passphraseFile);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  }

  const unpacked = join(opts.workDir, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  try {
    run(["tar", "-xzf", tarPath, "-C", unpacked], "tar extraction");
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const manifestPath = join(unpacked, MANIFEST);
  if (!existsSync(manifestPath)) return [`archive carries no ${MANIFEST}`];
  let entries: ManifestEntry[];
  try {
    entries = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (entries.length === 0) return [`${MANIFEST} lists no entries`];

  for (const entry of entries) {
    const restored = join(unpacked, "files", entry.entry);
    if (!existsSync(restored)) {
      errors.push(`missing from archive: ${entry.path}`);
      continue;
    }
    const { bytes, files } = measure(restored);
    if (files === 0 || bytes === 0) {
      errors.push(`restored empty: ${entry.path}`);
      continue;
    }
    if (bytes !== entry.bytes || files !== entry.files) {
      errors.push(`restored short: ${entry.path} manifest=${entry.bytes}B/${entry.files}f restored=${bytes}B/${files}f`);
    }
  }
  return errors;
}

// ── Retention ──────────────────────────────────────────────────────────────

// Only names this tool could have written are candidates for deletion. Anything
// else in the destination folder is the operator's, and a retention rule that
// can reach it is a destructive cleanup without an exact target.
export function planRetention(names: string[], keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--keep must be a positive integer, got ${keep}`);
  const ours = names.filter((name) => ARCHIVE_RE.test(name));
  const sorted = [...ours].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return sorted.slice(keep);
}

export function newestArchive(names: string[]): string | null {
  const ours = names.filter((name) => ARCHIVE_RE.test(name));
  if (ours.length === 0) return null;
  return [...ours].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
}

// ── Transports ─────────────────────────────────────────────────────────────

// A directory. Used by every test in this repository and by an operator who
// wants the archive on a second disk before it goes anywhere.
export class LocalTransport implements Transport {
  constructor(private readonly dir: string) {}
  describe(): string {
    return `local:${this.dir}`;
  }
  async list(): Promise<RemoteFile[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).map((name) => ({ id: join(this.dir, name), name }));
  }
  async upload(localPath: string, name: string): Promise<RemoteFile> {
    mkdirSync(this.dir, { recursive: true });
    const dest = join(this.dir, name);
    run(["cp", "-a", localPath, dest], `local upload of ${name}`);
    return { id: dest, name };
  }
  async download(file: RemoteFile, destPath: string): Promise<void> {
    mkdirSync(dirname(destPath), { recursive: true });
    run(["cp", "-a", file.id, destPath], `local download of ${file.name}`);
  }
  async remove(file: RemoteFile): Promise<void> {
    rmSync(file.id, { force: true });
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input as never).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type ServiceAccountKey = { client_email: string; private_key: string };

export function readServiceAccountKey(path: string): ServiceAccountKey {
  if (!existsSync(path)) throw new Error(`service-account key not found: ${path}`);
  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Deliberately does not echo the file. A parse error message that quotes the
    // offending text puts key material on stdout.
    throw new Error(`service-account key is not valid JSON: ${path}`);
  }
  if (!parsed.client_email || !parsed.private_key) throw new Error(`service-account key lacks client_email/private_key: ${path}`);
  return parsed as ServiceAccountKey;
}

// Exported so the signing shape is testable against a throwaway key rather than
// the host's real one.
export function signedAssertion(key: ServiceAccountKey, scope: string, issuedAt: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claim}`).sign(key.private_key);
  return `${header}.${claim}.${base64url(signature)}`;
}

export function throwawayServiceAccountKey(email: string): ServiceAccountKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export class DriveTransport implements Transport {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly folderId: string, private readonly keyPath: string) {}

  describe(): string {
    return `drive:${this.folderId}`;
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt > now + 60) return this.token.value;
    const key = readServiceAccountKey(this.keyPath);
    const assertion = signedAssertion(key, DRIVE_SCOPE, now);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    // Only the status and Google's own error token are surfaced. The response
    // body carries an access token on success and must never be logged.
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`Drive token exchange failed (HTTP ${response.status}): ${(detail as { error?: string }).error ?? "no error field"}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Drive token exchange returned no access_token");
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
    return body.access_token;
  }

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  }

  async list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${this.folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name)",
        pageSize: "200",
        // The destination is a shared drive (HR-2407). Without these two the API
        // answers 200 with an empty list, which reads exactly like "no backups
        // yet" and would make retention delete nothing forever.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.authorized(`https://www.googleapis.com/drive/v3/files?${params}`);
      if (!response.ok) throw new Error(`Drive list failed (HTTP ${response.status})`);
      const body = (await response.json()) as { files?: RemoteFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async upload(localPath: string, name: string): Promise<RemoteFile> {
    const boundary = "bpa-host-state-multipart-boundary";
    const metadata = JSON.stringify({ name, parents: [this.folderId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      await Bun.file(localPath).arrayBuffer(),
      `\r\n--${boundary}--\r\n`,
    ]);
    const response = await this.authorized(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name",
      { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
    );
    if (!response.ok) throw new Error(`Drive upload of ${name} failed (HTTP ${response.status})`);
    const created = (await response.json()) as RemoteFile;
    if (!created.id) throw new Error(`Drive upload of ${name} returned no file id`);
    return created;
  }

  async download(file: RemoteFile, destPath: string): Promise<void> {
    const response = await this.authorized(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
    );
    if (!response.ok) throw new Error(`Drive download of ${file.name} failed (HTTP ${response.status})`);
    mkdirSync(dirname(destPath), { recursive: true });
    await Bun.write(destPath, await response.arrayBuffer());
  }

  async remove(file: RemoteFile): Promise<void> {
    const response = await this.authorized(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) throw new Error(`Drive delete of ${file.name} failed (HTTP ${response.status})`);
  }
}

// ── Instance parameters ────────────────────────────────────────────────────

export type BackupParams = { driveFolderId?: string; serviceAccountKey?: string; keep?: number };

// A deliberately small reader over the `backup:` block of instance/params.yaml,
// matching how tools/check-fleet-cap.ts reads `fleet:`. The repository has no
// YAML dependency and this is not the row that adds one.
export function readBackupParams(repo: string): BackupParams {
  const path = join(repo, PARAMS);
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^backup:\s*(#.*)?$/.test(line));
  if (start < 0) return {};
  const params: BackupParams = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+([a-z_]+):\s*([^\s#]+)/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "drive_folder_id") params.driveFolderId = value;
    if (key === "service_account_key") params.serviceAccountKey = value;
    if (key === "keep") params.keep = Number(value);
  }
  return params;
}

export function makeTransport(spec: string, params: BackupParams): Transport {
  if (spec.startsWith("local:")) {
    const dir = spec.slice("local:".length);
    if (!dir) throw new Error("--dest local: requires a directory");
    return new LocalTransport(dir);
  }
  if (spec.startsWith("drive:")) {
    const folderId = spec.slice("drive:".length);
    if (!folderId) throw new Error("--dest drive: requires a folder id");
    const keyPath = params.serviceAccountKey;
    if (!keyPath) throw new Error(`no backup.service_account_key in ${PARAMS}; Drive uploads have no credential`);
    return new DriveTransport(folderId, keyPath);
  }
  throw new Error(`unrecognised --dest: ${spec} (expected local:<dir> or drive:<folderId>)`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

export const UNENCRYPTED_WARNING =
  "WARNING: writing an UNENCRYPTED host-state archive — it carries live credentials in cleartext at rest; pass --passphrase-file to encrypt it.";

const USAGE = `usage: bun tools/backup-host-state.ts [options]

  --check                  run every verify-command in the inventory and exit
  --verify                 download the newest archive and prove it restores
  (no mode flag)           build, upload, and apply retention

  --repo <path>            repository root (default: cwd)
  --inventory <path>       override the inventory path
  --root <path>            prefix for inventory paths (default: /) — test seam
  --dest local:<dir>|drive:<folderId>   destination (default: params.yaml)
  --keep <n>               archives to retain (default: ${DEFAULT_KEEP})
  --passphrase-file <path> GPG-encrypt the archive with this passphrase
  --dry-run                build and report, upload nothing, delete nothing`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const repo = flag(argv, "--repo") ?? process.cwd();
  const inventoryPath = flag(argv, "--inventory");
  const { rows, errors } = readInventory(repo, inventoryPath);
  if (errors.length) {
    for (const error of errors) console.error(`HOST-STATE ${error}`);
    return 1;
  }

  if (argv.includes("--check")) {
    const results = checkRows(rows);
    for (const { row, ok, detail } of results) console.log(`${ok ? "ok  " : "FAIL"} ${row.path} — ${detail}`);
    const failed = results.filter((result) => !result.ok);
    console.log(failed.length
      ? `HOST-STATE ${failed.length} of ${results.length} row(s) failed verification`
      : `HOST-STATE clean — ${results.length} row(s) verified`);
    return failed.length ? 1 : 0;
  }

  const params = readBackupParams(repo);
  const keep = Number(flag(argv, "--keep") ?? params.keep ?? DEFAULT_KEEP);
  const passphraseFile = flag(argv, "--passphrase-file");
  const destSpec = flag(argv, "--dest")
    ?? (params.driveFolderId ? `drive:${params.driveFolderId}` : undefined);
  if (!destSpec) throw new Error(`no --dest and no backup.drive_folder_id in ${PARAMS}`);
  const transport = makeTransport(destSpec, params);

  if (argv.includes("--verify")) {
    const remote = await transport.list();
    const newest = newestArchive(remote.map((file) => file.name));
    if (!newest) {
      console.error(`HOST-STATE no archive to verify at ${transport.describe()}`);
      return 1;
    }
    const file = remote.find((candidate) => candidate.name === newest)!;
    const workDir = mkdtempSync(join(tmpdir(), "host-state-verify-"));
    try {
      const localCopy = join(workDir, "download", newest);
      await transport.download(file, localCopy);
      const verifyErrors = verifyArchive(localCopy, { workDir: join(workDir, "work"), passphraseFile });
      for (const error of verifyErrors) console.error(`HOST-STATE ${error}`);
      console.log(verifyErrors.length
        ? `HOST-STATE NO-GO — ${newest} did not restore intact`
        : `HOST-STATE clean — ${newest} restored intact from ${transport.describe()}`);
      return verifyErrors.length ? 1 : 0;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (!passphraseFile) console.warn(UNENCRYPTED_WARNING);
  const root = flag(argv, "--root") ?? "/";
  const dryRun = argv.includes("--dry-run");
  const stagingDir = mkdtempSync(join(tmpdir(), "host-state-stage-"));
  const outDir = mkdtempSync(join(tmpdir(), "host-state-out-"));
  try {
    const built = buildArchive(rows, { root, stagingDir, outDir, stamp: archiveStamp(new Date()), passphraseFile });
    const totalBytes = built.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    console.log(`built ${built.name} — ${built.entries.length} row(s), ${totalBytes} B, encrypted=${built.encrypted}`);
    if (dryRun) {
      console.log(`HOST-STATE dry run — nothing uploaded to ${transport.describe()}, nothing deleted`);
      return 0;
    }
    await transport.upload(built.archivePath, built.name);
    console.log(`uploaded ${built.name} to ${transport.describe()}`);

    const remote = await transport.list();
    const doomed = planRetention(remote.map((file) => file.name), keep);
    for (const name of doomed) {
      await transport.remove(remote.find((file) => file.name === name)!);
      console.log(`retention: removed ${name}`);
    }
    console.log(`HOST-STATE clean — ${built.name} uploaded, ${Math.min(keep, remote.length - doomed.length)} archive(s) retained`);
    return 0;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`HOST-STATE ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
