import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PERSONA_HEADER,
  PERSONA_SECTIONS,
  listPersonaNames,
  loadPersona,
  validatePersona,
} from "./personas.ts";

const cli = join(import.meta.dir, "personas.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function repoWithPersonas(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "personas-"));
  temporaryDirectories.push(repo);
  const root = join(repo, "instance", "personas");
  mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return repo;
}

function profile(overrides: Record<string, unknown> = {}, body?: string): string {
  const front: Record<string, unknown> = {
    persona: "denys",
    role: "coder",
    "role-mapping": "real",
    status: "draft-for-discussion",
    summary: "Simplicity-first coder.",
    ...overrides,
  };
  for (const key of Object.keys(front)) {
    if (front[key] === undefined) delete front[key];
  }
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  const defaultBody =
    `${PERSONA_HEADER}\n\n# Denys\n\n` +
    PERSONA_SECTIONS.map((section) => `${section}\n\nSome content.\n`).join("\n");
  return `---\n${lines.join("\n")}\n---\n\n${body ?? defaultBody}`;
}

describe("validatePersona", () => {
  test("a complete profile passes and is typed", () => {
    const { errors, profile: parsed } = validatePersona(profile());
    expect(errors).toEqual([]);
    expect(parsed!.name).toBe("denys");
    expect(parsed!.role).toBe("coder");
    expect(parsed!.roleMapping).toBe("real");
    expect(parsed!.roleAgnostic).toBeUndefined();
    expect(parsed!.status).toBe("draft-for-discussion");
  });

  test("missing summary is a concrete failure", () => {
    const { errors } = validatePersona(profile({ summary: undefined }));
    expect(errors).toContain("missing or empty required field: summary");
  });

  test("an empty body is a concrete failure", () => {
    const { errors } = validatePersona(profile({}, ""));
    expect(errors).toContain("persona body is empty");
  });

  test("a header-only body is a concrete failure without tripping the content lint", () => {
    const { errors } = validatePersona(profile({}, `${PERSONA_HEADER}\n`));
    expect(errors).toContain("persona body contains only the mandatory BEHAVIOR ONLY header");
    expect(errors.some((error) => error.includes("forbidden behavior-only phrase"))).toBe(false);
  });

  test("missing mandatory BEHAVIOR ONLY header is a failure", () => {
    const body =
      "# Denys\n\n" + PERSONA_SECTIONS.map((section) => `${section}\n\nText.\n`).join("\n");
    const { errors } = validatePersona(profile({}, body));
    expect(errors.join("; ")).toContain("mandatory BEHAVIOR ONLY header");
  });

  test("header must be the FIRST body line, exact", () => {
    const body = `# Denys first\n\n${PERSONA_HEADER}\n\n` +
      PERSONA_SECTIONS.map((section) => `${section}\n\nText.\n`).join("\n");
    const { errors } = validatePersona(profile({}, body));
    expect(errors.join("; ")).toContain("mandatory BEHAVIOR ONLY header");
  });

  test("a missing required section is a failure", () => {
    const body =
      `${PERSONA_HEADER}\n\n` +
      PERSONA_SECTIONS.slice(0, -1)
        .map((section) => `${section}\n\nText.\n`)
        .join("\n");
    const { errors } = validatePersona(profile({}, body));
    expect(errors.join("; ")).toContain("missing required section '## Blind spots'");
  });

  test("required sections in the wrong order are a failure", () => {
    const reversed = [...PERSONA_SECTIONS].reverse();
    const body =
      `${PERSONA_HEADER}\n\n# Denys\n\n` +
      reversed.map((section) => `${section}\n\nText.\n`).join("\n");
    const { errors } = validatePersona(profile({}, body));
    expect(errors.some((error) => error.startsWith("required sections are out of order"))).toBe(true);
  });

  test("a duplicate required section is a failure", () => {
    const body =
      `${PERSONA_HEADER}\n\n# Denys\n\n` +
      PERSONA_SECTIONS.map((section) => `${section}\n\nText.\n`).join("\n") +
      `\n${PERSONA_SECTIONS[0]}\n\nMore text.\n`;
    const { errors } = validatePersona(profile({}, body));
    expect(errors).toContain(
      "duplicate required section '## Optimization target' (found 2)",
    );
  });

  test("an empty required section is a failure", () => {
    const body =
      `${PERSONA_HEADER}\n\n# Denys\n\n` +
      PERSONA_SECTIONS.map((section) =>
        section === "## Review & communication style"
          ? `${section}\n\n`
          : `${section}\n\nText.\n`
      ).join("\n");
    const { errors } = validatePersona(profile({}, body));
    expect(errors).toContain(
      "required section '## Review & communication style' has no content",
    );
  });

  test("an unexpected extra section is a failure", () => {
    const body =
      `${PERSONA_HEADER}\n\n# Denys\n\n` +
      PERSONA_SECTIONS.map((section) => `${section}\n\nText.\n`).join("\n") +
      "\n## Hidden powers\n\nNo.\n";
    const { errors } = validatePersona(profile({}, body));
    expect(errors).toContain("unexpected section heading '## Hidden powers'");
  });

  test("the explicit authority vocabulary reports persona, line, and matched phrase", () => {
    const phrases = [
      "veto",
      "mandatory seat",
      "mandatory",
      "may skip",
      "can skip",
      "skips review",
      "sufficient alone",
      "sufficient without",
      "barred",
      "never joins",
      "picks the sub-team",
      "composes the topic sub-team",
      "selects the sub-team",
      "vote",
      "seat",
      "must be present",
      "required reviewer",
      "has authority",
      "grants",
      "review tier",
      "Tier-A",
      "Tier-B",
    ];
    for (const phrase of phrases) {
      const body =
        `${PERSONA_HEADER}\n\n# Denys\n\n` +
        PERSONA_SECTIONS.map((section, index) =>
          `${section}\n\n${index === 0 ? `Forbidden: ${phrase}.` : "Text."}\n`
        ).join("\n");
      const { errors } = validatePersona(profile({}, body));
      expect(errors.some((error) =>
        new RegExp(
          `persona 'denys' line \\d+: forbidden behavior-only phrase '${phrase}'`,
          "i",
        ).test(error)
      ), phrase).toBe(true);
    }
  });

  test("role outside the real infra roles is a failure", () => {
    const { errors } = validatePersona(profile({ role: "architect" }));
    expect(errors.join("; ")).toContain("role must be one of");
  });

  test("role-mapping: proposed requires proposed-role; real forbids it", () => {
    const missing = validatePersona(profile({ "role-mapping": "proposed" }));
    expect(missing.errors.join("; ")).toContain("requires a non-empty proposed-role");

    const ok = validatePersona(
      profile({ "role-mapping": "proposed", "proposed-role": "architect" }),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.profile!.proposedRole).toBe("architect");

    const forbidden = validatePersona(profile({ "proposed-role": "architect" }));
    expect(forbidden.errors.join("; ")).toContain("only allowed with role-mapping: proposed");
  });

  test("role-agnostic accepts only explicit boolean true", () => {
    const allowed = validatePersona(profile({ "role-agnostic": true }));
    expect(allowed.errors).toEqual([]);
    expect(allowed.profile!.roleAgnostic).toBe(true);

    for (const value of [false, "yes"]) {
      const { errors } = validatePersona(profile({ "role-agnostic": value }));
      expect(errors.join("; ")).toContain(
        "role-agnostic, when present, must be boolean true",
      );
    }
  });

  test("status outside draft-for-discussion is a failure (phase-1 closed enum)", () => {
    const { errors } = validatePersona(profile({ status: "approved" }));
    expect(errors.join("; ")).toContain("status must be one of");
  });

  test("an unknown frontmatter key is a failure", () => {
    const { errors } = validatePersona(profile({ "trust-score": "0.9" }));
    expect(errors.join("; ")).toContain("unknown frontmatter key 'trust-score'");
  });

  test("no frontmatter block is a failure", () => {
    const { errors } = validatePersona("Just text.\n");
    expect(errors).toEqual(["no frontmatter block"]);
  });
});

