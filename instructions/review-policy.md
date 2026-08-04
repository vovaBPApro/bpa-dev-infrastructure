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
equals the report's commit before it accepts the record.

A reviewer LANE writes that record to TWO destinations, because two mechanisms
read it at different times. Landing reads `<reviewed-branch>.review.md` next to
the reviewed lane's report, as above. Lane exit reads `$LANE_REPORT_PATH`, the
reviewer's own terminal artifact, and `gate/lane-exit.sh --role reviewer` holds
it to the review contract rather than the coder report contract. Nothing copies
one to the other: a reviewer that writes only the landing artifact still exits
unfinished, and a reviewer that writes only its own report leaves nothing for
the gate to accept. Write both, with identical field values. The two readers share one
definition — `land_review_artifact_contract()` in `gate/land-lib.sh` — so a record
the exit guard accepts is shape-valid at landing too. They diverge only where
policy differs, and only in these three places: landing refuses a `REJECT` while
lane exit accepts it (a reviewer that reached a REJECT finished its work, so its
lane is terminal, not failed); `reviewed-sha` equality against the report's commit
is checked only at landing; and self-authorship is checked only at landing, where
the reviewed branch is known. Break-glass
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
returns for the target branch on origin** — never from a ref name. A
remote-tracking ref such as `refs/remotes/origin/main` is a local branch ref in
another namespace: lane worktrees share one Git common directory, so any lane
can point one at a commit origin has never held with an ordinary
`git update-ref`, needing no push access, no signing key, and nothing the
permission surface treats as privileged. The command therefore refuses a ref
name outright and accepts only an immutable SHA, and the gate refuses to
proceed at all when its local view of the target disagrees with what origin
answers. It accepts no authorization payload, trust root, or decision selector
from its caller — the one candidate fact it takes, the rev being landed, can
only make a decision file inert (one that rev **deletes**, measured against its
merge-base, so a lane cut before a grant was published is not mistaken for a
lane retracting it), never make one grant. A lane branch is refused as a
target, and as a default-branch nomination, before any of this runs.

What `origin` *means* is shared mutable state too. `remote.origin.url` lives in
the same lane-writable common directory, and Git honors extra `pushurl` values
— which once let three plain `git config` writes point the gate's reads at a
forged repository while its writes still reached the real one. The gate
therefore resolves **one origin URL per landing and uses it for every remote
read and write**: a second `url`, or any `pushurl`, is refused outright, and
the URL must equal the pin the target branch itself tracks
(`instance/params.yaml: repos.git_remote`) wherever that pin exists. With a
single URL there is no read/write split left to exploit — either it names the
real origin and the authority read from it is real, or it does not and nothing
the landing does ever reaches the real integration branch. Redirecting a clone
now requires forging the tracked pin on a forged remote — durable, reviewable
content, not an invisible config edit — and the payload guard reserves the
pinned value against candidate branches.

What the payload guard reserves and what the authority reads are **one
implementation, not two matching ones**: the guard asks the authority code
itself, over the raw blob bytes, whether a candidate file under
`instance/decisions/` carries a grant in its frontmatter. They used to be two
parsers over two I/O paths, and the gap between them was one NUL byte wide —
bash command substitution deletes NUL bytes, so a single binary byte closed
the frontmatter for the guard's copy and left it open for the reader's, and a
lane could land its own authorization through the ordinary gate. A blob
containing a NUL byte is not text: it grants nothing, and it is reserved,
because a file the predicate cannot certify inert must not be landable by a
lane. Recording an ordinary decision, or quoting the format inside one, stays
ordinary lane work; reserving less than the reader grants would let a lane
land its own authority, and reserving more would block the operator's verbatim
words.

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
check, so one bad file cannot abort landings for items it does not name. A file
that does name the item is still held to the whole contract, so an
authorization-shaped line for that item is never silently ignored — with one
exception that keeps the repair path inside the gate: a file the landing
candidate **deletes** — relative to its merge-base, so mere absence in a lane
cut earlier does not count — is inert, grant and refusal alike. Deletion is
retraction, so refusing it would protect an authorization that is being
removed. Without that, the two most likely operator typos — `park=cap`, or a
trailing space — bricked precisely the item he was trying to release, including
the branch that would delete the file, and repairing it meant borrowing another
item's id from a closed registry.

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

Two failure modes are outside the mechanism and known, so they are named rather
than implied. The replay loop consumes attempt refs in lexicographic order, so
once an item reaches two-digit rounds with a single-digit ref still unreplayed,
`10-` sorts before `2-` and the landing dies inside the replay loop — the same
place a stranded decision used to die. And `land_force_reset` treats an
untracked file in the canonical checkout as a failed rollback, so an ordinary
aborted landing can report `rollback-failed` for a ref that provably did not
move and wedge the next landing. Both are pre-existing, both have their own
rows, and neither is reachable through this authority.

The decision authority's trust root, stated without flattery, is **write access
to the integration branch on the real origin**. A tracked decision file proves
that someone with that write access published it — no more. On this
installation (`capture.mode: manual`) decision files do not travel through the
gate at all: the orchestrator captures the operator's words and pushes them to
the integration branch directly, as mandated routine, so the gate's review
requirement never applies to the decision itself, and what a tracked decision
is worth is exactly what the orchestrator's capture discipline is worth. The
gate's own guarantee is narrower and mechanical: no *lane*, using ordinary git
commands against anything a lane can write — local refs, remote-tracking refs,
the shared config, a candidate branch — can mint, redirect, or split that
authority, and every supported use of it is durably recorded. An agent that
pushes to the integration branch directly, or edits the gate's own tracked
code, is outside that boundary and always was; the mechanism makes such acts
durable and attributable, not impossible. Calling the command outside a landing
grants nothing, because the gate rebuilds review-round state from the target
branch at the start of every landing.

The recorded events are hash-chained, and the chain is verified on every read:
each digest is recomputed from the event's own fields, so editing a decision id,
an authorizer, a source path, a timestamp, or the order of events is a
fail-closed refusal rather than a value the next event chains onto. The
consumed-decision ledger and the events are checked against each other in both
directions, so neither an event without its ledger entry nor a ledger entry
whose event was deleted — including the newest one, where forward chain
verification cannot notice — loads. What this supports is detection of
**careless or partial** edits to the state file. It is not tamper-evidence
against a deliberate attacker: the digests are a pure function of public
fields, with no secret and no external anchor, so anyone who can write the file
can recompute a chain that verifies cleanly. And the file is a reserved path
rebuilt from the target branch each landing, so an agent that can push to the
integration branch directly rewrites history and the chain with it — the same
boundary as everything else on this page.

One property here is recorded as an open defect, not decided: an authorization
that arrives before its park **waits indefinitely**, and will fire at the first
`no-progress` park the item reaches, possibly much later and for a different
reason than the one he was asked about. A one-time go-ahead and a standing
condition are not the same thing. Bounding it costs the operator nothing to
write — the `at` a grant carries is gate-derived from the publishing commit,
not operator-supplied — but it does cost a correct definition of "the item has
advanced since": the natural bound (a grant published at round N authorises
round N+1 only) must be measured against the durable attempt-ref
reconstruction, because the tracked round cache can lag it — an item can carry
attempt refs and no cache entry at all, and HR-2149's own target does — and
measured against the cache such a bound would strand exactly the decision it
is meant to protect. That definition is successor work with its own row; until
it lands, the gun is loaded and this paragraph is the record saying so.

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
