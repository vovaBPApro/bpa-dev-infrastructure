import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RULES_BODY_LINE_BUDGET,
  hasBindingVerb,
  readHomeField,
  runMemorySweep,
  scanMemoryDir,
  scanRulesDir,
  stripFrontmatter,
  stripQuotesAndCode,
} from "./memory-sweep.ts";
import { serializeInboxLine } from "../../daemon/inbox-mirror.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Builds {repoRoot, rulesRoot, memoryRoot}. rules/memory files are written from
// the given maps. Guarantees the tool NEVER sees the real ~/.claude.
function fixture(opts: {
  rules?: Record<string, string>;
  memory?: Record<string, string>;
}): { repo: string; rulesRoot: string; memoryRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "memsweep-"));
  temporaryDirectories.push(base);
  const repo = join(base, "repo");
  const rulesRoot = join(base, "rules");
  const memoryRoot = join(base, "memory");
  mkdirSync(join(repo, "instance", "decisions"), { recursive: true });
  mkdirSync(rulesRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  for (const [name, contents] of Object.entries(opts.rules ?? {})) {
    writeFileSync(join(rulesRoot, name), contents);
  }
  for (const [name, contents] of Object.entries(opts.memory ?? {})) {
    writeFileSync(join(memoryRoot, name), contents);
  }
  return { repo, rulesRoot, memoryRoot };
}

