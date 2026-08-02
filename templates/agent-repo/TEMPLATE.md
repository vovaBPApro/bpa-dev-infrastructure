# agent-repo template

The born-clean skeleton every new L2 (framework) or L3 (agent) repo starts from.
Not consumed directly — `tools/instructions/scaffold.ts` copies it, substitutes
placeholders, and finishes the new repo so it passes `check.ts --strict` with
zero FAIL on its first commit.

## What scaffold does with this template

- Copies `CLAUDE.md` and substitutes `{{REPO_NAME}}`, `{{LAYER}}`, `{{MISSION}}`.
- Copies `instructions/README.md` (a generator-marked placeholder) then runs
  `index.ts` + `floor.ts` so the index and the CLAUDE.md Hard Floor section are
  freshly generated for the new (empty) instruction set.
- Creates `AGENTS.md` as a **symlink to `CLAUDE.md`** — the template ships no
  literal `AGENTS.md`; the symlink is created at scaffold time so the two
  agent contracts never drift (Hard Rule 5: no vendor rule forks).
- For `--layer L2` only: writes `L2_PARKED_PROMOTION.md` (the parked-content
  promotion procedure) and prints the L1 `instance/parked.md` rows as a
  promotion TODO. `L2_PARKED_PROMOTION.md` and this `TEMPLATE.md` are template
  scaffolding, not part of the scaffolded output for L3.

## Placeholders

| Placeholder    | Meaning                                          |
|----------------|--------------------------------------------------|
| `{{REPO_NAME}}`| The new repository's name.                        |
| `{{LAYER}}`    | `L2` or `L3`.                                      |
| `{{MISSION}}`  | The ≤5-line mission statement for the new repo.   |
