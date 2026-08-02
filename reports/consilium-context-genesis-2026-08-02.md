# Genesis addendum — ранні інструкції поточного оркестратора

Період: Telegram `msg_id` 5–302, 2026-07-30T11:53:22Z—2026-07-31T10:20:50Z (остання наявна рання інструкція перед орієнтиром `~305`). Джерело цитат: `data-hist/inbox.jsonl` (`sha256:7d81d50666a19bf7914365b470e74f2cd79e4ae13273897a632a1103554f9b0e`). Routing звірено з tracked `instance/decisions/triage.jsonl`, HR-рішеннями та `instance/workboard.md` на L1 SHA `c743b74fe521a0501afeff84dee9d9758f2b3c02`. Цитати нижче відтворені byte-exact із поля `text`; секретні вкладення й credential material не включено.

## 1. ІНФРА-ПРІОРИТЕТИ — тестовані вимоги

### G-INF-1 — оркестратор делегує роботу й лишається доступним

**Verbatim (`msg_id: 86`):**

> так а чого ти робиш реальну роботу? ти ж наче маєш бути в курсі, що ти оркестратор і всю реальну роботу віддаєш на агентів. твоя задача лише їх оркеструвати і бути завжди доступним для спілкування зі мною

**Тест:** під час довгої coder-місії оркестратор не редагує runtime/product files; lane отримує місію, а контрольне Telegram-повідомлення отримує bounded acknowledgement без очікування завершення lane.

**Routing:** `instructions/roles.md` (Orchestrator), `instructions/autonomy-and-capacity.md`; частково HR-86 через tracked triage. Окремого HR-86 artifact немає — **UNROUTED provenance**.

### G-INF-2 — живі end-to-end тести важливіші за narrative review

**Verbatim (`msg_id: 86`):**

> Якщо щось не працює, то роби, щоб працювало. І цей, менше review всяких, більше тестування. Живі тести себе краще показують, як ми бачимо з практики

**Тест:** для Telegram/MCP/launcher/runtime зміни disposable stand реально запускає boundary, виконує user-visible round trip, фіксує health/teardown; unit-only або review-only evidence не проходить gate.

**Routing:** сенс покрито `verification-and-locks` і stands/runtime rules, але `msg_id: 86` не має durable verbatim HR artifact — **UNROUTED provenance**.

### G-INF-3 — Codex має повноцінно підтримувати оркестратор і lanes

**Verbatim (`msg_id: 71`):**

> тобто, ну, я всю цю інфраструктуру хочу, щоб ще на кодексі працювала адекватно саме ти як оркестратор.
>
> ііі мені треба бути певним, що на кодексі на моделі soul воно теж буде адекватно працювати.
>
> перейшоби зробити release оч якийсь ретельний.

**Тест:** clean-start matrix запускає top orchestrator і coder/reviewer lanes через Codex, виконує dispatch→commit/evidence→review→landing/report без provider-specific ручних кроків.

**Routing:** пізніше уточнено HR-210, HR-269/HR-271 та `instructions/vendor-routing.md`; сама genesis-вимога `msg_id: 71` не має HR artifact — **UNROUTED provenance**.

### G-INF-4 — економити Claude, максимально використовувати Codex, фіксувати в git, не в пам’яті

**Verbatim (`msg_id: 210`):**

> і можеш якийсь більш надійний механізм мінімізаціі навантаження на клод і максимізаціі на кодекс? бо виглядає що тут є проблеми адже ти піднімаєш Claude-лейни коли я вже сказав максімально економити квоту клода! фіксуй такі речі не в памтть, а надійніше!

**Тест:** provider-routing test за дефолтом обирає Codex для lanes, Claude лише для явно дозволеної escalation/connector задачі; restart/clean clone зберігає правило без agent memory.

**Routing:** HR-210; актуальне уточнення HR-271; `instructions/vendor-routing.md`; `instance/params.yaml`.

### G-INF-5 — команда до десяти людей і реальний паралелізм заради швидкості

**Verbatim (`msg_id: 275`):**

> Я тобі з першого дня кажу, що наша мета — зробити команду з десяти людей, які в паралель працюють. І ти зараз кажеш, що ти робиш тут в один потік, тобто те, що я міг би, блядь, з ноутбука запускати і всьо.
>
> А я плачу за дуже серйозний сервер для того, щоб у нас була швидкість, швидкість, швидкість, швидкість. Ти це розумієш?
>
> Як ти це можеш гарантувати і зафіксувати нарешті? Що тобі заважає?

