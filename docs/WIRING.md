# Wiring — the composition root, and the bug that keeps coming back

This document exists because of one recurring defect. Four times during this build a component was
written, fully unit-tested, reviewed, merged green — and connected to **nothing**.

If you read only one paragraph, read this one:

> A unit test injects its own fakes. It therefore proves that a component *works*, and it can never
> prove that the app *uses* it. Everything in this repository is built behind structural seams and
> tested against plain objects, which is the right design and also the exact condition under which
> a component can be perfectly correct and completely unreachable. `src/main/wiring.test.ts` is the
> one test that stands in that gap.

---

## 1. The four instances

| Phase | What was built | What was missing | What the operator would have seen |
| --- | --- | --- | --- |
| 2 | `OverlayServer` — HTTP + WebSocket, state cache, resync-on-reconnect | `start()` was never called. Port 7320 was never bound. | The OBS Browser Source failed to connect. **No overlay layer at all** on the congregation screen — no lower thirds, no scripture, no slides. |
| 4 | `OAuthService` — full loopback consent flow, token storage in `safeStorage` | Nothing called `restore()` / `refresh()` at startup. The constructor cannot await the secrets store, so the service *deliberately* begins signed-out. | "Signed out" on the Go Live screen **every single launch**, despite a perfectly good stored refresh token. Sign in again, every Sunday. |
| 5 | `GoLiveService.initialize()` — reads OBS's real output state and adopts it | Nothing called `initialize()`. | Relaunch mid-service → GO LIVE looks idle → operator presses it → **a SECOND stream and a SECOND recording** during a live, un-repeatable event. The worst outcome this app has. |
| 8 | `CueEngine` + `scriptureDetector` — the plan-follower, hot phrases, reference detection | `getCueEngine()` defaulted `plan` and `overlay` but not `asr`, and no scripture detector was passed. | A brain with **neither ears nor eyes**. The engine subscribed to no transcript, held no detector, and silently suggested nothing forever. |

Every one of those passed every unit test in the repository, on every run, for the whole phase in
which it shipped.

They share one shape:

```
                      built                connected
  overlay server        yes                    no      ← start() never called
  oauth service         yes                    no      ← restore() never called
  golive service        yes                    no      ← initialize() never called
  cue engine            yes                  partly    ← two of four seams defaulted
```

None of them is a logic error. Each is a **missing line in the composition root**.

---

## 2. What the composition root is

Verger has two composition roots, and the split matters.

### `src/main/index.ts` — the *lifecycle* root

Runs inside `app.whenReady()`. It is the only place that:

- loads config and builds the real rolling-file logger,
- builds the OBS client, the overlay server, the YouTube service and the go-live service **with the
  real logger**, so their diagnostics land in the service-day log,
- **starts** the things that must be started (see §3),
- calls `registerIpc(...)`, and
- disposes IPC on `will-quit`.

It cannot be imported by a test: it takes the single-instance lock, installs process-level crash
handlers and creates a `BrowserWindow` at import time. That is why `wiring.test.ts` checks it by
reading its source (§6).

### `src/main/ipc/register.ts` — the *dependency* root

`registerIpc({ config, logger, obs })` takes three required dependencies and **resolves every other
subsystem itself**, from the same process-wide singletons the running app uses. Each resolution is
its own `try`/`catch`, so a subsystem that cannot be constructed degrades exactly one group of
channels and touches nothing else (Standing Rule 5).

This is the single most important thing to understand about the design: `registerIpc` with
production defaults is a *complete* wiring of the app's request surface. If `registerIpc` can
register every channel and answer every one of them without an internal error, the app's IPC layer
is wired. That is assertion #1 in `wiring.test.ts`, and it is the highest-value assertion in the
file.

---

## 3. Constructed vs. started — the distinction that keeps biting

Every factory in `src/main/*/index.ts` is **lazy and inert**. Constructing one opens no socket,
spawns no process, reads no network and starts no timer. That is deliberate: `src/main/index.ts`
builds all of them before a window exists, on machines with no OBS, no GPU and no credentials.

The consequence is that **constructing a subsystem does nothing**. Some of them additionally need to
be *started*, *restored* or *initialised*, and that call is a separate line that somebody has to
write. Here is the complete list.

