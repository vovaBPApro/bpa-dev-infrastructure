// Invocation graph over tracked repository sources.
//
// V3-0.28 first shipped reachability as `text.includes(basename)`: any tracked
// file that merely NAMED a mechanism made it reachable. A reviewer closed the
// loop by mutation -- append `# see also check-shared-stash.sh` to an unrelated
// script and the checker went green again -- so the detector for "a tracked
// mechanism with no executor" reproduced that exact defect inside itself. The
// basename form failed the same way: `runner:meteorite`'s needle `run.sh` was
// a substring of eight tracked paths, including `docker/whisper-proof-run.sh`.
//
// This module answers the question the row was opened for instead: does
// anything INVOKE the mechanism? An invocation is a token in COMMAND POSITION
// -- the command word itself, an argument to an interpreter, a systemd
// ExecStart, or a TypeScript spawn/import whose binding is actually called.
// Comments are stripped before any of it, so prose can never satisfy it, and
// paths are compared component-wise against the tracked file set, so a
// basename that is ambiguous (or is merely a substring of another basename)
// satisfies nothing.
//
// Known boundaries, deliberately not covered: a command assembled at runtime
// from concatenated fragments, dispatch through an associative array of command
// names, and heredoc bodies (which are parsed as ordinary commands rather than
// as generated data). Each would need a real shell parser; a false NEGATIVE
// here surfaces as an `unreachable mechanism` error naming the target, which is
// the fail-closed direction.
//
// One boundary is a decision rather than a limit: a command line that only ever
// appears inside a string literal -- a crontab entry a script printf-s into a
// file, say -- is NOT an invocation edge. Whether that line ever runs depends on
// whether the crontab was installed on some host, which is exactly the host
// state this repository-level checker cannot see. Counting it would be the
// unarmed-timer mistake in another costume: text describing a run is not a run.

const NUL = "\u0000";

export type EdgeClass = "production" | "test-real" | "test-fixture";
export type Edge = { from: string; line: number; cls: EdgeClass; how: string };

type Cmd = { tokens: string[]; line: number; fn: string | null };
type Binding = { name: string; paths: string[]; init: string; interpreter: boolean };
type CallSite = { line: number; args: string; direct: string };

type Source = {
  file: string;
  test: boolean;
  kind: "shell" | "unit" | "ts" | "other";
  commands: Cmd[];
  shellAliases: Map<string, string>;
  shellInterpreters: Set<string>;
  shellTainted: Set<string>;
  functions: { name: string; from: number; to: number }[];
  bindings: Map<string, Binding>;
  tainted: Set<string>;
  imports: { spec: string; names: string[]; line: number }[];
  calls: Map<string, CallSite[]>;
  spawns: CallSite[];
};

// ---------------------------------------------------------------- classifying

export function isTestFile(file: string): boolean {
  return /(?:^|\/)[^/]*\.(?:test|spec)\.[A-Za-z]+$/.test(file) || /(?:^|\/)tests?\//.test(file);
}

function sourceKind(file: string): Source["kind"] {
  if (/\/units\/[^/]+\.in$/.test(file) || /\.(?:service|timer|socket|path|mount)$/.test(file)) return "unit";
  if (/\.(?:sh|bash|in)$/.test(file)) return "shell";
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return "ts";
  return "other";
}

// ------------------------------------------------------------ comment removal

export function stripShellComments(text: string): string {
  return text.split("\n").map((raw) => {
    let quote: string | null = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "\\") { i++; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
    }
    return raw;
  }).join("\n");
}

export function stripTsComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const block = text.slice(i, close < 0 ? text.length : close + 2);
      out += block.replace(/[^\n]/g, " ");
      i = (close < 0 ? text.length : close + 1);
      continue;
    }
    out += c;
  }
  return out;
}

// --------------------------------------------------------------- path parsing

