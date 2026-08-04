import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDocs } from "./docs.ts";
import {
  createPathResolver,
  extractBacktickedPathTokens,
  extractPathTokens,
  normalizePathToken,
  readPathExemptions,
  runPathChecks,
  PATH_EXEMPTIONS_FILE,
} from "./paths.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// A real git repository: the predicate under test asks git what the repository
// carries, so a fixture that is not a repo would exercise the fallback instead
// of the production path.
function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "instr-paths-"));
  temporaryDirectories.push(repo);
  mkdirSync(join(repo, "instructions"), { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]);
  return repo;
}

function plainDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "instr-plain-"));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, "instructions"), { recursive: true });
  return dir;
}

// Writes a file and, unless told otherwise, tracks it — `git add` is enough,
// since ls-files reads the index.
function write(repo: string, relative: string, contents: string, track = true): void {
  const full = join(repo, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  if (track) spawnSync("git", ["-C", repo, "add", "--", relative]);
}

const BINDING = [
  "---",
  "id: demo",
  "layer: L1",
  "status: binding",
  "audience: all",
  "tags: [hygiene]",
  "summary: A binding doc.",
  "---",
  "",
].join("\n");

function bindingDoc(body: string): string {
  return `${BINDING}\n${body}\n`;
}

// Runs the check over a repo, returning findings for easier assertions.
function run(repo: string) {
  return runPathChecks(repo, collectDocs(join(repo, "instructions")));
}

function details(findings: ReturnType<typeof run>, level: string): string[] {
  return findings.filter((finding) => finding.level === level).map((finding) => finding.detail);
}

describe("normalizePathToken — what counts as a repo-relative path", () => {
  test("accepts a plain file path and an explicit directory", () => {
    expect(normalizePathToken("gate/land.sh")).toBe("gate/land.sh");
    expect(normalizePathToken("instructions/")).toBe("instructions/");
    expect(normalizePathToken("tools/instructions/check.ts")).toBe("tools/instructions/check.ts");
  });

  test("strips the prose wrapping a citation carries", () => {
    expect(normalizePathToken("(gate/land.sh,")).toBe("gate/land.sh");
    expect(normalizePathToken("gate/land.sh.")).toBe("gate/land.sh");
    expect(normalizePathToken("«instance/params.yaml»")).toBe("instance/params.yaml");
  });

  test("strips a line or anchor suffix — the file is still the claim", () => {
    expect(normalizePathToken("daemon/server.ts:1593")).toBe("daemon/server.ts");
    expect(normalizePathToken("tools/state-contract/check.ts:FLEET-IDLE")).toBe("tools/state-contract/check.ts");
  });

  test("rejects what is not a repo-relative path", () => {
    // Absolute and home paths are host state, not a claim about this repo.
    expect(normalizePathToken("/etc/systemd/system/foo.service")).toBeUndefined();
    expect(normalizePathToken("~/.claude/settings.json")).toBeUndefined();
    // Git refs and other slashed prose have no extension and no trailing slash.
    expect(normalizePathToken("origin/main")).toBeUndefined();
    expect(normalizePathToken("refs/stash")).toBeUndefined();
    expect(normalizePathToken("Europe/Warsaw")).toBeUndefined();
    // Shell and template forms.
    expect(normalizePathToken("origin/main...HEAD")).toBeUndefined();
    expect(normalizePathToken("instance/decisions/HR-<telegram-msg-id>.md")).toBeUndefined();
    expect(normalizePathToken("release/YYYY-MM-DD[.N]")).toBeUndefined();
    expect(normalizePathToken("git@github.com:vova/repo.git")).toBeUndefined();
    expect(normalizePathToken("https://example.test/a.md")).toBeUndefined();
    // A bare filename names no directory, so it is not treated as a path.
    expect(normalizePathToken("CLAUDE.md")).toBeUndefined();
  });
});

describe("token extraction", () => {
  test("a code span holding a whole command yields only its path token", () => {
    expect(extractBacktickedPathTokens("Run `bun tools/instructions/check.ts --repo <path>` now.")).toEqual([
      "tools/instructions/check.ts",
    ]);
  });

  test("prose outside backticks is not scanned in a document", () => {
    expect(extractBacktickedPathTokens("See gate/land-batch.sh for details.")).toEqual([]);
  });

  test("bare text is scanned for params.yaml-style citations", () => {
    expect(extractPathTokens("mode: manual  # instructions/orchestrator-fallback.md, see also x")).toEqual([
      "instructions/orchestrator-fallback.md",
    ]);
  });
});

describe("the existence predicate is what git carries, not what the host has", () => {
  test("an untracked file on disk does not satisfy a citation", () => {
    const repo = scratchRepo();
    write(repo, "gate/land.sh", "", false);
    expect(createPathResolver(repo).satisfied("gate/land.sh")).toBe(false);
    write(repo, "gate/land.sh", "");
    expect(createPathResolver(repo).satisfied("gate/land.sh")).toBe(true);
  });

  test("an empty directory satisfies nothing — git carries no such thing", () => {
    // `stand/` is exactly this on the canonical host: an empty leftover that
    // made the citation look true there and false in every lane worktree.
    const repo = scratchRepo();
    mkdirSync(join(repo, "stand"));
    expect(createPathResolver(repo).satisfied("stand/")).toBe(false);
    write(repo, "stand/compose.yaml", "");
    expect(createPathResolver(repo).satisfied("stand/")).toBe(true);
  });

  test("a trailing slash demands a directory, not a file of that name", () => {
    const repo = scratchRepo();
    write(repo, "soak", "a file, not a directory\n");
    expect(createPathResolver(repo).satisfied("soak/")).toBe(false);
    expect(createPathResolver(repo).satisfied("soak")).toBe(true);
  });

  test("a glob is answered by its deepest literal ancestor", () => {
    const repo = scratchRepo();
    write(repo, "instructions/doc.md", "");
    const resolver = createPathResolver(repo);
    expect(resolver.satisfied("instructions/**/*.md")).toBe(true);
    expect(resolver.satisfied("tools/state-contract/*.ts")).toBe(false);
  });

  test("outside a git repository the fallback is loud, not silent", () => {
    const dir = plainDirectory();
    expect(createPathResolver(dir).mode).toBe("filesystem");
    writeFileSync(join(dir, "instructions", "binding.md"), bindingDoc("Cites `gate/land-batch.sh`."));
    const warnings = details(run(dir), "WARN").join("\n");
    expect(warnings).toContain("not a git repository");
  });
});

describe("path-exists over binding sources", () => {
  test("a binding doc naming a missing path FAILs; an informational one does not", () => {
    const repo = scratchRepo();
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land-batch.sh`."));
    write(
      repo,
      "instructions/info.md",
      `${BINDING.replace("status: binding", "status: informational").replace("id: demo", "id: info")}\nSee \`gate/also-absent.sh\`.\n`,
    );
    expect(details(run(repo), "FAIL")).toEqual([
      "missing 'gate/land-batch.sh' — the document names a path the repository does not carry",
    ]);
  });

  test("CLAUDE.md and instance/params.yaml are checked like binding docs", () => {
    const repo = scratchRepo();
    write(repo, "CLAUDE.md", "Entry points: `instance/README.md`.\n");
    write(repo, "instance/params.yaml", "fleet_idle_check: tools/state-contract/check.ts:FLEET-IDLE\n");
    const failures = details(run(repo), "FAIL").join("\n");
    expect(failures).toContain("instance/README.md");
    expect(failures).toContain("tools/state-contract/check.ts");
  });

  test("a tracked path passes and is counted, not listed", () => {
    const repo = scratchRepo();
    write(repo, "gate/land.sh", "");
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land.sh`."));
    const findings = run(repo);
    expect(details(findings, "FAIL")).toEqual([]);
    expect(details(findings, "PASS")).toContain("1 referenced path exists");
  });
});

describe("the exemption ledger is itself checked", () => {
  const exempt = (rows: string[]) => `# header\n${rows.join("\n")}\n`;

  test("an exemption downgrades the failure to a visible WARN", () => {
    const repo = scratchRepo();
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land-batch.sh`."));
    write(
      repo,
      PATH_EXEMPTIONS_FILE,
      exempt(["instructions/binding.md\tgate/land-batch.sh\tpending-V3-2.13\tpolicy question, own row"]),
    );
    const findings = run(repo);
    expect(details(findings, "FAIL")).toEqual([]);
    expect(details(findings, "WARN")[0]).toContain("exempt 'gate/land-batch.sh' (reason=pending-V3-2.13)");
  });

  test("removing the exemption for a still-absent path turns it red again", () => {
    const repo = scratchRepo();
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land-batch.sh`."));
    write(repo, PATH_EXEMPTIONS_FILE, exempt([]));
    expect(details(run(repo), "FAIL")).toEqual([
      "missing 'gate/land-batch.sh' — the document names a path the repository does not carry",
    ]);
  });

  test("an exemption naming a path the repository DOES carry is rejected", () => {
    const repo = scratchRepo();
    write(repo, "gate/land.sh", "");
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land.sh`."));
    write(repo, PATH_EXEMPTIONS_FILE, exempt(["instructions/binding.md\tgate/land.sh\tplanned\tstale row"]));
    const failures = details(run(repo), "FAIL");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("'gate/land.sh' now exists — remove this exemption");
  });

  test("reason=generated holds only while the repository really ignores the path", () => {
    const repo = scratchRepo();
    write(repo, ".gitignore", "inbox.jsonl\n");
    write(repo, "instance/decisions/inbox.jsonl", "", false);
    write(repo, "instructions/binding.md", bindingDoc("Raw capture lives in `instance/decisions/inbox.jsonl`."));
    const row = "instructions/binding.md\tinstance/decisions/inbox.jsonl\tgenerated\tgitignored raw capture";
    write(repo, PATH_EXEMPTIONS_FILE, exempt([row]));
    // Ignored and untracked: the citation is exempt, in this tree and in every
    // other one, because the answer no longer depends on the host.
    expect(details(run(repo), "FAIL")).toEqual([]);

    // Drop the ignore rule and the same row is a bare missing file wearing a
    // reason it cannot support.
    write(repo, ".gitignore", "something-else\n");
    expect(details(run(repo), "FAIL")[0]).toContain("does not ignore 'instance/decisions/inbox.jsonl'");
  });

  test("a row nobody consults FAILs, so dead exemptions cannot accumulate", () => {
    const repo = scratchRepo();
    write(repo, "instructions/binding.md", bindingDoc("No paths here."));
    write(
      repo,
      PATH_EXEMPTIONS_FILE,
      exempt(["instructions/binding.md\tgate/land-batch.sh\tplanned\tno longer cited"]),
    );
    expect(details(run(repo), "FAIL")[0]).toContain("never consulted");
  });

  test("malformed rows fail closed rather than being dropped", () => {
    const repo = scratchRepo();
    const rows = [
      "instructions/binding.md\tgate/a.sh\tplanned", // 3 columns
      "instructions/binding.md\tgate/b.sh\tbecause-i-said-so\tunknown reason",
      "instructions/binding.md\tnot a path\tplanned\tnever produced by the scanner",
      "instructions/binding.md\tgate/c.sh\tplanned\tfirst",
      "instructions/binding.md\tgate/c.sh\tplanned\tduplicate",
    ];
    write(repo, "instructions/binding.md", bindingDoc("Cites `gate/c.sh`."));
    write(repo, PATH_EXEMPTIONS_FILE, exempt(rows));
    const failures = details(run(repo), "FAIL").join("\n");
    expect(failures).toContain("expected 4 non-empty tab-separated fields");
    expect(failures).toContain("unknown reason 'because-i-said-so'");
    expect(failures).toContain("is not a path this check can ever produce");
    expect(failures).toContain("duplicate exemption");
  });

  test("a missing ledger is the fail-closed direction, not a skip", () => {
    const repo = scratchRepo();
    write(repo, "instructions/binding.md", bindingDoc("The gate is `gate/land-batch.sh`."));
    expect(readPathExemptions(repo).rows.size).toBe(0);
    expect(details(run(repo), "FAIL")).toHaveLength(1);
  });
});