| Factory | Inert on construction | Needs an explicit call | Where |
| --- | --- | --- | --- |
| `getObsClient()` | yes | `connect()` — but only when the operator asks. Standing Rule 2: Verger never imposes state on OBS. | operator action |
| `getOverlayServer()` | yes — **binds nothing** | **`start()`** | `src/main/index.ts` |
| `getCameraService()` | yes | none | — |
| `getYouTubeService()` | yes — no OAuth client, no network | **`refresh()`** to restore the stored session | `src/main/index.ts` |
| `getGoLiveService()` | yes — no OBS request, no quota | **`initialize()`** to re-attach to a running broadcast | `src/main/index.ts` |
| `getPlanService()` | yes — no I/O at all | none | — |
| `getAsrService()` | yes — two dormant adapters, one small file read | `start()` — operator action only | operator action |
| `getCueEngine()` | yes — subscribes to the ASR singleton and holds the detector | none | — |
| `getHealthService()` | **no — it calls `start()` for you** | none, on purpose | inside the factory |
| `getCheckpointStore()` | **no — it calls `start()` for you** | none, on purpose | inside the factory |

Note the last two. `@main/health` self-starts inside its factory *specifically because* of the four
defects above: "somebody has to remember" is what failed, four times, so the health module removed
the opportunity to forget. Prefer that pattern for anything new — a factory that returns a
subscribed, running object is strictly harder to mis-wire than one that returns an object plus a
homework assignment.

Where self-starting is impossible (the overlay server must be started *after* config load and needs
its result awaited for the log line), the call belongs in `src/main/index.ts` and is guarded by
`wiring.test.ts` §6.

---

## 4. Dependencies that default to ABSENT

Most of `RegisterIpcDeps` is optional-with-a-singleton-default: omit it and `registerIpc` looks the
subsystem up itself. Those are safe — forgetting them changes nothing.

A small number default to **absent** instead, because there is no sensible singleton to look up.
These are the dangerous ones: omit them and the channel is permanently `NOT_CONFIGURED`, with no
error, no log line and no visible symptom other than a feature that quietly never works.

| Dep | Channels it feeds | Who must pass it | Status |
| --- | --- | --- | --- |
| `overlayReload` | `healthReloadOverlays` | `src/main/index.ts`, where the overlay server it watches already exists | **guarded by `wiring.test.ts`** |
| `scripture` | `cueResolveScripture`, `cueListTranslations` | whoever owns scripture resolution | `ScriptureResolver` exists and is unit-tested in `src/main/cue/ScriptureResolver.ts`, is not exported from `@main/cue`, has no zero-arg factory, and is passed by nobody. **This is the same pattern.** See §8. |

If you add an absent-by-default dependency, add a row here and a row in
`COMPOSITION_ROOT_DUTIES` in `wiring.test.ts`.

---

## 5. What `src/main/wiring.test.ts` asserts

It mocks exactly one module — `electron` — and nothing else. `register.test.ts` mocks every
subsystem singleton so it can prove the *degraded* contracts; `wiring.test.ts` mocks none of them so
it can prove the *wired* one. Neither replaces the other.

1. **Every channel in `IPC_CHANNEL_VALUES` has a registered handler** after `registerIpc()` with
   production defaults — no subsystem dep passed. This one assertion proves the default resolution
   path works for every subsystem in the app.
2. **Every declared channel is classified** as probed or deliberately skipped, so a new channel
   cannot be added, registered, and then never exercised by anything.
3. **No probed handler returns `Err(INTERNAL)`** on an unconfigured machine. Unconfigured is a
   *designed* state — `NOT_CONFIGURED`, `NOT_CONNECTED`, `NOT_FOUND`, or a plain `Ok`. `INTERNAL`
   means "we did not think about this", and an operator cannot act on it.
4. **The overlay server binds and serves.** Its production static-directory resolver must point at a
   directory that really contains `overlay.html`, the server must bind (on port 0, so this is
   parallel-safe), and `getInfo().pageUrl` — the exact string operators paste into an OBS Browser
   Source — must serve the page. See §7 for the redirect note.
5. **`getCueEngine()` with no arguments has ears and eyes.** A fake is injected at the *provider*
   seam only — the one place a real recogniser would open a socket or spawn Python — and a
   transcript is pushed through the real `AsrService`, the real transcript fan-out, the real default
   `asr` resolution and the real scripture detector, until a `CueSuggestion` for John 3:16 comes out
   the other end. If either Phase 8 default is dropped again, nothing arrives.
6. **`GoLiveService.initialize()` re-attaches** when its OBS seam reports streaming: `reattached`,
   phase `live`, and **zero** `startStreamAndRecord`, `stopStream` and `stopRecord` calls.
7. **The production factory manifest.** Every factory is zero-arg callable and returns an object, so
   a factory that grows a mandatory argument breaks a test instead of breaking `app.whenReady()`.
   Construction is also asserted to be inert — in particular the overlay server must not be
   listening merely because something imported it.