// Reduce a shell word or a path expression to the longest LITERAL trailing run
// of path components. `"$repo_root/meteorite/run.sh"` yields `meteorite/run.sh`
// -- the variable half is unknowable, the literal half is what identifies the
// file. Component-wise by construction: `docker/whisper-proof-run.sh` yields
// the basename `whisper-proof-run.sh`, which is not `run.sh`.
export function pathSuffix(word: string): string {
  let w = word.trim();
  for (let round = 0; round < 4; round++) {
    const next = w.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?])([^{}]*)\}/g, "$1");
    if (next === w) break;
    w = next;
  }
  w = w.replace(/\\(.)/g, "$1").replace(/["'`]/g, "");
  let prev = "";
  while (prev !== w) { prev = w; w = w.replace(/\$\([^()]*\)/g, NUL); }
  w = w.replace(/\$\{[^{}]*\}/g, NUL)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, NUL)
    .replace(/\$[@*#?$!0-9-]/g, NUL);
  const parts = w.split("/");
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (!part || part === "." || part === ".." || part.includes(NUL)) break;
    out.unshift(part);
  }
  return out.join("/");
}

// --------------------------------------------------------- shell tokenisation

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

function scanShell(text: string, startLine: number, out: Cmd[]): void {
  const nested: { text: string; line: number }[] = [];
  let tokens: string[] = [];
  let cur = "";
  let line = startLine;
  let cmdLine = startLine;
  const flush = () => { if (cur !== "") { tokens.push(cur); cur = ""; } };
  const endCmd = () => {
    flush();
    if (tokens.length) out.push({ tokens, line: cmdLine, fn: null });
    tokens = [];
    cmdLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") { endCmd(); line++; cmdLine = line; continue; }
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; line++; continue; }
      cur += c + (text[i + 1] ?? ""); i++; continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const seg = text.slice(i, close < 0 ? text.length : close + 1);
      cur += seg; line += count(seg, "\n"); i = close < 0 ? text.length : close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let seg = '"';
      for (; j < text.length; j++) {
        const d = text[j]!;
        if (d === "\\") { seg += d + (text[j + 1] ?? ""); j++; continue; }
        seg += d;
        if (d === '"') break;
      }
      cur += seg; line += count(seg, "\n"); i = j;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      const stop = Math.min(j, text.length);
      nested.push({ text: text.slice(i + 2, stop), line });
      const seg = text.slice(i, stop + 1);
      cur += seg; line += count(seg, "\n"); i = stop;
      continue;
    }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      const stop = close < 0 ? text.length : close;
      nested.push({ text: text.slice(i + 1, stop), line });
      const seg = text.slice(i, stop + 1);
      cur += seg; line += count(seg, "\n"); i = stop;
      continue;
    }
    if (c === " " || c === "\t") { flush(); continue; }
    if (c === ";" || c === "&" || c === "|") { endCmd(); continue; }
    if ((c === "(" || c === ")" || c === "{" || c === "}") && cur === "") { endCmd(); continue; }
    cur += c;
  }
  endCmd();
  for (const inner of nested) scanShell(inner.text, inner.line, out);
}

const SHELL_SKIP = new Set([
  "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac",
  "!", "exec", "command", "nohup", "time", "eval", "source", ".", "builtin",
]);
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "bun", "node", "deno", "python", "python3", "perl", "ruby"]);
const INTERPRETER_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const INTERPRETER_NAME = /(?:^|_)(?:BUN|BASH|SH|ZSH|NODE|DENO|PYTHON|PERL|RUBY|SHELL|INTERPRETER)(?:_BIN|_PATH|_EXE)?$/;

function bare(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

function isInterpreterToken(token: string, aliases: Set<string>): boolean {
  const word = bare(token);
  if (INTERPRETERS.has(word)) return true;
  if (INTERPRETERS.has(pathSuffix(word))) return true;
  const varMatch = word.match(INTERPRETER_VAR);
  if (varMatch && INTERPRETER_NAME.test(varMatch[1]!)) return true;
  return varMatch ? aliases.has(varMatch[1]!) : false;
}

function varName(token: string): string | null {
  const match = bare(token).match(INTERPRETER_VAR);
  return match ? match[1]! : null;
}

// Drop leading words that are syntax rather than the command: keywords,
// `VAR=value` prefixes, and `env`/`sudo` with their own flags.
function commandHead(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (SHELL_SKIP.has(token)) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i++; continue; }
    if (token === "env" || token === "sudo") {
      i++;
      while (i < tokens.length && (/^-/.test(tokens[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!))) {
        const flag = tokens[i]!;
        i++;
        if ((flag === "-u" || flag === "--unset" || flag === "-C") && i < tokens.length && !/^-/.test(tokens[i]!)) i++;
      }
      continue;
    }
    break;
  }
  return i;
}

