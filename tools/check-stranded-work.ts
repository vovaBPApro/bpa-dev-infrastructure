#!/usr/bin/env bun

// Stranded work: no ACCEPTed work may exist only on this host (cutover gate F,
// workboard V3-5.51).
//
// WHY THIS EXISTS. A review is the most expensive artifact this system makes --
// an independent lane reads a diff, executes it, and writes a verdict -- and
// the whole of it lives in two places that a meteorite takes together: a branch
// in a local clone, and a `.review.md` beside it in the lanes directory.
// Neither is on origin until the landing gate puts it there. Gate F's clause is
// therefore a one-line property with a large consequence: "there is a way back"
// only if every ACCEPT this host holds also exists somewhere this host is not.
// Hard Floor 5 says the same thing about mechanisms; this says it about
// reviewed work.
//
// WHAT IT SWEEPS, in two independent arms, because the two artifacts can
// disagree and either one alone would miss what the other holds:
//
//   review artifacts   `<lanes>/<branch>.review.md` carrying exactly one
//                      `verdict: ACCEPT` and exactly one `reviewed-sha:`, read
//                      with the same column-0, exactly-once rule
//                      `land_review_contract()` in gate/land-lib.sh applies. The
//                      attested SHA is the work the reviewer accepted.
//   lane reports       `<lanes>/<branch>.report.md` whose CONTRACT HEADER
//                      carries `review:`, which by instructions/lane-lifecycle.md
//                      claims a completed review. The header's `commit:` is the
//                      work that claim is about, and it is not always the SHA
//                      the artifact attests -- a report amended after review
//                      moves one and not the other, which is precisely a case
//                      worth catching.
//
// WHAT COUNTS AS AN ORIGIN COUNTERPART. Origin is the authority, and it is
// ASKED rather than remembered: `git ls-remote` against the configured remote.
// A local `refs/remotes/origin/*` mirror would have been cheaper and is exactly
// the wrong trade -- a remote-tracking ref left behind by a branch since force-
// deleted on origin would vouch for work that is no longer there, which is a
// false PASS in the one direction this checker must never fail in. When origin
// cannot be reached the answer is UNKNOWN, never PASS. `--remote-refs` supplies
// the same listing from a file so the tests are hermetic and offline.
//
// A SHA has a counterpart when origin publishes a ref pointing exactly at it --
// which covers `refs/heads/main`, a retained lane branch, and the
// `refs/bpa-review-attempts/*` namespace gate/land.sh pushes reviewed attempts
// into -- or when it is an ancestor of one, which is what "landed in main's
// history" means.
//
// READ-ONLY, WITHOUT EXCEPTION. Every git call here is a query (`ls-remote`,
// `cat-file -e`, `rev-list`), the lanes directory is opened for reading and
// nothing else, and no artifact is rewritten, moved, tidied or annotated. The
// evidence this sweeps is the only copy of several reviews on this box; a
// sweeper that edits its own inputs destroys the thing it was built to protect.
//
// DELIBERATE EXEMPTIONS live in a tracked file, three columns -- artifact, SHA,
// reason -- and the SHA is a column rather than an afterthought: an exemption
// must not silently widen to cover a NEW attestation that appears in a file
// already blessed. A stale exemption (the work has a counterpart now) and an
// orphan exemption (the artifact is gone) are both errors, the same way
// tools/check-mechanism-reachability.ts treats its own.
//
// Exit codes:
//   0  PASS     every ACCEPT this host holds has an origin counterpart
//   1  FAIL     an ACCEPT's work exists only on this host, or an exemption is stale/orphaned
//   3  UNKNOWN  origin could not be asked, or evidence could not be read

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fieldValues, headerValues, lineValue } from "../gate/report-contract";

const GIT_TIMEOUT_MS = 120_000;
const SHA = /^[0-9a-f]{40}$/;

export type Attestation = {
  /** The evidence file's base name -- the exemption key, and what a FAIL names. */
  artifact: string;
  /** `review-artifact` or `lane-report`: which arm found it. */
  arm: "review-artifact" | "lane-report";
  sha: string;
};

export type SweepResult = { attestations: Attestation[]; unknowns: string[] };

