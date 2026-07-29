# Stack Decision (agent framework + agents)

Status: **APPROVED** (Vova, 2026-07-29, Telegram decision 11567 «Го, стек
затверджую», followed by 11568 — see `instance/decisions/HR-11567.md`). The
operative stack is `migration-prep/STACK_CONSILIUM_FINAL.md`; its Phase 0
(measured spike with binding go/no-go numbers) is the first implementation
step, scheduled on the new 64 GB VM after migration day. The
problem statement and requirements below are the Human's (binding, verbatim).
The technology proposal was tested by an adversarial consilium the Human
ordered (Telegram 11562/11564); its verdict — which confirms and substantially
sharpens the proposal below — is the authoritative recommendation:
**`migration-prep/STACK_CONSILIUM_FINAL.md`**. This document moves to the
framework repository once it exists (per
`instructions/instruction-layers.md` this is an L2 concern parked in L1 while
L2 has no repo).

## Human requirements — verbatim (Vova, 2026-07-29, Telegram 11557 + 11558)

> Перед тим, як говорити про стек, є ще у мене інше питання. Це про те, як
> будуть працювати оці інструкції для агентів, для штучного інтелекту. Бо
> виходить, раніше у нас, умовно, всі інструкції спочатку жили взагалі. У нас
> був просто репозиторій білла, і в ньому були всі інструкції і по
> інфраструктурі, і по продукту самому. Потім я це якось розділив на три репо,
> і я не знаю, де і як саме воно жило. Я намагався перенести все в каркас
> максимально, але не впевнений. Я не впевнений, як воно відпрацювало. Бо мені
> здається, що багато чого губилось, можливо, якраз через це розділення
> нелогічне або неочевидне. Тобто нам треба вирішити, як це буде працювати
> зараз в новій інфраструктурі. Бо в нас, тіпа, ще одне репо додалось з самою
> інфраструктурою і оркестратором. Так, і мені дуже подобається ідея тримати
> там інструкції, які стосуються безпосередньо оркестрування інфраструктури.
> Тобто те, що я потім на будь-який інший проєкт, будь-якого іншого агента можу
> заюзати, можу просто видавати друзям, щоб вони самі собі робили якісь свої
> проєкти. І через це мені дуже подобається оця ідея, що багато чого, все, що
> generic, все, що пов'язано безпосередньо з оркеструванням, з інфраструктурою,
> бранчуванням, процесом розробки, оці речі, що спільні для всіх, їх тримати
> самі в цій інфраструктурі репозиторію. Але все ще, наприклад, у каркаса, у
> нього будуть свої якісь інструкції, промпти, у кожного агента буде там цілий
> величезний зоопарк своїх інструкцій. Ну, тобто там багато інформації буде,
> так. В один файл її пхати нерезонно, і треба, щоб і оркестратор, якщо що, міг
> підтягнути якусь інформацію, якісь інструкції для прийняття рішень. І щоб,
> звісно, агенти, які працюють над цим продуктом, щоб вони і розуміли, як
> діяти, тобто розуміли те, що прописано в оркестраторі, хоча б частину якусь
> цього, да, в інфраструктурі. І при цьому багато чого розуміли про сам проєкт,
> над яким працюють. От я не знаю, як це все склеїти, щоб воно дійсно було
> гарно структуровано, і щоб це адекватно працювало, щоб нічого не губилось. І
> щоб, коли нам треба оновити інструкції, то оркестратор одразу розумів дуже
> чітко, де саме цю інструкцію треба оновити, в якому репозиторії, і чого саме
> це стосується. От за цю штуку я думаю, і я не знаю, не впевнений, що ми
> дійсно дуже гарно її вирішили. Тобто за це треба подумати. І тепер питання
> про стек. Я можу вдруге запитати, як він там зараз фронт собі робить, щоб це
> легше було для штучного інтелекта, на якому стеку. Але я бачу проблеми з
> нашим поточним стеком. Тобто, по-перше, велика проблема в тому, що в каркас
> айфреймами вбудовуються всі агенти. От. По-друге, мабуть, це не проблема,
> скоріше особливість. Те, що нам, щоб повноцінно тести прогнати, треба
> збілдити все. І каркас, і агента, і встановити, і підняти. Начебто і окей, не
> проблема, але раніше це займало дуже багато часу. І через це я якось і не
> впевнений. В принципі, це моє рішення було зробити так, щоб воно повний
> environment збирало, щоб тести були релевантні. Той же playwright тести. Бо
> якщо якось піднімати агента з якимись шматками чогось, то, тіпа, воно
> неприкольно буде працювати. Мені реально подобається, що є оцей каркас
> окремий. Далі ще питання, да, в каркас вбудовувати айфреймами. Пам'ятаю, ми
> дійшли до того, що це погана думка. Треба якось по-іншому робити, але так і
> не вирішили, як саме. Додатково що? Ну нам треба вирішити, на яких
> технологіях ми це пишемо, щоб в першу чергу тобі було легко з цим працювати.
> Щоб ти дуже добре розумів, як воно працює. Щоб не продюсились баги, щоб ти це
> легко міг тестувати і через playwright, і взагалі міг глянути на сторінку,
> швидко зрозуміти, що да як. Ще інша дуже велика проблема в нас була, це коли
> ми починаємо редагувати щось на клієнтській частині, то в одному місці
> відремонтували, в іншому зламали. Якісь такі речі відбувались. От, тому зі
> стеком треба якось определитись. І плюс до всього ще, ну, у нас є impeccable.
> От я дуже хотів би його юзати. Можливо, потім пізніше ми якось інше заюзаємо
> для дизайна. Але, ну, поки є він.

