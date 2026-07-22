# v2 Notes — distilled prior-art for the Verger build

This folder is the mined, distilled knowledge of **rhema_v2** (`C:\Side projects\rhema_v2`), a mature prior iteration of this product built as a **Tauri 2 + Rust** desktop app with its own wgpu compositor, native encoder, and hardware protocol stack. **None of that engine is being ported.** Verger (this repo, `rhema_v3`) is a deliberately simpler system: an **Electron** control app that drives **OBS Studio** as the compositor/streamer, an independent HTML overlay layer served over WebSocket, and a pluggable ASR-fed cue engine — per `BLUEPRINT.md`. What these ten notes carry forward is everything that is *not* engine code: product decisions, security postures, message-shape designs, numeric thresholds validated across two build eras, legal/compliance obligations, and — most valuably — a 107-item audit of exactly how the prior build went wrong. Read a note before the prompt that consumes it; treat every number here as a default to adopt or consciously reject, not as inherited truth. Where a note and the Verger blueprint disagree, the blueprint wins and §4 below records why.

---

## 1. Index — which note feeds which build prompt

| Note file | What it specs | Prompts that consume it |
|---|---|---|
| [`STACK_AND_CONFIG.md`](./STACK_AND_CONFIG.md) | Exact dependency versions to mirror (minus Tauri), tsconfig/vite/vitest/playwright configs, the dark "booth" theme tokens verbatim, `.gitignore`/`.env.example` contract, CI/release/supply-chain/dependabot workflows, `src/` layering and the one-`index.html`-three-window-kinds routing trick | **1**, 10 |
| [`OPS_AND_UPDATE.md`](./OPS_AND_UPDATE.md) | First-run wizard (5 steps), service-day operator flow, Emergency Recovery text, ADR-010 electron-updater/electron-builder spec, Electron Fuses + ASAR hardening, licensing API (Workers/D1/HMAC/offline grace), the "empty env = degraded, never crash" rule | **1**, 9, **10** |
| [`PROTOCOL.md`](./PROTOCOL.md) | Blueprint PART 3 Electron IPC contract (`rhema:*` channel registry, `safeHandle` 6-step wrapper, coded errors), the as-built remote WS/REST envelope + command/event catalogs, CSP/navigation/permission hardening, message caps and coalescing, RBAC models | **1**, **2**, 3, 9 |
| [`NETWORK_AND_HARDWARE.md`](./NETWORK_AND_HARDWARE.md) | Port table, loopback-first bind posture, hashed-token + TOFU-TLS auth pipeline, firewall/VLAN guidance, Lite/Standard/Pro tier matrix and RAM auto-detection, streaming bitrate guard, tier downgrade gap | **2**, 5, 7, 10 |
| [`SHORTCUTS_AND_A11Y.md`](./SHORTCUTS_AND_A11Y.md) | Complete keyboard map, exact hold/tap thresholds, the "holds not taps" reasoning (BAINBRIDGE-4 / KAHNEMAN-2 / FITTS-3), PANIC semantics and the ESC-regression incident, remappability rules, Stream Deck / pedal transport, WCAG 2.1 AA operator-UI scope + contrast + hit-target numbers | **3**, 9, **10** |
| [`BLUEPRINT_V34_EXTRACTS.md`](./BLUEPRINT_V34_EXTRACTS.md) | `ScriptureNER` shape + confidence math + 8 required test cases + ReDoS hardening, CCLI compliance rules (SongSelect API retired), `schedule_items`/`macros`/`looks` schemas, 6-layer render model, streaming/encoder ladder, failure-mode and performance-budget numbers, post-service summary generator | 4, 5, **6**, **8**, 9 |
| [`LEGAL_AND_CONTENT.md`](./LEGAL_AND_CONTENT.md) | 17-row obligations tracker, the 6-step seed PD-verification process + PR checklist, the KRV legal-hold quarantine mechanism, licensed-API attribution, NOTICE/LICENSE bundling, EULA section-by-section UI obligations, the content-filter lesson | 4, 6, **8**, **10** |
| [`ASR_PIPELINE.md`](./ASR_PIPELINE.md) | Two-tier Whisper scheduler, Silero VAD thresholds + v5 I/O gotcha, HallucinationFilter rules, scripture confidence bands (canonical set), the never-auto-show-unless-resolved gate, SlideMind gates, model registry + SHA-256 pin pattern, GPU/CPU tiering, audio format | **7**, **8** |
| [`PLAN_LESSONS.md`](./PLAN_LESSONS.md) | Sandbox-child-process import pattern + PPTX/XLSX/DOCX/PDF parsing notes + the open per-slide-image bug, `CueContent`/`MediaCue`/`Playlist` shapes and mutation semantics, @dnd-kit pattern, 2-tier Bible detector + SlideMind decision order + human-always-wins mechanism, 50 lower-third templates + auto-injection routing, theological entities, watchdog/PANIC state machines, **all 107 PROBLEMS.md items** | 3, **6**, **8**, **9**; audit section applies to all 10 |
| [`I18N.md`](./I18N.md) | i18next/react-i18next wiring verbatim, directory layout, namespace-per-surface key convention, `{{var}}` interpolation, RTL mechanics, the `en-XA` pseudo-locale transform, the `labelKey`-on-static-array pattern, the CI gap, and the correction that **no Korean UI locale exists in v2** | **1**, **10** |

---

## 2. Cross-cutting invariants

These hold across the whole build. Each appears in multiple notes and/or is a Standing Rule in `verger_build_prompts.md`. Violating one is a defect regardless of which prompt is running.

### 2.1 Human always wins
Every automated action is overridable in one tap; assist mode is the default; auto-fire is opt-in per cue. v2 supplies the concrete, tested mechanism: the AI engine **never writes the authoritative slide state**. `engine.sync_current_slide(app_slide, now_ms)` runs *first* on every pipeline tick; any external/manual change snaps the engine's internal pointer, **resets the dwell clock to zero**, and **clears any pending recommendation** (`PLAN_LESSONS.md` Phase 06). Corollaries: manual override always wins regardless of AI state (`ASR_PIPELINE.md` §6); PANIC recovery deliberately does **not** auto-re-enable the AI director — the operator must re-engage it (`PLAN_LESSONS.md` Phase 19); the max-dwell failsafe is the one thing that fires regardless of mode, so a service can never get permanently stuck. Build the engine so it *emits intent* and something else applies it.

