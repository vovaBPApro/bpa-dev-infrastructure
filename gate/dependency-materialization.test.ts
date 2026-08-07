import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

// V3-5.25 regression lock: the landing baseline must answer the same in a clean
// clone of `main` as it does in the canonical checkout.
//
// THE DEFECT THIS LOCKS
// gate/land-lib.sh's tracked-test inventory includes integration tests that
// spawn daemon/server.ts. That process imports @modelcontextprotocol/sdk, which
// resolves only against daemon/node_modules -- git-ignored HOST state. The
// canonical checkout has it because somebody once ran an install there; a fresh
// clone of the same SHA does not. So the identical baseline reported
// `framework-check=test status=pass` here and
//
//   error: Cannot find module '@modelcontextprotocol/sdk/server/index.js'
//   LAND BASELINE framework-check=test status=fail
//   LAND verdict=aborted sha=none
//
// in a clone -- blocking every landing on the installation. A check whose
// verdict depends on ambient state is not a check, and the meteorite test
// (`instructions/reproducible-from-git.md`) says the repository alone must
// bring the host back.
//
// WHAT IS ASSERTED, and why each part is needed
// The fix is land_materialize_dependencies(), which runs
// `bun install --frozen-lockfile --ignore-scripts` in every tracked workspace
// that declares dependencies. Three failure modes have to stay red:
//
//   1. the step is removed, renamed, or moved after the tests it feeds;
//   2. a workspace gains dependencies with no tracked lockfile to derive them
//      from, so there is nothing reproducible to install;
//   3. the tree is satisfied from OUTSIDE the checkout -- a node_modules in a
//      parent directory, or a global install. That resolves here and nowhere
//      else, which is the original defect wearing a different hat: green on
//      this host, red in a clone, and green again the moment anyone "fixes" it
//      by installing on the host instead of in the repository;
//   4. the step's workspace inventory read fails and the step reports success
//      anyway, having materialized nothing.
//
// (3) is the load-bearing one. (1), (2) and (4) are the wiring that keeps it
// from being satisfied by accident.
//
// WHAT THIS LOCK DOES NOT COVER, stated because the review proved it (F1)
// The assertion behind (3) is that every external import resolves from INSIDE
// the checkout. It cannot detect a package whose CONTENT was tampered with in
// the host's bun install cache: bun hardlinks out of that cache, so the
// tampered file's realpath IS the in-checkout path and the assertion is
// satisfied. That residue is described in full in gate/land-lib.sh and is its
// own row, not something this file silently implies it covers.

const repoRoot = realpathSync(join(import.meta.dir, ".."));
const landLib = readFileSync(join(repoRoot, "gate/land-lib.sh"), "utf8");

type Workspace = { manifestRel: string; dir: string; dependencies: string[] };

function trackedManifests(): Workspace[] {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", "package.json", "*/package.json"],
    { encoding: "buffer" },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr?.toString().trim()}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((manifestRel) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, manifestRel), "utf8"));
      return {
        manifestRel,
        dir: join(repoRoot, dirname(manifestRel)),
        dependencies: Object.keys(manifest.dependencies ?? {}),
      };
    });
}

const workspaces = trackedManifests();

// The inventory is derived, not listed, so a new workspace is covered the day
// it is added. If the derivation itself ever returns nothing, every assertion
// below would pass vacuously -- so it does not get to.
test("the derived workspace inventory is not empty", () => {
  expect(workspaces.length).toBeGreaterThan(0);
});

test("the landing gate materializes dependencies before it runs the tracked tests", () => {
  expect(landLib).toContain("land_materialize_dependencies() {");

  const callSite = landLib.indexOf('land_materialize_dependencies "$repo" "$prefix"');
  const parseStep = landLib.indexOf("declared-check=parse status=running");
  const testStep = landLib.indexOf("framework-check=test status=running");

  expect(callSite).toBeGreaterThan(-1);
  expect(parseStep).toBeGreaterThan(-1);
  expect(testStep).toBeGreaterThan(-1);
  // Ordering, not mere presence: a materialization step that runs after the
  // tests it exists to feed is decoration.
  expect(callSite).toBeLessThan(parseStep);
  expect(callSite).toBeLessThan(testStep);
});

