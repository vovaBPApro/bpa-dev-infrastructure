---
id: telegram-history-audit-2026-08-01
layer: L1
status: informational
audience: orchestrator, human
tags: [audit, telegram, workboard]
summary: Independent audit of Vova's Telegram requirements (2026-06-30 to 2026-08-01) against primary evidence (git log, live code, live host state) — not against instance/workboard.md claims.
---

# Telegram history audit — 2026-08-01

## Scope and method

Primary sources read:
- `instance/decisions/inbox.jsonl` — read in full, all 253 lines (msg_id 5–722,
  2026-07-30T11:53 through 2026-08-01T06:13).
- `/root/orch-mailbox/vova-telegram-archive/vova-telegram-by-message-id.txt` —
  876 messages, 2026-06-30T05:34 through 2026-07-31T16:32. Read in full via
  four parallel extraction passes (lines 1–820, 800–1710, 1690–2780,
  2760–3849, i.e. msg_id 5372 through 11886, the end of the archive), each
  independently listing every distinct instruction, requirement, complaint,
  and standing rule with msg_id/timestamp. All four passes completed.

**Every extracted item was checked against primary evidence**, not
`instance/workboard.md` status markers: `git log`/`git show` in this repo,
direct inspection of current file contents and code (`grep`, `find`,
`git ls-tree HEAD`), live host state (`systemctl cat`, directory listings
under `/root/.claude/channels/telegram/`), branch counts (`git branch -a`),
and read-only inspection of `/srv/projects/agentic-bpa` (product repo — not
modified). Where workboard.md or `instance/decisions/triage.jsonl` claimed a
requirement was done/answered, that claim was independently re-derived from
code/git, not trusted at face value.

