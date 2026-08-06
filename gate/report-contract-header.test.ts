import { expect, test } from "bun:test";
import { contractHeader, fieldValues, headerValues } from "./report-contract";

// The grammar of a GRANTING field, driven directly. gate/bare-world.test.sh
// proves what each shape does to a real run; these cases own the rule itself,
// so every way of writing a line that is NOT a declaration has a lock of its
// own rather than being covered by whichever one somebody thought of.
//
// The rule: column 0, case-exact, inside the contract header block. Nothing
// else. Two review rounds were spent on a reader that tried to recognise the
// field in prose and be right about which prose was an example -- first fenced
// blocks, then indented ones. This reader does not look at prose.

const HEADER = [
  "commit: 0000000000000000000000000000000000000000 fixture",
  "verify: true",
  "result: clean",
  "secret-scan: clean",
  "remaining: none",
].join("\n");

function report(...body: string[]): string {
  return [HEADER, "", ...body, ""].join("\n");
}

test("the header is the run of fields the report opens with", () => {
  expect(contractHeader(report()).map((field) => field.label)).toEqual([
    "commit",
    "verify",
    "result",
    "secret-scan",
    "remaining",
  ]);
});

test("a markdown title and blank lines may precede it -- real reports have one", () => {
  const titled = `# Lane report -- v3-5.42 r3\n\n${HEADER}\nbare-world: capability=host-state reason=titled\n`;
  expect(headerValues(titled, "bare-world")).toEqual(["capability=host-state reason=titled"]);
});

test("a declaration in the contract header is read", () => {
  const declared = `${HEADER}\nbare-world: capability=mount-namespace reason=no-namespace-here\n\nprose\n`;
  expect(headerValues(declared, "bare-world")).toEqual(["capability=mount-namespace reason=no-namespace-here"]);
});

// Everything below is a line the report contract does NOT read. Each was
// reachable in some earlier version of this parser, and each is a grant nobody
// wrote.

const INERT: [name: string, body: string][] = [
  ["the same spelling in the body, at column 0", "bare-world: capability=host-state reason=body"],
  ["an indented code block (round 2's finding)", "    bare-world: capability=host-state reason=indented"],
  ["a fenced code block (round 1's finding)", "```text\nbare-world: capability=host-state reason=fenced\n```"],
  ["a tilde fence", "~~~\nbare-world: capability=host-state reason=tilde\n~~~"],
  ["a fence whose info string carries a NUL", "```te\0xt\nbare-world: capability=host-state reason=nul\n```"],
  ["a fence left unterminated", "```text\nbare-world: capability=host-state reason=unterminated"],
  ["a blockquote", "> bare-world: capability=host-state reason=quoted"],
  ["a list item", "- bare-world: capability=host-state reason=listed"],
  ["a sentence that happens to end in one", "The lane wrote bare-world: capability=host-state reason=prose"],
];

test.each(INERT)("inert: %s", (_name, body) => {
  expect(headerValues(report(body), "bare-world")).toEqual([]);
});

// ...and the same, in the header's own position, where only the exact spelling
// counts. A near-miss here is the shape most likely to be written by accident
// AND the shape a reader is most tempted to be helpful about.

const NEAR_MISS: [name: string, line: string][] = [
  ["a capitalised label", "Bare-World: capability=host-state reason=case"],
  ["an upper-case label", "BARE-WORLD: capability=host-state reason=shouting"],
  ["one leading space", " bare-world: capability=host-state reason=indented-by-one"],
  ["a tab before the label", "\tbare-world: capability=host-state reason=tabbed"],
  ["whitespace before the colon", "bare-world : capability=host-state reason=spaced"],
  ["no space after the colon", "bare-world:capability=host-state reason=tight"],
  ["a bolded label", "**bare-world:** capability=host-state reason=bold"],
];

test.each(NEAR_MISS)("inert in the header's own position: %s", (_name, line) => {
  expect(headerValues(`${HEADER}\n${line}\n`, "bare-world")).toEqual([]);
});

test("a blank line closes the block: what follows is body, however it is spelled", () => {
  const split = `${HEADER}\n\nbare-world: capability=host-state reason=after-the-gap\n`;
  expect(headerValues(split, "bare-world")).toEqual([]);
});

test("a report that opens with prose has no contract header at all", () => {
  const prosed = `This lane did the work.\n${HEADER}\nbare-world: capability=host-state reason=late\n`;
  expect(contractHeader(prosed)).toEqual([]);
  expect(headerValues(prosed, "bare-world")).toEqual([]);
});

test("every header occurrence is returned, so a duplicate is refused rather than picked", () => {
  const twice = `${HEADER}\nbare-world: capability=maskable-home reason=first\nbare-world: capability=maskable-home reason=second\n`;
  expect(headerValues(twice, "bare-world")).toEqual([
    "capability=maskable-home reason=first",
    "capability=maskable-home reason=second",
  ]);
});

test("CRLF is the same report as LF", () => {
  const crlf = `${HEADER}\nbare-world: capability=host-state reason=windows\n`.replaceAll("\n", "\r\n");
  expect(headerValues(crlf, "bare-world")).toEqual(["capability=host-state reason=windows"]);
});

test("a valueless field is read as empty, not as absent -- the caller refuses it", () => {
  expect(headerValues(`${HEADER}\nbare-world:\n`, "bare-world")).toEqual([""]);
});

// The deliberate divergence, stated as a lock so that "make them consistent"
// cannot be done by accident. `review:` DEMANDS a sibling artifact -- an extra
// match adds an obligation the report must satisfy, which is fail-closed -- so
// it keeps the permissive surface the report contract states. `bare-world:`
// GRANTS a clearance, so an extra match is a grant nobody wrote. Same-looking
// fields, opposite directions, and only one of them may be read out of prose.
test("`review:` keeps its permissive reader: over-matching a DEMANDING field is fail-closed", () => {
  const permissive = `${HEADER}\n  Review: ACCEPT\n`;
  expect(fieldValues(permissive, "review").values).toEqual(["ACCEPT"]);
  expect(headerValues(permissive, "review")).toEqual([]);
});
