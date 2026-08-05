# Audit — recorded requirements are not read at the moment they are needed

Dispatched 2026-08-05 at the operator's explicit instruction (Telegram 2446), above the
three-lane cap, because he called it the first-order problem. Extended by him mid-audit
(Telegram 2449) to cover the personas case as a second archetype.

> Я також писав як бекапити! Зберігаємо архів всієі папки з твоіми данними, та і все. Там
> було навіть про періодичність бекапів! Передивись історію в телеграм. Це потребує
> окремого аудіта, саме цей випадок! Бо це яскравий приклад того кейсу коли я тобі
> розказую тут купу деталей а вони потів забуваються чи пропускаються! Треба інвестігейт
> та фікс першочерговоі проблеми! (2446)

> По персонажах - я вже давно просив тебе дати мені мд файл з візуалізацією ролей і їх
> звязків, плюс додатково почснення кожного персонажа. Я це так і не отримав, ти
> благополучно проїбав! Це можна також додати в той інвестігейт, де я скаржився на драйв.
> Думаю це допоможе кращє ідентифікувати корін проблеми (2449)

He is right that the second case identifies the root better than the first. The two fail
in *different* places, and only both together show that there is no single missing step —
there is a chain in which **every** link is fail-open.

## Verdict

**Capture is not the failure. Capture works.** 752 inbound messages are recorded verbatim
in `instance/decisions/inbox.jsonl`; 664 carry a triage verdict; 80 carry a full `HR-*.md`
record. HR-2171 holds his backup design in his own words, amended four times as he refined
it.

**The failure is that nothing in this system surfaces an open obligation, and three
separate mechanisms actively hide one.** Writing the capture file is, mechanically, what
removes the requirement from every list an agent reads.

Findings are ranked by how much of his intent was lost, not by message count.

---

## F1 — The persona requirement was closed against workboard rows that do not exist

**Intent lost: the largest on this board.** The whole team-of-ten persona design, asked
for on 2026-07-30, re-asked on 07-31, re-asked again on 08-05. Six days, three asks.

He gave it at msg **146** (2026-07-30, ~3 600 chars): ten team members with roles *and*
human characteristics, personas assembled into a consilium by the level of the discussion —
a code review does not need a product manager, a strategy call may not need a coder. It is
captured well: `instance/decisions/HR-146.md` documents it in full as seed row **NI-1**,
alongside NI-2 (Google Drive debug access) and NI-3 (local Whisper).

On 2026-07-31 he asked directly whether it had been recorded and implemented — msg **563**,
*«а ці речі ти нормально зафіксував і реалізував?»*, re-pasting the entire pack.

The triage row for msg 563 answers that question, in git:

```
563 | directive | requirements-pack |
    personas-gdrive-debug-whisper-pack-captured-ni-1-ni-2-ni-3-workboard-rows
```

**`NI-1`, `NI-2` and `NI-3` do not exist in `instance/workboard.md`. Zero occurrences.**
The board was rebuilt on the `V3-*` numbering and the `NI-*` seed rows were never carried
across. Two further triage rows (msg 162, msg 564) point at the same vanished ids.

So the ledger records a closure that was never real, and it has read as closed since
2026-07-31. Nothing detects this: **`routes-to` and triage `reason` are free text, and no
checker anywhere validates that a closure target resolves** — `grep -rn "routes-to"` across
`tools/` and `gate/` returns nothing.

`instance/cast.md` (landed 2026-08-03, commit `b6e4dd5`) does contain a mermaid map of
roles and mechanisms with an explanation of each character — close to what he asked for at
2449. He says he never received it, and **there is no way to check whether it was sent**
(F5). It links to neither HR-146 nor the triage row, so from the ledger's side the persona
requirement still has no artifact at all.

**Why this is first:** it is the one case where the record does not merely stay silent — it
actively asserts, in git, that the work was captured. An agent doing the check that HR-735
requires before asking him anything would read that row and conclude the matter was
handled.

## F2 — HR-2171 is a perfect capture with no state, no row, and no delivery path

**Intent lost: a full day of backup design, re-litigated from scratch.**

