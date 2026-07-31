import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { admitsAudience, PACK_MARKER_PREFIX } from "./compose.ts";
import { PERSONA_HEADER, PERSONA_SECTIONS } from "./personas.ts";

const composer = join(import.meta.dir, "compose.ts");
const checker = join(import.meta.dir, "check.ts");
const coderGolden = join(import.meta.dir, "__fixtures__", "compose-coder-golden.json");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// A minimal-but-complete instance/ + instructions/ repo. `docs` maps a filename
// under instructions/ to its contents; `tags`/`packs`/`decisions` populate the
// instance/ config used by the composer.
function repoWith(spec: {
  docs: Record<string, string>;
  tags: string;
  packs: string;
  decisions?: Record<string, string>;
  personas?: Record<string, string>;
  params?: string;
}): string {
  const repo = mkdtempSync(join(tmpdir(), "compose-"));
  temporaryDirectories.push(repo);
  const instrRoot = join(repo, "instructions");
  mkdirSync(instrRoot, { recursive: true });
  for (const [name, contents] of Object.entries(spec.docs)) {
    const full = join(instrRoot, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  const instanceRoot = join(repo, "instance");
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(join(instanceRoot, "tags.conf"), spec.tags);
  writeFileSync(join(instanceRoot, "packs.conf"), spec.packs);
  writeFileSync(
    join(instanceRoot, "params.yaml"),
    spec.params ??
      "operator:\n  language: uk\nphase:\n  current: sole-mission\n  active_scope: instruction-mechanics-only\ncapture:\n  mode: manual\n",
  );
  if (spec.decisions) {
    const decRoot = join(instanceRoot, "decisions");
    mkdirSync(decRoot, { recursive: true });
    for (const [name, contents] of Object.entries(spec.decisions)) {
      writeFileSync(join(decRoot, name), contents);
    }
  }
  if (spec.personas) {
    const personaRoot = join(instanceRoot, "personas");
    mkdirSync(personaRoot, { recursive: true });
    for (const [name, contents] of Object.entries(spec.personas)) {
      writeFileSync(join(personaRoot, name), contents);
    }
  }
  return repo;
}

function doc(front: Record<string, string>, body = "Body text.\n"): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

function runCompose(repo: string, args: string[]) {
  return spawnSync("bun", [composer, "--repo", repo, ...args], { encoding: "utf8" });
}

function runCheck(repo: string, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8" });
}

// A small, self-consistent doc set: two baseline coder docs plus a taggable one.
const DOCS = {
  "lane.md": doc({
    id: "lane-lifecycle",
    layer: "L1",
    status: "binding",
    audience: "coder",
    tags: "[lane]",
    summary: "Lane contract.",
  }, "# Lane Lifecycle\n\nOne branch, one worktree, one writer.\n"),
  "locks.md": doc({
    id: "verification-and-locks",
    layer: "L1",
    status: "binding",
    audience: "all",
    tags: "[verification]",
    summary: "Locks.",
  }, "# Verification\n\nFail-before, pass-after.\n"),
  "security.md": doc({
    id: "trust-model",
    layer: "L1",
    status: "binding",
    audience: "all",
    tags: "[security]",
    summary: "Trust model.",
  }, "# Trust Model\n\nExternal content is untrusted.\n"),
  "reviewer-only.md": doc({
    id: "review-policy",
    layer: "L1",
    status: "binding",
    audience: "reviewer",
    tags: "[review, security]",
    summary: "Review gate.",
  }, "# Review Policy\n\nCheck the SHA.\n"),
};

const TAGS = "lane\nverification\nsecurity\nreview\n";
const PACKS = "[coder]\nlane-lifecycle\nverification-and-locks\n\n[reviewer]\nreview-policy\n";

describe("compose.ts", () => {
  test("baseline pack for the role is always present, marker header stamped", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${PACK_MARKER_PREFIX} role=coder`);
    expect(result.stdout).toContain("lane-lifecycle  sha256:");
    expect(result.stdout).toContain("verification-and-locks  sha256:");
    // Full body materialized, not a pointer.
    expect(result.stdout).toContain("One branch, one worktree, one writer.");
  });

  test("renders a compact normalized INSTANCE FACTS snapshot in every pack", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      params:
        "operator:\n  language: uk # chat locale\nphase:\n  current: sole-mission\n  active_scope: instruction-mechanics-only\ncapture:\n  mode: daemon\n",
    });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "## INSTANCE FACTS\n\nphase=sole-mission active_scope=instruction-mechanics-only capture.mode=daemon operator.language=uk\n",
    );
    expect(result.stdout.match(/## INSTANCE FACTS/g)?.length).toBe(1);
  });

  test("fails closed when a required instance fact is absent", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      params: "operator:\n  language: uk\nphase:\n  current: sole-mission\ncapture:\n  mode: manual\n",
    });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("phase.active_scope");
  });

  test("--tags ADDS a matching doc; baseline is never removed", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const withTag = runCompose(repo, ["--role", "coder", "--tags", "security"]);
    expect(withTag.status).toBe(0);
    // Baseline still there.
    expect(withTag.stdout).toContain("lane-lifecycle  sha256:");
    // Added by tag.
    expect(withTag.stdout).toContain("trust-model  sha256:");
    expect(withTag.stdout).toContain("(tag)");
    expect(withTag.stdout).toContain("External content is untrusted.");
  });

  test("a tag cannot remove a baseline doc (empty tags keeps full baseline)", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const base = runCompose(repo, ["--role", "coder"]);
    const tagged = runCompose(repo, ["--role", "coder", "--tags", "security"]);
    // Everything in the baseline manifest is still in the tagged manifest.
    for (const id of ["lane-lifecycle", "verification-and-locks"]) {
      expect(base.stdout).toContain(`${id}  sha256:`);
      expect(tagged.stdout).toContain(`${id}  sha256:`);
    }
  });

  test("unknown tag is a hard error, non-zero exit", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const result = runCompose(repo, ["--role", "coder", "--tags", "not-a-real-tag"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown tag 'not-a-real-tag'");
  });

  test("audience filter: a reviewer-only doc is excluded from the coder pack even via tag", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    // review-policy is audience:reviewer and tagged [review, security]. A coder
    // requesting `security` must NOT receive it.
    const coder = runCompose(repo, ["--role", "coder", "--tags", "security"]);
    expect(coder.stdout).not.toContain("review-policy  sha256:");
    // But a reviewer requesting the same tag does receive it.
    const reviewer = runCompose(repo, ["--role", "reviewer", "--tags", "security"]);
    expect(reviewer.stdout).toContain("review-policy  sha256:");
  });

  test("manifest hash matches the materialized content", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const out = join(repo, "out");
    const result = runCompose(repo, ["--role", "coder", "--out", out]);
    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const hasher = require("node:crypto");
    for (const entry of manifest.docs) {
      const body = readFileSync(join(out, "context", `${entry.id}.md`), "utf8");
      const hash = hasher.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
      expect(hash).toBe(entry.hash);
    }
  });

  test("--out writes context/ files and manifest.json", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const out = join(repo, "out");
    runCompose(repo, ["--role", "coder", "--out", out]);
    expect(existsSync(join(out, "preamble.md"))).toBe(true);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(existsSync(join(out, "context", "lane-lifecycle.md"))).toBe(true);
    expect(existsSync(join(out, "context", "verification-and-locks.md"))).toBe(true);
  });

  test("a pending decision appears in the pack; a routed one does not", () => {
    const pending = doc(
      { id: "hr-9001", state: "pending" },
      "# HR-9001\n\nDo the pending thing now.\n",
    );
    const routed = doc(
      { id: "hr-9002", state: "routed" },
      "# HR-9002\n\nAlready routed, do not deliver.\n",
    );
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      decisions: { "HR-9001.md": pending, "HR-9002.md": routed },
    });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INTERIM DIRECTIVES");
    expect(result.stdout).toContain("hr-9001  sha256:");
    expect(result.stdout).toContain("Do the pending thing now.");
    // Routed one must be absent.
    expect(result.stdout).not.toContain("hr-9002");
    expect(result.stdout).not.toContain("Already routed, do not deliver.");
  });

  test("no INTERIM DIRECTIVES section when nothing is pending", () => {
    const routed = doc({ id: "hr-9002", state: "routed" }, "# HR-9002\n\nRouted.\n");
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      decisions: { "HR-9002.md": routed },
    });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.stdout).not.toContain("INTERIM DIRECTIVES");
  });

  test("--assert-budget trips with exit 1 when the preamble is too large", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const tripped = runCompose(repo, ["--role", "coder", "--assert-budget", "3"]);
    expect(tripped.status).toBe(1);
    expect(tripped.stderr).toContain("exceeds --assert-budget");
    // Generous budget passes.
    const ok = runCompose(repo, ["--role", "coder", "--assert-budget", "100000"]);
    expect(ok.status).toBe(0);
  });

  test("missing --role is a usage error", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const result = runCompose(repo, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--role is required");
  });

  test("a baseline id whose audience excludes the role is a config error", () => {
    // reviewer baseline points at an audience:coder doc.
    const badPacks = "[reviewer]\nlane-lifecycle\n";
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: badPacks });
    const result = runCompose(repo, ["--role", "reviewer"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not deliverable to role 'reviewer'");
  });

  test("a baseline id that resolves to no doc is a config error", () => {
    const badPacks = "[coder]\nno-such-doc\n";
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: badPacks });
    const result = runCompose(repo, ["--role", "coder"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("resolves to no doc");
  });

  const PERSONA_BODY =
    `${PERSONA_HEADER}\n\n# Denys — coder lane, simplicity-first\n\n` +
    PERSONA_SECTIONS.map((section) => `${section}\n\nThe smallest correct change.\n`).join("\n");
  const PERSONA_OK =
    "---\npersona: denys\nrole: coder\nrole-mapping: real\n" +
    "status: draft-for-discussion\nsummary: Simplicity-first coder.\n---\n\n" +
    PERSONA_BODY;
  const PERSONA_REVIEWER =
    PERSONA_OK
      .replace("persona: denys", "persona: bohdan")
      .replace("role: coder", "role: reviewer")
      .replace("Simplicity-first coder.", "Adversarial reviewer.");

  test("without --persona the coder output is byte-identical to the committed pre-feature golden", () => {
    const bare = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const result = runCompose(bare, ["--role", "coder"]);
    expect(result.status).toBe(0);
    const golden = JSON.parse(readFileSync(coderGolden, "utf8")).preamble as string;
    if (result.stdout !== golden) {
      const firstDifference = [...result.stdout].findIndex(
        (character, index) => character !== golden[index],
      );
      throw new Error(
        "persona-less coder preamble differs from the committed pre-feature golden; " +
          "regenerate the fixture only for an intentional, separately reviewed default-render change " +
          `(first differing byte ${firstDifference}; actual=${result.stdout.length}, ` +
          `golden=${golden.length})`,
      );
    }
  });

  test("without --persona registry presence does not change any output byte", () => {
    const bare = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const withRegistry = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": PERSONA_OK },
    });
    const a = runCompose(bare, ["--role", "coder"]);
    const b = runCompose(withRegistry, ["--role", "coder"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe(a.stdout); // byte-identical: no-persona path never changes
    expect(b.stdout).not.toContain("PERSONA");
  });

  test("--persona injects the delimited profile section plus a manifest row", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": PERSONA_OK },
    });
    const result = runCompose(repo, ["--role", "coder", "--persona", "denys"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## PERSONA (behavior only)");
    expect(result.stdout).toContain("- denys  sha256:");
    expect(result.stdout).toContain("(persona)");
    expect(result.stdout).toMatch(
      /<!-- persona name=denys sha256:[0-9a-f]{12} source=instance\/personas\/denys\.md -->/,
    );
    // Full profile materialized, header line included.
    expect(result.stdout).toContain(PERSONA_HEADER);
    expect(result.stdout).toContain("The smallest correct change.");
    // Baseline floor untouched.
    expect(result.stdout).toContain("lane-lifecycle  sha256:");
  });

  test("--persona refuses a role mismatch with exit 2", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "bohdan.md": PERSONA_REVIEWER },
    });
    const result = runCompose(repo, ["--role", "coder", "--persona", "bohdan"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "persona 'bohdan' declares role 'reviewer', requested role 'coder'",
    );
  });

  test("--persona accepts a matching declared role", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": PERSONA_OK },
    });
    const result = runCompose(repo, ["--role", "coder", "--persona", "denys"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## PERSONA (behavior only)");
  });

  test("unknown persona is a hard error, non-zero exit", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": PERSONA_OK },
    });
    const result = runCompose(repo, ["--role", "coder", "--persona", "nobody"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown persona 'nobody'");
  });

  test("a profile missing the mandatory header is a hard error via --persona", () => {
    const broken =
      "---\npersona: denys\nrole: coder\nrole-mapping: real\n" +
      "status: draft-for-discussion\nsummary: Broken.\n---\n\n# No header first\n\n" +
      PERSONA_SECTIONS.map((section) => `${section}\n\nText.\n`).join("\n");
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": broken },
    });
    const result = runCompose(repo, ["--role", "coder", "--persona", "denys"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mandatory BEHAVIOR ONLY header");
  });

  test("all malformed profile structures fail --persona with exit 2 and concrete errors", () => {
    const validBody = PERSONA_BODY;
    const front =
      "---\npersona: denys\nrole: coder\nrole-mapping: real\n" +
      "status: draft-for-discussion\nsummary: Simplicity-first coder.\n---\n\n";
    const rows = [
      {
        name: "missing summary",
        contents: PERSONA_OK.replace("summary: Simplicity-first coder.\n", ""),
        error: "missing or empty required field: summary",
      },
      {
        name: "empty body",
        contents: front,
        error: "persona body is empty",
      },
      {
        name: "header-only body",
        contents: front + PERSONA_HEADER + "\n",
        error: "persona body contains only the mandatory BEHAVIOR ONLY header",
      },
      {
        name: "wrong section order",
        contents:
          front + `${PERSONA_HEADER}\n\n# Denys\n\n` +
          [...PERSONA_SECTIONS].reverse()
            .map((section) => `${section}\n\nText.\n`)
            .join("\n"),
        error: "required sections are out of order",
      },
      {
        name: "duplicate section",
        contents:
          front + validBody + `\n${PERSONA_SECTIONS[0]}\n\nMore text.\n`,
        error: "duplicate required section '## Optimization target' (found 2)",
      },
      {
        name: "empty section",
        contents:
          front + `${PERSONA_HEADER}\n\n# Denys\n\n` +
          PERSONA_SECTIONS.map((section) =>
            section === "## Review & communication style"
              ? `${section}\n\n`
              : `${section}\n\nText.\n`
          ).join("\n"),
        error: "required section '## Review & communication style' has no content",
      },
      {
        name: "unexpected section",
        contents: front + validBody + "\n## Extra\n\nText.\n",
        error: "unexpected section heading '## Extra'",
      },
      {
        name: "filename/frontmatter mismatch",
        contents: PERSONA_OK.replace("persona: denys", "persona: bohdan"),
        error: "persona name 'bohdan' does not match filename 'denys.md'",
      },
    ];

    for (const row of rows) {
      const repo = repoWith({
        docs: DOCS,
        tags: TAGS,
        packs: PACKS,
        personas: { "denys.md": row.contents },
      });
      const result = runCompose(repo, ["--role", "coder", "--persona", "denys"]);
      expect(result.status, row.name).toBe(2);
      expect(result.stderr, row.name).toContain(row.error);
    }
  });

  test("--out with a persona writes the profile and records it in manifest.json", () => {
    const repo = repoWith({
      docs: DOCS,
      tags: TAGS,
      packs: PACKS,
      personas: { "denys.md": PERSONA_OK },
    });
    const out = join(repo, "out");
    const result = runCompose(repo, ["--role", "coder", "--persona", "denys", "--out", out]);
    expect(result.status).toBe(0);
    expect(existsSync(join(out, "context", "persona-denys.md"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.persona.name).toBe("denys");
    // Without a persona the manifest has no persona key at all (byte-stability).
    const outBare = join(repo, "out-bare");
    runCompose(repo, ["--role", "coder", "--out", outBare]);
    const bareManifest = JSON.parse(readFileSync(join(outBare, "manifest.json"), "utf8"));
    expect("persona" in bareManifest).toBe(false);
  });

  test("manager receives orchestrator-audience docs", () => {
    const orchDoc = doc(
      { id: "orch-playbook", layer: "L1", status: "binding", audience: "orchestrator", tags: "[playbook]", summary: "P." },
      "# Orchestrator Playbook\n\nDispatch, verify, land.\n",
    );
    const repo = repoWith({
      docs: { ...DOCS, "orch.md": orchDoc },
      tags: TAGS + "playbook\n",
      packs: PACKS + "\n[manager]\norch-playbook\n",
    });
    const result = runCompose(repo, ["--role", "manager"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("orch-playbook  sha256:");
    expect(result.stdout).toContain("Dispatch, verify, land.");
  });
});

describe("admitsAudience", () => {
  test("all reaches every role; own audience always admitted", () => {
    for (const role of ["coder", "reviewer", "orchestrator", "manager"] as const) {
      expect(admitsAudience(role, "all")).toBe(true);
      expect(admitsAudience(role, role)).toBe(true);
    }
  });

  test("manager (and only manager) also gets orchestrator docs", () => {
    expect(admitsAudience("manager", "orchestrator")).toBe(true);
    expect(admitsAudience("coder", "orchestrator")).toBe(false);
    expect(admitsAudience("reviewer", "orchestrator")).toBe(false);
  });

  test("cross-role leakage is otherwise blocked", () => {
    expect(admitsAudience("coder", "reviewer")).toBe(false);
    expect(admitsAudience("reviewer", "coder")).toBe(false);
    expect(admitsAudience("orchestrator", "coder")).toBe(false);
  });
});

describe("pack-coverage check (check.ts [pack-coverage])", () => {
  // A binding doc that is neither in a baseline nor carries a real tag nor
  // opts out with pack:none is unreachable → WARN by default, FAIL --strict.
  const unreachableDocs = {
    "lane.md": DOCS["lane.md"],
    "locks.md": DOCS["locks.md"],
    "orphan.md": doc({
      id: "orphan-rule",
      layer: "L1",
      status: "binding",
      audience: "all",
      tags: "[nonexistent-tag]",
      summary: "Unreachable.",
    }, "# Orphan\n\nFiled but never delivered.\n"),
  };
  // tags.conf deliberately does NOT list `nonexistent-tag`.
  const coverageTags = "lane\nverification\n";
  const coveragePacks = "[coder]\nlane-lifecycle\nverification-and-locks\n";

  test("catches an unreachable binding doc: WARN default, FAIL under --strict", () => {
    const repo = repoWith({ docs: unreachableDocs, tags: coverageTags, packs: coveragePacks });
    const lenient = runCheck(repo);
    expect(lenient.stdout).toContain("WARN orphan.md [pack-coverage]");
    expect(lenient.status).toBe(0);

    const strict = runCheck(repo, ["--strict"]);
    expect(strict.stdout).toContain("FAIL orphan.md [pack-coverage]");
    expect(strict.status).toBe(1);
  });

  test("accepts an opted-out doc via pack: none", () => {
    const optedOut = {
      ...unreachableDocs,
      "orphan.md": doc({
        id: "orphan-rule",
        layer: "L1",
        status: "binding",
        audience: "all",
        tags: "[nonexistent-tag]",
        summary: "Unreachable but opted out.",
        pack: "none",
      }, "# Orphan\n\nIntentionally undelivered.\n"),
    };
    const repo = repoWith({ docs: optedOut, tags: coverageTags, packs: coveragePacks });
    const strict = runCheck(repo, ["--strict"]);
    expect(strict.stdout).toContain("PASS orphan.md [pack-coverage]");
    expect(strict.stdout).toContain("opted out via pack: none");
    expect(strict.status).toBe(0);
  });

  test("a doc reachable via a known tag passes coverage", () => {
    const repo = repoWith({ docs: DOCS, tags: TAGS, packs: PACKS });
    const strict = runCheck(repo, ["--strict"]);
    // trust-model is not in any baseline but its tag `security` is in tags.conf.
    expect(strict.stdout).toContain("PASS security.md [pack-coverage]");
    expect(strict.stdout).toContain("reachable via a known tag");
  });

  test("pack-coverage SKIPs when instance config is absent", () => {
    const repo = mkdtempSync(join(tmpdir(), "compose-nocfg-"));
    temporaryDirectories.push(repo);
    const instrRoot = join(repo, "instructions");
    mkdirSync(instrRoot, { recursive: true });
    writeFileSync(join(instrRoot, "lane.md"), DOCS["lane.md"]);
    const result = runCheck(repo, ["--strict"]);
    expect(result.stdout).toContain("SKIP instance/ [pack-coverage]");
  });
});

// Runs the composer against the REAL repo for each role and records line counts.
// Guards the fail-closed guarantees hold on production config, not just fixtures.
describe("compose.ts against the real repo", () => {
  const repoRoot = join(import.meta.dir, "..", "..");

  test("every role renders a non-empty pack with a stamped marker", () => {
    for (const role of ["coder", "reviewer", "orchestrator", "manager"] as const) {
      const result = runCompose(repoRoot, ["--role", role]);
      expect(result.status).toBe(0);
      const lines = result.stdout.split("\n").length;
      expect(lines).toBeGreaterThan(20);
      expect(result.stdout).toContain(`${PACK_MARKER_PREFIX} role=${role}`);
      // Record the size for the report.
      console.log(`real-repo pack: role=${role} lines=${lines}`);
    }
  });

  test("real repo: --persona denys attaches the roster profile", () => {
    const result = runCompose(repoRoot, ["--role", "coder", "--persona", "denys"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## PERSONA (behavior only)");
    expect(result.stdout).toContain(PERSONA_HEADER);
  });

  test("real repo: --role coder --persona orest is refused", () => {
    const result = runCompose(repoRoot, ["--role", "coder", "--persona", "orest"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "persona 'orest' declares role 'orchestrator', requested role 'coder'",
    );
  });

  test("real repo check --strict is clean (0 FAIL)", () => {
    const result = runCheck(repoRoot, ["--strict"]);
    expect(result.stdout).toContain("0 FAIL");
    expect(result.status).toBe(0);
  });
});