// ------------------------------------------------------------- TS expressions

function matchDelimiter(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[text[open]!]!;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === text[open]) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return text.length;
}

function readInitializer(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) return text.slice(start, i); depth--; continue; }
    if (depth === 0 && (c === ";" || c === "\n")) return text.slice(start, i);
  }
  return text.slice(start);
}

function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (c === "," && depth === 0) { out.push(text.slice(last, i)); last = i + 1; }
  }
  out.push(text.slice(last));
  return out.map((part) => part.trim()).filter(Boolean);
}

const STRING_LITERAL = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;

function literals(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map((m) => m[1] ?? m[2] ?? "");
}

// `join(repoRoot, "tools", "check-x.sh")` is the repository's normal way of
// naming a script; keep the literal segments and blank out the rest, then run
// the same trailing-literal-run rule the shell side uses.
export function expressionPath(expr: string): string {
  const trimmed = expr.trim();
  const call = trimmed.match(/^(?:[A-Za-z_$][\w$.]*\.)?(join|resolve)\s*\(/);
  if (call) {
    const open = trimmed.indexOf("(", call[0].length - 1);
    const body = trimmed.slice(open + 1, matchDelimiter(trimmed, open));
    const segments = splitArgs(body).map((arg) => {
      const literal = arg.match(/^"([^"]*)"$|^'([^']*)'$/);
      return literal ? (literal[1] ?? literal[2] ?? "") : NUL;
    });
    return pathSuffix(segments.join("/"));
  }
  const literal = trimmed.match(/^"([^"]*)"$|^'([^']*)'$|^`([^`$]*)`$/);
  return literal ? pathSuffix(literal[1] ?? literal[2] ?? literal[3] ?? "") : "";
}

// An argv array built once and threaded through a helper -- `const args =
// [checker, "--repo", repo]; spawnSync("bun", args)` -- is the repository's
// second-most-common invocation shape after a direct spawn. Carry the array's
// element paths on the binding so the helper's call site still resolves.
function expressionPaths(expr: string): string[] {
  const trimmed = expr.trim();
  if (trimmed.startsWith("[")) {
    return splitArgs(trimmed.slice(1, matchDelimiter(trimmed, 0))).map(expressionPath).filter(Boolean);
  }
  const single = expressionPath(trimmed);
  return single ? [single] : [];
}