`instance/decisions/HR-2171.md` is 13 272 bytes of his verbatim words plus measurements,
amended four times as he corrected it (2178, 2179, 2190, 2268). By content it is the best
artifact in the ledger. By mechanism it is inert:

- it carries **no `state:` field** — it is one of 31 HR files with no frontmatter at all;
- it has **no workboard row**. `V3-2.9` (enumerate host state) and `V3-2.10` (credential
  runbook) are adjacent obligations, not this one;
- therefore it is delivered to no lane pack, appears in no session load, and ages against
  no SLA (F3, F4, F7).

This was already noticed and also not acted on. `instance/consilium-sprints-2026-08-04-fable.md:171`,
written the day before the incident:

> HR-2171 backup (file the row — **it currently exists only as a decision**: hourly Google
> Drive backup, ~10 versions, restore-on-startup interview)

The observation that the row was missing was itself recorded and then not read. That is the
same failure applied to a report about the failure.

**Consequence, on the morning of 2026-08-05:** the backup design was handled as unknown
work. His side of that exchange is recorded — msg **2434** *«Так шо ти там писав про
клієнта дл драйв? Яка робота?»*, then msg **2438**:

> Ааааа, та ти чого блять! Я ж тобі всі ці речі вже розказував!

Per `operator-feedback`, that is one question with two possible causes. **The cause here is
cause 2: a missing mechanism, not a misunderstanding.** The words were understood well
enough to be written down accurately; nothing put them back in front of the reader.

Note also msg **2405** and **2407**: he asked himself which account to use (*«гангста чи
бпа?»*) and then answered it by **creating a shared drive** at 21:08 the previous evening.
The account question was closed by his own action seven hours before it was raised again.

## F3 — Writing the capture file is what makes the requirement invisible

This is the mechanism behind F1 and F2, and it is exact.

Every surfacing path keys on `state: pending`:

| path | file:line | selects |
|---|---|---|
| lane mission packs | `tools/instructions/compose.ts:371` | `if (state !== "pending") continue;` |
| orchestrator session load | `tools/instructions/session-load.ts:155` | `frontmatterValue(contents,"state") !== "pending"` → skip |
| 72h aging SLA | `tools/instructions/ledger.ts:308` | `if (fields.state !== "pending") continue;` |

**Zero of the 80 `HR-*.md` files carry `state: pending`.** Measured distribution:
`routed` 45, **no `state:` field at all** 31, `open` 2, `backlog` 1, `captured` 1. 31 files
have no frontmatter whatsoever. The vocabulary `instruction-layers` declares is
`pending | routed | parked | superseded`; three of the values actually in use are outside
it, and **nothing validates the vocabulary or requires the field**.

So no HR file has ever been delivered to a lane pack, appeared in a session load, or aged.

And the fallback path is worse. Both the aging check and the session load compute "already
handled" **from the filename alone**:

```
ledger.ts:147-155   routedMsgIds()  — for each entry matching /^HR-(.+)\.md$/i, add the id
ledger.ts:259       if (routed.has(id) || triaged.has(id)) continue;
session-load.ts:167-173, 202  — the same block, inline, identically
```

`routedMsgIds()` does not read `state:`. A msg is treated as routed because a file named
`HR-<id>.md` exists — whatever is inside it.

**The two rules compose into a trap.** An HR file with no `state:` is not `pending`, so it
reaches no pack and no session. Its existence marks the msg id as routed, so the raw inbox
row is suppressed too. The requirement is visible only while it is *un*captured; the act of
capturing it well is the act of hiding it. That is HR-2171 exactly.

## F4 — The session load that would surface open requirements does not run

`session-load.ts` is the one mechanism designed to put `params.yaml`, pending HR rows and
untriaged inbound into the orchestrator's standing context. It is not wired.

- The live orchestrator runs **`provider=claude`** — confirmed from the live process list:
  `claude --model claude-opus-5 --dangerously-skip-permissions --mcp-config …`.
- `orchestrator/launch.sh:252-295` is the `claude` branch. **It contains no `SessionStart`
  hook — zero occurrences.** Only the `codex` branch (`:304-311`) wires one.