test("the materialization is frozen to the lockfile and runs no lifecycle scripts", () => {
  // The licence to install at all is that the install cannot DECIDE anything:
  // --frozen-lockfile refuses when manifest and lockfile disagree, and
  // --ignore-scripts keeps a candidate's install-time code from running as the
  // gate. Dropping either flag turns a derivation into an authority the gate
  // does not have.
  expect(landLib).toContain('"$BUN_BIN" install --frozen-lockfile --ignore-scripts');
  expect(landLib).not.toMatch(/"\$BUN_BIN" install(?! --frozen-lockfile --ignore-scripts)/);
});

test("every tracked workspace that declares dependencies has a tracked lockfile", () => {
  const missing: string[] = [];
  for (const workspace of workspaces) {
    if (workspace.dependencies.length === 0) continue;
    const lockRel = join(dirname(workspace.manifestRel), "bun.lock");
    const tracked = spawnSync(
      "git",
      ["-C", repoRoot, "ls-files", "--error-unmatch", "--", lockRel],
      { stdio: "ignore" },
    );
    if (tracked.status !== 0) missing.push(lockRel);
  }
  expect(missing).toEqual([]);
});

// The external modules the baseline's own sources import, read from the tracked
// files rather than guessed from a manifest's entry point -- `bun install`
// materializes what the LOCKFILE names, and what has to resolve is what the
// code actually asks for. daemon/server.ts imports
// "@modelcontextprotocol/sdk/server/index.js", a subpath the package's "."
// export does not even expose, so resolving package names would have missed the
// exact specifier the aborted landing named.
//
// THE READER: Bun.Transpiler.scanImports, behind a shebang guard, UNIONED with
// a small lexical scanner over the same source.
//
// An earlier draft used a REGEX alone and justified it by claiming scanImports
// "terminates the process with status 0 and no output" on this repository's
// largest tracked source. That is false in every particular and the V3-5.25
// review disproved it (F2). What actually happens: scanImports throws an
// ordinary catchable BuildMessage, `Unexpected #!/usr/bin/env bun`, on any
// source whose first line is a shebang -- 22 of this repository's 133 tracked
// sources have one, and a 40-byte file reproduces it. It has nothing to do with
// file size and it is not a silent kill. Strip the shebang and the transpiler
// reads all 133.
//
// Recording a fictional failure mode as the reason a future maintainer must
// avoid the exact reader is worse than the weaker reader itself, so the exact
// reader is used. It is also strictly better on the one form a `from`-matching
// regex provably misses: a bare side-effect `import "pkg";` (F3), which the
// runtime performs.
//
// A UNION PARTNER IS STILL REQUIRED, and exactly one form needs it: a TS
// type-only import. `import type { A } from "pkg"` and `export type { T } from
// "pkg"` are erased by the transpiler, so scanImports reports nothing for them
// -- measurably, and `daemon/server.ts -> grammy/types` is a live instance in
// this tree. A specifier a tracked source names must resolve whether or not the
// emitted JS keeps it, so the union stays.
//
// WHAT THE PARTNER IS NOT ANYMORE, and why (V3-5.25 r5). It used to be the bare
// regex `/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/`,
// matching a `from "<name>"` substring ANYWHERE in the file -- inside a string,
// a comment, a template literal. The file's own comment called that
// "deliberately over-broad" and argued the over-breadth was the safe direction
// for a lock. It is not, and main proved it: `hygiene/reap.test.ts:824` asserts
// on the PROSE `"remote inventory: UNAVAILABLE from 'origin'"`, landed in
// d622131, and the reader collected `origin` as an import of that file and then
// demanded it resolve as a package. A lock that reds on an English sentence
// does not fail closed; it fails at random, teaches that its red means nothing,
// and blocks a landing that has no defect in it.
//
// So the partner now recognizes import SYNTAX rather than a substring: the
// source is lexically masked (comments blanked, string and template interiors
// replaced by a filler, offsets preserved), tokenized, and only these forms are
// collected --
//
//   * `import ... from "spec"` / `export ... from "spec"` at STATEMENT position
//     (start of file, or after `;`, `{`, `}`, or a line break -- so ASI-style
//     sources are covered too), with the specifier a plain quoted literal, as
//     the grammar requires;
//   * a bare side-effect `import "spec"` at statement position;
//   * `import("spec")` and `require("spec")` at any position, since a dynamic
//     import is an expression.
//
// The masking is what makes prose invisible: a literal is one opaque token, so
// nothing inside it can be read as syntax, and a comment is blank before the
// tokenizer ever sees it.
//
// What neither reader sees, stated because a lock's value is exactly its blind
// spots: computed dynamic specifiers (`import(someVariable)`), which no static
// reader can resolve; specifiers assembled from concatenated fragments; and
// anything inside a template literal's `${...}`, which the mask treats as part
// of the literal (the transpiler half still reads those, so only a type-only
// import written inside an interpolation would be missed by both).
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const LEADING_SHEBANG = /^#![^\n]*/;
// A filler that is not a quote, not whitespace, and not an identifier
// character, so a masked literal's interior can never be read as syntax. It
// replaces the interior one character for one character: the mask is
// index-for-index aligned with the source, and a substitution that changed a
// length would silently move every offset after it.
const LITERAL_FILL = String.fromCharCode(1);

