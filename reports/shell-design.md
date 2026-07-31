# Shell design: one browser, one application, agent modules

## Decision

Build one deployable web application in the new `agentic-bpa` monorepo. The
browser loads `apps/shell`; `apps/bill` and `apps/mila` are TypeScript/React
domain modules compiled into that application, not independently deployed web
applications. Public paths `/bill/*` and `/mila/*` belong to the shell's one
routing tree. There are no iframes, remote page proxies, agent-local browser
sessions, or agent-local application shells.

This preserves the old product's valuable behavior—persistent chrome and fast
agent switching—without preserving the browser and deployment boundaries that
made it fragile.

## Sources and authority

This design is grounded in:

- `instance/decisions/HR-330.md`: the binding operator directive. In particular,
  copy all shell functionality, connect chat correctly, preserve smooth agent
  switching, do not repeat the iframe mechanism, build the shell outside Bill,
  and keep Mila as an empty stub initially.
- `reports/stack-postmortem.md`: commit-history evidence that three independently
  built Next applications, iframe persistence, page proxies, shared packages,
  cookies, `postMessage`, and coordinated stands turned normal changes into
  cross-repository integration work.
- `/srv/archive/bpa-shell/docs/concepts/CONCEPT_spa_agent_modules.md`: the direct
  prior design for a shell-owned SPA with build-time agent UI modules.
- `/srv/archive/bpa-shell/docs/concepts/CONCEPT_shell_owns_chrome.md` and
  `CONCEPT_chat_driven_minimal_dashboard.md`: shell ownership of the front door,
  chrome, chat, settings, agent selection, and minimal dashboard.
- `/srv/archive/bpa-shell/PRODUCT.md`, `docs/definition.md`,
  `docs/architektur.md`, and `docs/limitations.md`: product vocabulary,
  framework capabilities, known cross-repo package problem, and the later
  same-origin API direction.
- The archived implementation in `/srv/archive/bpa-shell/apps/shell`, especially
  `KarkasLayout.tsx`, `KarkasAgentSurface.tsx`, `KarkasChatComposer.tsx`,
  `chat/history.ts`, the auth gate/session modules, settings, notifications,
  registry, and end-to-end/visual tests.

Where a document describes an aspiration and the implementation differs, the
implementation is used to inventory carry-over behavior. Where an old document
conflicts with HR-330 or the evidence-based post-mortem, HR-330 and the
post-mortem decide the new architecture.

## What the old shell actually provides

HR-330 says all shell functionality must be copied. “Shell functionality” is
therefore this behavior inventory, not merely the visible header.

### Chat

- One persistent shell-owned right-hand chat panel, resizable on desktop,
  collapsible, reopenable from the header, responsive on narrow viewports, and
  automatically collapsed for the large new-entry screen.
- Routing among `master`, Bill, and Mila; the active route and active agent are
  sent as page context. Agent-switch and navigation replies can update the UI.
- Streaming response frames, including activity, tool-use/progress, text deltas,
  final replies, stop/cancel behavior, and unavailable/unauthenticated states.
- Separate transcripts for master, Bill, and Mila inside a conversation;
  Bill → Mila → Bill restores Bill's transcript. The active and archived chat
  sessions survive reload through shell-owned browser storage.
- New conversation, conversation list, rename, timestamps, Markdown rendering,
  action cards, examples/empty state, and scroll-to-latest behavior.
- One attachment at a time with type and magic-byte checks, upload progress,
  removal, attachment bubbles, and routed ingestion. Prompt-input scanning is
  applied at chat text/upload chokepoints in the archived architecture.

Carry-over decision: preserve these user-visible and safety behaviors. The new
shell may change internal persistence from browser-only storage later, but the
first port must preserve per-agent transcripts and reload survival. Agent/domain
execution stays behind an explicit module command/query boundary; the shell
owns the chat UI and orchestration, not Bill's accounting logic.

### Agent switcher and state

- A top-header Bill/Mila selector with active accent/theme, company byline,
  responsive placement, keyboard-accessible buttons, reduced-motion handling,
  and a short FLIP animation.
- Instant switching because both iframe applications remained mounted and were
  hidden/shown. The shell remembered the last surface URL for each agent and
  mirrored in-frame navigation into browser history, including back/forward.
- Agent-aware navigation, accent, breadcrumbs, page title, chat target, and
  settings context.

Carry-over decision: preserve immediate visual response, last route per agent,
browser back/forward semantics, active accent, and persistent chrome. Do not
preserve “both complete apps stay mounted.” Route chunks and data are prefetched;
only explicitly approved lightweight client state is cached.

### Chrome

- Persistent header, branding, agent switcher, notification bell, chat-open
  button, user/avatar menu, navigation/breadcrumb band, optional agent sidebar,
  content area, loading indicator, and chat column.
