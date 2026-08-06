// Checker outcome vocabulary, shared by tools/instructions/check.ts and every
// module that feeds it findings (ledger.ts, paths.ts, session-load.ts).
//
// V3-5.44 (cutover-ready gate E: "any check whose inputs are absent reports
// UNKNOWN, never PASS"). Before this file the vocabulary was PASS/WARN/FAIL/
// SKIP, and a check that could not see its inputs had nowhere honest to sit: it
// either SKIPped (which reads as "fine, not applicable") or reported a measured
// verdict it had not measured. Both are the same defect — absence of evidence
// rendered as evidence of absence of a problem.
//
//   PASS     the check read its inputs and they were fine.
//   WARN     a real finding that is visible but not blocking.
//   FAIL     a real finding, blocking.
//   UNKNOWN  the check could NOT run: an input it must read to form its verdict
//            is absent or unreadable. Never green. Non-zero under --strict.
//   SKIP     the check does not apply to this repository, and the repository
//            SAYS SO. A SKIP must name the declaration that licenses it, in
//            place, in its detail string.
//
// The UNKNOWN-vs-SKIP question is decidable, not a matter of taste: if you can
// point at the thing that declares "this does not apply here" — a parameter
// (`capture.mode: manual`), an opt-out (`pack: none`), a marker the artifact
// itself carries, or a whole layer this repo does not have — it is a SKIP. If
// all you have is that the file is not there, it is UNKNOWN.

import { existsSync } from "node:fs";
import { join } from "node:path";

export type CheckLevel = "FAIL" | "UNKNOWN" | "WARN" | "SKIP" | "PASS";

// Report ordering: the two outcomes that block come first, then the visible
// findings, then the licensed non-applicable ones, then the measured greens.
export const LEVEL_ORDER: Record<CheckLevel, number> = {
  FAIL: 0,
  UNKNOWN: 1,
  WARN: 2,
  SKIP: 3,
  PASS: 4,
};

// Exit-code policy, in one place so every caller agrees. A FAIL always blocks.
// An UNKNOWN blocks under --strict — that is what "fail-closed" means when the
// inputs are missing — and stays loudly visible (its own level, its own count)
// otherwise, so a lenient run still shows what could not be measured.
export function blocks(level: CheckLevel, strict: boolean): boolean {
  if (level === "FAIL") return true;
  return level === "UNKNOWN" && strict;
}

// ---------------------------------------------------------------------------
// The instance/ layer: the one absence that licenses a SKIP.
//
// `instance/` is the L1 installation layer (instructions/instruction-layers.md).
// L2 and L3 repos are born without it — tools/instructions/scaffold.ts writes no
// instance/ dir at all — so an instance-backed check genuinely does not apply
// there. That is a declaration: the whole layer is absent by design.
//
// The moment a repo HAS an instance/ directory it is an installation, and every
// instance-backed input it lacks becomes UNKNOWN. A deleted params.yaml, a
// deleted decisions ledger or a deleted pack config must never read as "not
// applicable here" — that is exactly the silent pass gate E was written about.

export function hasInstanceLayer(repo: string): boolean {
  return existsSync(join(repo, "instance"));
}

// Verdict for an instance-backed input that is not present. `what` names the
// missing input; `measured` names, in the present tense, what could not be
// measured because of it.
export function instanceInputVerdict(
  repo: string,
  what: string,
  measured: string,
): { level: CheckLevel; detail: string } {
  if (!hasInstanceLayer(repo)) {
    return {
      level: "SKIP",
      detail: `no instance/ layer in this repo — ${what} is an L1 installation artifact (instruction-layers); nothing to check for ${measured}`,
    };
  }
  return {
    level: "UNKNOWN",
    detail: `instance/ exists but ${what} is absent — no verdict for ${measured}`,
  };
}