8. **Seam conformance.** `registerIpc`'s structural interfaces are satisfied at compile time by
   whatever `register.test.ts` injects; nothing checks the *production* object still has the
   methods. This does.
9. **Composition-root duties.** `src/main/index.ts` is checked by source for the four calls above.

### Channels it does not invoke, and why

| Channel | Why |
| --- | --- |
| `goLiveStart` | destructive: would push a stream and start a recording |
| `goLiveEnd` | destructive: would end a broadcast and stop both outputs |
| `cuePanic` | the master automation kill switch; proven in the cue tests, never pressed here |
| `obsConnect` | dials a real websocket and arms the reconnect backoff; OBS Studio is not installed |
| `obsSetConfig` | persists an OBS password into the real secrets store, then dials |
| `youtubeSignIn` | runs the loopback OAuth consent flow: binds a callback port, opens a browser |
| `asrStart` | opens a Deepgram websocket or spawns the Python faster-whisper sidecar |

Everything else is invoked for real, including the recovery channels — a recovery action that fails
in the moment it is needed is worse than one that does not exist.

---

## 6. Why the composition root is checked by source

`src/main/index.ts` cannot be imported under vitest. Reading it and matching four patterns is crude,
and it is still the only mechanical guard between this repository and a fifth instance. Each pattern
carries the history of the bug it is guarding, so a failure explains itself:

```
overlay.start(          Phase 2 — port 7320 never bound
youtube.refresh(        Phase 4 — signed out every launch despite a stored token
goLive.initialize(      Phase 5 — a SECOND stream and a SECOND recording
overlayReload:          Phase 9 — the watchdog wired to nothing
```

If you rename one of these, the test will fail. That failure is not noise: a rename of a wiring call
is exactly the moment to re-read what it connects. Update the pattern deliberately.

---

## 7. Known finding: `GET /overlay` answers 301

`express.static` is mounted at `/overlay`, and a request for the un-slashed mount path answers
`301 -> /overlay/` before serving `overlay.html`. An OBS Browser Source is Chromium and follows that
transparently, so the overlay does reach the congregation screen — but the documented URL costs one
extra round trip on every browser-source reload. `wiring.test.ts` asserts the page is reached in at
most one hop and records the direct status, rather than hiding either fact.

---

## 8. Checklist: adding a new subsystem

Work through all of it. Every item exists because skipping it shipped a bug.

1. **Build it behind structural seams** and unit-test it against plain objects. No test in this repo
   may need OBS, a network, a GPU or an Electron runtime.
2. **Give it a zero-argument factory** in `src/main/<name>/index.ts`, plus a `reset<Name>()` that
   disposes. Zero-argument is not a style preference: `registerIpc` and `src/main/index.ts` both
   call these with no arguments, so a mandatory parameter is a crash at `app.whenReady()`.
3. **Make construction inert** — no socket, no child process, no timer, no network. If it must
   subscribe or poll, prefer to `start()` it *inside the factory* the way `@main/health` does, so
   there is nothing left for a caller to forget.
4. **If it genuinely cannot self-start**, put the call in `src/main/index.ts` and add a row to
   `COMPOSITION_ROOT_DUTIES` in `wiring.test.ts` with the failure it prevents.
5. **Add its channels** to `IpcChannel`, `IpcRequest`, `IpcResponse` and `VergerApi` in
   `@shared/ipc`, and handlers in `register.ts`. Assertion #1 will fail until you do.
6. **Classify every new channel** in `PROBED_CHANNELS` (with a valid argument) or
   `SKIPPED_CHANNELS` (with a reason). Assertion #2 will fail until you do.
7. **Give it a defined unconfigured answer.** `NOT_CONFIGURED` for "no credentials",
   `NOT_CONNECTED` for "nothing is listening", `NOT_FOUND` for "no such thing". Never `INTERNAL`.
   Assertion #3 will fail otherwise.
8. **Add its factory to `PRODUCTION_FACTORIES`**, and — if `registerIpc` reaches it through a
   structural seam — add a row to `SEAM_CONFORMANCE`.
9. **If its `registerIpc` dep defaults to absent**, add a row to §4 above *and* a
   `COMPOSITION_ROOT_DUTIES` entry. This is the failure mode with no symptom.
10. **Give it a health light** in `SUBSYSTEMS` (`@shared/health`) with an honest `stillWorks`
    string, and remember that a subsystem which is merely unconfigured is `not-configured`, never
    amber.
11. **Ask the question directly**: *if I deleted the body of this subsystem's main entry point,
    which test would go red?* If the answer is "none", you have written instance number six.