- Desktop/mobile layout behavior, sidebar collapse/open-slot persistence,
  chat-width persistence, themes/agent accents, focus behavior, reduced motion,
  and light/dark visual contracts.
- Shell-owned settings modal/page with User, Company, Connections, Language,
  and Versions sections, including password/account editing, agent versions,
  QBO connection/import status, and URL-addressable section state.
- Notifications aggregated across agents without remounting on agent switches.
- User menu actions: Settings, Rules, clear client caches, and Sign out.
- Onboarding/empty dashboard when no agent is installed, health/readiness and
  version surfaces, and an unavailable-agent state.

Carry-over decision: port the chrome and its interaction contracts. Product
features accidentally implemented under shell APIs (for example QBO import)
move into Bill's module/BFF namespace; the shell keeps only their chrome-level
entry and status slot.

### Authentication and routing

- Shell-owned login, register, email verification, forgot/reset password,
  logout, account/password management, TOTP-capable shared auth, organization
  selection/context, and authoritative server-side session validation.
- A coarse fail-closed route gate plus authoritative validation in pages/API
  handlers. Unauthenticated pages redirect to `/login`; unauthenticated APIs
  return `401`.
- One host-only, `HttpOnly`, `SameSite=Lax`, `Path=/` session cookie backed by
  one session store. The shell already treats this as the browser session of
  record.
- Top-level QBO OAuth callback exemption and state validation. The archived
  history also proves why OAuth must never run inside a frame.
- Browser-history synchronization for `/bill/*` and `/mila/*`, same-origin API
  paths, safe redirect/origin handling, and live public-origin tests.

Carry-over decision: retain all auth journeys that are still product-required
and their security properties. There is exactly one browser identity. OAuth
callbacks remain top-level routes such as `/auth/callback/qbo`; they return to a
validated shell route after consuming state.

## Is `CONCEPT_spa_agent_modules.md` still the right answer?

Yes for the core answer: one shell-owned SPA, build-time React agent modules,
one chrome, one client-side router, shell-owned route registration, and no
foreign App Router trees or whole-page proxies. That is the correct direct
answer to HR-330 and should be implemented rather than reinvented.

It is stale in these exact respects:

1. **Repository topology.** It assumes three repositories and asks how to
   publish `@agent-bill/surface` and `@agent-mila/surface`. HR-330's confirmed
   target is one monorepo with one lockfile, so there is no cross-repo package
   publication decision. Use workspace TypeScript boundaries.
2. **Deployment topology.** It preserves each agent backend/API as a separate
   service and has browser modules call agent-specific services. The
   post-mortem now requires one deployable web app and says a service is split
   only for a demonstrated scaling, security, or failure-domain boundary. No
   such boundary is established for Bill or Mila. Their BFF handlers compile
   into the shell deployable.
3. **Browser API/auth transport.** Its wording allows direct agent backend
   origins and runtime API-base injection. The new ruling is one origin and one
   BFF/session boundary. Browser code calls only same-origin `/api/*`; there is
   no browser-to-agent origin, cookie forwarding, or signed shell-to-page proxy.
4. **Route implementation detail.** A generic catch-all matcher was sensible
   when externally published modules had to contribute unknown routes. In one
   repo, a statically composed, typed route tree is simpler and gives the
   framework direct route-level chunking/prefetch. A module manifest may supply
   nav metadata and loaders, but it must not implement a second router.
5. **Mila scope.** The old concept plans extraction of Mila's implemented
   screens. HR-330 explicitly requires a dumb empty Mila stub now. Port only its
   switcher identity, route, accent, and empty surface in the first shell build.

`CONCEPT_shell_owns_chrome.md` is more stale: it is an incremental cutover plan
that retains whole-page worker proxies, signed forwarded identity, allowlists,
and chrome-less remote surfaces. Those are rollback seams for the old system,
not the destination for a clean repo. Its ownership decisions remain useful;
its proxy mechanism does not.

The old `architektur.md` also disagrees internally: it says one browser app but
retains private Bill/Mila processes, worker registration, signed dispatch, and
narrow API forwarding. The post-mortem's later, explicit one-deployable ruling
wins. Keep typed module boundaries and postpone processes until an operational
boundary is evidenced.

## Concrete workspace and module shape

The confirmed directory names remain unchanged:

