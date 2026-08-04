---
id: review-policy
layer: L1
status: binding
audience: reviewer
tags: [review, risk]
summary: Review is a risk and evidence gate: check the SHA, changed paths, acceptance evidence, and rollback posture.
---

# Review Policy

Review is a risk and evidence gate, not a style ritual. Review the exact commit
SHA, changed paths, acceptance evidence, and rollback posture; reject a
narrative that cannot be rerun.

## Tiers and routing

- **Tier A:** authentication or authorization, migrations or data integrity,
  money, orchestrator or watchdog core, secrets, CI or environment schema,
  production infrastructure, cleanup/rollback, and evidence-gate changes.
  Unclear classification is Tier A.
- **Tier B:** bounded lower-risk docs, tests, and fixes that do not alter a
  Tier-A surface.
- Tier A requires an independent implementation consilium with distinct
  role/persona lenses before landing. Per `instance/decisions/HR-212.md`, role
  diversity outranks vendor diversity; cross-vendor review is a supplement when
  cheaply available, not a condition landing waits for. A review of a plan never
  substitutes for diff review.
- Tier B requires an independent executable lock review: run the relevant
  regression lock, prove it fails before the fix and passes at the reviewed
  SHA, and reject false-green test environments. A visual or interaction lock
  must exercise a live rendered surface when that is what failed.
- Route matching paths through `gate/review-policy.conf`. `gate/land.sh` is the
  fail-closed landing gate; use `gate/land-batch.sh` only for independently
  ready, gated branches. Neither tool replaces review judgment.

## Review record and verdict

Record reviewer identity/independence, tier, reviewed SHA and diff, commands
run, evidence inspected, findings, and one verdict: `ACCEPT`, `REJECT`, or
`NO-GO`. Any reject, missing evidence, timeout, scope breach, or unverified
rollback blocks landing until dispositioned.

Classify every finding as `closed`, `moved`, or `open`; for each disposition,
cite its evidence and mark whether the evidence was read or executed. A finding
is `closed` only when its new evidence would have caught the original failure.

For gate-routed changes, the record must include plain column-1 `reviewed-sha:`
and non-empty `independence:` fields. The landing gate verifies that the SHA
equals the report's commit before it accepts the record. Break-glass
`--skip-review` requires a reason and is durably audited in the runtime review
skip log; see the gate's usage output for operational mechanics.

## Constrained-provider review

A same-provider consortium is valid when its reviewers are separate sessions
with distinct role/persona lenses. Preserve separate passes for security,
operations/runtime, and tests/regression; every pass reviews the same SHA and
any rejection parks the item. Provider constraint never lowers the tier,
session-independence requirement, or an explicit approval boundary.

## Round cap and test escalation

The landing gate checks the caller's item against the tracked instance review-item
registry on the target branch. That registry maps a durable mission/acceptance id
to a stable branch root; disposable `-rN` recuts therefore share one counter and
unknown ids fail instead of minting state. The gate records every reviewed landing
attempt in two origin-visible, non-branch Git ref namespaces before continuing
the landing. The gate requires an exact mirror: independently forging or deleting
either record is detected and fails closed before the counter is reconstructed.
The target-branch JSON and Git-common-dir copy are reconstructable caches over
those refs, so restarting the orchestrator, deleting the cache, or making a fresh
clone does not reset either measure. Existing malformed or unsafe state still
fails closed.

An item receives at most three review rounds. A fourth is refused and parked as
`cap`. There is no lane-callable reset or override. At the cap, unresolved
concerns become executable fail-before and pass-after locks; if that cannot be
done, the item remains parked for recut.

An operator may release only a `no-progress` park, and only through one of two
authorities. Both consume a decision exactly once, for exactly the item it names,
through the same ledger.

The primary authority is **a decision file tracked on the integration branch**.
A file `instance/decisions/<decision-id>.md` carries exactly one line, **inside
its YAML frontmatter**:

```text
---
id: <decision-id>
operator-unpark: v2 item=<item-id> decision=<decision-id> park=no-progress
---
```

Its `<decision-id>` must equal its own file name, so the audit record leads back
to the operator's words in one step and a file cannot be padded with extra
grants.

The frontmatter requirement is not decoration. This directory is where the
operator's words are stored verbatim (Hard Rule 16), and those words routinely
quote this format back — including in the fenced block two paragraphs up. A
marker matched anywhere in the file cannot tell a quotation from a grant, so
capturing his message about this feature would silently unpark whatever item it
quoted. Below the closing `---`, the line is text about an authorization and
grants nothing; a file with no frontmatter, or an unterminated block, grants
nothing either.

The landing gate reads that directory from **the commit SHA `git ls-remote`
returns for the target branch on origin** — never from a ref name. That
distinction is the whole trust root. A remote-tracking ref such as
`refs/remotes/origin/main` is a local branch ref in another namespace: lane
worktrees share one Git common directory, so any lane can point one at a commit
origin has never held with an ordinary `git update-ref`, needing no push access,
no signing key, and nothing the permission surface treats as privileged. The
command therefore refuses a ref name outright and accepts only an immutable SHA,
and the gate refuses to proceed at all when its local view of the target
disagrees with what origin answers. It equally accepts no authorization payload,
trust root, or decision selector from its caller; a lane branch is refused as a
target before any of this runs.

