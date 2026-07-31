## 1. Questions for the Human

1. Should the CORE guide be delivered to every coder, reviewer, orchestrator, and manager, or only to roles that communicate directly with you?
2. Do you approve keeping the repo-added pointer above the otherwise byte-identical Human-provided body of `How-to-Work-With-Vova.md`, or should the source file remain wholly untouched with the pointer only in `README.md`?
3. Should phone-chat brevity remain the binding default even when the full guide calls for deeper reasoning, with depth stored in durable artifacts and offered on request?
4. Should “material financial exposure” and “legal acceptance” be added to the binding irreversible-decision set, or should agents continue following the narrower current set?

## 2. Duplication (one-home violations)

| Full-guide section | Owning instruction | CORE treatment |
|---|---|---|
| Evidence and executable work (`instance/operator/How-to-Work-With-Vova.md:292`) | Verification evidence (`instructions/verification-and-locks.md:19`) and coder evidence (`instructions/roles.md:27`) | Keeps operator-specific response behavior; points completion to the owners. |
| Ownership and clarifying questions (`instance/operator/How-to-Work-With-Vova.md:524`) | Coder duties (`instructions/roles.md:27`) and dispatched-lane autonomy (`instructions/autonomy-and-capacity.md:32`) | Uses path pointers; does not restate the authority boundary. |
| Completion reporting (`instance/operator/How-to-Work-With-Vova.md:571`) | Decidable report contract (`instructions/verification-and-locks.md:33`) | Uses one pointer only. |
| Escalation boundaries (`instance/operator/How-to-Work-With-Vova.md:1015`) | Irreversible set (`instructions/autonomy-and-capacity.md:12`) | Omits a duplicate list and follows the binding owner. |
| Profile precedence (`instance/operator/How-to-Work-With-Vova.md:1070`) | Layer precedence (`instructions/instruction-layers.md:58`) | Uses a path pointer; does not define another precedence rule. |
| Role versus behavior authority (`instance/operator/How-to-Work-With-Vova.md:670`) | Role authority and boundaries (`instructions/roles.md:62`) | Uses a path pointer; does not redefine authority. |

## 3. Contradictions

- Response order:
  - “Begin with the useful conclusion or the key uncertainty.” (`instance/operator/How-to-Work-With-Vova.md:357`)
  - “> 1. Problem” followed later by “> 4. Recommendation” (`instance/decisions/HR-189.md:299`, `instance/decisions/HR-189.md:302`)
  - Follow answer-first today. This mission explicitly requires it, and the Human rates the How-to as more valuable than the profile (`instance/decisions/HR-189.md:427`).
- Depth in chat:
  - “When uncertain, lead with the conclusion and provide enough detail to validate it.” (`instance/operator/How-to-Work-With-Vova.md:381`)
  - “If something genuinely needs depth, say that it exists and offer it, rather than sending it.” (`instructions/operator-feedback.md:40`)
  - Follow `operator-feedback` for Human chat because it is binding and specific to that channel; keep validation detail in the durable artifact.
- Escalation:
  - “* material financial exposure;” and “* legal acceptance;” (`instance/operator/How-to-Work-With-Vova.md:1024`, `instance/operator/How-to-Work-With-Vova.md:1025`)
  - “Human approval is required for secrets, dependency or lockfile mutations,” continuing through the bounded list (`instructions/autonomy-and-capacity.md:15`)
  - Follow the binding L1 irreversible set today. The full guide itself says, “Current instructions always take precedence over the operator profile.” (`instance/operator/How-to-Work-With-Vova.md:1070`)

## 4. Already enforced mechanically

- The full guide is not packed. The compact CORE is explicitly admitted from
  its instance home and included in all four role baselines.
- SessionStart reads params, pending ledger input, runtime state, and the same
  cross-root index of binding documents used by the other instruction tools.
- Pack reachability, closed tag/baseline configuration, Hard Floor drift, and the SessionStart budget are checker gates (`tools/instructions/check.ts:174`, `tools/instructions/check.ts:214`, `tools/instructions/check.ts:252`).
- Completion evidence, review, secret scanning, and report-SHA equality are landing gates (`gate/land.sh:144`, `gate/land.sh:151`, `gate/land.sh:157`, `gate/land.sh:160`). The secret scanner also checks decoded bounded base64 candidates (`gate/land-lib.sh:217`, `gate/land-lib.sh:226`).
- Independent-review identity and reviewed-SHA freshness are checked mechanically (`gate/land-lib.sh:132`, `gate/land-lib.sh:136`).
- `instructions/personas.md` does not exist on this branch.

## 5. Attachment and token cost

The collector admits only instance Markdown files explicitly configured for
packability, validates them through the instruction schema, and refuses
symlinks or path escapes. The CORE is configured and universally delivered by
the four role baselines; the full reference remains on demand.

Measured with `wc -l -c -w` after this refactor. No repository tokenizer is available, so token counts use a byte-based estimate of UTF-8 bytes ÷ 4, a rough assumption for mostly English Markdown:

| Document | Lines | Bytes | Words | Estimated tokens |
|---|---:|---:|---:|---:|
| Full reference | 1,117 | 28,033 | 4,157 | ≈7,008 |
| CORE | 63 | 3,599 | 489 | ≈900 |

If the alternative were attaching the full reference, the CORE saves 24,434 bytes, or ≈6,109 estimated tokens, per dispatch. Across 100 dispatches that is ≈610,850 estimated tokens.

## 6. Resolution

- Universal delivery to coder, reviewer, orchestrator, and manager was chosen.
- The compact file remains at its operator-specific home under
  `instance/operator/`; explicit packability admits it without walking
  `instance/` generally.
- A symlink remains refused because the landing payload guard rejects mode
  `120000`; the packability reader likewise accepts regular files only.
- Response order is channel-first, while chat depth, execution authority, and
  escalation remain with their existing binding instruction owners.