// A `/` opens a regex literal only where a value may begin. Tracked here so a
// regex containing an odd quote -- `/don't/` -- cannot desync the mask and
// blank real code after it. Judged on the previous significant character, plus
// the keywords after which an expression starts.
const VALUE_POSITION_PUNCTUATION = new Set("=(,:[!&|?{};+-*%^~<>".split(""));
const VALUE_POSITION_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await",
]);

type Literal = { start: number; end: number; quote: string; value: string };
type MaskedSource = { masked: string; literals: Map<number, Literal> };
type Token = { kind: "word" | "punct" | "literal"; text: string; index: number; quote?: string };

// Blanks comments and literal INTERIORS while preserving every offset and every
// newline, so the masked string and the source stay index-for-index aligned and
// the tokenizer below can be a plain forward scan.
export function maskLiterals(source: string): MaskedSource {
  const out = source.split("");
  const literals = new Map<number, Literal>();
  const blank = (from: number, to: number, fill: string) => {
    for (let k = from; k < to && k < source.length; k++) {
      out[k] = source[k] === "\n" ? "\n" : fill;
    }
  };

  let i = 0;
  let previousChar = "";
  let previousWord = "";
  while (i < source.length) {
    const ch = source[i]!;
    const pair = source.slice(i, i + 2);

    if (pair === "//") {
      const newline = source.indexOf("\n", i);
      const stop = newline === -1 ? source.length : newline;
      blank(i, stop, " ");
      i = stop;
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(i, stop, " ");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let terminated = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === ch) { terminated = true; break; }
        // An unterminated single-quoted string ends at the newline rather than
        // swallowing the rest of the file.
        if (ch !== "`" && c === "\n") break;
        j++;
      }
      const end = Math.min(j, source.length);
      literals.set(i, { start: i, end, quote: ch, value: source.slice(i + 1, end) });
      blank(i + 1, end, LITERAL_FILL);
      i = terminated ? end + 1 : end;
      previousChar = ch;
      previousWord = "";
      continue;
    }
    if (
      ch === "/" &&
      (previousChar === "" ||
        VALUE_POSITION_PUNCTUATION.has(previousChar) ||
        VALUE_POSITION_KEYWORDS.has(previousWord))
    ) {
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { terminated = true; break; }
        j++;
      }
      // Only a CLOSED regex literal is masked; an unterminated one was a
      // division after all, and falls through as an ordinary character.
      if (terminated) {
        blank(i + 1, j, " ");
        i = j + 1;
        previousChar = "/";
        previousWord = "";
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j]!)) j++;
      previousWord = source.slice(i, j);
      previousChar = source[j - 1]!;
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) {
      previousChar = ch;
      previousWord = "";
    }
    i++;
  }

  return { masked: out.join(""), literals };
}