**What this pass did NOT get to**: the by-message-id archive stops at
2026-07-31T16:32; the tail of the two-sided archive (`vova-telegram-FULL-two-sided.txt`,
~23k lines, which also carries the orchestrator's own replies) was not read
line-by-line — it was used only for targeted greps during verification, not
as a primary extraction source. A systematic re-check of every one of the
several hundred extracted items against code is not complete; the items
below are the ones independently verified as gaps, not an exhaustive
line-by-line reconciliation. Given the volume (roughly 300+ distinct
requirement-shaped statements extracted, many repeated dozens of times), this
report groups recurring themes rather than listing every occurrence — each
theme lists representative msg_ids, not all of them.

---

## 1. NO evidence of being addressed

### 1.1 Fleet/lane capacity is not actually maintained or enforced anywhere in code
**This is the single largest, longest-running, best-evidenced gap.**

Representative quotes (dozens more like these exist from 2026-07-10 through
2026-08-01, nearly every day):
- msg_id=281 (2026-07-31 08:44): *"Коли стає менше трьох паралельних лейнів,
  уже маєш мені писати і казати, що роботи малувато; треба накидать"*
- msg_id=470/474/477 (2026-07-31 16:02–16:25): repeated — lane count dropped,
  no notification fired, "У тебе задача — десять лейнів стабільно тримати."
- msg_id=9503 (old archive, 2026-07-18): *"Давай якось надійно виправимо на
  рівні інструкцій щоб ти завжди старався тримати флот мінімум 6, максімум 15
  кодерів"*
- msg_id=7844/7853/7859/7905/7919/7926/7938/7963/7977/7985/7993/8025/8031/8942/9274/9434/9492/9495/9520/9578/9587/9669/9681
  (2026-07-10 through 2026-07-19, dozens of occurrences): "0 кодерів", "1
  кодер", "де 9 кодерів в паралель?", "8 менеджерів на 1 кодера" — the fleet
  repeatedly collapses to 0–2 active coders against a stated target of 6–15 (at
  times 9, at times 10).
- msg_id=11499 (2026-07-28, three days before the current inbox period):
  Vova himself writes out the exact recurring-problem list —
  *"без постійного нагляду флот здувається і нічого не робиться; репо
  засмічуються незрозумілими бранчами; з'їдається місце на диску; все
  сповільнюється через тестування, що впирається в один білд/стенд"* — and
  asks the orchestrator to search Telegram logs for this same pattern and
  prior fix proposals. The identical set of symptoms (fleet deflates, branch
  litter, disk fill, single-build bottleneck) recurs again in the 2026-07-30
  to 2026-08-01 window covered by `inbox.jsonl` (msg_id=470/474/477/705).
  This is not a one-off complaint; it is a five-week-old, self-diagnosed,
  repeatedly-recurring failure pattern.
- msg_id=11695 (2026-07-29): explicit request to stress-test holding 10
  parallel agents overnight — "10, 20, 100, 500 раундів по колу" — no
  evidence this stress test exists (`grep -rl "10.*round\|stress.*fleet\|fleet.*stress"`
  across `orchestrator/`/`daemon/` finds nothing), consistent with §1.1's
  finding that no code enforces or even measures sustained fleet capacity.

**Verification**: `instructions/autonomy-and-capacity.md` DOES codify this as
a binding rule ("Fewer than three running lanes is a REPORTABLE condition" —
citing HR-281 verbatim). But `grep -rn "MIN_LANE\|min_lanes\|TARGET_LANE\|capacity.*gauge\|fewer.*than.*3"` across `orchestrator/` and `daemon/`
returns **zero hits**. No code computes a running-lane count against a
floor/ceiling and no code fires an alert on breach. This matches the
workboard's own honest rows: `ML-7` (alarm audience routing, open), `ML-15`
(fleet/manager/lane visibility in `/status`, open — "candidate commits...
exist only on unlanded lane refs"), `W-14` (make `/status` human-useful,
open). The rule has been written down and repeated for over five weeks; the
code that would make it true does not exist.

### 1.2 Branch proliferation — a Hard Floor rule, currently violated on the live host
Hard Floor 12 states: "Branch and worktree hygiene is mandatory... Do not let
branches or worktrees breed." Complaints span 2026-07-16 through 2026-08-01:
- msg_id=8738 (2026-07-16): *"це вже далеко не перший раз проблема з тим, що
  бранчі плодяться... більше сотні бранчів у нас збираються... щоб точно не
  плодились у нас бранчі"*
- msg_id=8805 (2026-07-16): asks why branch-proliferation protections
  apparently don't exist/work, asks for root cause.
- msg_id=705 (2026-08-01, inbox.jsonl, TODAY): *"ми плодимо купу бранчів,
  хоча цього не мало бути! Це те що мало бути ідеально протестовано у новій
  інфрі"*

**Verification**: `git branch | wc -l` on this host right now = **124 local
branches**, of which **93 are not merged into `main`**. A reap tool exists
(`hygiene/reap.sh`, with `hygiene/reap.test.sh` and `gate/reap-safety.test.sh`
— real, tested code, several landed commits: `1ee982c`/`82023ff`/`7fd040c`
etc.), but there is **no systemd timer or crontab entry that runs it**
(`systemctl list-timers` shows no reap timer; `crontab -l` is empty). The
capability exists and is manually invocable; it is not wired to run
automatically, so branches keep accumulating exactly as complained about,
including as of today.

### 1.3 "Minimize Claude/Fable quota, maximize Codex/GPT for child agents" has no enforcing code
Stated as a standing rule at least 15+ times across the whole period,
e.g. msg_id=5873 (2026-07-02), 6394/6400 (2026-07-04), 7001/7009 (2026-07-07),
8853 (2026-07-16, most detailed statement of the intended hierarchy), and
again today: msg_id=210, 271, 709 (inbox.jsonl).
- msg_id=271 (2026-07-31): *"усі лейни — на Codex - я про це прощу тебе з
  пешого дня"*
- msg_id=709 (2026-08-01): *"твоя задача — зробити так, щоб на fable було
  мінімальне навантаження... всі дочірні агенти піднімаються на кодексах"*

**Verification**: `orchestrator/dispatch-lane.sh` — the actual lane-dispatch
entry point — contains **zero** references to `codex`, `provider`, or
`model` (checked by direct grep) and its own header comment states: *"The
repo has no lane launcher yet... The actual launch is intentionally out of
scope here."* The dedicated attempt to build this (`ag-codex-launcher`
branch) is **rejected in review** (`orchestrator/runtime/reports/rev-ag-codex-launcher-spec.env-invalidated.md`:
`verdict: rejected` — mandated suite exits 2 before any PASS row) and is not
an ancestor of `HEAD` (`git ls-tree -r HEAD | grep -i codex` finds only a
notify-wiring test, no launcher). So there is currently no code path that
pins lane dispatch to a specific provider at all — the routing this rule
requires does not exist yet, despite being repeated for a month.

