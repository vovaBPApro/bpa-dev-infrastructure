Applies to TSX React components and hooks; TypeScript guidelines apply first.

# React AI Coding Guidelines

## State and effects

- Prefer explicit events, deterministic state transitions, pure components, composition, and reducers for coordinated or phased state.
- Use `useEffect` only for external side effects: network activity, subscriptions, listeners, timers, or external-system synchronization. Never use it to derive or synchronize React state, drive UI logic, or show feedback.
- Effect callbacks are synchronous; invoke and handle an inner async function when needed. Clean up listeners, timers, subscriptions, and abort controllers.
- Include every reactive input read by an effect. Stabilize non-reactive dependencies at module scope, a ref, or a callback; never disable exhaustive-deps to conceal a design problem.
- Copy state only at explicit boundary events such as opening a modal or selecting an item, never through automatic effect synchronization.
- Refs hold DOM handles and mutable non-rendering values; state/reducers hold values that affect rendering. Guards are only for idempotent external effects, stale async results, or Strict Mode tolerance.

## Performance, data, and navigation

- Do not memoize speculatively. Use `useMemo` or `useCallback` only for a demonstrated expensive computation, stable dependency/interface requirement, or memoized consumer.
- Prefer a server-state layer when remote data needs sharing, retry, cache, invalidation, pagination, deduplication, or coordinated lifecycle. Simple isolated fetches must still handle loading and errors explicitly.
- Navigation belongs to user-driven flows or route/session guards, not derived visual state.

## Components and semantics

- Use stable model identity for list keys, never random values or mutable-position indexes. Fragments in lists use keyed `React.Fragment`.
- Prefer composition to prop drilling; refactor when unused props cross more than two intermediate components.
- Define custom component props explicitly. Do not pass DOM props or spread loose props unless the interface intentionally supports them.
- Custom hooks begin with `use`, obey hook rules, return named objects where helpful, and do not hide state machines in effects.
- Use semantic HTML, avoid needless wrappers and clickable `div`s, label icon-only controls, and give images descriptive `alt` text (or empty alt only when decorative).
- Use early returns for major conditional branches; avoid non-boolean short-circuit rendering and deeply nested ternaries.

## Testing

- Test user-visible behavior, interactions, conditional states, and integration with providers at public boundaries. Query by role, label, text, or test ID; prefer `userEvent`.
- Mock external services at the network boundary. Do not assert component state, effect counts, styling, or third-party internals.

Prefer events over observation, reducers over effects, snapshots over synchronization, and correctness over lint suppression.
