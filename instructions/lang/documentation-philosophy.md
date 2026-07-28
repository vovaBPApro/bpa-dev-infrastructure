Applies to Markdown documentation and code comments.

# AI-Native Documentation Philosophy

## Principles

- Code, types, schemas, tests, and directory structure are the primary implementation documentation. Keep them clear enough to explain ordinary behavior directly.
- Write documents for durable context that code cannot express: system boundaries, responsibilities, data flow, constraints, trade-offs, anti-patterns, and decision rationale.
- Prefer principle- and constraint-driven guidance over tutorials, copied signatures, exhaustive API restatements, or step-by-step examples that will drift from the implementation.
- Explain why a boundary or restriction exists, especially for security, safety, data integrity, performance, legacy incompatibility, or operational recovery.
- Use minimal, high-precision comments for non-obvious critical decisions. Do not narrate obvious syntax or duplicate types.
- Treat constraints as first-class features. Make prohibited paths and their consequences explicit so future changes preserve intent.
- Keep documentation narrow, accurate, and maintained alongside the decision it describes. Remove or correct stale claims rather than accumulating competing instructions.
- Prefer architecture brain dumps for complex design reasoning when a polished tutorial would hide uncertainty or create maintenance fiction.

Why: AI collaborators derive implementation from the repository; concise durable reasoning gives them the context needed to extend it safely without replacing code truth.