**Тест:** за наявності ≥10 незалежних ready rows fleet досягає 10 active leases, кожна lane має окремі worktree/resources; throughput і queue latency вимірюються, а single-thread execution при достатній черзі fail-closed.

**Routing:** HR-117 → HR-281; `instructions/autonomy-and-capacity.md`; generic mission in root contract. Triage прямо фіксує `msg_id: 275` як captured.

### G-INF-6 — нижче трьох lanes: повідомити лише якщо бракує роботи; інакше це infra failure

**Verbatim (`msg_id: 281`):**

> Коли стає менше трьох паралельних лейнів, уже маєш мені писати і казати, що роботи малувато; треба накидать 

**Verbatim (`msg_id: 299`):**

> а на дошці є відкриті рядки - ну, власне, якщо рядків немає, то це просто одразу має йти до мене питання, щоб я тобі розказав, що робити далі.
>
> А-а-а, якщо тіпа є що робити і лейнів всього три, то це означає, що тобі треба включатися і виправляти якісь проблеми.
>
> Значить, у тебе щось неправильно працює, і я навряд там зможу сильно допомогти.

**Тест:** зовнішній fleet watcher інжектить обидва стани: (a) ready=0, active<3 → рівно одне bounded out-of-work повідомлення; (b) ready>0, active≤3 → internal red health + recovery/dispatch, без хибного прохання до Human.

**Routing:** HR-281; `instructions/autonomy-and-capacity.md`; fleet-nudge; частина “ready>0 means infra failure” не має окремого verbatim HR artifact — **UNROUTED provenance**.

### G-INF-7 — сторож не залежить від AI-сесії

**Verbatim (`msg_id: 299`):**

> тимчасовий сторож на сервері — раз на 10 хвилин рахує лейни - це якийсь крон? має юути щось не залежне від щі!

**Тест:** kill/hang top-orchestrator process; незалежний versioned service/timer продовжує рахувати leases, виявляє under-capacity та створює durable alarm/recovery evidence.

**Routing:** HR-281 disposition і systemd fleet-nudge реалізація; немає окремого HR-299 verbatim artifact — **UNROUTED provenance**.

### G-INF-8 — міграційна parity перевіряється проти старих реалізацій, не згадок

**Verbatim (`msg_id: 101`):**

> І питання тоді дуже велике: а що ще у нас не пережило міграцію? Які ще фічі? Бо це я ще постійно спотикатись буду в різних місцях об якісь дрібнички, які наче у нас були, але ми їх не змігрували, не перенесли, загубили по путьі. Як це відбувається?

**Verbatim (`msg_id: 108`):**

> тож ти там покопайся, поки ще час маєш, пошукай, що ще міг зробити неправильно, не домігрувати.

**Тест:** machine-readable capability inventory порівнює всі старі repo/live-daemon entry points із новими як `ported | deliberately-dropped(reason) | open(row)`; неврахований capability робить parity gate red.

**Routing:** HR-101, HR-108, HR-117; workboard ML-1..16 та **ML-GOV** (open).

### G-INF-9 — інструкції розділені за шарами, але compose доставляє потрібний infra+product context

**Verbatim (`msg_id: 98`):**

> ми зараз дуже сильно розділяємо це. у нас є один репозиторій, в якому безпосередньо описується інфраструктура, оркестратор, тобто це власне твій репозиторій, в якому ти зараз працюєш.
>
> далі будуть ще репозиторії окремих проєктів, де вже не буде інформації про те, як оркестратор має працювати, бо я не хочу це дублювати. там будуть вже інструкції безпосередньо відносно продуктів, проєктів, репозиторіїв конкретних, з якими ти будеш працювати.
>
> тому тут виникає складність, що треба якось по-розумному менеджити контекст. тобто тим же агентам, яких піднімаємо, треба дати частину контексту від інфраструктури, щоб він розумів, хто він, що від нього очікується і в якій екосистемі він працює.
>
> в той же час йому треба підвантажити контекст уже безпосередньо по продукту.

**Тест:** compose fixture для кожної ролі містить pinned baseline L1 + потрібний L2/L3 product pack, не дублює binding instruction ids, відмовляє на unknown tags і відтворюється з clean clone.

