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

describe("daemon/server.ts honours the receipt at every reaction site", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("both generic ack sites gate on a stored mirror row", () => {
    const sites = [
      ...server.matchAll(
        /if \(\s*([^()]*?captionHandled !== 'permission-reply'\s*)\)/g,
      ),
    ].map((m) => m[1]!);

    // The 👀 site and the access.ackReaction site — the two the Human reads
    // as a receipt. If this count changes, the new site needs the gate too.
    expect(sites.length).toBe(2);
    for (const condition of sites) {
      expect(condition).toContain("receipt?.stored === true");
    }
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
});