```text
apps/
  shell/                 # the only web framework app and deployable
    app/                  # the only route tree and root layout
    src/chrome/           # header, switcher, nav, chat frame, settings frame
    src/auth/             # login/session/BFF guards and OAuth callbacks
    src/registry/         # static composition of Bill and Mila manifests
    src/state/            # shell UI, route-memory and chat session stores
  bill/                   # workspace module; no Next/Vite app root, no deploy
    src/module.ts         # manifest and lazy screen/data registrations
    src/routes/           # Bill React route surfaces
    src/api/              # BFF commands/queries registered into shell handlers
    src/chat/             # Bill chat turn adapter/tool policy
  mila/                   # workspace module; initially only a stub
    src/module.ts
    src/routes/stub.tsx
packages/
  chrome/                 # shared shell visual primitives/tokens
  auth/                   # framework-neutral session domain and persistence port
  module-contract/        # AgentModule types and validation
  test-kit/               # route/auth/module integration fixtures
```

`apps/bill` and `apps/mila` are called apps because that layout is confirmed,
but their package manifests must not expose `dev`, `start`, or independent web
builds. Only `apps/shell` owns the web framework, React root, global CSS,
middleware, public assets, and runtime start command. Root tooling enforces one
lockfile and one React/web-framework version.

Minimal static contract:

```ts
type AgentModule = {
  id: 'bill' | 'mila';
  label: string;
  basePath: `/${string}`;
  accent: string;
  defaultPath: `/${string}`;
  nav: readonly { id: string; label: string; href: `/${string}` }[];
  preload: () => Promise<unknown>;
  chat: { target: 'bill' | 'mila'; policy: 'read-only' | 'read-write' };
};
```

The registry imports both modules statically and rejects duplicate ids,
base-path escapes, nav links outside the module base, and missing default routes
in tests. Screen components do not receive raw session tokens. They call typed
same-origin BFF clients or server actions whose handlers resolve session and
organization afresh.

## One route tree

```text
/
├── /login, /register, /forgot-password, /reset-password
├── /auth/callback/qbo
├── /(authenticated)                         # one persistent ShellLayout
│   ├── /bill                                -> redirect /bill/dashboard
│   ├── /bill/dashboard                     -> Bill first surface
│   ├── /bill/...                           -> later Bill vertical slices
│   ├── /mila                               -> Mila empty stub
│   ├── /settings/:section?                 -> shell settings frame
│   ├── /rules                              -> shell rules
│   └── /costs                              -> shell cost view, if retained
└── /api
    ├── /auth/*, /account/*, /profile/*      # shell BFF/session owner
    ├── /chat/stream, /chat/upload           # one shell chat boundary
    ├── /notifications/*                     # shell aggregation boundary
    ├── /bill/*                              # Bill handlers in same process
    └── /mila/*                              # absent/health stub initially
```

The authenticated layout never unmounts while navigating between Bill and Mila.
It owns header, selector, sidebar frame, breadcrumb frame, notification slot,
chat panel, settings overlay, and content outlet. Route modules supply only the
outlet content plus normalized nav/breadcrumb metadata.

### Instant switching without iframes

On first authenticated shell render:

- preload the tiny module manifests, both agent icons, and the Mila stub chunk;
- after the current route becomes interactive, prefetch the other agent's
  `defaultPath` route chunk and its minimal loader response;
- on pointer hover, focus, or touch-start of a selector option, immediately
  prefetch that agent's default/last route chunk and query key;
- render the selected accent/label synchronously, then perform a client-side
  route transition. Keep the old reduced-motion-aware selector animation and a
  shell loading bar if the outlet is not ready.

Do not keep complete hidden route trees mounted. Cache code chunks through the
router/bundler and server data through an explicit query cache. A keep-alive
component is permitted only after a measured expensive-root regression and must
be bounded (for example, one inactive route), never the default architecture.

### State that survives a switch

Shell-global state survives because `ShellLayout` stays mounted:

- authenticated user/organization snapshot (with server revalidation);
- chat open/closed state, width, active conversation, archived conversation
  list, streaming/cancel state, and per-agent transcripts;
- notification unread state;
- theme/accent transition, responsive chrome state, and settings return route;
- sidebar/chat dimensions and other user chrome preferences;
- `lastRouteByAgent`, so Bill → Mila → Bill returns to the prior Bill route.

Module state rules are explicit:

- server/domain data lives in a keyed query cache and survives according to its
  freshness policy;
- URL-worthy state (selected transaction, filters that must be shareable) is in
  the URL;
- unsaved form drafts survive only when a route declares a keyed draft store;
  navigation warns before discarding an undeclared dirty form;
- ephemeral component state (open popover, local hover) may reset;
- Mila's initial stub has no retained domain state.

Switching via the header uses the last route for that agent; a direct URL and
back/forward always win over remembered state. Reload reconstructs the active
agent from the URL, not from local storage.

## One origin, one BFF, one session

The public browser sees one origin, for example `https://app.example.com`, and
only the shell deployable. All browser calls are relative same-origin calls.

- One `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/` session
  cookie. One session table/store and one revocation/logout path.
