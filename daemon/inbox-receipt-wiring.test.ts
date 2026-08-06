import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Wiring lock: the daemon's reaction sites must obey the receipt
// ---------------------------------------------------------------------------
// handleInbound is not importable (server.ts constructs a live Bot at module
// load), so the wiring is locked against the real source text — the same
// approach gate/review-contract-parity.test.ts uses. This is what catches a
// future reaction site added without the gate, which is the exact defect
// HR-2486 was raised about.
//
// V3-5.7: the first version of this lock matched the GATE CONDITION
// (`if (…captionHandled !== 'permission-reply')`) and counted the matches. An
// ungated 👀 inserted above `deliverOrBuffer` carries no such clause, so it
// added no match, the count stayed at two, and the suite stayed green on the
// exact false green it exists to prevent. So the lock now works the other way
// round: it enumerates the REACTION CALLS inside handleInbound and requires
// each one to prove a gate, which makes an unrecognised site red by default
// instead of invisible. `reactionSites` is exercised below against synthetic
// bodies too, so the analyzer cannot pass by finding nothing.

const REACTION_CALL = /(?:setMessageReaction|\.react)\s*\(/g;
const RECEIPT_GATE = "receipt?.stored === true";
const PERMISSION_BLOCK = "if (permMatch) {";

// Comment text blanked to spaces, string and template contents kept verbatim,
// byte offsets preserved so every index still points at the real source.
//
// Comments MUST go: the receipt gate is described in prose directly above the
// site it guards, so a lock reading raw text would accept a comment as a gate —
// and would then accept a site whose only gate is a comment claiming one.
// Strings stay because the permission-reply clause is a string comparison.
// Regex literals are not modelled; `endedInCode` below reports the confusion
// that would cause rather than letting it decide a verdict silently.
function blankComments(src: string): { code: string; endedInCode: boolean } {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out += "  ";
        i++;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out += "  ";
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") state = c;
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i++;
      } else out += c === "\n" ? c : " ";
      continue;
    }
    // Inside a string or template literal: kept verbatim.
    out += c;
    if (c === "\\") {
      const escaped = src[i + 1];
      if (escaped !== undefined) {
        out += escaped;
        i++;
      }
      continue;
    }
    if (c === state) state = "code";
  }
  return { code: out, endedInCode: state === "code" };
}

