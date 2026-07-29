// Frontmatter schema for instruction documents (L1 infra checker, Phase 0).
//
// Per migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md §2.1: every instruction
// doc carries YAML frontmatter that records its routing as data. This module
// defines that schema, a minimal frontmatter parser, and a validator. It has no
// runtime dependencies beyond Bun/node so it can run in the landing gate.

export const LAYERS = ["L1", "L2", "L3", "L2-parked"] as const;
export type Layer = (typeof LAYERS)[number];

export const STATUSES = ["binding", "informational", "archived"] as const;
export type Status = (typeof STATUSES)[number];

export const AUDIENCES = ["orchestrator", "coder", "reviewer", "manager", "all"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const RISKS = ["low", "normal", "high"] as const;
export type Risk = (typeof RISKS)[number];

export type Frontmatter = {
  id: string;
  layer: Layer;
  status: Status;
  audience: Audience;
  tags: string[];
  summary: string;
  // Optional fields (§2.1).
  decision?: string[];
  floor?: boolean;
  risk?: Risk;
  sunset?: string;
  overrides?: string[];
  // Tombstone pointer for a moved doc (§2.2, §2.5).
  "moved-to"?: string;
  // Pack-coverage opt-out: `pack: none` declares a binding doc is intentionally
  // never delivered via a pack (§2.3 coverage rule). Any other value is invalid.
  pack?: string;
};

// kebab-case, globally unique. Lowercase letters, digits, single hyphens.
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ParsedDoc = {
  frontmatter: Record<string, unknown> | undefined;
  body: string;
  // Raw frontmatter block text (between the --- fences), for freshness hashing.
  raw: string | undefined;
};

// Extracts a leading YAML frontmatter block delimited by `---` fences. Returns
// `frontmatter: undefined` when the file has no frontmatter block at the top.
export function parseFrontmatter(contents: string): ParsedDoc {
  // Tolerate a leading BOM and blank lines are not allowed before the fence:
  // the block must be the very first thing in the file.
  const normalized = contents.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: undefined, body: normalized, raw: undefined };
  }
  const raw = match[1];
  const body = normalized.slice(match[0].length);
  return { frontmatter: parseYamlBlock(raw), body, raw };
}

// A deliberately small YAML subset parser sufficient for the flat instruction
// frontmatter: `key: scalar`, `key: [a, b]`, and block lists of `- item`. This
// avoids a YAML dependency in a Bun/no-deps gate context. Unsupported structure
// (nested maps) is surfaced as a validation error rather than silently dropped.
export function parseYamlBlock(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (!keyMatch) {
      result.__error = `unparseable line: ${line.trim()}`;
      continue;
    }
    const key = keyMatch[1];
    const rest = keyMatch[2].trim();
    if (rest === "") {
      // Could be a block list on following indented `- ` lines.
      const items: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
        items.push(stripScalar(lines[index].replace(/^\s*-\s+/, "")));
        index += 1;
      }
      result[key] = items;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === "" ? [] : inner.split(",").map((item) => stripScalar(item.trim()));
      continue;
    }
    result[key] = coerceScalar(stripScalar(rest));
  }
  return result;
}

function stripScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  frontmatter?: Frontmatter;
};

// Validates a parsed frontmatter map against the instruction schema. Returns the
// list of concrete errors (empty when valid) and, on success, the typed value.
export function validateFrontmatter(fm: Record<string, unknown> | undefined): ValidationResult {
  const errors: string[] = [];
  if (fm === undefined) {
    return { valid: false, errors: ["no frontmatter block"] };
  }
  if (typeof fm.__error === "string") {
    errors.push(`frontmatter parse: ${fm.__error}`);
  }

  requireString(fm, "id", errors);
  if (typeof fm.id === "string" && !ID_PATTERN.test(fm.id)) {
    errors.push(`id must be kebab-case (got '${String(fm.id)}')`);
  }
  requireEnum(fm, "layer", LAYERS, errors);
  requireEnum(fm, "status", STATUSES, errors);
  requireEnum(fm, "audience", AUDIENCES, errors);
  requireStringList(fm, "tags", errors);
  requireString(fm, "summary", errors);

  // Optional fields — validate only when present.
  if ("decision" in fm) validateStringList(fm, "decision", errors);
  if ("overrides" in fm) validateStringList(fm, "overrides", errors);
  if ("floor" in fm && typeof fm.floor !== "boolean") {
    errors.push(`floor must be a boolean (got '${String(fm.floor)}')`);
  }
  if ("risk" in fm && !RISKS.includes(fm.risk as Risk)) {
    errors.push(`risk must be one of ${RISKS.join("|")} (got '${String(fm.risk)}')`);
  }
  if ("sunset" in fm && typeof fm.sunset !== "string") {
    errors.push("sunset must be a string predicate");
  }
  if ("moved-to" in fm && typeof fm["moved-to"] !== "string") {
    errors.push("moved-to must be an id string");
  }
  if ("pack" in fm && fm.pack !== "none") {
    errors.push(`pack, when set, must be 'none' (got '${String(fm.pack)}')`);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], frontmatter: fm as unknown as Frontmatter };
}

function requireString(fm: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof fm[key] !== "string" || (fm[key] as string).trim() === "") {
    errors.push(`missing or empty required field: ${key}`);
  }
}

function requireEnum(
  fm: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  errors: string[],
): void {
  if (!allowed.includes(fm[key] as string)) {
    errors.push(`${key} must be one of ${allowed.join("|")} (got '${String(fm[key])}')`);
  }
}

function requireStringList(fm: Record<string, unknown>, key: string, errors: string[]): void {
  if (!Array.isArray(fm[key])) {
    errors.push(`${key} must be a list`);
    return;
  }
  validateStringList(fm, key, errors);
}

function validateStringList(fm: Record<string, unknown>, key: string, errors: string[]): void {
  const value = fm[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${key} must be a list of strings`);
  }
}