function tokenize({ masked, literals }: MaskedSource): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < masked.length) {
    const literal = literals.get(i);
    if (literal) {
      tokens.push({ kind: "literal", text: literal.value, index: i, quote: literal.quote });
      i = literal.end + 1;
      continue;
    }
    const ch = masked[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < masked.length && /[A-Za-z0-9_$]/.test(masked[j]!)) j++;
      tokens.push({ kind: "word", text: masked.slice(i, j), index: i });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", text: ch, index: i });
    i++;
  }
  return tokens;
}

// Start of file, after a statement terminator or a brace, or after a line break
// (ASI). Deliberately does NOT include arbitrary expression context: that is
// the whole difference between reading syntax and grepping for `from`.
function atStatementPosition(tokens: Token[], index: number, masked: string): boolean {
  const previous = tokens[index - 1];
  if (!previous) return true;
  if (previous.kind === "punct" && (previous.text === ";" || previous.text === "{" || previous.text === "}")) {
    return true;
  }
  const between = masked.slice(previous.index + previous.text.length, tokens[index]!.index);
  return between.includes("\n");
}

// The specifier of an import/export declaration is a plain string literal by
// grammar -- `import x from \`y\`` is a syntax error -- so requiring a non-
// backtick quote here costs nothing and drops tagged templates like
// ``query.from`select ...` ``. A dynamic import DOES accept a template, and is
// read separately below.
function declarationSpecifier(token: Token | undefined): string | undefined {
  if (!token || token.kind !== "literal" || token.quote === "`") return undefined;
  return token.text;
}

export function importSyntaxSpecifiers(source: string): string[] {
  const maskedSource = maskLiterals(source);
  const tokens = tokenize(maskedSource);
  const found: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") continue;

    // `import("spec")` / `require("spec")` -- expression position, any depth.
    if (
      (token.text === "import" || token.text === "require") &&
      tokens[i + 1]?.kind === "punct" &&
      tokens[i + 1]!.text === "(" &&
      tokens[i + 2]?.kind === "literal"
    ) {
      found.push(tokens[i + 2]!.text);
      continue;
    }

    if (token.text !== "import" && token.text !== "export") continue;
    if (!atStatementPosition(tokens, i, maskedSource.masked)) continue;

    // Bare side-effect `import "spec";`.
    const sideEffect = token.text === "import" ? declarationSpecifier(tokens[i + 1]) : undefined;
    if (sideEffect !== undefined) {
      found.push(sideEffect);
      continue;
    }

    // `import ... from "spec"` / `export ... from "spec"`, bounded by the
    // declaration's own terminator so a later statement's tokens cannot be
    // read as part of this clause.
    for (let j = i + 1; j < tokens.length; j++) {
      const clause = tokens[j]!;
      if (clause.kind === "punct" && clause.text === ";") break;
      if (clause.kind === "word" && (clause.text === "import" || clause.text === "export")) break;
      if (clause.kind === "word" && clause.text === "from") {
        const specifier = declarationSpecifier(tokens[j + 1]);
        if (specifier !== undefined) found.push(specifier);
        break;
      }
    }
  }

  return found;
}

function loaderFor(file: string): "ts" | "tsx" | "js" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".ts")) return "ts";
  return "js";
}

// Exported for the reader's own locks below: the repaired properties are
// asserted against this function directly, on inputs the tracked tree does not
// currently contain, so they stay red if the reader regresses in either
// direction.
export function readSpecifiers(source: string, file: string): string[] {
  const specifiers = new Set<string>();

  // The transpiler is the exact reader. A leading shebang is stripped because
  // it is the one thing scanImports refuses outright; a throw for any OTHER
  // reason is raised, never swallowed. A reader that returns [] on failure
  // would turn an unreadable source into "imports nothing", which is the
  // failure-as-absence shape this whole change exists to remove.
  try {
    for (const imported of new Bun.Transpiler({ loader: loaderFor(file) })
      .scanImports(source.replace(LEADING_SHEBANG, ""))) {
      specifiers.add(imported.path);
    }
  } catch (error) {
    throw new Error(`scanImports failed on ${file}: ${error}`);
  }

  // The union partner's extra reach: type-only declarations the transpiler
  // erases. Its shape filter applies only here, because it reads syntax the
  // transpiler declined to emit rather than a compiled result -- a transpiler
  // result is already exactly what the code asked for and must not be dropped
  // by a shape guess.
  for (const specifier of importSyntaxSpecifiers(source)) {
    if (PACKAGE_SPECIFIER.test(specifier)) specifiers.add(specifier);
  }

  return [...specifiers];
}

