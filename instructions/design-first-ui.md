---
id: design-first-ui
layer: L1
status: binding
audience: all
tags: [ui, design, workflow]
summary: Approve the UI design before implementation, then re-read the feature plan.
---

# Design-First UI Workflow

Decided with the Human on 2026-07-29 (Telegram 11558). Verbatim source (Vova):

> «…він заточений під те, щоб ми спочатку робили дизайни зовнішнього вигляду, а
> вже потім реалізовували функциональну частину. Ось цей підхід я би зберіг, і
> це, мабуть, треба додати теж у інструкції інфраструктури і оркестратора.
> Тобто, щоб коли ми зачіпаємо фронтенд частину, то для неї треба, як би,
> погодити дизайн юзер-інтерфейса перед тим, як переходити до реалізації. І
> взагалі, після погодження юзер-інтерфейса сам план фічі треба ще передивитись,
> бо багато чого могло помінятись і доз'ясуватись, уже коли ми говоримо про
> реальну картинку, реального дизайну дивимось на щось реальне.»

## Binding rules

- Any feature that touches a visible frontend surface goes through two ordered
  gates before implementation:
  1. **Design approval.** Produce the user-interface design first (mockup,
     rendered prototype, or styled static screen — something the Human can look
     at as a real picture) and get the Human's approval of the look before any
     functional implementation starts.
  2. **Plan re-read.** After the design is approved, re-read the feature plan
     against the approved picture and update it. Seeing the real design
     routinely changes and clarifies requirements; an unrevised plan is stale
     by definition.
- Implementation may start only from the approved design plus the re-read plan.
  A frontend diff whose feature skipped either gate is incomplete.
- Backend-only work is exempt. Small visual defect fixes follow
  `verification-and-locks.md` (visual lock) and `ui-quality.md`; they do not
  need a new design round unless they change the intended look.
- The design tooling is repository-configured (see `ui-quality.md`); the
  ordering requirement here is tool-independent.

## Why

Approving a real picture first surfaces the requirement changes while they are
still cheap, and keeps the plan — not the accidental first implementation — as
the source of truth for what gets built.
