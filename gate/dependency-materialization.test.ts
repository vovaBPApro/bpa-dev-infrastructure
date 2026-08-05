import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
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
//      by installing on the host instead of in the repository.
//
// (3) is the load-bearing one. (1) and (2) are the wiring that keeps it from
// being satisfied by accident.

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
// Bun.Transpiler.scanImports would be the exact reader, and it is deliberately
// not used: on this repository's largest tracked source it terminates the
// process with status 0 and no output, which inside the landing suite would be
// a silent kill dressed as a pass -- the failure mode `verification-and-locks`
// spends a section on. A regex plus a package-name shape filter is the weaker
// reader that cannot do that. It errs toward finding MORE specifiers than the
// runtime does (a package named in a comment is still required to resolve),
// which is the safe direction for a lock.
const IMPORT_FORM = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

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
    for (const match of readFileSync(join(repoRoot, file), "utf8").matchAll(IMPORT_FORM)) {
      const specifier = match[2];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("bun:") || specifier.startsWith("node:")) continue;
      if (isBuiltin(specifier)) continue;
      if (!PACKAGE_SPECIFIER.test(specifier)) continue;
      found.push({ file, specifier });
    }
  }
  return found;
}

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
