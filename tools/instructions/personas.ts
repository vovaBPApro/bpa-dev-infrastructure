#!/usr/bin/env bun
//
// Persona profile registry — phase-1 STATIC personas (instructions/personas.md).
//
// A persona is a behavior-only flavor attached to a lane's compose pack via
// `compose.ts --persona <name>`. Profiles live one-per-file under
// instance/personas/<name>.md (roster = this-installation facts, per the
// instruction-layers routing rule; the format and this validator are the
// generic L1 mechanism).
//
// Fail-closed contract:
//   - Unknown persona name → error (compose hard-fails, exit 2).
//   - A profile missing the mandatory BEHAVIOR-ONLY header line, a required
//     section, or a valid frontmatter field → error.
//   - The registry is validated standalone (this file's CLI), NOT via
//     tools/instructions/check.ts: check.ts walks instructions/ docs and the
//     persona roster deliberately lives in instance/ with its own schema.
//
// CLI: bun tools/instructions/personas.ts [--repo <path>]
//   Validates every profile in instance/personas/. Exit 0 when clean, 1 on any
//   FAIL. An absent registry directory is not an error (personas are optional).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./schema.ts";

// The mandatory first body line of every profile. Behavior, not authority —
// «поведінку, а не повноваження» (HR-161). Exact match, byte for byte.
export const PERSONA_HEADER =
  "BEHAVIOR ONLY: this persona changes how a lane reasons and communicates. " +
  "It NEVER changes authority, permissions, review tiers, capabilities, or evidence gates.";

// Real infra roles a persona may ride (instructions/roles.md). No other role
// exists; a roster wish for PM/QA/Security/UX/architect is expressed as
// `role-mapping: proposed` + `proposed-role:` and grants NOTHING.
export const PERSONA_ROLES = ["orchestrator", "manager", "coder", "reviewer"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

export const ROLE_MAPPINGS = ["real", "proposed"] as const;

// Phase 1: every profile is draft data awaiting the three-way finalization
// (HR-161). An approved status is a future decision, so the enum is closed.
export const PERSONA_STATUSES = ["draft-for-discussion"] as const;

export const PERSONA_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Required body sections, as exact heading lines.
export const PERSONA_SECTIONS = [
  "## Optimization target",
  "## Strengths",
  "## Review & communication style",
  "## Consilium participation",
  "## Blind spots",
] as const;

const KNOWN_KEYS = new Set([
  "persona",
  "role",
  "role-mapping",
  "proposed-role",
  "status",
  "summary",
]);

export type PersonaProfile = {
  name: string;
  role: PersonaRole;
  roleMapping: (typeof ROLE_MAPPINGS)[number];
  proposedRole?: string;
  status: string;
  summary: string;
  // Path relative to the repo root, for pack provenance comments.
  relative: string;
  // Full file contents (frontmatter + body): what gets materialized.
  contents: string;
};

export function personasRoot(repo: string): string {
  return join(repo, "instance", "personas");
}

// Validates one profile's contents. Returns concrete errors (empty when valid)
// and, on success, the typed profile minus its repo-relative location.
export function validatePersona(
  contents: string,
): { errors: string[]; profile?: Omit<PersonaProfile, "relative"> } {
  const errors: string[] = [];
  const { frontmatter, body } = parseFrontmatter(contents);
  if (frontmatter === undefined) {
    return { errors: ["no frontmatter block"] };
  }
  if (typeof frontmatter.__error === "string") {
    errors.push(`frontmatter parse: ${frontmatter.__error}`);
  }
  for (const key of Object.keys(frontmatter)) {
    if (key === "__error") continue;
    if (!KNOWN_KEYS.has(key)) errors.push(`unknown frontmatter key '${key}'`);
  }

  const name = frontmatter.persona;
  if (typeof name !== "string" || !PERSONA_NAME_PATTERN.test(name)) {
    errors.push(`persona must be a kebab-case name (got '${String(name)}')`);
  }
  const role = frontmatter.role;
  if (!PERSONA_ROLES.includes(role as PersonaRole)) {
    errors.push(`role must be one of ${PERSONA_ROLES.join("|")} (got '${String(role)}')`);
  }
  const mapping = frontmatter["role-mapping"];
  if (!ROLE_MAPPINGS.includes(mapping as (typeof ROLE_MAPPINGS)[number])) {
    errors.push(`role-mapping must be one of ${ROLE_MAPPINGS.join("|")} (got '${String(mapping)}')`);
  }
  const proposedRole = frontmatter["proposed-role"];
  if (mapping === "proposed") {
    if (typeof proposedRole !== "string" || proposedRole.trim() === "") {
      errors.push("role-mapping: proposed requires a non-empty proposed-role");
    }
  } else if (proposedRole !== undefined) {
    errors.push("proposed-role is only allowed with role-mapping: proposed");
  }
  const status = frontmatter.status;
  if (!PERSONA_STATUSES.includes(status as (typeof PERSONA_STATUSES)[number])) {
    errors.push(`status must be one of ${PERSONA_STATUSES.join("|")} (got '${String(status)}')`);
  }
  const summary = frontmatter.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    errors.push("missing or empty required field: summary");
  }

  // Mandatory header: the FIRST non-blank body line, exactly.
  const firstBodyLine = body.split(/\r?\n/).find((line) => line.trim() !== "");
  if (firstBodyLine?.trim() !== PERSONA_HEADER) {
    errors.push("first body line must be the mandatory BEHAVIOR ONLY header (exact match)");
  }

  for (const section of PERSONA_SECTIONS) {
    const present = body
      .split(/\r?\n/)
      .some((line) => line.trim() === section);
    if (!present) errors.push(`missing required section '${section}'`);
  }

  if (errors.length > 0) return { errors };
  return {
    errors: [],
    profile: {
      name: name as string,
      role: role as PersonaRole,
      roleMapping: mapping as (typeof ROLE_MAPPINGS)[number],
      ...(typeof proposedRole === "string" ? { proposedRole } : {}),
      status: status as string,
      summary: summary as string,
      contents,
    },
  };
}

