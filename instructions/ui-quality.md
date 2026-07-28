# UI Quality

Route every UI creation, modification, and UI review through the repository's
design-quality system and its anti-pattern detector before acceptance. The
repository may configure the specific tool or hook; the quality requirement is
tool-independent.

- Load and apply the designated design system, tokens, accessibility rules, and
  interaction conventions before editing a visible surface.
- Run the configured anti-pattern detector on touched UI and resolve or
  explicitly track its findings before acceptance.
- Verify the rendered result in a live browser when the change affects visible
  layout, interaction, state, typography, color, overflow, or responsive
  behavior.
- Pair UI defect fixes with the live visual lock required by
  `verification-and-locks.md`.

A UI diff that bypasses the designated design-quality route is incomplete.