- The auth guard protects the authenticated layout and all BFF handlers by
  default. Public routes are an explicit closed allowlist. Pages redirect to
  `/login`; APIs return `401`. Every sensitive handler performs authoritative
  validation and organization/role authorization; middleware cookie presence
  alone is not authorization.
- The BFF derives `userId`, `organizationId`, and role from the validated
  server-side session. Browser-supplied identity headers are ignored. Agent
  React modules never see the raw cookie or mint another identity.
- Bill and Mila BFF namespaces are code-ownership boundaries inside the same
  process, not reverse proxies. Their handlers call domain application services
  directly through typed interfaces.
- OAuth initiation and callbacks are top-level shell routes. State binds the
  callback to the initiating session/organization and a safe internal return
  path. No callback or authorization page is framed.
- CSRF protection, origin validation, request-size limits, prompt/file scanning,
  audit events, and rate limits are applied centrally at the BFF and narrowed by
  domain handlers where needed.

If a future Bill job worker earns a separate process boundary, the browser
contract does not change: the BFF remains the sole public session boundary and
calls that private service server-to-server. That split requires measured
operational evidence and its own auth/failure contract.

## Port order: the smallest end-to-end switching proof

The first slice is deliberately smaller than “port the shell,” but it crosses
every boundary needed to prove the architecture.

### Slice 0 — executable skeleton and contract

Create the monorepo workspace, one shell app, one lockfile/React version, the
validated `AgentModule` contract, Bill and Mila manifests, and a persistent
authenticated `ShellLayout`. Bill renders a static `Dashboard` marker; Mila
renders the required empty stub. No legacy proxy or iframe code is copied.

Acceptance lock: module registry validation proves exactly `bill` and `mila`,
one route owner, and no module package exposes an independent web start/build.

### Slice 1 — switching vertical proof (first usable increment)

Add the real selector/chrome behavior, `/bill/dashboard`, `/mila`, client-side
navigation, per-agent last-route memory, route prefetch, back/forward handling,
loading state, and reduced-motion behavior. Add one harmless shell-global state
counter or draft fixture to demonstrate that chrome state remains mounted.

Live Playwright acceptance:

1. authenticate once and land on `/bill/dashboard`;
2. mutate shell-global fixture state and navigate Bill to a second test route;
3. hover/focus Mila and observe its route prefetch;
4. click Mila: URL becomes `/mila`, Mila stub appears, header/chat remain the
   same DOM instances, fixture state is unchanged, and no iframe exists;
5. click Bill: the remembered Bill test route returns without full document
   navigation;
6. browser Back/Forward restores the matching active agent and content;
7. network assertions show one origin and no foreign HTML/page proxy request.

This is the smallest slice that proves the operator's valued switching behavior
end to end. It must be green before porting broad chrome or any Bill domain UI.

### Slice 2 — auth/session and chat spine

Port the actual login/logout/session guard and one shell chat conversation with
per-agent transcripts, streaming stub endpoints, current-route context, reload
persistence, stop, and error states. Prove one login covers Bill and Mila and
unauthenticated BFF calls fail closed. Then add attachment scanning/upload.

### Slice 3 — remaining shell functionality

Port notifications, breadcrumbs/nav/sidebar behavior, settings sections,
account/password flows, rules, cache clearing, responsive/visual behavior,
onboarding/unavailable states, OAuth callback shell, health/readiness/version,
and the relevant visual/accessibility locks. Preserve behavior; do not import
old proxy routes or iframe synchronization helpers.

### Slice 4 — first real Bill vertical slice

Replace Bill's static marker with one thin read-only screen and same-process BFF
query. This proves typed Bill UI → BFF → domain-service flow under the same
session. Only after that boundary is locked should QuickBooks transaction import
and email document matching begin. Mila remains the stub until the operator
changes its scope.

## Explicit non-decisions for build lanes

Build lanes must not reopen these choices:

- no iframe, web component embedding, micro-frontend runtime, or remote HTML;
- no separate Bill/Mila frontend servers, router roots, lockfiles, React
  versions, browser sessions, or public origins;
- no generic worker registry for browser page composition;
- no cross-repo UI package publication mechanism;
- no hidden mounting of all complete agent surfaces as the normal speed tactic;
- no QBO/domain logic in shell chrome modules—only under Bill ownership;
- no Mila feature port beyond the empty stub in the initial scope.

## Pack consumption check

- `review-policy` `sha256:b95d6eb6d0e5` — Review Policy
- `verification-and-locks` `sha256:b13ed13070c1` — Verification and Regression Locks
- `roles` `sha256:cd4c40c4e640` — Roles
- `instruction-layers` `sha256:f9a51936be92` — Instruction Layers
- `tool-permissions` `sha256:6c7b9f57fbbd` — Tool Permissions
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git