// The source text of one top-level function, plus its offset in the file so
// failures can name a real line number. Prettier keeps top-level closing braces
// in column 1, which is what bounds the body.
function topLevelFunction(
  src: string,
  name: string,
): { body: string; offset: number } {
  const offset = src.indexOf(`async function ${name}(`);
  expect(offset).toBeGreaterThanOrEqual(0);
  const close = src.indexOf("\n}\n", offset);
  expect(close).toBeGreaterThan(offset);
  return { body: src.slice(offset, close + 3), offset };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// The `{`-block headers enclosing `index`, outermost first: for a reaction site
// this is every condition it sits under. A site at the function's top level
// returns just the function header, i.e. no gate at all — which is precisely
// the false green this lock was rewritten for.
function enclosingHeaders(code: string, index: number): string[] {
  const open: number[] = [];
  for (let i = 0; i < index; i++) {
    const c = code[i];
    if (c === "{") open.push(i);
    else if (c === "}") open.pop();
  }
  return open.map((brace) => {
    let start = 0;
    for (let i = brace - 1; i >= 0; i--) {
      const c = code[i]!;
      if (c === ";" || c === "{" || c === "}") {
        start = i + 1;
        break;
      }
    }
    return collapse(code.slice(start, brace + 1));
  });
}

type Site = {
  call: string;
  headers: string[];
  gate: "receipt" | "permission-reply" | null;
};

// Every reaction call in `body`, with the gate each one proves. `null` means the
// site claims no gate the receipt contract recognises: the lock's default
// answer, so a site nobody taught this analyzer about fails loudly.
function reactionSites(body: string): Site[] {
  const { code, endedInCode } = blankComments(body);
  expect(endedInCode).toBe(true);
  return [...code.matchAll(REACTION_CALL)].map((match) => {
    const at = match.index!;
    const end = code.indexOf(";", at);
    const call = collapse(code.slice(at, end < 0 ? code.length : end));
    const headers = enclosingHeaders(code, at);
    const gate = headers.some((h) => h.includes(RECEIPT_GATE))
      ? "receipt"
      : headers.some((h) => h === PERMISSION_BLOCK)
        ? "permission-reply"
        : null;
    return { call, headers, gate };
  });
}

describe("daemon/server.ts honours the receipt at every reaction site", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const inbound = topLevelFunction(server, "handleInbound");

  test("every reaction site inside handleInbound proves a gate", () => {
    const sites = reactionSites(inbound.body);

    // The failure has to say WHICH site and under what, or the next reader
    // learns only that a number changed.
    expect(
      sites.filter((s) => s.gate === null).map((s) => [s.call, s.headers]),
    ).toEqual([]);

    // Vacuity guard: an analyzer that found nothing would satisfy the line
    // above. These are the sites that exist today — the 👀 receipt, the
    // configured access.ackReaction, and the permission-reply ✅/❌ ack.
    expect(sites.filter((s) => s.gate === "receipt").length).toBe(2);
    expect(sites.filter((s) => s.gate === "permission-reply").length).toBe(1);
  });

  test("the permission-reply site is the ✅/❌ ack and nothing else", () => {
    // `if (permMatch)` is accepted as a gate because that block has already
    // consumed a permission reply. Keep it pinned to the ack it was accepted
    // for: the emoji is derived from the match, not a free choice.
    const { code } = blankComments(inbound.body);
    const block = code.slice(
      code.indexOf(PERMISSION_BLOCK),
      code.indexOf("if (!hasAttachment) return;"),
    );
    expect(block).toContain("'✅'");
    expect(block).toContain("'❌'");
    expect(block).toContain("emoji: emoji as");
  });

  test("REGRESSION V3-5.7: the ungated site the old lock let through is red", () => {
    // The exact false green the V3-2.18 reviewer executed against the previous
    // lock: eyes on a message whose mirror may have failed, inserted above the
    // delivery call and carrying no permission-reply clause. Spliced into the
    // real body rather than a toy string, so this stays a statement about
    // server.ts. On disk it was replayed once by hand and this named test went
    // red; here it is permanent.
    const anchor = "\n  deliverOrBuffer(text, meta);\n";
    expect(inbound.body).toContain(anchor);
    const mutated = inbound.body.replace(
      anchor,
      [
        "",
        "  if (msgId != null) {",
        "    void bot.api",
        "      .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }])",
        "      .catch(() => {});",
        "  }",
        "  deliverOrBuffer(text, meta);",
        "",
      ].join("\n"),
    );
    expect(mutated).not.toBe(inbound.body);

    const ungated = reactionSites(mutated).filter((s) => s.gate === null);
    expect(ungated.length).toBe(1);
    // Outermost header is always handleInbound's own; the site's only condition
    // is the innermost one, and it says nothing about the mirror.
    expect(ungated[0]!.headers.at(-1)).toBe("if (msgId != null) {");

    // A bare site with no enclosing condition at all is the same verdict.
    const bare = inbound.body.replace(
      anchor,
      "\n  void bot.api.setMessageReaction(chat_id, msgId!, []);\n" +
        "  deliverOrBuffer(text, meta);\n",
    );
    expect(reactionSites(bare).filter((s) => s.gate === null).length).toBe(1);
  });

  test("a comment claiming the gate is not the gate", () => {
    // Why comments are blanked: the receipt gate is explained in prose directly
    // above the site it guards, so a lock reading raw text would accept the
    // explanation instead of the code.
    const [site] = reactionSites(
      [
        "async function handleInbound(ctx) {",
        "  // gated on receipt?.stored === true, honestly",
        "  if (msgId != null) {",
        "    await bot.api.setMessageReaction(chat_id, msgId, []);",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(site!.gate).toBe(null);
  });

  test("a grammY ctx.react() site is a reaction site too", () => {
    // The bypass a setMessageReaction-only lock would have: same symbol on the
    // same message through the context helper.
    const [site] = reactionSites(
      [
        "async function handleInbound(ctx) {",
        "  await ctx.react('👀');",
        "}",
      ].join("\n"),
    );
    expect(site!.gate).toBe(null);
  });

  test("the react MCP tool's guarded site is not read as an inbound site", () => {
    // V3-5.8 landed a reservation guard around the model-driven `react` tool,
    // which is a reaction call in the same file with a different contract
    // (locked by react-receipt-reservation.test.ts). handleInbound's boundary
    // must exclude it, or this lock would judge it by the wrong rule.
    expect(inbound.body).not.toContain("case 'react':");
    expect(inbound.body).not.toContain("assertReactionEmojiAllowed(");

    const toolSite = server.indexOf("assertReactionEmojiAllowed(String(");
    expect(toolSite).toBeGreaterThanOrEqual(0);
    const bodyEnd = inbound.offset + inbound.body.length;
    expect(toolSite < inbound.offset || toolSite >= bodyEnd).toBe(true);

    // ...and every reaction call the whole file has is accounted for: the ones
    // inside handleInbound plus the guarded tool site plus the commented-out
    // decision-ack site, which blanking removes.
    const whole = blankComments(server);
    expect(whole.endedInCode).toBe(true);
    expect([...whole.code.matchAll(REACTION_CALL)].length).toBe(
      reactionSites(inbound.body).length + 1,
    );
  });

  test("the analyzer reads handleInbound as balanced", () => {
    // The scanner counts braces without modelling regex literals. If a future
    // edit introduces one it cannot read, that shows up here as an unbalanced
    // body — a named failure — rather than as a silently mis-attributed gate.
    const { code, endedInCode } = blankComments(inbound.body);
    expect(endedInCode).toBe(true);
    let depth = 0;
    let lowest = 0;
    for (const c of code) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (depth < lowest) lowest = depth;
    }
    expect([lowest, depth]).toEqual([0, 0]);
  });

  test("the swallowing catch is gone and cannot come back", () => {
    expect(server).not.toContain("never block delivery on mirroring");
    // The daemon must go through mirrorInbound, which reports the outcome,
    // rather than calling the throwing append directly.
    expect(server).not.toContain("appendInboxLine(");
    expect(server).toContain("mirrorInbound(");
  });

  test("delivery is not nested inside any mirror branch", () => {
    // deliverOrBuffer sits at handleInbound's top level (two-space indent), so
    // no mirror outcome can skip it. A regression that moved delivery under
    // `if (receipt...)` would indent it further and fail here.
    expect(server).toContain("\n  deliverOrBuffer(text, meta);\n");
  });

  test("the mirror-failure notice cannot be lost with its reply target", () => {
    // V3-5.7: the notice replied to the offending message with no
    // allow_sending_without_reply, so a deleted target made Telegram refuse the
    // send and he lost the only warning that a requirement never reached disk.
    // The payload is built by mirrorFailureSendOptions (behaviour locked in
    // inbox-mirror.test.ts); handleInbound must use it rather than hand-rolling
    // options that can drop the flag again.
    expect(inbound.body).toContain("mirrorFailureSendOptions(msgId)");
    const { code } = blankComments(inbound.body);
    for (const literal of code.matchAll(/reply_parameters:\s*\{[^}]*\}/g)) {
      expect(literal[0]).toContain("allow_sending_without_reply: true");
    }
  });
});