**Routing:** HR-98 → `instructions/instruction-layers.md`; composition-interface residual retained in HR-98.

### G-INF-10 — інструкція без reachability path вважається втраченою

**Verbatim (`msg_id: 283`):**

> І так, я просив передивитись всі інструкції, бо всі файли мають посилатись один на одного. Бо якщо на файл немає ніяких посилань, то його ніхто ніколи взагалі не прочитає.
>
> Власне, це тоді означає, що або ця інструкція не потрібна, або ми просто щось проїбали по дорозі.

**Тест:** graph checker стартує з root/index/compose entry points; кожен binding instruction має reachable edge та рівно один canonical home; orphan або duplicate id валить check.

**Routing:** частково `instructions/instruction-layers.md` та generated README/index mechanics; `msg_id: 283` не має HR artifact — **UNROUTED**.

### G-INF-11 — Human chat короткий; статус має бути корисним людині

**Verbatim (`msg_id: 108`):**

> і ще питання по твоїх інструкціях. якось ти забагато текста мені пишеш. я не можу так багато читати.

**Verbatim (`msg_id: 125`):**

> І ти знов почав писати багато текста! Можеш це виправити на рівні внструкцій?

**Тест:** operator-facing reply fixture застосовує bounded concise format; `/status` на realistic fleet state показує human-readable active count/work/blocker/action, не raw JSON.

**Routing:** HR-108; `instructions/operator-feedback.md`; HR-150/W-14 для `/status`. `msg_id: 125` є лише у triage, без verbatim HR artifact — **UNROUTED provenance**.

### G-INF-12 — лайка означає diagnostic question, не запрошення виправдовуватись

**Verbatim (`msg_id: 302`):**

> Тому було б добре, якби ти зміг зафіксувати десь на рівні інструкцій, що якщо я починаю лаятись, то це я більше ставлю тобі запитання: що тобі заважає зробити те, щоб, ну, так, щоб все було так, як я очікую?
>
> Е-е-е, можеш це якось так запрограмувати собі, сприймати таким чином, щоб ти, ну, не виправдовувався, нічого?

**Тест:** operator-feedback scenario з angry input породжує evidence-first diagnosis (`expected / observed / blocker / action`), без defensive/apology-only response; directive зберігається verbatim.

**Routing:** HR-302 → `instructions/operator-feedback.md`.

## 2. ПРОДУКТОВІ РІШЕННЯ раннього періоду

### G-PROD-1 — команда/personas: постійні ролі, місійні підкоманди, рольова різноманітність

**Verbatim (`msg_id: 146`):**

> Перше, у нас мета була з новою інфраструктурою зробити так, щоб вона працювала як команда з десяти людей. І у мене є скажена ідея, щоб одного цих десять людей на оцю команду тобі розписати ролі додатково ще, як персонажам їм прописати, якісь людські якості надати, там, для менеджера, для розробників різних, типу, щоб це було як реальні люди, у яких є там у кожного якісь свої окремі сильні сторони, може, свої особливості.

**Verbatim (`msg_id: 203`):**

> 1. а ти як думаєш? моя чйка - натягнути на поточні ролі та розширити
> 2. 2. ну я уявляв це як набір постійних ролей, а далі під міссію може формуватись підкоманда з різних ролей. Ну і для консиліумів теж
> 3. так
> 4. в тебе є сервер, квота, купа лейнів для паралелізму і вся ніч попереду! Тобто годин 9
> 5. так, авто адаптивність можна додавати в беклог з низьким пріорітетом

**Current routing:** HR-146, HR-161 (brainstorm caveat), HR-185 (certain subset authorized), HR-203; workboard NI-1 remains open. HR-210 adds human qualities to QA/Security lenses. HR-212 makes role-diverse GPT consilium primary.

### G-PROD-2 — team має компенсувати оператора, а не дзеркалити його

**Verbatim (`msg_id: 190`):**

> The AI organization should compensate rather than mirror the operator.
>
> Recommended counterbalances:
>
> * strong Delivery Manager
> * pragmatic Product voice
> * skeptical Devil's Advocate
> * execution-oriented PM
> * conservative QA
>
> The goal is not agreement.
>
> The goal is higher-quality decisions.

**Current routing:** HR-189; delivered guide HR-254 → `instance/operator/How-to-Work-With-Vova.md`; persona/consilium composition feeds NI-1.

