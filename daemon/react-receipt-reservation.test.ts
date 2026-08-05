import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECEIPT_EMOJI,
  assertReactionEmojiAllowed,
  isReceiptEmoji,
} from "./inbox-mirror";

// ---------------------------------------------------------------------------
// Regression lock: the model-driven `react` tool cannot forge the receipt
// ---------------------------------------------------------------------------
// HR-2486 makes 👀 on the Human's own message mean «отримав і зберіг». Before
// this lock, `daemon/server.ts`'s `react` MCP tool passed any emoji straight to
// setMessageReaction on any allowlisted chat with no stored-row check — and the
// orchestrator used it to hand-react 👀 through 2026-08-05. That is a receipt
// for a row nobody proved exists.
//
// Two halves, because either alone is defeatable:
//   • the guard itself, executed — refuses the symbol, and its lookalikes;
//   • the wiring, against the real source text — server.ts constructs a live
//     Bot at module load and is not importable, so the same approach
//     inbox-receipt-wiring.test.ts and gate/review-contract-parity.test.ts use
//     applies here. Delete the guard call from the tool and this turns red.

describe("the receipt emoji is reserved against a model-driven react call", () => {
  test("the reserved symbol is the eyes the Human actually reads", () => {
    expect(RECEIPT_EMOJI).toBe("👀");
  });

  test("a react call asking for 👀 is refused, and the refusal says why", () => {
    expect(() => assertReactionEmojiAllowed("👀")).toThrow(/reserved/);
    // Named, not generic: the caller is a model that will otherwise retry the
    // identical call. The reason and the rule have to be in the message.
    let message = "";
    try {
      assertReactionEmojiAllowed("👀");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("👀");
    expect(message).toContain("HR-2486");
    expect(message).toContain("receipt");
  });

  test("lookalike spellings of the same rendered eyes are refused too", () => {
    // What is verified here is the guard's own behavior: it folds each of these
    // spellings onto the reserved symbol and refuses it. Whether Telegram would
    // ALSO render them as the receipt is a property of Telegram's
    // setMessageReaction validator, which no lane here can reach — it is
    // untested in both directions and deliberately not asserted. Folding the
    // whole invisible class is what makes that external answer stop mattering.
    for (const forged of [
      "👀️", // variation selector
      "👀︎",
      " 👀 ", // padded
      "​👀", // zero-width space
      "👀‍",
      "﻿👀",
    ]) {
      expect(isReceiptEmoji(forged)).toBe(true);
      expect(() => assertReactionEmojiAllowed(forged)).toThrow(/reserved/);
    }
  });

  // Built from codepoints, never pasted: a table of invisible characters
  // written as literals is unreadable in a diff and unmaintainable in review —
  // the reader cannot see what the row asserts, which is how the gap below got
  // in. Each row names the character it stands for.
  const INVISIBLE_DECORATIONS: Array<[string, number]> = [
    ["U+200E left-to-right mark", 0x200e],
    ["U+200F right-to-left mark", 0x200f],
    ["U+202A left-to-right embedding", 0x202a],
    ["U+202C pop directional formatting", 0x202c],
    ["U+2062 invisible times", 0x2062],
    ["U+2066 left-to-right isolate", 0x2066],
    ["U+2069 pop directional isolate", 0x2069],
    ["U+00AD soft hyphen", 0x00ad],
    ["U+034F combining grapheme joiner", 0x034f],
    ["U+180E Mongolian vowel separator", 0x180e],
    ["U+E0061 tag character", 0xe0061],
    ["U+0000 NUL", 0x0000],
  ];

  test.each(INVISIBLE_DECORATIONS)(
    "an invisible decoration is folded, not a loophole: %s",
    (_name, codepoint) => {
      // The first fold enumerated seven codepoints and stopped one short of
      // U+200E; these eleven-plus spellings walked straight through it while
      // leaving bare eyes on screen. The fold now covers the CLASS
      // (\p{Cc} + \p{Default_Ignorable_Code_Point} + \s), so a decoration
      // nobody thought of on the day is covered too.
      const ch = String.fromCodePoint(codepoint as number);
      for (const forged of [RECEIPT_EMOJI + ch, ch + RECEIPT_EMOJI]) {
        expect(isReceiptEmoji(forged)).toBe(true);
        expect(() => assertReactionEmojiAllowed(forged)).toThrow(/reserved/);
      }
    },
  );

  test("a VISIBLY different string is not folded into the receipt", () => {
    // The other half of the fold's contract, and the reason it cannot simply
    // strip everything: each of these renders as something the Human can see
    // is not the receipt, so refusing it would be over-refusal.
    const visiblyDifferent: Array<[string, string]> = [
      ["skin-tone suffix", RECEIPT_EMOJI + "\u{1F3FB}"],
      ["ZWJ + skin-tone modifier", RECEIPT_EMOJI + "\u{200D}\u{1F3FB}"],
      ["doubled eyes", RECEIPT_EMOJI + RECEIPT_EMOJI],
      ["enclosing keycap", "\u{0031}\u{FE0F}\u{20E3}"],
      ["U+1F441 single eye", "\u{1F441}"],
      ["U+1F441 single eye + VS16", "\u{1F441}\u{FE0F}"],
    ];
    for (const [name, allowed] of visiblyDifferent) {
      expect([name, isReceiptEmoji(allowed)]).toEqual([name, false]);
      expect(() => assertReactionEmojiAllowed(allowed)).not.toThrow();
    }
  });

  test("every other reaction still goes through untouched", () => {
    for (const allowed of ["👍", "✍️", "✅", "❌", "🔥", "", "👁"]) {
      expect(isReceiptEmoji(allowed)).toBe(false);
      expect(() => assertReactionEmojiAllowed(allowed)).not.toThrow();
    }
  });
});

describe("daemon/server.ts wires the reservation into the react tool", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  // The `react` case body, from the case label to the tool's return.
  const reactCase = server.match(
    /case 'react': \{[\s\S]*?return \{ content: \[\{ type: 'text', text: 'reacted' \}\] \};/,
  )?.[0];

  test("the react tool guards before it reacts", () => {
    expect(reactCase).toBeDefined();
    const guard = reactCase!.indexOf("assertReactionEmojiAllowed(");
    const call = reactCase!.indexOf("setMessageReaction(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThanOrEqual(0);
    // Guarding after the API call would react first and refuse afterwards.
    expect(guard).toBeLessThan(call);
  });

  test("the guard is the shared one, not a local re-implementation", () => {
    // A second copy of the emoji test would drift from the contract it serves.
    // Asserted against the import statement rather than the whole file: a
    // failure here has to print something a reader can act on.
    const importBlock = server.match(
      /import \{[^}]*\} from '\.\/inbox-mirror';/,
    )?.[0];
    expect(importBlock).toBeDefined();
    expect(importBlock).toContain("assertReactionEmojiAllowed");
  });

  test("the tool advertises the reservation to the model that calls it", () => {
    const schema = server.match(/name: 'react',\n\s*description:[\s\S]*?\n\s*inputSchema/)?.[0];
    expect(schema).toContain("👀");
    expect(schema).toContain("HR-2486");
  });

  test("the model-driven react tool is the only reaction site it can reach", () => {
    // The daemon's own receipt sites live in handleInbound and are locked by
    // inbox-receipt-wiring.test.ts. Inside the MCP tool dispatch there must be
    // exactly one reaction call, the guarded one — a second, unguarded tool
    // path would reopen the hole this lock closes.
    const dispatch = server.match(
      /server\.setRequestHandler\(CallToolRequestSchema[\s\S]*?\n  \}\);\n/,
    )?.[0];
    expect(dispatch).toBeDefined();
    expect([...dispatch!.matchAll(/setMessageReaction\(/g)].length).toBe(1);
  });
});