function isExternal(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("bun:") || specifier.startsWith("node:")) return false;
  return !isBuiltin(specifier);
}

function externalImports(): { file: string; specifier: string }[] {
  const listed = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"],
    { encoding: "buffer" },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr?.toString().trim()}`);
  }
  const found: { file: string; specifier: string }[] = [];
  for (const file of listed.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    for (const specifier of readSpecifiers(source, file)) {
      if (isExternal(specifier)) found.push({ file, specifier });
    }
  }
  return found;
}

// The fixtures below are written LITERALLY: a real import clause with its
// specifier quoted inline, sitting in an ordinary string of this file. Until
// V3-5.25 r5 they could not be, and the reason is the whole point of that
// round. The predecessor reader matched `from "<name>"` anywhere in a file, so
// a literal fixture was collected as a real import OF THIS FILE and then
// required to resolve from gate/, where no such package exists -- the lock
// failed on its own examples, and the specifiers had to be assembled from
// fragments to hide them from it.
//
// A reader that its own test file has to hide from is a reader that any tracked
// source can trip by accident, and one did: `hygiene/reap.test.ts:824`, below.
// So the hiding is removed on purpose, and this file is now its own in-tree
// fixture for the repaired direction: if the reader ever regresses to matching
// inside strings and comments, the whole-tree lock further down reds with
// `gate/dependency-materialization.test.ts -> lock-fixture-package: unresolved`
// -- red-before, in the tree, without a synthetic file.
const FIXTURE = "lock-fixture-package";

// Verbatim from hygiene/reap.test.ts:824, landed in d622131 (V3-5.13). Prose
// inside an assertion string, containing no import and naming no dependency --
// and the exact line on which the predecessor reader demanded that a package
// called `origin` resolve, blocking a landing that had no defect in it.
const PROSE_OFFENDER =
  `expect(out.stdout).toContain("remote inventory: UNAVAILABLE from 'origin'");`;

test("the import reader survives a shebang, sees bare side-effect imports, and never swallows a throw", () => {
  // F2: the whole tracked justification for avoiding the exact reader was that
  // it dies on a large source. It dies on a SHEBANG, at 40 bytes, catchably.
  // Red against an unguarded scanImports, which throws on this input.
  expect(readSpecifiers(`#!/usr/bin/env bun\nimport z from "lock-fixture-package";\n`, "x.ts"))
    .toContain(FIXTURE);

  // F3: a bare side-effect import is a form the runtime performs and a
  // `from`-matching reader cannot see. Nothing in the tracked tree uses this
  // form today, so only a synthetic input keeps it red.
  expect(readSpecifiers(`import "lock-fixture-package";\n`, "x.ts")).toContain(FIXTURE);

  // The union partner's own reach, kept: a type-only declaration the transpiler
  // ERASES still names a specifier that has to resolve. Union, not replacement.
  // Red against a transpiler-only reader; `daemon/server.ts -> grammy/types` is
  // the live instance this protects.
  expect(readSpecifiers(`import type { A } from "lock-fixture-package-types";\n`, "x.ts"))
    .toContain("lock-fixture-package-types");
  expect(readSpecifiers(`export type { T } from "lock-fixture-package-exported";\n`, "x.ts"))
    .toContain("lock-fixture-package-exported");

  // Fail-closed: an unreadable source must not read as "imports nothing".
  expect(() => readSpecifiers("import { from '", "x.ts")).toThrow(/scanImports failed on x\.ts/);
});