### G-PROD-3 — Google Drive debug access має бути provider-independent

**Verbatim (`msg_id: 146`):**

> Про цю частину, дивись, про доступ до Google Drive. Так, ну, мабуть, варто тобі створити, для тебе зробити service account, щоб, власне, сам оркестратор та й будь-який агент за потреби, будь-який член команди, мав доступ до Google диска, щоб вони змогли туди сходити, прочитати, перевірити щось для дебага, я думаю, буде дуже корисно.

**Verbatim (`msg_id: 279`):**

> Ми тобі для цього зараз і робимо service account, щоб ти міг нормально ходити туди, незалежно від того, на якому штучному інтелекті, на якому провайдері ти працюєш.

**Current routing:** HR-146 / NI-2; setup flow triaged as answered. Credential content deliberately excluded. Provider-independence wording in `msg_id: 279` has no separate HR artifact — **UNROUTED provenance**.

### G-PROD-4 — Shared Drive: optional service account viewer with graceful failure

**Verbatim (`msg_id: 292`):**

> Коли ми продукт підключаємо до Google Drive, там даєш сервіс-акаунту права viewer, наприклад.
>
> Якщо в тебе є сервіс-акаунт і він налаштований, то даєш. Якщо ні, то просто пропускаєш цей крок.

**Verbatim (`msg_id: 297`):**

> Але якщо є такий сценарій, коли shared drive створили, але є service account, і цей service account ніхто не може додати. Не виходить додати, падає помилка.
>
> То можна ж повідомлення показати юзеру, що створили все актуально, отлично, але service account не змогли додати.
>
> Ось можете додати йому права viewer на новий shared drive самі і дати їм цю пошту.

**Current routing:** HR-292 covers product-vs-infra ownership and Google integration context; triage says msg 297 was followed during setup, but the product behavior (optional key, viewer grant, partial-success notice with manual recovery) has no explicit PR/W acceptance row — **UNROUTED**.

### G-PROD-5 — одна local Whisper STT модель для Telegram і продукту, з вимірюванням RAM/мов

**Verbatim (`msg_id: 146`):**

> Install local Wispr model and process the voice messages from TG! Requires testing and gotta see how much RAM it requires.

**Verbatim (`msg_id: 146`):**

> Виходячи з цього, я би спочатку розгорнув Whisper модель. У нас ресурсу, мені здається, вистачає. І на цій моделі, ну, щоб вона була на сервері, щоб можна було переганять слова в текст. Причому на різних мовах. Ну, принаймні, для початку українською я буду з нею спілкуватись, англійська точно треба буде теж, польська якась може додатись.

**Current routing:** HR-146 / NI-3; workboard records orchestrator consumer done and product consumer open. Acceptance має вимірювати transcription accuracy/round-trip, peak RAM та concurrency, а не лише install success.

## 3. UNROUTED / routing gaps

1. `msg_id: 86` — verbatim requirement “оркестратор не робить реальну роботу” and live-test priority exist only via broad current rules/triage, not a dedicated provenance artifact.
2. `msg_id: 71` — original Codex end-to-end readiness/release demand has no HR artifact; later vendor routing captures only its evolved policy.
3. `msg_id: 125` — “short replies at instruction level” is triaged/codified generally, but the verbatim source is absent from HR decisions.
4. `msg_id: 279` — provider-independent Google access has no durable verbatim route.
5. `msg_id: 283` — every instruction must be reachable/referenced has no HR artifact or explicit workboard acceptance row.
6. `msg_id: 292/297/299` — product Shared Drive behavior lacks a PR/W row covering all four states: no SA, grant succeeds, grant fails after drive creation, organizer prerequisite/manual recovery.
7. `msg_id: 299` — ready work + ≤3 lanes must be treated as infrastructure failure, distinct from empty-queue Human escalation; HR-281 captures the threshold but not this complete state machine verbatim.
8. `msg_id: 144` / same external share as `msg_id: 59` — tracked triage says the owed preferred ingestion/answer remains open; any unique early-product content in that external chat remains unverified here.

## Consilium use

Treat routed requirements as constraints, not proof of completion. For each proposal, demand an executable test against G-INF-1..12 and disposition G-PROD-1..5 explicitly. An absent route is `UNROUTED`, an unmeasured behavior is failed, and “triaged as answered” is not implementation evidence.
