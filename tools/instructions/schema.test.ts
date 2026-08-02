import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, validateFrontmatter } from "./schema.ts";

const fixtures = join(import.meta.dir, "fixtures");

function loadFixture(name: string) {
  return parseFrontmatter(readFileSync(join(fixtures, name), "utf8"));
}

describe("schema", () => {
  test("parses every optional field of a full fixture (inline and block lists)", () => {
    const parsed = loadFixture("valid-full.md");
    const result = validateFrontmatter(parsed.frontmatter);
    expect(result.valid).toBe(true);
    const fm = result.frontmatter!;
    expect(fm.id).toBe("valid-full");
    expect(fm.layer).toBe("L1");
    expect(fm.floor).toBe(true);
    expect(fm["floor-line"]).toBe("Exercise the generated Hard Floor imperative field.");
    expect(fm.risk).toBe("high");
    expect(fm.sunset).toBe("phase != sole-mission");
    // Block-style list under `decision:` and inline `[...]` under `tags:`.
    expect(fm.decision).toEqual(["hr-11562", "hr-11564"]);
    expect(fm.tags).toEqual(["hygiene", "gate"]);
    expect(fm.overrides).toEqual(["some-narrowed-rule"]);
    expect(parsed.body.trim()).toBe("Body of the fully-populated fixture.");
  });

  test("rejects a bad enum fixture with a concrete error", () => {
    const parsed = loadFixture("bad-enum.md");
    const result = validateFrontmatter(parsed.frontmatter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("status must be one of"))).toBe(true);
  });

  test("rejects an empty floor-line", () => {
    const parsed = parseFrontmatter(
      "---\nid: x\nlayer: L1\nstatus: binding\naudience: all\ntags: [t]\nsummary: s\nfloor-line: ''\n---\n\nBody.\n",
    );
    const result = validateFrontmatter(parsed.frontmatter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("floor-line"))).toBe(true);
  });

  test("reports missing frontmatter", () => {
    const parsed = parseFrontmatter("# No frontmatter here\n");
    expect(parsed.frontmatter).toBeUndefined();
    const result = validateFrontmatter(parsed.frontmatter);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("no frontmatter block");
  });

  test("flags each missing required field", () => {
    const parsed = parseFrontmatter("---\nid: only-id\n---\n\nBody.\n");
    const result = validateFrontmatter(parsed.frontmatter);
    expect(result.valid).toBe(false);
    for (const field of ["layer", "status", "audience", "tags", "summary"]) {
      expect(result.errors.some((error) => error.includes(field))).toBe(true);
    }
  });
});