- That codex hook points at `$REPO_DIR/.claude/hooks/session-load.sh`. **The file does not
  exist, and `git ls-files .claude` returns nothing** — the entire `.claude/` directory is
  untracked. No tracked file creates it; the only other mention is a commented example in
  `runtime.env.example:41`.
- `launch.sh:304` guards on `[[ -x "$CODEX_SESSION_HOOK" ]]`, so an absent hook is **skipped
  in silence**. Fail-open.

The comment sitting directly above that guard asserts the opposite:

> without persisted trust codex drops the hook … and the orchestrator boots blind. **The
> hook source is this repository.**

It is not in this repository. This is also a Hard Floor 5 defect on its own: a mechanism
that exists only as a path some host might satisfy cannot be rebuilt from git.

**Net effect:** the 28 inbox rows that have neither a triage verdict nor an HR file — which
include **2405 and 2407, his shared-drive answer** — are visible through exactly one
mechanism, and that mechanism never fires.

## F5 — Outbound content is not retained, so "did I already tell him?" is unanswerable

`daemon/history-logger.ts` logs every Telegram delivery to
`/root/.claude/channels/telegram/history/messages-YYYY-MM.jsonl`. Measured on the live
file: **1 527 entries, 1 047 of them `direction: out, outcome: delivered`**, since
2026-08-01.

The stored fields are `ts, direction, outcome, chat_id, user, type, kind, content_length,
content_sha256`. **There is no content field.** Only a length and a hash.

Consequences:

- Whether `instance/cast.md` was ever sent to him (F1) **cannot be determined** — by him
  saying so, or not at all.
- The check HR-735 requires — *has he already been answered this?* — is answerable for his
  side of the conversation and **structurally unanswerable for ours**.
- Retention is 30 days (`DEFAULT_RETENTION_DAYS = 30`) and a 10 MB cap trims **oldest lines
  first** (`trimForAppend`, `:67-77`). Outbound before 2026-08-01 is already gone.
- The whole store is host-only, under `/root/.claude`, and is not in the V3-2.9 enumeration.

Retaining outbound text is a decision with a privacy and secret-handling dimension, so this
finding is stated, not fixed.

## F6 — 60% of his directives exist only as a one-line quote

Of the 285 rows triaged `directive`:

| bucket | count |
|---|---|
| triage row only — no HR file, and the msg id is referenced nowhere in `instance/`, `instructions/` or `CLAUDE.md` | **172 (60%)** |
| referenced somewhere, no HR file | 106 |
| HR file exists | 7 |

Across all 285, **51.6% of his original characters survive into the stored `quote`**
(99 611 → 51 433). Nine directives of 1 500+ characters have no HR file at all; the worst
compressions are msg 351 (3 645 → 46 chars, 1.3%), msg **563** (3 237 → 47 chars, 1.5% —
the persona re-ask from F1), msg 564 (1 627 → 71), msg 973 (1 539 → 71).

`repository-hygiene` requires the triage ledger to carry a verbatim `quote`, and it does —
but a verbatim *fragment* of a 3 600-character requirement is not the requirement. Nothing
distinguishes "this message was one line long" from "this message was flattened to one
line", because only the quote is kept and the inbox it was cut from is gitignored.

**89 of the 285** directive rows carry a `reason` that claims capture, routing or
completion. Three of those claims are provably false (F1). The other 86 are unverified by
any mechanism.

## F7 — Nothing ages, and the checker is green while it is all outstanding

`bun tools/instructions/ledger.ts` and `--strict` both **exit 0** with no findings.

The 72h aging SLA applies only to `state: pending` rows (`ledger.ts:308`), and there are
none. The inbox-triage SLA (`:259`) skips any id with an HR file or a triage row. So the
ledger is green with 80 uncleared HR records, three false closure claims, and 28 untriaged
inbound rows.

`tools/check-decision-ledger-drift.sh` checks only that HR records present on the donor
line also exist here — file existence, not whether the requirement inside was ever read.
Its own header names the failure class and does not close it:

> the requirement survived, the mechanism did not

## F8 — `instance/README.md` has never existed, and the pre-ask check routes through it

`CLAUDE.md` states: *"`instance/README.md` indexes this installation's facts and retained
evidence."* HR-735 and Hard Rule 14 require checking what he has already answered before
asking him anything. That check routes through a file that has never existed in v3 —
already recorded as audit finding F9 and still open.

He asked about it himself at msg **2444**, and proposed the fix in the same breath:

> А що саме мало бути в інстанс/рідмі? Що саме туди фіксується? Бо можливо варто завести
> правило щоб щє перевірялись логи телеграм і моі повідомлення? Чи може якісніше фіксувати
> в доку і інструкціі всі вимоги що я тобі тут розказую в телеграм?

The mechanism proposed below is his, made checkable.

---

## Classification summary

| class | count | basis |
|---|---|---|
| **captured and ignored** | **F1, F2 named; ≥3 provable** | HR record exists, closure target does not resolve or no row exists, work did not happen |
| **captured and flattened** | **172** directives | one-line quote only, no HR file, no reference anywhere tracked |
| **captured and referenced** | 106 directives + 80 HR files | msg id cited somewhere in tracked text — a *reference* proxy, not proof of completion |
| **never captured** | not measurable from here | `inbox.jsonl` is the only inbound record and is itself host-only and gitignored |

The last row is a real limit, stated rather than papered over: an audit whose ground truth
is the inbox cannot find what never reached the inbox. The "captured and referenced" count
is a proxy — a citation in a consilium document is not evidence the work happened, which is
why F1 and F2 were verified individually instead of counted.

---

## The smallest mechanism that makes this structural

One checker, three rules, one generated file. It closes F1, F2, F3, F6 and F7 and does not
depend on anyone's diligence.

**1. `state:` becomes mandatory, and absence means open — not invisible.**
Every `HR-*.md` carries `state:` from the declared vocabulary. A file with no `state:`, or
a value outside `pending | routed | parked | superseded`, is treated as **open** and fails
the checker. This alone un-hides the 31 fieldless records including HR-2171.

**2. Every closure claim must resolve.**
An HR `routes-to:` and a triage `reason` that names a target must name something that
exists — a workboard row id present in `instance/workboard.md`, or a file path that exists.
An unresolvable target is a FAIL, not a pass. This is the rule that catches `NI-1/NI-2/NI-3`
and would have caught it on 2026-07-31.

**3. The open-obligation list is generated, never hand-maintained.**
The same checker writes `instance/open-requirements.md`: every requirement that is not
provably closed, with its msg id, date, age, and the target it is waiting on. That is the
list that does not exist today and whose absence makes *"did he already say this?"*
archaeology. Because it is derived, it cannot drift from the ledger; because it is tracked,
it survives the meteorite; and because it is one file, `CLAUDE.md` can route the HR-735
pre-ask check at it instead of at the absent `instance/README.md`.

**Delivery changes by one predicate.** `compose.ts:371`, `session-load.ts:155` and
`ledger.ts:308` currently select `state === "pending"`. They should select **not closed**.
And `routedMsgIds()` must read the file's state rather than infer routing from its
filename — that single function is what converts a good capture into a hidden one.

### What this does NOT fix

- **It does not make anyone read the list.** It guarantees the list exists, is complete
  against the inbox, and cannot silently claim a closure that isn't there. Reading it is
  still a behaviour, and behaviour is what failed here.
- **It does not recover the delivery question (F5).** Whether he was told something, or
  sent an artifact, stays unanswerable until outbound content is retained — a separate
  decision with privacy and secret-handling consequences that is his to make.
- **It does not wire the session load (F4).** The `claude` provider branch has no
  SessionStart hook and the codex hook file is untracked and absent. That is its own row,
  and until it lands, a generated list still has no automatic path into a session.
- **It cannot see the "never captured" class.** Ground truth is `inbox.jsonl`, which is
  host-only and gitignored. A requirement that never reached it is invisible to this
  mechanism and to this audit.