export type LoadResult = { profile: PersonaProfile } | { errors: string[] };

// Loads one persona by name from instance/personas/. Unknown name, invalid
// name shape (also blocks path traversal), invalid profile, or a
// filename/frontmatter name mismatch are all errors — the caller fails closed.
export function loadPersona(repo: string, name: string): LoadResult {
  if (!PERSONA_NAME_PATTERN.test(name)) {
    return { errors: [`invalid persona name '${name}' (want kebab-case)`] };
  }
  const relative = join("instance", "personas", `${name}.md`);
  const path = join(repo, relative);
  if (!existsSync(path)) {
    return { errors: [`unknown persona '${name}' (no ${relative})`] };
  }
  const contents = readFileSync(path, "utf8");
  const { errors, profile } = validatePersona(contents);
  if (errors.length > 0 || !profile) return { errors };
  if (profile.name !== name) {
    return { errors: [`persona name '${profile.name}' does not match filename '${name}.md'`] };
  }
  return { profile: { ...profile, relative } };
}

// Lists profile names in the registry (filenames, sorted). Absent dir → [].
export function listPersonaNames(repo: string): string[] {
  const root = personasRoot(repo);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/, ""))
    .sort();
}

if (import.meta.main) {
  let repo = process.cwd();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo" && args[index + 1]) {
      repo = args[++index];
      continue;
    }
    process.stderr.write("Usage: bun tools/instructions/personas.ts [--repo <path>]\n");
    process.exit(2);
  }

  const names = listPersonaNames(repo);
  if (names.length === 0) {
    console.log("personas: no registry at instance/personas/ (nothing to validate)");
    process.exit(0);
  }
  let failures = 0;
  for (const name of names) {
    const result = loadPersona(repo, name);
    if ("errors" in result) {
      failures += 1;
      console.log(`FAIL ${name}.md  ${result.errors.join("; ")}`);
    } else {
      const p = result.profile;
      const mapping = p.roleMapping === "proposed" ? `proposed:${p.proposedRole}` : "real";
      console.log(`PASS ${name}.md  role=${p.role} mapping=${mapping} status=${p.status}`);
    }
  }
  console.log(`\nsummary: ${failures} FAIL, ${names.length - failures} PASS (${names.length} profiles)`);
  process.exit(failures > 0 ? 1 : 0);
}
