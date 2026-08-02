---
id: lang-typescript-ai-guidelines
layer: L2-parked
status: binding
audience: coder
tags: [lang, typescript]
summary: TypeScript AI coding guidelines for TypeScript and TSX source files.
---

Applies to TypeScript and TSX source files.

# TypeScript AI Coding Guidelines

## Core principles

- Read the relevant documentation before changing code; change files deliberately, preserve the existing structure, and stay within the requested scope.
- Do not invent features. Prefer the simplest maintainable solution.
- Use modern TypeScript and the repository's module conventions. Do not change configuration or add dependencies without explicit approval.
- Keep units small and focused: files under 200 instructions, classes under ten public members, and functions under 20 instructions unless the local architecture requires an approved exception.

## Names, types, and structure

- Use PascalCase for classes, camelCase for variables/functions/methods, and kebab-case for files and directories.
- Begin booleans with verbs such as `is`, `has`, or `can`; begin functions with verbs; avoid nonstandard abbreviations.
- Declare explicit types for exported values, public members, function parameters, and returns. Infer unambiguous local types.
- Avoid `any`; use precise types or narrow `unknown`. Create domain types where needed.
- Name domain-significant numbers as constants; plain loop counters and unambiguous `0`, `1`, and `-1` are acceptable.
- Separate concerns through public interfaces, composition, immutable data, and established project boundaries. Prefer guard clauses and named predicates to deep nesting.

## Quality and dependencies

- Handle empty, null, undefined, and failure cases with clear messages. Use result types or guards for expected outcomes; reserve throws for exceptional failures.
- Use comments only for non-obvious architectural, constraint, legacy, or business-rule reasoning. Code and types should carry ordinary explanation.
- Minimize dependencies and justify each one; prefer platform and standard-library facilities where they meet the need.

## Testing

- Every feature, bug fix, or behavior change ships with automated tests. Public behavior needs a happy-path, key edge-case, and failure-path lock.
- Co-locate `*.test.ts` or `*.spec.ts` files with matching source structure. Use Arrange-Act-Assert, independent tests, descriptive names, and cleanup for side effects.
- Isolate unit tests with appropriate doubles; do not test third-party internals, type-only declarations, or trivial accessors.

Choose simplicity, correctness, and maintainability over cleverness or premature optimization.