function readable(path: string): string | { unreadable: string } {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every ACCEPT claim this host holds, and every claim that could not be read.
 * An unreadable or malformed claim is an UNKNOWN and never a silent skip: the
 * whole value of this sweep is that it does not pass over evidence it failed to
 * understand.
 */
export function sweep(lanesDir: string): SweepResult | { unknown: string } {
  let entries: string[];
  try {
    const stat = statSync(lanesDir);
    if (!stat.isDirectory()) return { unknown: `lanes directory is not a directory: ${lanesDir}` };
    entries = readdirSync(lanesDir).sort();
  } catch (error) {
    return { unknown: `lanes directory unreadable: ${lanesDir} (${error instanceof Error ? error.message : String(error)})` };
  }

  const attestations: Attestation[] = [];
  const unknowns: string[] = [];

  for (const name of entries.filter((entry) => entry.endsWith(".review.md"))) {
    const contents = readable(join(lanesDir, name));
    if (typeof contents !== "string") {
      unknowns.push(`${name}: review artifact unreadable (${contents.unreadable})`);
      continue;
    }
    const verdict = lineValue(contents, "verdict");
    if (verdict === undefined) {
      unknowns.push(`${name}: review artifact carries no single \`verdict:\` field, so whether it ACCEPTs anything is unreadable`);
      continue;
    }
    if (verdict !== "ACCEPT") continue;
    const reviewedSha = lineValue(contents, "reviewed-sha");
    if (reviewedSha === undefined || !SHA.test(reviewedSha)) {
      unknowns.push(`${name}: ACCEPT with no single 40-hex \`reviewed-sha:\` field (${reviewedSha ?? "absent or repeated"}), so the accepted work is unidentifiable`);
      continue;
    }
    attestations.push({ artifact: name, arm: "review-artifact", sha: reviewedSha });
  }

  for (const name of entries.filter((entry) => entry.endsWith(".report.md"))) {
    const contents = readable(join(lanesDir, name));
    if (typeof contents !== "string") {
      unknowns.push(`${name}: lane report unreadable (${contents.unreadable})`);
      continue;
    }
    const review = fieldValues(contents, "review");
    if (review.unterminatedFence) {
      unknowns.push(`${name}: lane report has an unterminated fenced block, so its fields cannot be told from its examples`);
      continue;
    }
    if (review.values.length === 0) continue;
    const commits = headerValues(contents, "commit");
    // `commit:` is read from the contract header only, spelled exactly at
    // column 0 -- the position gate/report-contract.ts documents, and the same
    // one gate/completion-guard.ts pins the branch tip against.
    const commit = commits.length === 1 ? commits[0]!.split(/\s+/)[0] ?? "" : "";
    if (!SHA.test(commit)) {
      unknowns.push(`${name}: report claims a completed review (\`review:\`) but its contract header carries no single 40-hex \`commit:\` (${commits.length} found), so the reviewed work is unidentifiable`);
      continue;
    }
    attestations.push({ artifact: name, arm: "lane-report", sha: commit });
  }

  return { attestations, unknowns };
}

export type Exemption = { artifact: string; sha: string; reason: string };

export function readExemptions(path: string): Exemption[] | { unknown: string } {
  const contents = readable(path);
  // An absent exemptions file means nothing is exempt, which is the strict
  // reading and the safe one. An unreadable-but-present file is UNKNOWN: a
  // permission error must not silently become "no exemptions" and then a FAIL
  // nobody can act on, nor the reverse.
  if (typeof contents !== "string") {
    return contents.unreadable.includes("ENOENT") ? [] : { unknown: `exemptions file unreadable: ${path} (${contents.unreadable})` };
  }
  const rows: Exemption[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = line.split("\t");
    if (cells.length !== 3 || cells.some((cell) => !cell.trim())) {
      return { unknown: `${path}:${index + 1} is not a three-column artifact/sha/reason row` };
    }
    if (!SHA.test(cells[1]!.trim())) return { unknown: `${path}:${index + 1} exempts a non-40-hex sha (${cells[1]!.trim()})` };
    rows.push({ artifact: cells[0]!.trim(), sha: cells[1]!.trim(), reason: cells[2]!.trim() });
  }
  return rows;
}

export type OriginRefs = { targets: Set<string>; count: number };

export function parseRemoteRefs(listing: string): OriginRefs {
  const targets = new Set<string>();
  let count = 0;
  for (const line of listing.split("\n")) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
    if (!match) continue;
    // A peeled tag line (`<sha> refs/tags/x^{}`) names the object the tag
    // resolves to, which is as good a counterpart as the tag itself.
    targets.add(match[1]!);
    count += 1;
  }
  return { targets, count };
}