describe("text helpers", () => {
  test("stripFrontmatter removes a leading --- block", () => {
    // The fence match consumes up to one trailing newline; the blank line that
    // separated frontmatter from body remains, which is fine for verb scanning.
    expect(stripFrontmatter("---\ndescription: MUST x\n---\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("no frontmatter\n")).toBe("no frontmatter\n");
  });

  test("stripQuotesAndCode drops blockquotes and fenced code", () => {
    const body = "keep this\n> quoted MUST line\n```\nfenced MUST\n```\nalso keep\n";
    const remaining = stripQuotesAndCode(body);
    expect(remaining).toContain("keep this");
    expect(remaining).toContain("also keep");
    expect(remaining).not.toContain("quoted MUST");
    expect(remaining).not.toContain("fenced MUST");
  });

  test("hasBindingVerb catches English and Ukrainian verbs", () => {
    expect(hasBindingVerb("you MUST do it")).toBe(true);
    expect(hasBindingVerb("NEVER touch prod")).toBe(true);
    expect(hasBindingVerb("завжди роби X")).toBe(true);
    expect(hasBindingVerb("ніколи не")).toBe(true);
    expect(hasBindingVerb("a calm descriptive note")).toBe(false);
    // Not a false positive on substrings of ordinary words.
    expect(hasBindingVerb("the mustard is on the shelf")).toBe(false);
  });

  test("readHomeField reads home: from frontmatter", () => {
    expect(readHomeField("---\nname: x\nhome: tool-permissions\n---\n\nbody\n")).toBe("tool-permissions");
    expect(readHomeField("---\nname: x\n---\n\nbody\n")).toBeUndefined();
    expect(readHomeField("---\nhome:\n---\n\nbody\n")).toBeUndefined();
  });
});

describe("scanRulesDir", () => {
  test("a pointer-only rules file is clean", () => {
    const { rulesRoot } = fixture({
      rules: { "ok.mdc": "---\ndescription: pointer\n---\n\nSee instruction `tool-permissions`.\n" },
    });
    expect(scanRulesDir(rulesRoot)).toHaveLength(0);
  });

  test("frontmatter description with a binding verb does NOT trip the body scan", () => {
    const { rulesRoot } = fixture({
      rules: { "fm.mdc": "---\ndescription: rules you MUST follow\n---\n\nSee `roles`.\n" },
    });
    expect(scanRulesDir(rulesRoot)).toHaveLength(0);
  });

  test("a binding verb in the body is flagged", () => {
    const { rulesRoot } = fixture({
      rules: { "bad.mdc": "---\ndescription: x\n---\n\nYou MUST always run tests.\n" },
    });
    const defects = scanRulesDir(rulesRoot);
    expect(defects.some((d) => d.reason.includes("pointers-only"))).toBe(true);
  });

  test("a quoted binding verb is exempt", () => {
    const { rulesRoot } = fixture({
      rules: { "quoted.mdc": "---\ndescription: x\n---\n\n> Vova: you MUST do it\n\nSee `roles`.\n" },
    });
    expect(scanRulesDir(rulesRoot)).toHaveLength(0);
  });

  test("a body over the pointer budget is flagged", () => {
    const long = "line\n".repeat(RULES_BODY_LINE_BUDGET + 5);
    const { rulesRoot } = fixture({ rules: { "long.mdc": `---\ndescription: x\n---\n\n${long}` } });
    expect(scanRulesDir(rulesRoot).some((d) => d.reason.includes("pointer budget"))).toBe(true);
  });
});

describe("scanMemoryDir", () => {
  test("a rule-stating entry without home: is flagged", () => {
    const { memoryRoot } = fixture({
      memory: { "r.md": "---\nname: r\n---\n\nAgents NEVER touch prod.\n" },
    });
    expect(scanMemoryDir(memoryRoot).some((d) => d.reason.includes("no home"))).toBe(true);
  });

  test("a rule-stating entry WITH home: is clean", () => {
    const { memoryRoot } = fixture({
      memory: { "r.md": "---\nname: r\nhome: tool-permissions\n---\n\nAgents NEVER touch prod.\n" },
    });
    expect(scanMemoryDir(memoryRoot)).toHaveLength(0);
  });

  test("a non-rule (descriptive) memory entry is clean even without home:", () => {
    const { memoryRoot } = fixture({
      memory: { "note.md": "---\nname: n\n---\n\nThe log path is prod-start.log.\n" },
    });
    expect(scanMemoryDir(memoryRoot)).toHaveLength(0);
  });

  test("MEMORY.md index is skipped", () => {
    const { memoryRoot } = fixture({
      memory: { "MEMORY.md": "# Index\n\nEntries MUST be listed.\n" },
    });
    expect(scanMemoryDir(memoryRoot)).toHaveLength(0);
  });

  test("a verbatim-quoted rule in memory is exempt (no false positive)", () => {
    const { memoryRoot } = fixture({
      memory: { "verbatim.md": "---\nname: v\n---\n\nVova said:\n\n> ти МUST це зробити\n\nnote.\n" },
    });
    expect(scanMemoryDir(memoryRoot)).toHaveLength(0);
  });
});

describe("runMemorySweep — filing + non-destructiveness", () => {
  test("files one JSONL row per defect with the memory-sweep-defect kind", () => {
    const { repo, rulesRoot, memoryRoot } = fixture({
      rules: { "bad.mdc": "---\ndescription: x\n---\n\nYou MUST run tests.\n" },
      memory: { "r.md": "---\nname: r\n---\n\nAgents NEVER touch prod.\n" },
    });
    const result = runMemorySweep({ repo, rulesRoot, memoryRoot, dryRun: false, nowIso: "2026-07-29T00:00:00.000Z" });
    expect(result.defects).toHaveLength(2);
    expect(result.filed).toBe(2);

    const inbox = join(repo, "instance", "decisions", "inbox.jsonl");
    const lines = readFileSync(inbox, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { msg_id: string; chat_id: string; ts: string; text: string };
      expect(String(row.msg_id)).toContain("memsweep-");
      expect(row.chat_id).toBe("memory-sweep");
      const payload = JSON.parse(row.text) as { kind: string };
      expect(payload.kind).toBe("memory-sweep-defect");
    }
  });

  test("append shape matches the daemon serializer exactly", () => {
    const { repo, rulesRoot, memoryRoot } = fixture({
      rules: { "bad.mdc": "---\ndescription: x\n---\n\nMUST do X.\n" },
    });
    const result = runMemorySweep({ repo, rulesRoot, memoryRoot, dryRun: false, nowIso: "2026-07-29T00:00:00.000Z" });
    const inbox = join(repo, "instance", "decisions", "inbox.jsonl");
    const actual = readFileSync(inbox, "utf8");
    const defect = result.defects[0];
    const expected = serializeInboxLine({
      msg_id: "memsweep-2026-07-29T00:00:00.000Z-0",
      chat_id: "memory-sweep",
      ts: "2026-07-29T00:00:00.000Z",
      text: JSON.stringify({ kind: defect.kind, surface: defect.surface, file: defect.file, reason: defect.reason }),
    });
    expect(actual).toBe(expected);
  });

  test("--dry-run files NOTHING", () => {
    const { repo, rulesRoot, memoryRoot } = fixture({
      rules: { "bad.mdc": "---\ndescription: x\n---\n\nMUST do X.\n" },
    });
    const result = runMemorySweep({ repo, rulesRoot, memoryRoot, dryRun: true });
    expect(result.defects.length).toBeGreaterThan(0);
    expect(result.filed).toBe(0);
    expect(existsSync(join(repo, "instance", "decisions", "inbox.jsonl"))).toBe(false);
  });

  test("is non-destructive: rules and memory files are untouched", () => {
    const rulesBody = "---\ndescription: x\n---\n\nMUST do X.\n";
    const memBody = "---\nname: r\n---\n\nAgents NEVER touch prod.\n";
    const { repo, rulesRoot, memoryRoot } = fixture({
      rules: { "bad.mdc": rulesBody },
      memory: { "r.md": memBody },
    });
    runMemorySweep({ repo, rulesRoot, memoryRoot, dryRun: false, nowIso: "2026-07-29T00:00:00.000Z" });
    expect(readFileSync(join(rulesRoot, "bad.mdc"), "utf8")).toBe(rulesBody);
    expect(readFileSync(join(memoryRoot, "r.md"), "utf8")).toBe(memBody);
  });

  test("a clean tree files nothing and reports zero defects", () => {
    const { repo, rulesRoot, memoryRoot } = fixture({
      rules: { "ok.mdc": "---\ndescription: p\n---\n\nSee `roles`.\n" },
      memory: { "ok.md": "---\nname: n\nhome: roles\n---\n\nAgents NEVER touch prod.\n" },
    });
    const result = runMemorySweep({ repo, rulesRoot, memoryRoot, dryRun: false });
    expect(result.defects).toHaveLength(0);
    expect(result.filed).toBe(0);
  });
});