### 2.2 Always-on local recording
Whenever streaming starts, OBS local recording starts too, and it is never optional (`BLUEPRINT.md` §5, Standing Rule 3, Prompt 5). This is a Verger-native invariant — v2 had no OBS — but it is the direct descendant of v2's streaming resilience rules: auto-reconnect with exponential backoff, buffer up to 3s during reconnect, every drop surfaced in the post-service report, and **"NEVER silently stop streaming"** (`BLUEPRINT_V34_EXTRACTS.md` §7). The END sequence must stop recording only as an explicit, held-confirm operator action.

### 2.3 Loopback-first networking
Default `bindAddress = "127.0.0.1"`, `remoteEnabled = false`. LAN exposure requires **both** a boolean flip **and** a concrete interface IP — there is no code path that binds a wildcard `0.0.0.0` (`NETWORK_AND_HARDWARE.md` §2, Standing Rule 7). In Node terms: always pass the host explicitly to `server.listen()` / `new WebSocketServer({ host })`; never omit it (it defaults to all interfaces) and never hardcode `0.0.0.0`. If a remote surface is ever added, preserve the request pipeline order — **Host allow-list → Origin allow-list → token auth → RBAC → rate limit** — because the DNS-rebinding and CSWSH defenses must run *before* auth, not after; v2 shipped without them and its own audit marked that as the top unmitigated threat (`PROTOCOL.md` §4 #28/#29/#48).

### 2.4 Never emit bulk copyrighted text
Two distinct rules that share a root:
- **Build-time:** never prompt an agent to *output* bulk scripture/lyrics/large copyrighted text — the API content filter blocks it regardless of public-domain status and kills the agent. Route bulk text through files (downloaded or pre-validated seed JSON) and load it in code; agents write loader code plus tiny fixtures only. This killed a v2 phase dispatch once already (`PLAN_LESSONS.md`, `LEGAL_AND_CONTENT.md` §7).
- **Runtime:** verse text is **never** produced by a generative model. `ScriptureNER` emits only a *reference*; text is resolved from a licensed API or a verified-PD local source. Unresolvable → show the reference plus "verse text unavailable", never invented text. The auto-show gate is one function with three required conditions (`mode === 'auto' && confidence > 0.95 && verseResolved`), not scattered checks. This is stated in the EULA as a product guarantee, so the code must make it true by construction (`ASR_PIPELINE.md` §5, `LEGAL_AND_CONTENT.md` §6 EULA §3, `BLUEPRINT_V34_EXTRACTS.md` §1). Anything with unclear PD status stays quarantined by filename at the loader **and** hidden from the picker UI, with a standing regression test.

### 2.5 Empty env key = degraded, never crash
Every secret lives in gitignored `.env` with its key name mirrored into `.env.example` at an empty value; an empty value means "run this subsystem in not-configured mode" (Standing Rule 5, `STACK_AND_CONFIG.md` §10). v2's implementation of this is the one part of its cloud layer that was genuinely well designed: every subsystem boots to a typed `NotConfigured` state and the app runs fully offline with an empty `.env` (`OPS_AND_UPDATE.md` §7). Mirror the `UpdaterStatus`/`LicenseStatus` discriminated-union pattern in TypeScript and gate the renderer UI on it. Related: no required env var may hard-crash the app, and the offline-first requirement is CI-testable — sever the network and assert a full service runs end to end (`BLUEPRINT_V34_EXTRACTS.md` §8).

### 2.6 Holds, not taps
Hand-back-control must be non-destructive and instantly reachable; anything destructive must require a deliberate hold that **cannot complete in under ~1.5s** (KAHNEMAN-2), and must be physically distant from primary actions (FITTS-3). Concretely: `ESC` held 2s disables AI only and leaves output untouched; a *separate* on-screen "Clear All" held 2s is the only control that clears live output; PANIC is `SPACE` held 3s and **never cuts video, stream, or recording**. v2 shipped a version where plain single-tap ESC instantly cleared overlays — its own audit (#86/#105) records that the docs and code agreed with each other while both violated the design rules (`SHORTCUTS_AND_A11Y.md` §2/§6). Build hand-back-control and destructive-clear as structurally separate code paths so they cannot re-merge under refactoring, and apply hold-to-confirm to *every* destructive single-key action, not just the flagship one.

### 2.7 OBS is the engine; the app is a convenience layer
If the app crashes, OBS keeps streaming and recording; on relaunch the app **reconnects to OBS's current state** rather than assuming it owns it (`BLUEPRINT.md` §2/§9, Standing Rule 2, Prompts 5 and 9). v2's equivalent invariant was "render thread sacred (never panics, re-serves last frame)" and the chaos-test requirement that **"the congregation output never goes black unrecoverably"** (`SHORTCUTS_AND_A11Y.md` §4). Two v2 lessons apply directly: (a) v2 left the PANIC→safe-frame swap as a deferred, unwired gap — Verger must wire the equivalent (overlay swaps to logo/last-good state) in the same change that adds the PANIC flag, not later; (b) the overlay server keeps last-known state per layer and re-sends it on reconnect, so a crashed browser source re-syncs itself (Prompt 2, tested in Prompt 9).

---

## 3. Two more rules worth treating as invariants

Not on the original list, but they recur in enough notes to belong here:

- **One validated boundary, from handler #1.** v2 shipped ~150 IPC commands with zero sender validation, zero schema validation, zero RBAC, and never retrofitted the wrapper (`PLAN_LESSONS.md` audit #19–#25). Build the `safeHandle` equivalent — sender-origin check (treat a null `senderFrame` as rejection), Zod parse, session lookup, permission check, token-bucket rate limit on destructive channels, try/catch → coded error — before the second handler exists. Errors return `{ ok: false, error: CODE }`, never throw across a process boundary (`PROTOCOL.md` §2.4).
- **Docs and code agreeing is not the same as being right.** v2's worst drift (#104, #105) was self-consistent: docs matched code, both diverged from the governing spec. Diff both against `BLUEPRINT.md` periodically, keep one shared `protocol.ts` whose Zod schemas *are* the types, and pick each port/contract exactly once.

---

## 4. Contradictions & open questions

Where the notes disagree with each other, with the v2 blueprint, or with Verger's simplifications — and which wins.

| # | The disagreement | Winner for Verger |
|---|---|---|
| 1 | **Scripture confidence bands.** Blueprint v3.4 (Electron era): fuzzy band 0.70–0.95, discard below 0.70. Later Rust era: 0.95 / 0.65 / 0.50, discard below 0.50. (`BLUEPRINT_V34_EXTRACTS.md` §1 vs `ASR_PIPELINE.md` §4) | **0.95 / 0.65 / 0.50 / discard <0.50.** Later, more precisely specified, and actually shipped and tested. The raw `ScriptureNER` scoring rubric (0.98/0.95/0.65/0.50/0.40) is consistent across both and is not in dispute. |
| 2 | **ESC semantics.** `GETTING_STARTED.md` (via `OPS_AND_UPDATE.md` §2) documents "ESC = clear all overlays". `SHORTCUTS.md` (via `SHORTCUTS_AND_A11Y.md` §1) documents "ESC hold 2s = disable AI only; SHIFT+ESC dismisses lower thirds; Clear All is a separate held on-screen button". | **`SHORTCUTS_AND_A11Y.md` wins.** It post-dates the audit that flagged the other behavior as a blueprint violation (#86/#105). The OPS keymap is the *bug*, preserved verbatim in an unfixed doc. |
| 3 | **Caption-server bind address.** `NETWORK_AND_HARDWARE.md` §2: 8765 binds `127.0.0.1` unconditionally, always. `ASR_PIPELINE.md` §7: the bind was deliberately changed 127.0.0.1 → `0.0.0.0` so attendee phones could reach it, and that is the shipped behavior. | **Neither, as written.** Attendee captions are outside Verger's Phase 0–4 scope. If ever built: honor Standing Rule 7 — explicit opt-in plus a concrete LAN IP, never a wildcard bind — and unify its auth with the main token model rather than reproducing v2's second, unmigrated HS256-JWT domain. |
| 4 | **Port 8420.** `PROTOCOL.md` §4 finds it in PROBLEMS.md #104 with no explanation. `NETWORK_AND_HARDWARE.md` §1 identifies it as a vestigial `NetworkSettings.control_port` field never wired to any listener. | **`NETWORK_AND_HARDWARE.md` wins — it is a phantom.** Do not add a control port to Verger's settings schema. Operator control is Electron IPC and must never be a TCP socket. Likewise do not resurrect 3001. |
| 5 | **Which port numbers at all.** v2 canonical is 7320 (WS) / 7321 (REST); shipped code drifted to 8420/3001/8765/3002 (#104). Verger needs exactly one overlay HTTP server + one control WebSocket. | **Pick once, document once, in one file.** Reusing 7320/7321 avoids inventing new numbers and matches any future Stream Deck work; whatever is chosen, a single constants module is the source of truth for code *and* `docs/OBS_SETUP.md`. Vite's 1420/1421 are a Tauri convention with no meaning for Electron — don't let anything hardcode them. |
| 6 | **Message envelope shape.** v2 has three incompatible designs: flat named IPC channels (never built), flat `{ type: 'slide:next', requestId }` (never built), and the shipped `{ type: 'command'\|'event'\|'state'\|'preview'\|'error', ... }` whose secondary key name *changes with the type* and whose `error` has no payload wrapper at all. | **One discriminated union, stable discriminant, `payload` always present, coded errors.** Per `PROTOCOL.md` Verger note 2. Shared Zod schemas in one `protocol.ts` imported by main, renderer, and overlay. |
| 7 | **Event naming.** Shipped v2 mixes PascalCase (`SlideAdvanced`, `BibleReferenceDetected`) with colon-namespaced lowercase (`slide:live`, `dmx:scene:fired`) in the same stream. The IPC registry is consistently `rhema:<domain>:<action>`. | **Adopt `verger:<domain>:<action>` for channels.** Keep v2's *event names* as a checklist of what the engine must be able to tell the UI (Prompt 2 explicitly reuses `SlideAdvanced` / `BibleReferenceDetected`), but normalize the casing convention. |
| 8 | **RBAC.** v2 has a 4-tier ladder (Volunteer/Operator/Director/Admin) *and* a functional-role matrix (Supervisor/Presentation/Camera/Lighting/Stream/ReadOnly), bridged only at the remote-API boundary and enforced nowhere else (#51). | **Verger is single-operator — build no RBAC now.** But keep exactly one enforcement point in the IPC wrapper so a role check can be added in one place later. Never grow a second "convenience" role model around one surface. |
| 9 | **Stream Deck PANIC gesture.** v2's plugin scaffold used **double-tap**; the keyboard uses a **3-second hold**. A double-tap can complete well under KAHNEMAN-2's 1.5s System-2 floor. | **Hold-to-fire everywhere.** Same gesture semantics on keyboard, pedal, and any control surface. A pedal should emit the same key codes so the existing tap/hold state machine handles it for free (Prompt 3 → Prompt 10). |
| 10 | **Runtime.** Blueprint ADR-001 mandated Electron; v2 built Tauri and reversed it in ADR-001B, never writing the swap ADR. | **Electron, per Verger's locked decisions.** Consequence to internalize: blueprint PART 3 (IPC contract), PART 10.4 (Fuses/ASAR), CSP/navigation lockdown, and the `safeStorage` Linux `basic_text` caveat are **fresh, unexercised specs written for exactly Verger's runtime** — high-value, but not battle-tested carryover. Conversely, all v2 hardware protocol work (NDI/DMX/VISCA in Rust) has no portable equivalent. |
| 11 | **Updater env var.** Blueprint Appendix B: `RHEMA_UPDATE_URL` (a *base* URL). Shipped v2: `RHEMA_UPDATE_MANIFEST_URL` (a *full* URL to one `latest.json`). | **Base URL, `electron-updater` generic provider.** `autoUpdater.setFeedURL({ provider: 'generic', url })` with `electron-builder` generating the per-platform YAML — no bespoke manifest parser needed. Record the decision in an ADR rather than inheriting the ambiguity. |
| 12 | **Update signature verification.** v2 pinned a minisign pubkey (`RHEMA_UPDATER_PUBKEY`) because `tauri-plugin-updater` verifies it natively. `electron-updater` instead relies on OS code-signing (Authenticode / notarization) plus HTTPS. | **OS code-signing is the primary control; drop the pubkey env var unless a deliberate defence-in-depth decision is made.** Either way, decide explicitly — a pubkey whose verification path doesn't exist is worse than none. Also: versioned CDN paths (`/stable/{version}/`) over v2's flat overwrite-in-place `latest.json`, and design rollout/rollback deliberately — v2 has neither. |
| 13 | **Korean.** The brief assumed v2 had EN/KO locales. It does not: `SUPPORTED_LOCALES` is `['en','ar','he']`, only `en.json` exists, and `ar`/`he` have picker entries + RTL mechanics but no translations. Blueprint v3.4 contains no Korean product handling at all (only payments/business context). | **Korean operator UI is net-new work, not a port** (`I18N.md`). But the real Korean prior art *does* exist elsewhere and should be used: bilingual Bible-reference regex including `장`/`절` forms, and EN+KO verbal trigger phrase lists (`PLAN_LESSONS.md` Phase 06) feed Prompt 8 directly. Keep "Korean *content* locale" and "Korean *UI chrome* locale" as separately tracked concerns. |
| 14 | **Pseudo-locale CI.** Blueprint 13.3 and `docs/I18N.md` both claim pseudo-localization runs in CI. `ci.yml` has no such step, and there is no ESLint config in the repo at all. | **The claim is false; the gap is real.** Prompt 10 must actually wire it (`i18n:check` script + CI step), and Prompt 1 should add `eslint-plugin-i18next`'s literal-string rule at scaffold time — retrofitting onto 100+ components is exactly what left v2 at ~6/100 converted. |
| 15 | **Lower-thirds prior art.** `BLUEPRINT_V34_EXTRACTS.md` §5 concludes no lower-third data model exists. `PLAN_LESSONS.md` Phase 07 documents 50 templates with a full schema, animation math, and auto-injection routing. | **Both are correct about their own source.** The blueprint doesn't spec it; the implementation did. **`PLAN_LESSONS.md` Phase 07 is the spec for Prompt 3** — normalized 0.0–1.0 layout coords, `FieldDefinition` shape, in/out animation with derived hold time, and the `generation`-id guard against stale auto-dismiss timers. |
| 16 | **OBS / YouTube prior art.** `BLUEPRINT_V34_EXTRACTS.md` §6/§7 confirm v2 had **no** obs-websocket integration (OBS appears only as an NDI receiver in a QA harness) and **no** YouTube Data API integration (streaming was generic FFmpeg→RTMP). | **Nothing to mine — Prompts 4/5 are entirely net-new.** Stop looking for prior art there. What *is* reusable: the CCLI streaming-license gate, the 2s keyframe interval as a YouTube ingest requirement, the bitrate ladder, and the upstream-bandwidth pre-flight guard. |
| 17 | **Bitrate numbers.** `NETWORK_AND_HARDWARE.md` §10 gives an upload-bandwidth *guard* (<5 Mbps → 480p@2 Mbps; <10 Mbps → 720p@5 Mbps, nothing above 10). `BLUEPRINT_V34_EXTRACTS.md` §7 gives an encoder *ladder* (1080p30 4500 / 1080p60 6000 / 720p30 2500 kbps). | **Not actually contradictory — different layers.** In Verger, **OBS owns encoding**, so both become pre-flight advice and settings copy, not app-controlled encoder config. The gap above 10 Mbps is genuine; Verger defines its own 1080p rung or defers to OBS's existing profile. |
| 18 | **Hardware tiers.** v2's Lite/Standard/Pro (8/16/32 GB) gate AI features and parallel inference. Verger's default ASR is **cloud Deepgram**, and OBS — not the app — does compositing and encoding. | **Do not inherit the tier system wholesale.** The RAM-detection thresholds remain useful for one narrow decision: whether the *local* faster-whisper adapter is viable on this machine (Prompt 7). Also fix v2's admitted downgrade gap — actively disable orphaned settings rather than "preserving them inactive". |
| 19 | **Local ML model registry.** `config/models.json` hash-pins 14–15 models, but **every `sha256` is currently empty**, i.e. every model is unpinned pass-with-warning. | **Keep the three-outcome rule** (match → load; mismatch → **refuse**; unknown or empty pin → load with warning) for Prompt 7's local adapter, and don't bundle weights in the installer. Two license flags carry over hard: never default to **YOLOv8/Ultralytics (AGPL-3.0)** for any detection, and **NLLB is CC-BY-NC-4.0** (non-commercial only). |
| 20 | **Entity count.** `PLAN.md` says 556 theological entities; the on-disk files total 585. | **585** (on-disk count is ground truth). Minor, but symptomatic — two numbers in one repo disagreed and nothing caught it. |
| 21 | **Coverage thresholds.** v2's vitest coverage thresholds are `0/0/0/0` with a comment promising to ratchet them; they never were. | **Pick real numbers in Prompt 1** or explicitly record that coverage is measured but unenforced. Don't silently inherit the placeholder. |
| 22 | **E2E scope.** v2's Playwright config drives the renderer over `vite preview` only and never the native shell; native-shell E2E was "tracked as a follow-up" and never landed. CI never ran Playwright at all. | **Use Playwright's `_electron.launch()` from the start** (Prompt 10) — it drives the real Electron window and IPC, and is simpler for Electron than the Tauri equivalent ever was. This closes a real v2 gap rather than reproducing it. |
| 23 | **Out-of-scope numbers.** Many precise v2 figures cover DMX/ArtNet/sACN, VISCA PTZ, NDI, multi-campus, biometrics, and the native compositor — all explicitly **out** of Verger's blueprint. | **Recorded in §5 for completeness and marked out-of-scope.** If one starts looking tempting, it is a post-1.0 extension, not a Phase 0–4 requirement. |
| 24 | **Rate-limit numbers.** `safeHandle` uses 20 ops / 5 s per session on destructive channels; the remote API uses 100 req/min per token. | **Not a conflict — different surfaces.** The IPC bucket limits *operator-initiated commands only* and must never throttle internal loops that don't traverse IPC. |
| 25 | **PPTX per-slide images.** v2's importer always returns an empty `image_paths` per slide because `ppt/slides/_rels/slideN.xml.rels` is never parsed — a documented, still-open bug. | **Fix it on first implementation** (Prompt 6). Parse the slide `_rels` to map `r:embed` IDs to `ppt/media/*`. Inheriting a known-broken behavior is the one thing worse than reimplementing it. |

**Still genuinely open** (no source resolves these; decide deliberately): whether Verger keeps v2's dark-only ERGO-1 constraint and `overflow:hidden; user-select:none` kiosk body styling; whether the caption/attendee surface exists at all; what the checkpoint-recovery (CTRL+D) persistence format is — v2 documents only "~10 seconds of AI state" with no schema anywhere; whether a foot pedal is HID-key-emulation (recommended, zero new gesture code) or a distinct device layer — v2 has **no** pedal documentation of any kind; and the exact boundary inclusivity at 0.95 for auto-advance (v2 settled on `>= 0.80` recommend, `> 0.95` auto, leaving the point 0.95 itself deliberately unresolved).

---

## 5. Numbers cheat-sheet

Every concrete figure across the ten notes. **Scope column:** ✅ = adopt for Verger · ⚠️ = adopt with a decision (see §4) · ❌ = out of Verger's blueprint scope, recorded for completeness only.

### 5.1 Input, timing & safety UX

| Figure | Value | Scope | Source |
|---|---|---|---|
| SPACE tap → advance | < 300 ms | ✅ | SHORTCUTS_AND_A11Y |
| SPACE hold → PANIC | > 3000 ms | ✅ | SHORTCUTS_AND_A11Y |
| ESC hold → disable AI only | 2000 ms | ✅ | SHORTCUTS_AND_A11Y |
| "Clear All" hold → clear output | 2000 ms | ✅ | SHORTCUTS_AND_A11Y |
| KAHNEMAN-2 System-2 floor | action must not complete in < 1.5 s | ✅ | SHORTCUTS_AND_A11Y |
| Test assertion: press < 2 s must NOT trigger Clear All | 2 s | ✅ | SHORTCUTS_AND_A11Y |
| CTRL+D checkpoint rewind | ~10 s of AI state | ⚠️ | SHORTCUTS_AND_A11Y, OPS_AND_UPDATE |
| "Clear All" hold required even via API | 2 s | ✅ | BLUEPRINT_V34_EXTRACTS (T9) |
| Post-override "accept suggestion" target enlarges | ~10 s (FITTS-4) | ✅ | SHORTCUTS_AND_A11Y |
| Advance→go-live→advance loop cadence assumption | repeats every 2–5 min (FITTS-2) | ✅ | SHORTCUTS_AND_A11Y |

### 5.2 Accessibility, hit targets & theme

| Figure | Value | Scope | Source |
|---|---|---|---|
| Primary button min hit target (FITTS-1) | 48 × 48 px @ 96 dpi | ✅ | SHORTCUTS_AND_A11Y |
| Go Live / Clear min hit target | 64 × 64 px | ✅ | SHORTCUTS_AND_A11Y |
| Clickable thumbnails (GESTALT-2) | 64 × 64 px, 6 px radius | ✅ | SHORTCUTS_AND_A11Y |
| v2's shipped violation (anti-pattern) | 28 × 28 px PTZ buttons | ❌ (don't repeat) | SHORTCUTS_AND_A11Y |
| Primary text contrast (ERGO-2) | ≥ 7:1 (AAA) | ✅ | SHORTCUTS_AND_A11Y |
| Status-indicator contrast floor | 3:1 | ✅ | SHORTCUTS_AND_A11Y |
| Measured: `#e5e7eb` on `#0a0a0f` | 15.95:1 | ✅ | SHORTCUTS_AND_A11Y |
| Measured: `#9ca3af` on `#1a1a26` | 6.78:1 (just under AAA) | ✅ | SHORTCUTS_AND_A11Y |
| Measured: accent `#6366f1` on `#0a0a0f` | 4.42:1 — never body text alone | ✅ | SHORTCUTS_AND_A11Y |
| Theme tokens | bg `#0a0a0f` · surface `#12121a` · surface-2 `#1a1a26` · accent `#6366f1` · hover `#4f46e5` · accent-2 `#818cf8` · panic `#ef4444` · live `#22c55e` · text `#e5e7eb` · muted `#9ca3af` · border `#242433` | ⚠️ | STACK_AND_CONFIG |
| Card / panel radii | 14 / 16 / 18 px | ⚠️ | STACK_AND_CONFIG |
| Backdrop blur | 0 px (flat, despite `glass-*` naming) | ⚠️ | STACK_AND_CONFIG |
| Reduced-motion override | all durations → 0.01 ms, iteration count 1 | ✅ | STACK_AND_CONFIG |
| Macro quick-trigger panel cap (MILLER-2) | exactly 8 per page (2×4) | ❌ | BLUEPRINT_V34_EXTRACTS |
| Default alert tone | 880 Hz, 100 ms, repeated ×2 | ⚠️ | BLUEPRINT_V34_EXTRACTS |
| Post-service summary must appear within | 30 s of service end | ⚠️ | BLUEPRINT_V34_EXTRACTS |

### 5.3 ASR pipeline

| Figure | Value | Scope | Source |
|---|---|---|---|
| Draft tier cadence / latency | every ~500 ms / ~150 ms | ✅ | ASR_PIPELINE |
| Final tier cadence / latency | every ~5 s / ~2.5 s on CPU | ✅ | ASR_PIPELINE |
| Verger blueprint partial cadence | every ~200–500 ms | ✅ | BLUEPRINT.md §4 |
| Final replaces draft | in place, no merge/diff | ✅ | ASR_PIPELINE |
| VAD open | prob > 0.5 for 2 consecutive chunks | ✅ | ASR_PIPELINE |
| VAD close | prob < 0.35 for 8 consecutive chunks | ✅ | ASR_PIPELINE |
| VAD pre-roll retained | 500 ms | ✅ | ASR_PIPELINE |
| Audio format | 16 kHz mono PCM throughout | ✅ | ASR_PIPELINE |
| Capture buffer | 512 samples = 32 ms | ✅ | ASR_PIPELINE |
| ASIO buffer (general audio ADR) | 64–256 samples (1.5–5.8 ms @ 44.1 kHz) | ⚠️ | ASR_PIPELINE |
| Hallucination filter carve-out | preserve ≤ 3 liturgical repeats, collapse longer runs | ✅ | ASR_PIPELINE |
| Max utterance staging cap | 30 s | ✅ | ASR_PIPELINE |
| Extra caption target language cost | ~50 ms each | ⚠️ | ASR_PIPELINE, NETWORK_AND_HARDWARE |
| Model sizes | tiny ~37–38.8 MB · small ~244 MB · large-v3 ~375–393 MB · Silero VAD 2,327,524 B · MiniLM-L6 ~23 MB · NLLB-600M ~629 MB | ⚠️ | ASR_PIPELINE |
| Whisper-via-ONNX download footprint | ~500 MB | ⚠️ | NETWORK_AND_HARDWARE |

### 5.4 Confidence, detection & cue engine

| Figure | Value | Scope | Source |
|---|---|---|---|
| `ScriptureNER` full book name | 0.98 | ✅ | BLUEPRINT_V34_EXTRACTS, ASR_PIPELINE |
| `ScriptureNER` explicit abbreviation | 0.95 | ✅ | both |
| `ScriptureNER` Levenshtein-1 | 0.65 | ✅ | both |
| `ScriptureNER` Levenshtein-2 | 0.50 | ✅ | both |
| `ScriptureNER` spoken form (no verse no.) | 0.40 | ✅ | both |
| **Canonical bands** | ≥0.95 auto-queue · 0.65 show with `?` · 0.50 show with `?` · **< 0.50 discard** | ✅ | ASR_PIPELINE |
| Superseded bands (do not use) | >0.95 auto · 0.70–0.95 fuzzy · <0.70 discard | ❌ (see §4 #1) | BLUEPRINT_V34_EXTRACTS |
| Auto-show gate | `mode==='auto'` **AND** confidence > 0.95 **AND** verse resolved | ✅ | ASR_PIPELINE |
| Fatigue exception (after 90 min) | *suggest* threshold 0.80 → 0.70; auto-show stays fixed at > 0.95 | ✅ | ASR_PIPELINE |
| SlideMind recommend | ≥ 0.80 (inclusive lower bound) | ✅ | ASR_PIPELINE, NETWORK_AND_HARDWARE |
| SlideMind auto-advance | > 0.95 (exclusive) | ✅ | same |
| Bible detector Tier 1 (regex, EN+KO) | confidence 0.98 | ✅ | PLAN_LESSONS |
| Bible detector Tier 2 (Aho-Corasick entity/alias) | confidence 0.82 | ✅ | PLAN_LESSONS |
| `SemanticSlideMatcher` default threshold | 0.75 cosine (test: known lyric > 0.80) | ✅ | ASR_PIPELINE, BLUEPRINT_V34_EXTRACTS |
| FAISS search | `k=5`; < 5 ms for < 50,000 vectors | ⚠️ | ASR_PIPELINE |
| Embedding inference | < 50 ms per 5 s segment (MiniLM-L6 INT8 CPU) | ⚠️ | ASR_PIPELINE |
| Transcript → slide-match budget | < 500 ms on an Intel i5 | ✅ | ASR_PIPELINE |
| SlideMind rolling window | 10,000 ms | ✅ | PLAN_LESSONS |
| SlideMind min dwell | 8,000 ms | ✅ | PLAN_LESSONS |
| SlideMind max dwell failsafe | 120,000 ms (fires regardless of mode) | ✅ | PLAN_LESSONS |
| SermonIntelligence context window | 60,000 ms | ⚠️ | PLAN_LESSONS |
| Same-entity re-suggest suppression | 30,000 ms | ⚠️ | PLAN_LESSONS |
| Entity suggestion threshold | 0.45 cosine (soft, operator-confirmed only) | ⚠️ | PLAN_LESSONS |
| Salient-alert requirement | any AI decision < 0.80 needs a *qualitatively* different visual+audible cue | ✅ | BLUEPRINT_V34_EXTRACTS |
| SRK-3 "surface the rule" trigger | AI confidence < 60% | ✅ | BLUEPRINT_V34_EXTRACTS |
| Verger blueprint per-cue example | `autoFireThreshold: 0.82` | ✅ | BLUEPRINT.md §7 |
| Theological entity corpus | 585 across 6 seed files (102/98/96/103/97/89) | ⚠️ | PLAN_LESSONS |

### 5.5 Ports, protocol & limits

| Figure | Value | Scope | Source |
|---|---|---|---|
| Remote control WebSocket | 7320 | ⚠️ | NETWORK_AND_HARDWARE, PROTOCOL |
| REST API | 7321 | ⚠️ | same |
| Caption WS | 8765 | ❌ | same |
| Campus sync WS | 3002 | ❌ | NETWORK_AND_HARDWARE |
| Legacy remote alias (loopback-only) | 3001 | ❌ (do not resurrect) | both |
| Phantom "control port" | 8420 — never wired to a listener | ❌ (do not resurrect) | NETWORK_AND_HARDWARE |
| ArtNet / sACN | 6454 / 5568 UDP | ❌ | NETWORK_AND_HARDWARE |
| NDI | 5353–5368 UDP | ❌ | NETWORK_AND_HARDWARE |
| RTMP / SRT outbound | 1935 TCP / 10080+ UDP | ✅ (firewall doc) | NETWORK_AND_HARDWARE |
| Vite dev / HMR (Tauri convention only) | 1420 / 1421 | ❌ | STACK_AND_CONFIG |
| Per-token rate limit | 100 req/min → 429 + `Retry-After` | ⚠️ | PROTOCOL, NETWORK_AND_HARDWARE |
| IPC destructive-channel bucket | 20 ops / 5 s per session | ✅ | PROTOCOL |
| IPC schema-validation budget | < 1 ms | ✅ | PROTOCOL |
| IPC message size cap | 256 KB per payload | ✅ | PROTOCOL |
| High-frequency push coalescing | keep-latest, flush ≤ 10 Hz (`status:update` ~5 Hz); slide/AI events **never** coalesced | ✅ | PROTOCOL |
| WS heartbeat | ping every 10 s, pong within 5 s | ⚠️ | PROTOCOL, ASR_PIPELINE |
| WS close codes | 4001 auth reject · 4002 heartbeat timeout | ⚠️ | PROTOCOL |
| Max simultaneous WS clients | 64 (tunable) | ⚠️ | PROTOCOL |
| Pairing token | 256-bit random; only SHA-256 hash stored; timing-safe compare; shown once | ⚠️ | PROTOCOL, NETWORK_AND_HARDWARE |
| Remote privilege elevation TTL | 60 minutes | ❌ | PROTOCOL |
| Remote state broadcast loop | ~100 ms (disabling remote saves it) | ⚠️ | NETWORK_AND_HARDWARE |
| Internet-facing caption rate limit | max 100 connections/min per IP | ❌ | NETWORK_AND_HARDWARE |
| REST endpoint count spec'd | 24 routes | ❌ | PROTOCOL |
| IPC error codes | `INVALID_SENDER` · `INVALID_PAYLOAD` · `NO_SESSION` · `FORBIDDEN` · `RATE_LIMITED` · `INTERNAL_ERROR` | ✅ | PROTOCOL |

### 5.6 Hardware tiers & streaming

| Figure | Value | Scope | Source |
|---|---|---|---|
| Tier RAM thresholds | Lite 8 GB · Standard 16 GB · Pro 32 GB+ | ⚠️ | NETWORK_AND_HARDWARE |
| RAM auto-detection mapping | < 8 GB → Lite (warn) · 8–15 → Lite · 16–31 → Standard · 32+ → Pro | ⚠️ | NETWORK_AND_HARDWARE |
| CPU cores per tier | quad-core / 6+ / 12+ | ⚠️ | NETWORK_AND_HARDWARE |
| Parallel inference tasks | Lite 0–1 · Standard 1 (strict FIFO) · Pro 4+ | ⚠️ | NETWORK_AND_HARDWARE, ASR_PIPELINE |
| Displays per tier | 2 / 4 / unlimited | ❌ | NETWORK_AND_HARDWARE |
| Upstream bandwidth per tier | 2 / 5 / 10+ Mbps | ✅ | NETWORK_AND_HARDWARE |
| LAN bandwidth per tier | 20 / 50 / 100 Mbps | ⚠️ | NETWORK_AND_HARDWARE |
| Pro GPU | 6+ GB VRAM, RTX 3060+ class, target < 5 ms inference | ⚠️ | NETWORK_AND_HARDWARE |
| Bitrate guard: upload < 5 Mbps | cap 480p @ 2 Mbps | ✅ | NETWORK_AND_HARDWARE |
| Bitrate guard: upload < 10 Mbps | cap 720p @ 5 Mbps | ✅ | NETWORK_AND_HARDWARE |
| Encoder ladder | 1080p30 → 4500 kbps · 1080p60 → 6000 · 720p30 → 2500 | ⚠️ (OBS owns it) | BLUEPRINT_V34_EXTRACTS |
| Keyframe interval | 2 s (YouTube/Facebook ingest requirement) | ✅ | BLUEPRINT_V34_EXTRACTS |
| Stream audio | AAC-LC 128–160 kbps | ⚠️ | BLUEPRINT_V34_EXTRACTS |
| Upstream pre-flight guard | warn if measured upstream < 1.5 × target bitrate | ✅ | BLUEPRINT_V34_EXTRACTS |
| RTMP reconnect buffer | up to 3 s | ✅ | BLUEPRINT_V34_EXTRACTS |
| `streams` table defaults | 1920×1080, 4500 kbps, 30 fps | ⚠️ | BLUEPRINT_V34_EXTRACTS |
| NDI health check | < 10 ms ping to camera | ❌ | NETWORK_AND_HARDWARE |

### 5.7 Performance, resilience & failure thresholds

| Figure | Value | Scope | Source |
|---|---|---|---|
| Output frame rate | 60 fps ± 2 over any 10 s window | ❌ (OBS owns) | BLUEPRINT_V34_EXTRACTS |
| Slide go-live latency | < 100 ms from IPC receipt to first rendered frame | ✅ | BLUEPRINT_V34_EXTRACTS |
| 40-slide PPTX ingest | < 3 s to first slide visible | ✅ | BLUEPRINT_V34_EXTRACTS |
| 40-slide deck embedding | < 2 s to index updated | ⚠️ | BLUEPRINT_V34_EXTRACTS |
| Bible verse detection → suggestion panel | < 2 s | ✅ | BLUEPRINT_V34_EXTRACTS |
| Startup time | < 4 s icon click → ready to operate | ✅ | BLUEPRINT_V34_EXTRACTS |
| Memory ceiling | < 2 GB RSS per BrowserWindow; alert if main > 1.5 GB | ✅ | BLUEPRINT_V34_EXTRACTS |
| Output-window crash recovery | recreate + re-push state in < 2 s | ✅ | BLUEPRINT_V34_EXTRACTS |
| Manual mode after AI process death | active within 2 s | ✅ | SHORTCUTS_AND_A11Y, BLUEPRINT_V34_EXTRACTS |
| Operator awareness of AI failure | < 3 s | ✅ | SHORTCUTS_AND_A11Y |
| Time to manual takeover | < 10 s | ✅ | SHORTCUTS_AND_A11Y |
| Error rate, first 5 manual advances after takeover | < 20 % | ✅ | SHORTCUTS_AND_A11Y |
| Watchdog ping / timeout | 5,000 ms / 10,000 ms (2 missed beats of grace) | ✅ | PLAN_LESSONS |
| SRK-3 disk alarm | free space < 2 GB | ✅ | BLUEPRINT_V34_EXTRACTS |
| SRK-3 CPU alarm | > 85 % for > 30 s | ✅ | BLUEPRINT_V34_EXTRACTS |
| DMX refresh | 30 Hz min / 44 Hz target / never < 20 Hz | ❌ | BLUEPRINT_V34_EXTRACTS |
| VISCA round trip | < 200 ms LAN; timeout 500 ms | ❌ | BLUEPRINT_V34_EXTRACTS |
| PANIC emergency DMX | channels 1–5 = 255 on universe 1 | ❌ | PLAN_LESSONS |
| PanicPhase legal transitions | `Idle → Panicked → Recovering → Idle` only | ✅ | PLAN_LESSONS |

### 5.8 File import & media

| Figure | Value | Scope | Source |
|---|---|---|---|
| Sandbox child-process timeout | 30 s, then kill | ✅ | PLAN_LESSONS |
| Max import size | 50 MiB, checked **before** spawning the sandbox | ✅ | PLAN_LESSONS |
| Magic-byte pre-flight | first 8 bytes: `PK\x03\x04` (zip) · `%PDF-` (pdf) | ✅ | PLAN_LESSONS |
| Decompression-bomb image guard | skip images > 64 MB | ✅ | PLAN_LESSONS |
| T13 archive caps | ≤ 500 MB uncompressed, entry-count cap, ≤ 100 MP image dimensions | ✅ | BLUEPRINT_V34_EXTRACTS |
| Thumbnail size | 320 × 180 | ⚠️ | PLAN_LESSONS |
| PDF page raster width | 1280 px | ⚠️ | PLAN_LESSONS |
| Video thumbnail seek | `-ss 5`, 1 frame | ⚠️ | PLAN_LESSONS |
| @dnd-kit drag activation | `PointerSensor` distance 4 px | ✅ | PLAN_LESSONS |
| yt-dlp format selector | `best[ext=mp4][height<=1080]` | ⚠️ | PLAN_LESSONS |

### 5.9 Overlay / lower-thirds

| Figure | Value | Scope | Source |
|---|---|---|---|
| Bundled templates | 50 (≥10 speaker, ≥10 scripture, ≥5 song, ≥5 announcement asserted by test) | ✅ | PLAN_LESSONS |
| Layout coordinate space | normalized 0.0–1.0; font sizes virtual px against a 1080-tall canvas | ✅ | PLAN_LESSONS |
| Song auto-dismiss | 6,000 ms | ✅ | PLAN_LESSONS |
| Speaker auto-dismiss | 8,000 ms | ✅ | PLAN_LESSONS |
| Scripture auto-dismiss | none — holds until dismissed | ✅ | PLAN_LESSONS |
| Example template animation | fade in 600 ms / out 400 ms | ✅ | PLAN_LESSONS |
| Hold time derivation | `hold = auto_dismiss − in − out` (author sets total visible window) | ✅ | PLAN_LESSONS |
| Easing | linear (fade/wipe/reveal) · ease-out cubic `1−(1−t)³` (slide) · smoothstep `3t²−2t³` (flip) · elastic `t + sin(t·6π)(1−t)·0.3` | ✅ | PLAN_LESSONS |
| DMX scene fade defaults | 500 ms in / 500 ms out, hold −1 = until next cue | ❌ | BLUEPRINT_V34_EXTRACTS |
| Annotation layer auto-clear | 60 s without input | ❌ | BLUEPRINT_V34_EXTRACTS |

### 5.10 Ops, packaging, licensing & legal

| Figure | Value | Scope | Source |
|---|---|---|---|
| Update check delay after startup | 10 s | ✅ | OPS_AND_UPDATE |
| Squirrel first-run guard | never call `checkForUpdates()` when `--squirrel-firstrun` is in `process.argv` | ✅ | OPS_AND_UPDATE |
| Electron version floor | ≥ 27, or patched 22.3.24 / 24.8.3 / 25.8.1 / 26.2.1 (ASAR-integrity bypass fix) | ✅ | OPS_AND_UPDATE |
| Required Fuses | `runAsNode=false`, `enableNodeCliInspectArguments=false`, `enableNodeOptionsEnvironmentVariable=false`, `onlyLoadAppFromAsar=true`, `enableEmbeddedAsarIntegrityValidation=true`, `grantFileProtocolExtraPrivileges=false`, `enableCookieEncryption=true` | ✅ | OPS_AND_UPDATE, BLUEPRINT_V34_EXTRACTS |
| Never auto-restart | no forced restart during a service — notify only, apply on manual restart | ✅ | OPS_AND_UPDATE |
| License offline grace | 14 days | ⚠️ | OPS_AND_UPDATE |
| License HTTP timeout | 8 s | ⚠️ | OPS_AND_UPDATE |
| Node / npm engines | node `>=20.0.0 <25.0.0`, npm `>=10.0.0` | ✅ | STACK_AND_CONFIG |
| CI frontend job | checkout → setup-node 20 (npm cache) → `npm ci` → `tsc --noEmit` → `test:run` → `build`, 3-OS matrix | ✅ | STACK_AND_CONFIG |
| npm audit threshold | `--audit-level=high` (deliberately not `critical`) | ✅ | STACK_AND_CONFIG |
| Supply-chain cron | `17 4 * * *` daily | ✅ | STACK_AND_CONFIG |
| Dependabot | weekly/Monday, 10-PR cap, minor+patch auto-grouped | ✅ | STACK_AND_CONFIG |
| Vitest coverage thresholds in v2 | 0 / 0 / 0 / 0 (placeholder, never ratcheted) | ⚠️ | STACK_AND_CONFIG |
| Copyright statutory damages | **$750 – $150,000 per work** — the reason only verified-PD content is bundled | ✅ | LEGAL_AND_CONTENT |
| ESV API free tier | 5,000 queries/day | ✅ | BLUEPRINT_V34_EXTRACTS |
| Royalty-free quotation cap (publisher permissions) | ~500 verses / 25 % of host work | ✅ | BLUEPRINT_V34_EXTRACTS |
| Legal-hold quarantine | `LEGAL_HOLD_SEED_FILES = ["seed_ko_krv.json"]` — file stays on disk, excluded from loader **and** picker, standing regression test | ✅ | LEGAL_AND_CONTENT |
| CCLI gating points | both settings-time **and** go-live-time, plus a pre-flight missing-metadata warning | ✅ | LEGAL_AND_CONTENT |
| EULA acceptance | first-run "I Accept" gate; re-acceptance required on material change (needs version tracking) | ✅ | LEGAL_AND_CONTENT |

### 5.11 i18n

| Figure | Value | Scope | Source |
|---|---|---|---|
| Stack versions | i18next 23.16.8 · react-i18next 15.7.4 · browser-languagedetector 8.2.1 | ✅ | I18N, STACK_AND_CONFIG |
| Supported locales in v2 | `['en','ar','he']` — **no `ko`**; only `en.json` has a bundle | ⚠️ (see §4 #13) | I18N |
| RTL locales | `['ar','he','fa','ur']`, matched on base subtag | ✅ | I18N |
| Pseudo-locale code | `en-XA`, enabled via `VITE_PSEUDO_LOCALE=1` or `?pseudo=1` | ✅ | I18N |
| Pseudo padding | ~40 % of non-whitespace length, capped at 12 `·` chars, wrapped in `⟦…⟧` | ✅ | I18N |
| Accent map size | 52 entries (a–z, A–Z) | ✅ | I18N |
| v2 conversion coverage at freeze | ~6 of ~100 component files | ❌ (anti-pattern) | I18N |
| i18n unit tests | 9 pure-logic cases (pseudo transform + RTL detection) — port directly | ✅ | I18N |

---

*Ten notes, one folder, one rule: prefer the number that was validated twice, and when two sources disagree, §4 says which one wins.*