const TAINT = /\bmkdtemp(?:Sync)?\s*\(|\btmpdir\s*\(|\bmktemp\b|\bTMPDIR\b/;
// Free identifiers only. A property name must not be read as a reference to a
// same-named binding: `import.meta.dir` is not the local `dir` that a fixture
// factory returned, and reading it as one taints every repository-rooted path.
const IDENTIFIER = /(?<![.\w$])[A-Za-z_$][\w$]*/g;

function identifiers(text: string): string[] {
  return [...text.matchAll(IDENTIFIER)].map((m) => m[0]!);
}

// ------------------------------------------------------------- source parsing

function parseShell(file: string, text: string): Partial<Source> {
  const stripped = stripShellComments(text);
  const prepared = sourceKind(file) === "unit"
    ? stripped.split("\n").map((line) => line.replace(/^\s*Exec[A-Za-z]*\s*=/, "")).join("\n")
    : stripped;
  const commands: Cmd[] = [];
  scanShell(prepared, 1, commands);

  // Function ranges, so an invocation buried in a function nobody calls is not
  // mistaken for a live one -- that is the reap-cron defect, not a hypothetical.
  const functions: { name: string; from: number; to: number }[] = [];
  const lines = prepared.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!.match(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\(\s*\))?\s*\{\s*$/);
    if (!start || (!/\(\s*\)/.test(lines[i]!) && !/^\s*function\s/.test(lines[i]!))) continue;
    let depth = 0;
    let end = lines.length;
    for (let j = i; j < lines.length; j++) {
      const plain = lines[j]!.replace(/"[^"]*"|'[^']*'/g, "");
      depth += count(plain, "{") - count(plain, "}");
      if (j > i || depth > 0) { if (depth <= 0) { end = j + 1; break; } }
    }
    functions.push({ name: start[1]!, from: i + 1, to: end });
  }
  for (const cmd of commands) {
    const enclosing = functions.filter((fn) => cmd.line >= fn.from && cmd.line <= fn.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
    cmd.fn = enclosing ? enclosing.name : null;
  }

  const shellAliases = new Map<string, string>();
  const shellInterpreters = new Set<string>();
  const assignments = new Map<string, string>();
  for (const cmd of commands) {
    for (const token of cmd.tokens) {
      const assign = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (!assign) continue;
      const [, name, value] = assign as unknown as [string, string, string];
      assignments.set(name, `${assignments.get(name) ?? ""} ${value}`);
      const suffix = pathSuffix(value);
      if (suffix) shellAliases.set(name, suffix);
      if (isInterpreterToken(value, new Set())) shellInterpreters.add(name);
    }
  }

  const shellTainted = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const before = shellTainted.size;
    for (const [name, value] of assignments) {
      if (shellTainted.has(name)) continue;
      const references = [...value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
      if (/\bmktemp\b|\bTMPDIR\b/.test(value) || references.some((ref) => shellTainted.has(ref))) shellTainted.add(name);
    }
    if (shellTainted.size === before) break;
  }

  return { commands, functions, shellAliases, shellInterpreters, shellTainted };
}

function parseTs(file: string, text: string): Partial<Source> {
  const stripped = stripTsComments(text);
  const bindings = new Map<string, Binding>();
  for (const match of stripped.matchAll(/(?:^|[;{}()\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g)) {
    const init = readInitializer(stripped, match.index! + match[0].length);
    const name = match[1]!;
    bindings.set(name, {
      name,
      paths: expressionPaths(init),
      init,
      interpreter: /^\s*(?:"|')(?:bash|sh|bun|node|deno|python3?)(?:"|')\s*$/.test(init) || /process\.execPath/.test(init),
    });
  }
  // Array-literal initializers may name the script through another binding.
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const binding of bindings.values()) {
      if (!binding.init.trim().startsWith("[")) continue;
      for (const id of identifiers(binding.init)) {
        for (const path of bindings.get(id)?.paths ?? []) {
          if (binding.paths.includes(path)) continue;
          binding.paths.push(path);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  const functionBodies = new Map<string, string>();
  for (const match of stripped.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{)|(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=;]+)?=>\s*\{)/g)) {
    const name = match[1] ?? match[2]!;
    const open = match.index! + match[0].length - 1;
    functionBodies.set(name, stripped.slice(open, matchDelimiter(stripped, open) + 1));
  }

  const tainted = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const before = tainted.size;
    for (const [name, body] of functionBodies)
      if (!tainted.has(name) && (TAINT.test(body) || identifiers(body).some((id) => tainted.has(id)))) tainted.add(name);
    for (const [name, binding] of bindings)
      if (!tainted.has(name) && (TAINT.test(binding.init) || identifiers(binding.init).some((id) => tainted.has(id)))) tainted.add(name);
    if (tainted.size === before) break;
  }

  const lineOf = (index: number) => count(stripped.slice(0, index), "\n") + 1;

  const imports: Source["imports"] = [];
  for (const match of stripped.matchAll(/(?:^|[;\n])\s*import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g))
    imports.push({ spec: match[2]!, names: importedNames(match[1]!), line: lineOf(match.index!) });
  for (const match of stripped.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g))
    imports.push({ spec: match[1]!, names: [], line: lineOf(match.index!) });

  const calls = new Map<string, CallSite[]>();
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    const site: CallSite = { line: lineOf(match.index!), args: stripped.slice(open + 1, matchDelimiter(stripped, open)), direct: "" };
    calls.set(match[1]!, [...(calls.get(match[1]!) ?? []), site]);
  }

  const spawns: CallSite[] = [];
  for (const match of stripped.matchAll(/\b(?:Bun\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    const args = stripped.slice(open + 1, matchDelimiter(stripped, open));
    spawns.push({ line: lineOf(match.index!), args, direct: splitArgs(args)[0] ?? "" });
  }

  return { bindings, tainted, imports, calls, spawns };
}

function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) for (const part of braced[1]!.split(",")) {
    const alias = part.trim().split(/\s+as\s+/);
    if (alias.length) names.push(alias[alias.length - 1]!.trim());
  }
  const namespaced = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaced) names.push(namespaced[1]!);
  const dflt = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, "").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(dflt)) names.push(dflt);
  return names.filter(Boolean);
}