- **It does not judge whether the work satisfies the requirement.** Rule 2 proves a target
  *exists*; it does not prove the target is adequate. A row that resolves to a workboard
  entry saying nothing useful passes.
- **It does not un-flatten the 172 already-flattened rows.** It stops the next one; the
  existing backlog is re-reading work.

---

## By-product — everything he has said about Google Drive and backups

Consolidated from the raw inbox. Later messages supersede earlier ones; supersessions are
marked. Message ids are `inbox.jsonl` / Telegram ids.

**What to back up.** The whole data folder, as an archive — *«Зберігаємо архів всієі папки
з твоіми данними, та і все»* (2446); *«просто архівувати папку і бекапити архів в гугл
драйв і все»* (2268). Measured now: `/root/.local/state/bpa` **135 168 B** (`state.db`,
`-wal`, `-shm`), `/root/.local/state/bpa-dev-infrastructure` **1 445 B**. His premise that
the files are small holds.

**Cadence: every 5 minutes.** *«тоді бекапи можемо робити кожні п'ять хвилин, я думаю, для
google це невелике навантаження по запитах»* (2178) — **supersedes** the hourly figure in
2171 (*«туди просто бекап раз на годину нехай»*).

**Retention: last 10, simple rotation.** *«останні десять версій ти зберігаєш на цьому, на
google диску. ти їх просто перетираєш, переписуєш. одну додаєш, одну видаляєш, коли
накопичились, і всьо. ти не так поняв про десять версій. нащо ти ускладняєш?»* (2190) —
**rejects** the two-tier retention the orchestrator proposed. At a 5-minute cadence this is
a 50-minute horizon; he chose it knowingly and it is not a reason to complicate the design.

**Where: a shared drive he already created.** *«створив для тебе шеред драйв
https://drive.google.com/drive/u/6/folders/0AHlmi32nQJZnUk9PVA»* (2407) — **supersedes**
*«просто в My Drive папочку створюй»* (2171). He raised the account choice himself at 2405
(*«гангста чи бпа?»*) and settled it by creating the drive; **there is no open question
about which account.**

**Credential: a service account that exists.** *«я ж тебе налаштовував, давав тобі ключик
оцей json сервісного аккаунта»* (2190). Present on this host at
`/root/.config/bpa/oauth/gcp-sa-bpapro-agents.json` (2 357 B, dated 2026-07-31),
`client_email` `bpa-dev-orch@bpapro-agents.iam.gserviceaccount.com`, project `bpapro-agents`.
The private key was not read and must never enter git. The session's own Drive tools are an
interactive OAuth connection and are **not** the machine's access — they are absent in
headless and cron runs. Earlier context: he set the service account up on 2026-07-31 (264,
285) and asked for full read+write scope (456); the connected identity reported at the time
was `head@gangstabarber.com` (475).

**Restore flow.** Unpacking, not a subsystem — *«відновлення не дуже і треба бо ти стартуєш
вже з памяттю»* (2268). At startup the installation asks whether backup files exist; by
default it states that it backs up to Drive, offers to walk him through granting access,
then locates the files itself, because the naming and folder convention is a written rule:
*«він знатиме й найменування, і в якій папці шукати, бо по факту ж це прописані правила»*
(2171). He allows a fuller restore path later, to support other restore targets, but it is
not what makes the first version work.

**Two startup states** (2171). Fresh/zero: interrogate the operator, propose a strategy
fitted to the hardware, **approval mandatory, editing optional**, then come up from
nothing — the same requirement as HR-2120. Restored: initialise from prior data.

**Sequencing.** *«бекап і відновлення - це можемо реалізувати після переходу на новий
сервер»* (2268) — not a cutover prerequisite in its simple form.

**Two standing constraints.** Backing up is publishing, so the V3-2.9 enumeration must say
per item whether it is safe to send off-host. And **the service-account key must not be
backed up to the Drive it authenticates to** — a restore that needs the key to fetch the
key is not a restore.

**Status:** all of the above is ruled and unambiguous. It has **no workboard row**. Filing
that row is F2's remedy and is out of scope for this audit.