describe("loadPersona", () => {
  test("unknown persona name errors (fail-closed)", () => {
    const repo = repoWithPersonas({ "denys.md": profile() });
    const result = loadPersona(repo, "nobody");
    expect("errors" in result && result.errors.join("; ")).toContain("unknown persona 'nobody'");
  });

  test("a name that is not kebab-case (incl. path traversal) errors", () => {
    const repo = repoWithPersonas({ "denys.md": profile() });
    for (const name of ["../denys", "Denys", "de nys", ""]) {
      const result = loadPersona(repo, name);
      expect("errors" in result).toBe(true);
    }
  });

  test("frontmatter name must match the filename", () => {
    const repo = repoWithPersonas({ "petro.md": profile() }); // persona: denys inside
    const result = loadPersona(repo, "petro");
    expect("errors" in result && result.errors.join("; ")).toContain(
      "does not match filename 'petro.md'",
    );
  });

  test("a valid profile loads with its repo-relative path", () => {
    const repo = repoWithPersonas({ "denys.md": profile() });
    const result = loadPersona(repo, "denys");
    expect("profile" in result).toBe(true);
    if ("profile" in result) {
      expect(result.profile.relative).toBe(join("instance", "personas", "denys.md"));
    }
  });

  test("listPersonaNames: sorted names; absent registry is empty, not an error", () => {
    const repo = repoWithPersonas({ "denys.md": profile(), "aa.md": profile() });
    expect(listPersonaNames(repo)).toEqual(["aa", "denys"]);
    const empty = mkdtempSync(join(tmpdir(), "personas-empty-"));
    temporaryDirectories.push(empty);
    expect(listPersonaNames(empty)).toEqual([]);
  });
});

describe("personas.ts CLI", () => {
  test("a registry with an invalid profile exits 1", () => {
    const bad = profile({}, "# No header\n");
    const repo = repoWithPersonas({ "denys.md": profile(), "broken.md": bad });
    const result = spawnSync("bun", [cli, "--repo", repo], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL broken.md");
    expect(result.stdout).toContain("PASS denys.md");
  });

  test("duplicate persona identities are an explicit registry failure", () => {
    const repo = repoWithPersonas({
      "denys.md": profile(),
      "denys-copy.md": profile(),
    });
    const result = spawnSync("bun", [cli, "--repo", repo], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "duplicate persona identity 'denys' declared by denys.md, denys-copy.md",
    );
  });

  test("the REAL repo roster validates clean (0 FAIL) and is the full 10", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const result = spawnSync("bun", [cli, "--repo", repoRoot], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 FAIL");
    expect(result.stdout).toContain("(10 profiles)");
  });
});