// ------------------------------------------------------------------ the graph

export type Graph = {
  edgesTo(target: string): Edge[];
  armEdges(unit: string, parked: Set<string>): { file: string; line: number } | null;
};

export function buildGraph(files: Map<string, string>, unitArmed: (file: string) => boolean = () => false): Graph {
  const tracked = [...files.keys()];

  // A path expression identifies a file only when exactly one tracked file ends
  // with it. `run.sh` names meteorite/run.sh only while no sibling shares that
  // basename; the moment one does, the ambiguous form stops proving anything.
  const owners = new Map<string, Set<string>>();
  for (const file of tracked) {
    const parts = file.split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      const suffix = parts.slice(i).join("/");
      if (!owners.has(suffix)) owners.set(suffix, new Set());
      owners.get(suffix)!.add(file);
    }
  }
  const resolves = (word: string, target: string): boolean => {
    const suffix = pathSuffix(word);
    if (!suffix) return false;
    const set = owners.get(suffix);
    return set !== undefined && set.size === 1 && set.has(target);
  };

  const sources: Source[] = [];
  for (const [file, text] of files) {
    const kind = sourceKind(file);
    if (kind === "other") continue;
    const base: Source = {
      file, kind, test: isTestFile(file), commands: [], shellAliases: new Map(), shellInterpreters: new Set(),
      shellTainted: new Set(), functions: [], bindings: new Map(), tainted: new Set(), imports: [],
      calls: new Map(), spawns: [],
    };
    sources.push(Object.assign(base, kind === "ts" ? parseTs(file, text) : parseShell(file, text)));
  }

  // A shell function is live when some command anywhere in the tracked tree
  // names it in command position, from top level or from another live function.
  const definedFunctions = new Map<string, Source[]>();
  for (const source of sources)
    for (const fn of source.functions) definedFunctions.set(fn.name, [...(definedFunctions.get(fn.name) ?? []), source]);
  const live = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const before = live.size;
    for (const source of sources) {
      for (const cmd of source.commands) {
        if (cmd.fn !== null && !live.has(cmd.fn)) continue;
        const head = cmd.tokens[commandHead(cmd.tokens)];
        if (head && definedFunctions.has(head) && !live.has(head)) live.add(head);
      }
    }
    if (live.size === before) break;
  }
  const liveAt = (cmd: Cmd) => cmd.fn === null || live.has(cmd.fn);

  const classOf = (source: Source, tainted: boolean): EdgeClass =>
    source.test ? (tainted ? "test-fixture" : "test-real") : "production";

  function shellEdges(source: Source, target: string, out: Edge[]): void {
    for (const cmd of source.commands) {
      if (!liveAt(cmd)) continue;
      const start = commandHead(cmd.tokens);
      const head = cmd.tokens[start];
      if (head === undefined) continue;
      const aliasHead = varName(head);
      const direct = resolves(head, target)
        || (aliasHead !== undefined && aliasHead !== null && source.shellAliases.get(aliasHead) !== undefined
          && owners.get(source.shellAliases.get(aliasHead)!)?.size === 1
          && owners.get(source.shellAliases.get(aliasHead)!)!.has(target));
      let how = direct ? (resolves(head, target) ? "command word" : "command word via $" + aliasHead) : "";
      if (!direct && isInterpreterToken(head, source.shellInterpreters)) {
        for (const token of cmd.tokens.slice(start + 1)) {
          if (token.startsWith("-")) continue;
          const alias = varName(token);
          const aliasPath = alias ? source.shellAliases.get(alias) : undefined;
          if (resolves(token, target) || (aliasPath && owners.get(aliasPath)?.size === 1 && owners.get(aliasPath)!.has(target))) {
            how = `argument to ${bare(head)}`;
            break;
          }
        }
      }
      if (!how) continue;
      const tainted = cmd.tokens.some((token) =>
        /\bmktemp\b/.test(token) || [...token.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some((m) => source.shellTainted.has(m[1]!)));
      out.push({ from: source.file, line: cmd.line, cls: classOf(source, tainted), how });
    }
  }

  function tsEdges(source: Source, target: string, out: Edge[]): void {
    const dir = source.file.includes("/") ? source.file.slice(0, source.file.lastIndexOf("/")) : "";
    for (const entry of source.imports) {
      if (!entry.spec.startsWith(".")) continue;
      const normalized = normalize(`${dir}/${entry.spec}`);
      const candidates = [normalized, `${normalized}.ts`, `${normalized}.tsx`, `${normalized}/index.ts`];
      if (!candidates.includes(target)) continue;
      const sites = entry.names.flatMap((name) => source.calls.get(name) ?? []);
      for (const site of sites) {
        const tainted = identifiers(site.args).some((id) => source.tainted.has(id)) || TAINT.test(site.args);
        out.push({ from: source.file, line: site.line, cls: classOf(source, tainted), how: "imported and called" });
      }
    }
    for (const site of source.spawns) {
      const hasInterpreter = /["'](?:bash|sh|zsh|bun|node|deno|python3?)["']|process\.execPath|Bun\.which/.test(site.args)
        || identifiers(site.args).some((id) => source.bindings.get(id)?.interpreter);
      const owns = (path: string) => path !== "" && owners.get(path)?.size === 1 && owners.get(path)!.has(target);
      const names = literals(site.args).some((literal) => resolves(literal, target));
      const viaBinding = identifiers(site.args).some((id) => (source.bindings.get(id)?.paths ?? []).some(owns));
      const directHit = owns(expressionPath(site.direct))
        || (source.bindings.get(site.direct.trim())?.paths ?? []).some(owns);
      if (!((names || viaBinding) && hasInterpreter) && !directHit) continue;
      const tainted = identifiers(site.args).some((id) => source.tainted.has(id)) || TAINT.test(site.args);
      out.push({ from: source.file, line: site.line, cls: classOf(source, tainted), how: directHit ? "spawned directly" : "spawned via interpreter" });
    }
  }

  return {
    edgesTo(target: string): Edge[] {
      const out: Edge[] = [];
      for (const source of sources) {
        if (source.file === target) continue;
        if (source.kind === "unit" && !unitArmed(source.file)) continue;
        if (source.kind === "ts") tsEdges(source, target, out);
        else shellEdges(source, target, out);
      }
      return out;
    },
    armEdges(unit: string, parked: Set<string>) {
      for (const source of sources) {
        if (source.test || parked.has(source.file) || source.kind === "unit") continue;
        for (const cmd of source.commands) {
          if (!liveAt(cmd)) continue;
          const start = commandHead(cmd.tokens);
          const head = cmd.tokens[start];
          if (!head || bare(head) !== "systemctl" && pathSuffix(bare(head)) !== "systemctl") continue;
          const rest = cmd.tokens.slice(start + 1).map(bare);
          if (rest.includes("enable") && rest.some((token) => token === unit || token.endsWith(`/${unit}`))) {
            return { file: source.file, line: cmd.line };
          }
        }
      }
      return null;
    },
  };
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
