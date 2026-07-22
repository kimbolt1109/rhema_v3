# Development guide

How to build, run, test, and extend Verger. Read [`../CLAUDE.md`](../CLAUDE.md) first — it holds
the standing rules this guide operationalises — and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the
process model.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 (`<25` recommended) | `engines.node` is `>=20.0.0`. Developed on Node 24.17.0. |
| npm | ≥ 10 | `packageManager` is pinned to `npm@11.13.0`. |
| Git | any recent | Remote is `github.com/kimbolt1109/rhema_v3`. |
| OBS Studio | 30+ | **Optional for development.** Needed only to see a real connection. |

**OBS is not installed on the development machine.** No code in this repo has ever talked to a live
OBS instance. That is a deliberate constraint, not a temporary one: OBS behaviour is specified by
mock-based unit tests (see §6), and the app is required to run correctly with OBS absent — the
Connection screen shows "Not configured" or "Down" and everything else keeps working. Installing
OBS is tracked in [`../HUMAN_TASKS.md`](../HUMAN_TASKS.md).

### Enabling the OBS WebSocket server (when you do have OBS)

1. `Tools → WebSocket Server Settings`
2. Tick **Enable WebSocket server**; note the **Server Port** (default `4455`)
3. **Show Connect Info** → copy the password
4. Put both in `.env`:
   ```ini
   OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
   OBS_WEBSOCKET_PASSWORD=<password>
   ```
   An **empty password is valid** and means OBS has authentication disabled. An **empty URL** means
   "not configured" — the reconnect loop stays idle rather than dialling.

---

## 2. Install

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

`.env` is gitignored. Every key may be left empty; nothing in it is required for the app to start.
Never commit a real value, and never paste a secret into any file other than `.env`.

---

## 3. The dev loop

```bash
npm run dev
```

This runs `electron-vite dev`, which:

- builds `src/main` and `src/preload` and watches them (a change restarts the Electron process),
- serves `src/renderer` from a Vite dev server on **`127.0.0.1:5273`** (`strictPort: true` — if the
  port is taken, the run fails rather than silently moving),
- exports `ELECTRON_RENDERER_URL` so the main process loads the dev server instead of the built
  `out/renderer/index.html`.

Other entry points:

```bash
npm start          # electron-vite preview — run the built output, no packaging
npm run build      # typecheck (both projects) then electron-vite build → out/
npm run package    # build then electron-builder --win   (Phase 10)
```

Build output layout (`out/`) is fixed and load-bearing:

| Path | Format | Why it matters |
|---|---|---|
| `out/main/index.js` | ESM | `package.json` `main` points here. |
| `out/preload/index.cjs` | **CommonJS** | `package.json` is `"type": "module"`, and Electron 38 only loads an **ESM** preload when `sandbox: false`. Verger keeps `sandbox: true`, so the preload must be CJS with an explicit `.cjs` extension, and the main process must resolve exactly this path. |
| `out/renderer/` | web assets | Renderer entry is exactly `src/renderer/index.html`. |

---

## 4. Typechecking

There are **two independent tsconfig projects**, not one. Run both — `npm run typecheck` does.

```bash
npm run typecheck:node   # tsc --noEmit -p tsconfig.node.json
npm run typecheck:web    # tsc --noEmit -p tsconfig.web.json
npm run typecheck        # both, node first
```

| Project | Covers | `types` | The trap |
|---|---|---|---|
| `tsconfig.node.json` | `src/main`, `src/preload`, `src/shared`, `electron.vite.config.ts`, `vitest.config.ts` | `["node"]` | — |
| `tsconfig.web.json` | `src/renderer`, `src/shared` | `["vite/client"]` | **No Node types.** `src/shared` is compiled by *both*, so any `process`, `Buffer`, `__dirname`, or `NodeJS.*` reference inside `src/shared` fails `typecheck:web`. |

`tsconfig.web.json` also deliberately drops the `@main/*` path alias, so a renderer file that
imports main-process code fails typecheck before it can fail at bundle time.

### Strictness you must write for

`tsconfig.base.json` turns on essentially everything. The four that bite most often:

- **`verbatimModuleSyntax`** — type-only imports must be written `import type { X } from '...'`.
  A plain `import { SomeType }` that is only used as a type is an error.
- **`noUncheckedIndexedAccess`** — `arr[i]` and `record[key]` are `T | undefined`. Narrow before use.
- **`exactOptionalPropertyTypes`** — you cannot assign `undefined` to an optional property. Either
  omit the key entirely or declare it `prop?: T | undefined`.
- **`noUnusedParameters`** — prefix a deliberately unused parameter with `_`.

Also on: `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noImplicitReturns`, `isolatedModules`.

---

## 5. Running tests

Vitest is configured with **two projects**, because Verger has two runtimes under test.

```bash
npm run test:run                   # both projects, once
npx vitest run --project node      # main / preload / shared, environment: node
npx vitest run --project renderer  # React UI, environment: jsdom
npm test                           # watch mode
npm run test:coverage              # v8 coverage, text + html
```