// Direction 1 of the r5 repair, at reader level: narrowing the reader to import
// SYNTAX must not cost it a single real import form. Each case is a form the
// runtime or the type-checker actually resolves, and the whole-tree lock below
// is only as good as this list.
test("the import reader still collects every real import form", () => {
  const collected = (source: string) => readSpecifiers(source, "x.ts");

  expect(collected(`import a from "lock-fixture-value";`)).toContain("lock-fixture-value");
  expect(collected(`export { a } from "lock-fixture-reexport";`)).toContain("lock-fixture-reexport");
  expect(collected(`export * from "lock-fixture-star";`)).toContain("lock-fixture-star");
  expect(collected(`const m = await import("lock-fixture-dynamic");`))
    .toContain("lock-fixture-dynamic");
  expect(collected(`const m = require("lock-fixture-required");`))
    .toContain("lock-fixture-required");

  // A multi-line clause: the specifier is many tokens and one newline away from
  // the `import` keyword that authorizes it. This is the shape daemon/server.ts
  // uses, and a statement-anchored reader that gave up at the line end would
  // silently drop it.
  expect(collected(`import {\n  type A,\n  b,\n} from "lock-fixture-multiline";\n`))
    .toContain("lock-fixture-multiline");

  // No semicolons (ASI): the statement boundary is a line break and nothing
  // else. Both imports must survive, including the type-only one that only the
  // union partner can see.
  expect(collected(`const x = 1\nimport type { A } from "lock-fixture-asi"\nconst y = 2\n`))
    .toContain("lock-fixture-asi");

  // A regex literal containing an unbalanced quote earlier in the file must not
  // desync the mask and swallow the import that follows it.
  expect(collected(`const re = /don't/;\nimport type { A } from "lock-fixture-after-regex";\n`))
    .toContain("lock-fixture-after-regex");
});

// Direction 2 of the r5 repair: the defect itself. Every case here is prose,
// and every one of them was collected as an import by the predecessor reader.
test("the import reader does not collect prose that resembles an import", () => {
  const collected = (source: string) => readSpecifiers(source, "x.ts");

  // The tracked line that proved the defect. It names `origin`; the reader must
  // report nothing at all for it.
  expect(collected(PROSE_OFFENDER)).toEqual([]);

  // A string, a template literal, a line comment and a block comment, each
  // carrying a complete import clause.
  expect(collected(`const message = "see: import x from 'pkg-in-a-string'";`)).toEqual([]);
  expect(collected("const t = `see: import x from 'pkg-in-a-template'`;")).toEqual([]);
  expect(collected(`// import x from "pkg-in-a-line-comment";\n`)).toEqual([]);
  expect(collected(`/*\n  import x from "pkg-in-a-block-comment";\n*/\n`)).toEqual([]);

  // `from` as an ordinary call or property, which is only prose to a reader
  // that greps for the word.
  expect(collected(`const rows = db.from("pkg-in-a-query");`)).toEqual([]);
  expect(collected(`const q = sql.from\`pkg-in-a-tagged-template\`;`)).toEqual([]);

  // Both directions in ONE source, which is the property that actually matters:
  // the prose is ignored and the real import beside it is still collected.
  const mixed = `import type { A } from "lock-fixture-real";\n${PROSE_OFFENDER}\n`;
  expect(collected(mixed)).toEqual(["lock-fixture-real"]);
});

test("every external import in a tracked source resolves from inside the checkout", () => {
  const imports = externalImports();
  // Vacuous-pass guard: if the scan ever finds nothing, this test stops being a
  // lock and starts being a decoration that reports green forever.
  expect(imports.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const { file, specifier } of imports) {
    let resolved: string;
    try {
      resolved = realpathSync(Bun.resolveSync(specifier, dirname(join(repoRoot, file))));
    } catch (error) {
      // Unresolvable is the clean-clone symptom itself, and the exact line the
      // aborted landing printed: the module the baseline's tests need was never
      // materialized inside the checkout.
      offenders.push(`${file} -> ${specifier}: unresolved (${error})`);
      continue;
    }
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
      // Resolved, but from host state: a node_modules in a parent directory or
      // a global install. Green here, red in every clone.
      offenders.push(`${file} -> ${specifier}: resolved outside the checkout at ${resolved}`);
    }
  }
  expect(offenders).toEqual([]);
});