The trust root is therefore the one the repository already enforces:
`instance/decisions/` reaches origin only through this gate, gate paths require
an independent ACCEPT, and the payload guard reserves any candidate file under
that directory carrying the marker in its frontmatter — so a lane cannot land the
authorization that would release it, while recording an ordinary decision, or
quoting the format inside one, stays ordinary lane work. What the guard reserves
and what the authority reads are the same definition on purpose: reserving less
would let a lane land its own authority, and reserving more would block the
operator's verbatim words.

Consumption is recorded in the target-branch review-round history and is durable
only if the landing merges, so a failed landing does not burn a decision — and
does not strand one either. An authorised landing that publishes its attempt ref
and then aborts leaves that ref permanent while the release goes unrecorded; the
gate replays such a ref as a reconstruction rather than a fresh admission, so the
park it rebuilds is the one the target branch recorded and the decision still
applies on the next attempt. A decision id, once spent, is bound to that item
forever: retargeting the file at another item is refused, and reapplying it to
the same item is a logged no-op. An authorization that meets no `no-progress`
park is not consumed — it waits for one, and never fires against a `cap` park.

A malformed, archived, or hostile file in that directory fails **that decision**
and never the gate. Files are filtered to the item being landed before any strict
check, so one bad file cannot abort landings for items it does not name — which
is what leaves a repair path through the gate rather than around it. A file that
does name the item is still held to the whole contract, so an authorization-shaped
line for that item is never silently ignored.

The alternative authority is a signature, kept because HR-2109 gives the eventual
administrator bot a signing role. An operator may release the same park with
`gate/operator-unpark.sh`.
The authorization is an exact, versioned statement signed in the
`bpa-operator-unpark` SSH namespace by a principal pinned in the fixed
`bpa-operator-unpark.allowed-signers` file in the repository's Git common
directory; the private key must remain off the agent host. This host-level public
trust root is provisioned during onboarding, is never read from a candidate tree,
and cannot be selected with a command-line option. The command publishes the authorization and signature atomically in
two origin-visible ref namespaces. Landing verifies the mirror and signature,
retains the decision id, authorizer, time, and hash-chained event in review-round
history, clears only consecutive no-progress, and grants exactly one additional
attempt without erasing the round count. It cannot release a `cap` park.

Root equivalence means no mechanism on this host can absolutely stop a malicious
agent that replaces the Git-common-dir trust file, steals an available signing key, or coordinates rewriting both remote
namespaces. Keeping the private key off-host prevents supported agents from
producing authority; paired immutable records make every supported use visible
and detect one-sided suppression, matching the attempt-ref threat boundary.

The decision authority has the same boundary and one addition of its own: it is
only as strong as write access to the integration branch on origin. An agent that
can push there directly, rather than through this gate, can write its own
authorization — which is why direct pushes to the integration branch are outside
lane authority, and why the review requirement on gate paths is the thing that
makes a tracked decision mean anything. Calling the command outside a landing
grants nothing, because the gate rebuilds review-round state from the target
branch at the start of every landing.

The recorded events are hash-chained, and the chain is verified on every read:
each digest is recomputed from the event's own fields, so editing a decision id,
an authorizer, a source path, a timestamp, or the order of events is a
fail-closed refusal rather than a value the next event chains onto. That makes it
tamper-**evident** against edits to the state file, which is the claim it can
support. It is not tamper-proof: the file is a reserved path rebuilt from the
target branch each landing, so an agent that can push to the integration branch
directly can still rewrite history and the chain with it — the same boundary as
everything else on this page.

One property here is deliberately left open for the operator rather than decided
in the mechanism: an authorization that arrives before its park **waits
indefinitely**, and will fire at the first `no-progress` park the item reaches,
possibly much later and for a different reason than the one he was asked about.
A one-time go-ahead and a standing condition are not the same thing. The grant
already carries the commit date of the commit that published it, so bounding its
age — or requiring it to name the round it authorises — would close this by
construction. Both change what the operator has to write, so the choice is his.

The counter is honest-but-not-tamper-resistant while lanes are root-equivalent.
A root lane can coordinate the same rewrite or deletion across both remote
namespaces, edit Git-common-dir state, or edit the gate itself; the mirror detects
independent forgery and suppression, not a coordinated root attack. Tamper
resistance depends on V3-1.9's non-root lane boundary plus independent landing
review. This mechanism prevents supported-interface evasion and detects
single-surface origin tampering; it does not claim protection from a malicious
root process.

Separately, consecutive reviewed attempts without a landed SHA are counted as
no progress. Reaching the configured limit parks the item as `no-progress`.
Every successful landing records its SHA and resets only this consecutive
no-progress measure; it does not erase the total review-round count. Missing,
unreadable, non-regular, symlinked, or malformed state fails landing closed.