### 1.4 Google Drive shared-drive service-account auto-provisioning (detailed spec, never even logged as a requirement)
msg_id=292/295/297/299 (2026-07-31, ~09:10–10:13) is a detailed, multi-part
product spec: when a shared drive is created during Google onboarding, the
configured service account should be auto-added with `viewer` rights; if
adding it fails (not organizer), show the user a clear message rather than
silently reporting success; if no service-account key is configured at all,
skip the step; this is product-scope work to be remembered for later, not
implemented immediately.

**Verification**: `grep -n "viewer|organizer|serviceAccount" /srv/projects/agentic-bpa/packages/integrations/src/google-drive/storage-client.ts`
returns nothing. `grep -rn "shared drive|service account|organizer" instance/workboard.md`
returns nothing. `grep '"msg_id":"29[2-9]"' instance/decisions/triage.jsonl`
returns nothing. This requirement was never captured in an HR file, never
triaged, never referenced on the workboard, and is not implemented in the
product repo — a genuine total gap, not merely a low-priority backlog item
that's tracked-but-open.

### 1.5 Very recent, explicit corrections not yet triaged or captured (today, 2026-08-01)
- msg_id=707 (06:04): *"А ти читав июмоі вимоги до цього перемикача? Знайди
  де я кажу що це має бути дропдаут? А? Не вийде блять! Бо я просив щоб воно
  виглядало по іншому!"* — an explicit statement that the current
  agent/transaction-type switcher UI violates a prior spec (must NOT be a
  dropdown). `grep -rin "dropdown" instance/` finds nothing addressing this;
  `grep '"msg_id":"707"' instance/decisions/triage.jsonl` is empty. Not
  captured anywhere yet.
- msg_id=705 — branch breeding, see 1.2, also untriaged (`grep` for `"705"`
  in triage.jsonl: empty).

These are recent enough that some lag is expected, but they are exactly the
kind of thing Vova is currently angry about being lost, so they're listed
here rather than assumed to be "in progress."

### 1.6 Detailed old-product specs are referenced only generically, not actually re-captured
The old (June–July) Telegram history contains dozens of concrete, specific
product requirements that are still relevant to the ongoing `agentic-bpa`
rebuild (HR-330) but exist nowhere as a tracked, content-addressable spec —
only as a broad instruction on the workboard to "go read the archive."
Examples of specific requirements that don't appear searched-for anywhere in
`instance/` (checked via grep for their distinguishing terms — all zero
hits): Google Drive folder structure strictly `YYYY-MM` (msg_id=6300);
Gmail tag scheme `bill_TODO` / `bill_matched` for sync status (msg_id=5653);
"no horizontal scroll in the menu, ever" (msg_id=5655); one shared, reusable
loading-state component used everywhere (msg_id=5650); progress bar rendered
in the active agent's accent color, placed between header and content
(msg_id=5638); "one feature = one place = one point of entry, at most two"
site-wide anti-duplication rule (msg_id=7563). `PR-3`/`PR-5`/`PR-8`/`PR-9` on
the workboard correctly flag that these need to be gathered from the
archive before implementation — but the gathering itself hasn't happened,
so there is a real risk these specifics get silently dropped again exactly
as they were in the first migration (which is itself the subject of
`PR-13`, "43 capabilities NOT PORTED").