// A child that drives land_resolve_bun must not inherit the caller's resolve
// overrides. land_resolve_bun REFUSES a caller-supplied BUN_BIN --
// `LAND step=preflight status=fail detail=caller-bun-override-refused` -- and
// that refusal is correct behavior: a caller does not get to choose which bun
// the gate runs. But it means any test driving the function through an
// inherited environment asserts whatever the caller happened to export rather
// than the behavior under test. That caller is not hypothetical: every lane
// exiting through gate/lane-exit.sh sources land-lib.sh and calls
// land_resolve_bun, which EXPORTS BUN_BIN, so completion-guard.ts's verify run
// -- and every test it spawns -- carries it.
//
// Measured at 54fb255, one SHA, one command, differing only in this variable:
// with BUN_BIN unset the step reached the inventory read and failed by name,
// exit 0 for the suite; with BUN_BIN set it never got past preflight and the
// suite exited 1. A check whose verdict depends on ambient state is the exact
// defect the rest of this file locks, one level up -- so the environment is
// sanitized HERE, in the spawn, rather than by unsetting anything globally,
// which would only move the ambience somewhere less visible.
//
// Both names are OUTPUTS of land_resolve_bun, never inputs. Only BUN_BIN
// changes the outcome today; LAND_CHECK_PATH is stripped for the rule, not for
// a measured failure, since land_resolve_bun assigns it unconditionally.
const RESOLVE_OUTPUTS = ["BUN_BIN", "LAND_CHECK_PATH"];

export function envWithoutResolveOverrides(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const sanitized = { ...source };
  for (const name of RESOLVE_OUTPUTS) delete sanitized[name];
  return sanitized;
}

// Takes its source as an argument so the property is asserted on an input the
// ambient environment cannot supply or withhold -- and without mutating
// process.env, which would leak into every other test in the file. Without
// this, emptying the sanitizer would still read green in any environment that
// happens not to export BUN_BIN, which is how this defect survived review in
// the first place.
test("the spawn sanitizer removes the resolve outputs and keeps everything else", () => {
  const sanitized = envWithoutResolveOverrides({
    BUN_BIN: "/somewhere/bun",
    LAND_CHECK_PATH: "/somewhere/bin",
    PATH: "/usr/bin",
  });
  expect(sanitized.BUN_BIN).toBeUndefined();
  expect(sanitized.LAND_CHECK_PATH).toBeUndefined();
  expect(sanitized.PATH).toBe("/usr/bin");
});

test("an unreadable workspace inventory fails the step closed, by name", () => {
  // F4: the inventory read was the one fail-OPEN path in a function that is
  // otherwise meticulous about never letting a failure read as an absence. With
  // `git ls-files` failing, `manifests` was empty, the loop never ran, and the
  // function returned 0 having materialized nothing and printed no `deps=` line.
  // Driven through the real function rather than asserted against its text.
  const notARepo = mkdtempSync(join(tmpdir(), "bpa-inventory-lock-"));
  try {
    const run = spawnSync(
      "bash",
      [
        "-c",
        '. "$1"/gate/land-lib.sh && land_resolve_bun && land_materialize_dependencies "$2" TRIAL-INVENTORY',
        "bash",
        repoRoot,
        notARepo,
      ],
      { encoding: "utf8", env: envWithoutResolveOverrides() },
    );
    // Named first, and separately from the assertions below, because it is the
    // difference between "the step failed the way it must" and "the step never
    // ran". Red against an inheriting spawn under any caller that exports
    // BUN_BIN -- which is what the landing and lane-exit gates both are.
    expect(run.stderr).not.toContain("caller-bun-override-refused");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deps=install status=fail");
    expect(run.stderr).toContain("detail=inventory-unreadable");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("materialized dependency output stays out of git", () => {
  // The step writes node_modules/ into the checkout on every landing. If that
  // were ever trackable, the gate would dirty the tree it is about to merge and
  // the payload guard would start refusing landings for the gate's own output.
  const notIgnored: string[] = [];
  for (const workspace of workspaces) {
    if (workspace.dependencies.length === 0) continue;
    const modulesRel = join(dirname(workspace.manifestRel), "node_modules");
    expect(existsSync(join(repoRoot, modulesRel))).toBe(true);
    const ignored = spawnSync(
      "git",
      ["-C", repoRoot, "check-ignore", "-q", "--", modulesRel],
      { stdio: "ignore" },
    );
    if (ignored.status !== 0) notIgnored.push(modulesRel);
  }
  expect(notIgnored).toEqual([]);
});