export function originRefs(options: { repo: string; remote: string; remoteRefsFile?: string }): OriginRefs | { unknown: string } {
  if (options.remoteRefsFile) {
    const contents = readable(options.remoteRefsFile);
    if (typeof contents !== "string") return { unknown: `remote ref listing unreadable: ${options.remoteRefsFile} (${contents.unreadable})` };
    const parsed = parseRemoteRefs(contents);
    // Same refusal as the live query below, and for the same reason: a listing
    // naming no ref is an absent input, and gate E's rule is that an absent
    // input reports UNKNOWN. Reading it as "origin holds nothing" would turn a
    // broken query into a FAIL against every ACCEPT on the box.
    if (parsed.count === 0) return { unknown: `${options.remoteRefsFile} names no ref, so no counterpart could exist and none could be ruled out` };
    return parsed;
  }
  const run = spawnSync("git", ["-C", options.repo, "ls-remote", options.remote], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (run.signal) return { unknown: `\`git ls-remote ${options.remote}\` was killed by ${run.signal} after ${GIT_TIMEOUT_MS}ms, so origin was not asked` };
  if (run.status !== 0) return { unknown: `\`git ls-remote ${options.remote}\` failed (${(run.stderr ?? "").trim().split("\n").at(-1) || `exit ${run.status}`}), so origin was not asked` };
  const parsed = parseRemoteRefs(run.stdout ?? "");
  if (parsed.count === 0) return { unknown: `\`git ls-remote ${options.remote}\` returned no refs, so no counterpart could exist and none could be ruled out` };
  return parsed;
}

/**
 * Which of `shas` this host's object database still holds as commits, asked in
 * ONE `git cat-file --batch-check` rather than one process per sha: the live
 * sweep faces hundreds of artifacts and three hundred origin refs, and a
 * checker whose cost is a spawn per ref is a checker that gets skipped.
 */
export function presentCommits(repo: string, shas: string[]): Set<string> {
  const present = new Set<string>();
  if (shas.length === 0) return present;
  const run = spawnSync("git", ["-C", repo, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    encoding: "utf8",
    input: shas.join("\n"),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) return present;
  for (const line of (run.stdout ?? "").split("\n")) {
    const match = line.match(/^([0-9a-f]{40}) commit$/);
    if (match) present.add(match[1]!);
  }
  return present;
}

export type Disposition = { state: "counterpart" } | { state: "stranded"; detail: string } | { state: "unknown"; detail: string };

/**
 * Whether the local object database still holds `sha`, and whether origin can
 * reach it. The three-way answer matters: work absent from this host is not
 * stranded ON this host, but it is also not something this checker verified, so
 * it says so rather than counting it either way.
 */
export function disposition(repo: string, sha: string, refs: OriginRefs, presentTargets: string[], present: Set<string>): Disposition {
  if (refs.targets.has(sha)) return { state: "counterpart" };
  if (!present.has(sha)) {
    return { state: "unknown", detail: `attested sha ${sha} is absent from this host's object database, so whether the work still exists anywhere is unmeasured` };
  }
  if (presentTargets.length === 0) {
    return { state: "stranded", detail: `attested sha ${sha} is on this host and no origin ref points at it or reaches it` };
  }
  const input = [sha, ...presentTargets.map((target) => `^${target}`)].join("\n");
  const reachable = spawnSync("git", ["-C", repo, "rev-list", "--max-count=1", "--stdin"], { encoding: "utf8", input, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (reachable.signal) return { state: "unknown", detail: `reachability of ${sha} from origin was killed by ${reachable.signal}, so it is unmeasured` };
  if (reachable.status !== 0) return { state: "unknown", detail: `reachability of ${sha} from origin could not be computed (${(reachable.stderr ?? "").trim().split("\n").at(-1) || `exit ${reachable.status}`})` };
  return (reachable.stdout ?? "").trim() === ""
    ? { state: "counterpart" }
    : { state: "stranded", detail: `attested sha ${sha} is on this host and is reachable from no ref origin publishes` };
}

export type StrandedVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type StrandedResult = { verdict: StrandedVerdict; findings: string[]; evidence: string[] };

export function checkStrandedWork(options: { repo: string; lanesDir: string; remote: string; remoteRefsFile?: string; exemptions: string }): StrandedResult {
  const repo = resolve(options.repo);
  const findings: string[] = [];
  const evidence: string[] = [];

  const swept = sweep(options.lanesDir);
  if ("unknown" in swept) return { verdict: "UNKNOWN", findings: [swept.unknown], evidence };
  const exemptions = readExemptions(options.exemptions);
  if ("unknown" in exemptions) return { verdict: "UNKNOWN", findings: [exemptions.unknown], evidence };
  const refs = originRefs({ repo, remote: options.remote, remoteRefsFile: options.remoteRefsFile });
  if ("unknown" in refs) return { verdict: "UNKNOWN", findings: [refs.unknown], evidence };

  // Only origin targets this host actually holds can bound a rev-list walk; a
  // target whose object is missing locally is still an exact-match counterpart
  // through refs.targets above, so nothing is lost by excluding it here.
  const attestedShas = swept.attestations.map((attestation) => attestation.sha);
  const present = presentCommits(repo, [...new Set([...refs.targets, ...attestedShas])]);
  const presentTargets = [...refs.targets].filter((target) => present.has(target));

  evidence.push(`lanes-dir=${options.lanesDir}`);
  evidence.push(`origin=${options.remote} refs=${refs.count} distinct-targets=${refs.targets.size} present-locally=${presentTargets.length}`);
  evidence.push(`accept-attestations=${swept.attestations.length} exemptions=${exemptions.length}`);

  const exempted = new Map(exemptions.map((row) => [`${row.artifact}\t${row.sha}`, row]));
  const usedExemptions = new Set<string>();
  const seenArtifacts = new Set(swept.attestations.map((attestation) => attestation.artifact));

  let stranded = 0;
  let unmeasured = swept.unknowns.length > 0;
  for (const unknown of swept.unknowns) findings.push(`UNKNOWN ${unknown}`);

  for (const attestation of swept.attestations) {
    const key = `${attestation.artifact}\t${attestation.sha}`;
    const verdict = disposition(repo, attestation.sha, refs, presentTargets, present);
    if (verdict.state === "counterpart") {
      if (exempted.has(key)) {
        usedExemptions.add(key);
        findings.push(`FAIL stale exemption: ${attestation.artifact} sha=${attestation.sha} now has an origin counterpart`);
        stranded += 1;
      }
      continue;
    }
    if (verdict.state === "unknown") {
      unmeasured = true;
      findings.push(`UNKNOWN ${attestation.arm} ${attestation.artifact}: ${verdict.detail}`);
      // An exemption written against an UNKNOWN is consumed HERE, before the
      // orphan sweep below, and refused for what it actually is. Falling
      // through instead told an operator that their artifact carries no ACCEPT
      // attesting that sha, while the artifact plainly does -- a true verdict
      // direction reached by a false statement about the evidence, pointing the
      // repair at deleting the review record. The row is still an error, because
      // an unmeasured attestation is not exemptible: nothing was measured for an
      // exemption to overrule.
      if (exempted.has(key)) {
        usedExemptions.add(key);
        stranded += 1;
        findings.push(
          `FAIL inapplicable exemption: ${attestation.artifact} sha=${attestation.sha} exempts an attestation this sweep could not measure, and an UNKNOWN is not exemptible — resolve the UNKNOWN above, do not exempt it`,
        );
      }
      continue;
    }
    if (exempted.has(key)) {
      usedExemptions.add(key);
      evidence.push(`exempt ${attestation.artifact} sha=${attestation.sha} reason=${exempted.get(key)!.reason}`);
      continue;
    }
    stranded += 1;
    findings.push(`FAIL stranded ${attestation.arm} ${attestation.artifact}: ${verdict.detail}`);
  }

  for (const row of exemptions) {
    const key = `${row.artifact}\t${row.sha}`;
    if (usedExemptions.has(key)) continue;
    stranded += 1;
    findings.push(
      seenArtifacts.has(row.artifact)
        ? `FAIL orphan exemption: ${row.artifact} carries no ACCEPT attesting sha=${row.sha}`
        : `FAIL orphan exemption: ${row.artifact} holds no ACCEPT this sweep can see`,
    );
  }

  if (stranded > 0) return { verdict: "FAIL", findings, evidence };
  if (unmeasured) return { verdict: "UNKNOWN", findings, evidence };
  return { verdict: "PASS", findings, evidence };
}

export const EXIT_CODES: Record<StrandedVerdict, number> = { PASS: 0, FAIL: 1, UNKNOWN: 3 };

export function defaultLanesDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache"), "infra-lanes");
}

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) {
    console.error(`STRANDED-WORK UNKNOWN argument-missing name=${name}`);
    process.exit(EXIT_CODES.UNKNOWN);
  }
  return value;
}

if (import.meta.main) {
  const repo = argument("--repo", join(import.meta.dir, ".."));
  const result = checkStrandedWork({
    repo,
    lanesDir: argument("--lanes-dir", defaultLanesDir()),
    remote: argument("--remote", "origin"),
    remoteRefsFile: argument("--remote-refs", "") || undefined,
    exemptions: argument("--exemptions", join(repo, "instance/stranded-work-exemptions.tsv")),
  });
  for (const line of result.evidence) console.log(`STRANDED-WORK evidence ${line}`);
  for (const line of result.findings) console.error(`STRANDED-WORK ${line}`);
  console.log(`STRANDED-WORK ${result.verdict}`);
  process.exit(EXIT_CODES[result.verdict]);
}