---

## 2. PARTIALLY addressed

### 2.1 Bidirectional Telegram history logging — code exists, not actually running
`daemon/history-logger.ts` and its test are landed (workboard `ML-11`
labeled **done**, SHA `31a64ca`/`081bff4`). It writes to
`TELEGRAM_STATE_DIR/history/messages-YYYY-MM.jsonl`. Directly verified on
this host: `TELEGRAM_STATE_DIR=/root/.claude/channels/telegram` (from the
deployed systemd unit), and `ls -la /root/.claude/channels/telegram/` shows
only `.env`, `access.json`, `daemon.pid`, `daemon/`, `inbox/` — **no
`history/` directory exists**. So msg_id=75 ("ти десь логуєш повідомлення з
телеграм?") and msg_id=719 ("чи не двосторонні у тебе логи?") are answered
"yes" by the workboard's `ML-11: done` row but the honest answer today is
"code exists, is not wired into the live message path, produces nothing."
This is self-caught as `W-29` on the current workboard (opened the same
session as this audit was requested) — flagging it here because it's a
direct, verified answer to something Vova asked about explicitly and
repeatedly, and because `ML-11: done` next to it is misleading on its own.

### 2.2 Orchestrator resting-model pin is documented but not honored by the launch path
The resting model has been corrected at least four times (decision at
07-18 → `default_opus`; `HR-269`; `HR-271`; `HR-709` today → back to Fable).
`HR-709`'s own text states: *"the `runtime.env` pin already said fable at the
moment this ruling arrived, but the live session was running Sonnet — a
separate launch-path defect, not resolved by this commit."* No workboard row
currently tracks fixing the launch path itself (only the decision record was
added). msg_id=700 today ("А чого це в нас оркестратор стартує на сонет?")
is the direct trigger and remains open as a code defect, not just a policy
question.

### 2.3 Codex lane launcher — tracked as "answered" but not actually landed (see also §3)
msg_id=214 ("Лаунчер кодекс лейнів… Чого це не було просто скопійовано зі
старого репо?") — see §1.3 for the code evidence: the launcher does not
exist on `main` and its implementation branch was rejected in review.

### 2.4 Whisper voice transcription — orchestrator side proven, product side open
Workboard `NI-3` already states this honestly (orchestrator consumer done
2026-07-31, product/chat voice-button consumer still open, RAM measurement
outstanding). Spot-checked and found consistent with the underlying
`daemon/transcribe.test.ts` evidence cited — no discrepancy found, listed
here only because it's a real msg_id=146/564 requirement that is genuinely
half-done, not to relitigate it.

### 2.5 "Write to instructions, not memory" — repeated instruction, repeatedly still needed
Stated at least at msg_id=8902 (2026-07-16), 281/719/721 (2026-07-31/08-01).
As recently as msg_id=719/721 TODAY he is still saying this ("нормально
запиши... не в пам'ять тільки твою кончену диряву... і це зафіксуй собі в
інструкціях"). The instructions layer does exist and is used for many
decisions (25 HR-*.md files exist under `instance/decisions/` matching
inbox msg_ids), so this is not a total gap — but the fact that the identical
complaint recurs on the very last day in scope suggests the practice is
inconsistent rather than fixed.

---

## 3. False-green found in the tracking itself (not just the workboard)

- **`instance/decisions/triage.jsonl`, msg_id=214**: verdict recorded as
  `"answer_status":"answered"`, reason
  `"answered-launcher-spec-received-and-system-units-rebuilt"`. Independently
  verified: the actual codex-lane-launcher implementation
  (`orchestrator/launch-codex-lane.sh` on branch `ag-codex-launcher`) is
  **rejected** by review (`rev-ag-codex-launcher-spec.env-invalidated.md`,
  `verdict: rejected`) and the file is not present on `main`
  (`git show main:orchestrator/launch-codex-lane.sh` fails). "Answered"
  should not mean "a spec was written and a review was rejected" — this is a
  tracking-level false-green on the exact msg_id he singled out as an
  example of things being ignored (msg_id=214 was quoted again in his
  frustrated messages today).

- **Workboard `ML-11` ("done") vs. `W-29` ("landed but not live")**: both
  rows currently coexist on `instance/workboard.md`, describing the same
  capability. `W-29` is a same-day self-correction (opened today, in this
  session's git history) so this is not a hidden defect — but it is exactly
  the kind of "done" label Vova said he doesn't trust, and it is a real
  example of why: reading `ML-11` alone gives a false picture, and the
  correcting row (`W-29`) exists only because someone happened to go re-check
  it after he asked.

- **`instance/decisions/triage.jsonl` coverage is much smaller than
  `inbox.jsonl`**: only 66 of 253 current-era msg_ids have any triage row at
  all (checked by cross-referencing msg_ids in both files) — including zero
  coverage for msg_id=292–299 (Drive service-account spec, §1.4), 535/537
  (transaction form / chat capability — though these did become HR-535/HR-537
  and workboard PR-8/PR-9, so they are tracked via a different mechanism),
  549 (a "Fleet watchdog cannot read workboard" error, not independently
  re-verified in this pass), 705/707 (§1.5), and 715/716/719/721/722 (the
  messages that are effectively the direct ask behind this audit). Many
  untriaged messages are pure chatter, but this gap means "triaged" cannot be
  read as "everything substantive was looked at" — it is a partial index,
  not a complete one.

---

## What was not independently re-verified in this pass

- Items already stated on `instance/workboard.md` as explicitly **open** with
  "no implementation or landing evidence exists" in the row text itself
  (e.g. most of the `PR-*` product rows, `ML-2`, `ML-6`, `ML-7`, `ML-8`,
  `ML-15`, `ML-16`, `W-08`, `W-10`, `W-14`, `W-17`, `W-19`, `W-20`, `PR-11`,
  `PR-12`, `PR-13`) were taken as already-honest self-reporting and were not
  re-derived from scratch — spot-checking a sample (ML-11/W-29, the fleet
  rows, the codex launcher) found the workboard's *open* rows to be accurate
  where checked; the concern per the task is specifically **done** rows and
  untracked items, which is where this report's effort went.
- The full two-sided archive (`vova-telegram-FULL-two-sided.txt`, ~23k
  lines, includes the old orchestrator's replies) was not read end-to-end;
  only targeted greps were run against it. A full read could surface
  additional context on which promises were made and broken, but was out of
  budget for this pass.
- msg_id=549 ("Fleet watchdog не може прочитати workboard") was noted but not
  independently root-caused.
- All four extraction passes over the by-message-id archive completed
  (msg_id 5372 through 11886, the full archive). The extraction surfaced
  roughly 300+ distinct requirement-shaped statements; the large majority
  are either (a) specific UI/bug complaints about the pre-rebuild product,
  now superseded by the 2026-07-31 decision to rebuild from scratch
  (`HR-330`), or (b) restatements of the same handful of standing themes
  covered in §1 and §2 above. This report does not re-list every
  occurrence — it groups by theme and cites representative msg_ids. A few
  narrower one-off product requirements from the June–July window (e.g. the
  multi-QuickBooks managerial/statutory connection model, msg_id=7032; the
  prompt-injection risk from documents carrying hidden instructions,
  msg_id=7611, which IS covered generically by `instructions/prompt-injection-trust-model.md`
  but not tested against the specific "white-on-white text in a scanned
  invoice" case he described) were not individually re-verified against the
  current product repo and may be worth a follow-up pass if useful.
- Security/network items from the archive (e.g. msg_id=10456-10460, blocking
  external access to ports 631/3100-3102 via iptables + a `bpa-port-guard`
  systemd unit) were not independently re-checked against the current host
  firewall state in this pass.
