# Human Requirements Matrix — 2026-07-28

Durable checklist extracted from VovaBPApro's Telegram direction. Quoted blocks
are verbatim and must not be silently reinterpreted or dropped. Each row needs
an owner, commit, automated evidence, and Docker/runtime result.

## Verbatim mission statements

> Інфраструктуру яка працюватиме як годинник і замінить команду з 10 людей!

> Коміть все в нову репо, переглядай як що працювало чи не працювало у старій репо, тестуй через докер

> Там має бути якийсь док де зібрано всі проблеми з інфраструктурою. Ти можеш його використати для консиліума?

> я думав в нас буде /home/bpa-dev-infrastructure а в ній вже робоча папка в яку стягуються всі репо над якими буде працювати інстанс оркестратора

> блять, пушся кожен раз після комміту! Завжди!!!!

> підробляти green - це треба якось ультранадійно зашити для всього що ми робимо!

> Так блять! Збирай ретельний контекст та піднімай консиліум що буде обговорювати к нам в новій інфраструктурі не допускати таких помилок! І нехай це одразу туди в новий репо закладуть

> не погано. Але я наговорив вже і багато дрібних деталей на які ти теж маєш звернути увагу! і не забув про все це під час реалізації

## Checkable acceptance matrix

| ID | Requirement | Evidence required |
|---|---|---|
| HR-01 | Existing stable daemon is the compatibility source; no invented second runtime. | Source inventory, parity table, independent review. |
| HR-02 | Repo includes orchestrator/agent instructions, docs, watchdog source, and runnable entrypoint. | Tracked-file manifest and clean-checkout bootstrap test. |
| HR-03 | Canonical root is `/home/bpa-dev-infrastructure`; mission workspaces are isolated below it. | Bootstrap path/isolation test; no legacy path dependency. |
| HR-04 | Orchestrator, workers, Telegram admin, watchdog, cleanup, restart and recovery form one deployable system. | Docker lifecycle and restart/replay evidence. |
| HR-05 | Multiple independent Docker stands run concurrently, each with unique project/network/ports/workspace, plus one integration stand. | Parallel matrix run and collision checks. |
| HR-06 | Stable lifecycle, leases/TTL/fencing, worktree hygiene, disk hysteresis, MANUAL semantics and watchdog behavior are preserved. | Old/new contract matrix and regression suite. |
| HR-07 | Green is fail-closed: absent, forged, stale or contradictory evidence is NO-GO. | Harness tests for forged green, stale lease, failed rollback and incomplete tests. |
| HR-08 | Independent review evaluates test quality and rejects false greens. | Review report tied to exact SHA and commands. |
| HR-09 | Every commit is pushed immediately; status names exact SHA and remote. | Push log/remote SHA for every commit. |
| HR-10 | Health/auth, resource limits/soak, ports/volumes and rollback are safe encoded defaults, not questions for Human. | Versioned contracts and live Docker evidence. |
| HR-11 | Stale worktrees/temp artifacts are reclaimed without deleting active work. | Dry-run/apply cleanup tests and disk report. |
| HR-12 | All Human details remain verbatim-linked to implementation tasks. | This matrix linked from operating docs; status/owner/commit per row. |
| HR-13 | No premature progress claims or topic switching: one mission chain until landed or explicit NO-GO. | Machine-readable completion guard. |
| HR-14 | Morning test stand and concise “what changed / what to test” report are delivered. | Timestamped stand health result and evidence. |

## Operating rule

Complete means repository evidence exists and the commit is pushed. Otherwise
report `NO-GO` with the concrete blocker; explanations never substitute for a
landed artifact.