| Project | Environment | Include glob | Setup |
|---|---|---|---|
| `node` | `node` | `src/{main,preload,shared}/**/*.test.ts` | none |
| `renderer` | `jsdom` | `src/renderer/**/*.test.ts`, `src/renderer/**/*.test.tsx` | `vitest.setup.ts` (jest-dom matchers, `jest-axe`'s `toHaveNoViolations`, auto-`cleanup`) |

**Put each test file where its project's glob will actually find it.** `passWithNoTests: true` is
set — a phase that legitimately has no tests yet must not fail the gate — which means a test file
placed outside both globs fails *silently* rather than loudly. If a suite you just wrote reports
zero tests, the file is in the wrong place.

Path aliases (`@shared`, `@renderer`, `@main`) resolve in Vitest, `electron.vite.config.ts`, and
`tsconfig.base.json`. All three must stay in sync; changing one alone will produce a build that
typechecks but doesn't run, or vice versa.

---

## 6. Testing philosophy

**Behaviour over mock shape.** Assert what the module *does* — the state it lands in, the events it
emits, the ordering it guarantees — not which internal methods it happened to call. A test that
breaks when you rename a private helper is a test that will be deleted under pressure during a
service week.

**OBS is always mocked. Always.** No test may require a running OBS, a network connection, or a
real Electron runtime. The obs-websocket client is unit tested against a fake socket, and the cases
that matter are the unhappy ones:

- connect succeeds → identified → state becomes connected, version and scene list are read *from
  OBS*, never assumed;
- socket closes unexpectedly → reconnecting, with the backoff schedule advancing as specified;
- authentication is rejected → the terminal auth-failed state, and **no** reconnect storm;
- OBS closed and reopened → the client recovers without operator intervention;
- explicit disconnect → no reconnect.

The same rule generalises to every external dependency added in later phases: YouTube, Deepgram,
and the local ASR sidecar are all mocked at their client boundary.

**No copyrighted fixtures.** Never commit Bible verse text, whole Bibles, or song lyrics — not into
code, not into test fixtures, not into snapshots. Tests that need scripture use *references*
(`John 3:16`) and stub the resolver. Copyrighted translations are fetched at runtime from a licensed
API with attribution; only verified public-domain data is ever bundled from files. This is both a
legal obligation and a practical one: bulk copyrighted text trips content filters and has killed a
build phase in the prior project. See `v2-notes/LEGAL_AND_CONTENT.md`.

**Accessibility is a test, not a review comment.** Every UI phase adds a `jest-axe` assertion
(`await expect(container).toHaveNoViolations()`) plus explicit checks for the booth constraints:
minimum hit targets (48×48 px for primary controls, 64×64 px for Go Live / Clear), status conveyed
by more than colour alone, and `prefers-reduced-motion` honoured.

**Layer independence is asserted, not assumed.** "A camera switch does not touch overlay state, and
showing an overlay does not touch the camera" is an architectural invariant with a test behind it,
per [`../CLAUDE.md`](../CLAUDE.md).

**Never assert on a secret value.** Tests may assert that a subsystem reports "not configured", or
that a log line contains a key *name*; they may never contain or assert a key *value*.

---

## 7. File layout and conventions

```
src/
  main/       Node / Electron main process. All privileged work: window creation,
              OBS client, config + .env reading, file system, logging, IPC handlers.
  preload/    The bridge. Built to CommonJS at out/preload/index.cjs. Exposes a
              small, explicitly enumerated, typed API via contextBridge. No logic.
  renderer/   React 19 + Tailwind booth UI. Entry is exactly src/renderer/index.html.
              Never imports from src/main (the alias is not even mapped here).
  shared/     Pure TypeScript: types, Zod 4 schemas, pure functions. Imported by
              main, preload, and renderer. NO Node globals — see §4.
  overlay/    (Phase 2) Framework-free HTML/CSS/JS pages loaded into OBS as
              browser sources. Excluded from unit coverage.
docs/
  ARCHITECTURE.md, DEVELOPMENT.md
  v2-notes/   Distilled prior art from rhema_v2. Reference only. Never edited.
```

Rules that are cheap to follow and expensive to retrofit:

- **`src/shared` is the single source of protocol truth.** Its Zod schemas *are* the types
  (`z.infer`), so main, preload, renderer, and the overlay pages cannot drift apart. Do not
  hand-write a parallel interface for a schema that already exists.
- **Pick each constant exactly once.** Ports, channel names, timeouts, and thresholds live in one
  module in `src/shared` and are imported everywhere else — including into docs by reference, not by
  retyping the number. The prior project shipped four different port numbers for one server because
  this rule was not enforced.
- **Import ordering**: node builtins → external packages → aliased internal (`@shared`, `@main`,
  `@renderer`) → relative. Type-only imports use `import type`.
- **Tailwind tokens only.** Colours are `background`, `surface`, `surface-2`, `accent`
  (+ `accent-hover`), `accent-2`, `panic`, `live`, `text`, `text-muted`, `border`, `ring`. Hit-target
  sizes are `touch` (44px), `touch-lg` (56px), `touch-xl` (72px). Radii `rounded-glass` / `-md` /
  `-lg`; shadows `shadow-glass` / `glow` / `float` / `inner-highlight` / `float-dark`; animations
  `float`, `fade-in-up`, `logo-in`, `glow-pulse`. There is **no backdrop blur and no light mode** —
  the app is used in a dark booth and dark mode is the only mode. Do not add ad-hoc hex values.
- **No user-facing string literals in components.** Every visible string goes through i18next with a
  namespace-per-surface key. Retrofitting i18n onto a hundred finished components is what left the
  prior project ~6 % translated.
- **`.env` and `.env.example` move together.** Adding a key to one without the other is a defect.
  The canonical key list is the `ENV_KEYS` tuple in `src/main/config/env.ts`, and it must match
  `.env.example` exactly — same names, same order, no extras, no omissions. All env *reading*
  happens in `src/main`; `src/shared` may hold the *shape* of config but can never read it.
  (Note: `.env.example`'s header currently points at `src/shared/config.ts` for this list. There
  must only ever be one list — see the drift note in `ARCHITECTURE.md` §2.)

---

## 8. Disjoint file ownership (parallel agent builds)

Phases are implemented by several agents working simultaneously. The rule that makes that safe:

> **Every agent is given an explicit, exhaustive list of files it may create or modify, and the
> lists are pairwise disjoint. No two agents ever write the same file.**

Practically:

1. Before dispatch, the phase is decomposed into independent modules, and every file each module
   needs is assigned to exactly one owner. Files nobody owns do not get written this phase.
2. An agent that discovers it needs a change in someone else's file **does not make it**. It builds
   against the contract as published in `src/shared` and reports the gap.
3. `src/shared` is written first and by one owner, because everyone else compiles against it. If the
   contract owner fails, downstream agents document and build against what actually exists on disk
   rather than inventing an API — a fabricated signature costs more than a missing one.
4. Shared, already-verified root configuration (`package.json`, the tsconfigs,
   `electron.vite.config.ts`, `vitest.config.ts`, `tailwind.config.js`, `electron-builder.yml`,
   `.env.example`) is off-limits to phase agents entirely.
5. Governance files — `BLUEPRINT.md`, `verger_build_prompts.md`, `docs/v2-notes/*` — are immutable.
   `STATUS.md` and `HUMAN_TASKS.md` are appended by the integrator at the end of the phase, not by
   the parallel workers.
6. Integration is a separate step: after all agents return, the integrator runs the full typecheck,
   build, and test suite and fixes the seams.

---

## 9. Phase workflow

From [`../CLAUDE.md`](../CLAUDE.md). For each of the ten prompts in `verger_build_prompts.md`, in
order:

1. **Read** — `BLUEPRINT.md`, the phase prompt, and the `docs/v2-notes/` files it names.
2. **Delta** — itemise the concrete gaps between the current tree and the phase's DONE-WHEN.
3. **Dispatch** — implement, splitting independent modules across parallel agents scoped to disjoint
   file sets (§8).
4. **Integrate & verify** — `npm run typecheck`, `npm run build`, `npm run test:run`. Fix until
   green.
5. **Log** — append a `## Cycle N — Phase M` entry to `STATUS.md`; add any human-only blockers to
   `HUMAN_TASKS.md`.
6. **Ship** — commit and push to `origin/main`.

**Never block on a human.** If a phase needs a key, an account, or a certificate, stub it behind
config so the subsystem reports "not configured", write the exact ask to `HUMAN_TASKS.md`, and keep
going.

### Definition of green

A phase is not done until all of these hold:

- `npm run typecheck` clean (both projects)
- `npm run build` clean
- `npm run test:run` passing
- the phase's own acceptance checklist satisfied
- a `STATUS.md` cycle entry appended
- committed and pushed to `origin/main`

Claiming any of these without having run it in the session is the one banned reporting behaviour.
Report what you actually ran.

---

## 10. Debugging notes

- **Renderer devtools**: available in the dev run. The renderer is sandboxed with
  `contextIsolation: true` — you cannot reach Node from the console, by design. If you need
  privileged access to diagnose something, add a handler in main behind the validated IPC wrapper;
  do not loosen the window's `webPreferences`.
- **Main-process logs** go to a rolling file in Electron's `userData` directory, plus stdout in dev.
  Log messages may name a config key; they may never contain its value.
- **Preload changes require an Electron restart**, not just an HMR tick — `electron-vite dev`
  handles this, but if a `contextBridge` addition doesn't appear, restart the dev command.
- **"Cannot find module out/preload/index.cjs"** means the preload build format was changed. It must
  stay CJS with an `.cjs` extension while `sandbox: true` (§3).
- **Typecheck passes but the build fails on a `src/shared` file** — you almost certainly used a Node
  global there. Move the Node-dependent part into `src/main` and keep `src/shared` pure.