> І я так розумію, він заточений під те, щоб ми спочатку робили дизайни
> зовнішнього вигляду, а вже потім реалізовували функциональну частину. Ось цей
> підхід я би зберіг, і це, мабуть, треба додати теж у інструкції
> інфраструктури і оркестратора. Тобто, щоб коли ми зачіпаємо фронтенд частину,
> то для неї треба, як би, погодити дизайн юзер-інтерфейса перед тим, як
> переходити до реалізації. І взагалі, після погодження юзер-інтерфейса сам
> план фічі треба ще передивитись, бо багато чого могло помінятись і
> доз'ясуватись, уже коли ми говоримо про реальну картинку, реального дизайну
> дивимось на щось реальне. Там думок ще дуже багато всяких. Це поки що те, що
> в голову прийшло. Можеш над цим попрацювати спочатку. Постарайся мене
> мінімально смикати, максимально зрозуміти мене і самостійно довести до того
> результату, який мені треба. І дуже ретельно думай про те, що ти мені кажеш,
> яку інформацію даєш і які питання ставиш. Це все має бути націлено в першу
> чергу на досягнення взаємного бачення і розуміння того, що ми робимо і як ми
> робимо. Але без якихось складних жаргонів і термінології, і складних
> формулювань. Бо я і сам розробник з великим досвідом, але мені тебе дуже
> важко складно розуміти.

Related earlier decisions (same day): framework and each agent get their own
new repositories (`instructions/repo-layout.md`); trunk-based branching
(`instructions/branching-policy.md`); 64 GB RAM target VM
(`instance/migration-day.md`); no legacy DB carry-over (Telegram 11543).

## Derived requirements (binding)

1. No iframes. Agents must compose into the framework shell some other way.
2. Full-environment tests (framework + agent built, installed, and running;
   Playwright against the real thing) stay — but the build/боот cycle must be
   fast enough to be routine.
3. The stack must be maximally AI-legible: the working agent should understand
   the whole page at a glance, produce few bugs, and test easily via
   Playwright.
4. "Fixed here, broke there" on the client side must be structurally prevented,
   not just tested away.
5. `impeccable` is the design-quality tool for now and must fit the stack.
6. Design-first UI workflow is law: `instructions/design-first-ui.md`.
7. A separate framework (каркас) stays — the Human explicitly likes it.

## Proposal (orchestrator draft — superseded in detail by the consilium)

The consilium confirmed every line of this draft and resolved the open
questions (composition mechanism, contract strategy, test-cycle budgets,
migration phasing). Read `STACK_CONSILIUM_FINAL.md` for the operative version;
this section is kept as the historical draft the consilium started from.

- **TypeScript everywhere.** One language across framework, agents, and infra
  (infra is already Bun/TypeScript by hard rule).
- **Frontend: React + Vite single-page app. No Next.js.** The operator product
  needs no SSR/SEO; a large share of legacy pain was Next-specific (standalone
  builds, server-action pinning, slow builds, `.next` state). Vite gives
  seconds-long builds — which is what makes requirement 2 (full-environment
  tests) routine instead of painful.
- **Agent UI ships as a package, not an iframe.** Each agent repo exports its
  UI as an npm package; the framework shell imports and mounts it under its own
  router. One app, one auth context, one design context; Playwright sees one
  plain page.
- **Backend: Bun + a light HTTP framework (e.g. Hono), zod-typed API contracts
  shared between client and server.** Breaking a contract fails compilation,
  not production — this is the structural answer to requirement 4.
- **One shared UI-primitive package in the framework** (single source of look),
  with `impeccable` configuration and Playwright screenshot-based visual
  regression on key pages as the second half of the requirement-4 answer.
- **Stands build prewarmed images** on the 64 GB VM for full-environment
  Playwright runs.

## Next step

The Human reviews `STACK_CONSILIUM_FINAL.md` (Ukrainian summary in its last
section); on his go, Phase 0 of that document starts (the measured spike with
binding go/no-go numbers), and the document moves to the framework repository
at its creation.
