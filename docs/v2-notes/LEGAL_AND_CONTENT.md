# Legal & Content Obligations — mined from rhema_v2
> Sources:
> - `C:\Side projects\rhema_v2\docs\LEGAL_OBLIGATIONS.md`
> - `C:\Side projects\rhema_v2\docs\SEED_COPYRIGHT_PROCESS.md`
> - `C:\Side projects\rhema_v2\EULA.md`
> - `C:\Side projects\rhema_v2\PLAN.md` (grep: "Content-filter lesson")
> - `C:\Side projects\rhema_v2\.claude\worktrees\optimistic-neumann-1b8932\src-tauri\src\bible\mod.rs` (grep: `LEGAL_HOLD_SEED_FILES` — confirmed the *only* place in the repo that string appears; used solely to verify the mechanism `LEGAL_OBLIGATIONS.md` row 7 and `SEED_COPYRIGHT_PROCESS.md` describe, not separately mined)
>
> NOTE: `src-tauri/` does **not** exist at the repo root of rhema_v2 — it only exists inside a Claude-Code worktree (`.claude\worktrees\optimistic-neumann-1b8932\src-tauri\`). Any v2 doc that cites `src-tauri/src/bible/mod.rs` as if it were a root-level path is describing a path that is not present in the mainline checkout. Treat that as a discrepancy to be aware of, not a Verger action item (Verger doesn't have `src-tauri` at all — see application notes).
>
> This note contains **no verse text, lyrics, or slide content** — process and mechanism only, per mining brief.

## 1. The obligations tracker (`docs/LEGAL_OBLIGATIONS.md`)

This file is described as a "repo-side mirror of the blueprint PART 15 obligations table (PROBLEMS.md #62)" — the definitive text lives in `Rhema_Blueprint_v3.4.md` PART 15, this file mirrors/tracks status. Status legend used throughout:

```
✅ compliant · 🟡 action in progress · 🔴 unresolved · ⏸ blocked on owner
```

Full table verbatim (columns: `#`, `Obligation`, `Source`, `Status`, `Where handled`):

| # | Obligation | Source | Status | Where handled |
|---|-----------|--------|--------|---------------|
| 1 | CCLI non-affiliation disclaimer (first run + song import) | ADR-012 | 🟡 Phase 1 | `FirstRunWizard.tsx`, song import flow |
| 2 | CCLI Streaming License gating before go-live | ADR-014 | 🟡 Phase 1 | `StreamSettings.tsx`, `stream_start` |
| 3 | Auto-composed streaming attribution overlay | ADR-014 | 🟡 Phase 1 | `StreamAttribution.tsx`, `songs` metadata columns |
| 4 | Pre-stream warning for songs missing copyright metadata | ADR-014 (H) | 🟡 Phase 1 | pre-flight check |
| 5 | "Live AI captions — may contain errors" marker | ADR-015 (C) | 🟡 Phase 1 | caption monitor/settings/output |
| 6 | EULA with AS-IS AI disclaimer ("hallucination", no theological advice) | ADR-015 (C) | 🟡 Phase 1 draft; ⏸ legal wording review | `EULA.md`, first-run acceptance |
| 7 | KRV (개역한글 1961) public-domain verification before bundling | ADR-013 | ⏸ owner legal review — seed **quarantined** in Phase 1 | `seed_ko_krv.json` (LEGAL_HOLD) |
| 8 | Per-language PD verification process for future seeds | ADR-013 | ✅ Phase 1 | `docs/SEED_COPYRIGHT_PROCESS.md` |
| 9 | Copyrighted-translation attribution (ESV / API.Bible) + API-key gating | ADR-013 (C) | 🟡 Phase 5 | `bible/providers/`, `bible_translations` |
| 10 | Ultralytics YOLOv8 AGPL: commercial license OR detector swap | PART 15.1 (C) | 🔴 model path hard-disabled in Phase 1; RT-DETR (Apache-2.0) swap in Phase 6; ⏸ owner decision | `cameras/detector.rs` |
| 11 | NDI OEM license | PART 15 | ⏸ owner — feature stays gated, no SDK in repo | HUMAN_TASKS |
| 12 | Dante (Audinate) licensing | PART 12 | ⏸ owner — not implemented | HUMAN_TASKS |
| 13 | Via LA AVC/H.264 patent-pool opinion | PART 15 | ⏸ owner (OpenH264/LGPL-FFmpeg path itself is compliant per audit) | HUMAN_TASKS |
| 14 | AV1 (SVT-AV1) encode path; HEVC deliberately absent + warning | ADR-016 | 🟡 Phase 9 | `streaming/ffmpeg.rs` |
| 15 | GStreamer / FFmpeg / ONNX Runtime redistribution review | PART 10.5 | ⏸ owner (with code-signing task) | HUMAN_TASKS |
| 16 | Runtime: Tauri 2 supersedes blueprint's Electron (MIT) dependency — PART 15.1's "Electron / MIT / include LICENSE in bundle" row is **not applicable** to this build; Tauri/wgpu/wry licenses (MIT/Apache-2.0) take its place in the bundled NOTICE file | ADR-001B | 🟡 Phase 12 (bundled-license generation, with code-signing task) | `docs/adr/ADR-001B-tauri-runtime.md`, release NOTICE file |
| 17 | Permissive-license notice bundling for components actually shipped in this build: `whisper-rs`/whisper.cpp (MIT), FAISS (MIT, `faiss-index` feature), SQLite (public domain), ONNX Runtime (MIT, via `ort`) — no royalty/copyleft risk, but each requires its upstream LICENSE text in the release NOTICE bundle (PART 15.1 rows: "None" risk still requires notice inclusion) | PART 15.1 | 🟡 Phase 12 (bundled-license generation, with code-signing task) | `src-tauri/Cargo.toml`, release NOTICE file |

Trailing notes on the file (verbatim, condensed):
- "Rows are updated as phases land. Do not delete rows — flip status with a dated note."
- "Phase 13 cross-check (docs reconciliation): rows 10/11/13/14 (Ultralytics, NDI OEM, Via LA AVC, AV1/HEVC) verified present and current against `Rhema_Blueprint_v3.4.md` PART 15.1. Rows 16–17 added to cover blueprint-listed components this codebase actually depends on (or, for Electron, explicitly no longer does per ADR-001B) that PART 15.1 lists but the tracker had not itemized. Components in PART 15.1 this codebase does **not** depend on (ASIO SDK, Tesseract OCR, Llama 3.1 — verified via `Cargo.toml`/`package.json` grep, no matches) are intentionally not tracked as rows; they are not obligations of this build."

### Row-by-row takeaways an implementer needs

**Row 1 — CCLI non-affiliation disclaimer.** Two trigger points: first-run wizard AND song-import flow. Disclaimer must state RHEMA is not affiliated with/endorsed by CCLI (echoed in EULA §6, see below).

**Row 2 — CCLI Streaming License gating before go-live.** Streaming must be gated on the operator confirming/holding a CCLI Streaming License (distinct from the base CCLI Church Copyright License — streaming requires the separate license). v2 wired this at `StreamSettings.tsx` (settings UI) and `stream_start` (the actual command/action that begins a stream) — i.e. gating happens both at configuration time and at the actual go-live action, not just a checkbox buried in settings.

**Row 3 — Auto-composed streaming attribution overlay.** When streaming, the app must auto-generate an attribution overlay (song title/author/CCLI number etc., composed from song metadata) rather than relying on the operator to add it manually. Depends on `songs` table carrying the necessary copyright metadata columns.

**Row 4 — Pre-stream warning for missing copyright metadata.** A pre-flight check before streaming starts: if a song in the set list is missing its copyright metadata (author, CCLI song number, publisher, etc.), warn the operator before go-live rather than silently streaming unattributed content.

**Row 5 — Live AI captions disclaimer marker.** A persistent "Live AI captions — may contain errors" marker must appear wherever captions are shown (monitor view, settings, and stream/output — i.e. all three surfaces, not just one).

**Row 6 — EULA AI disclaimer.** Must be accepted at first run (see EULA breakdown below). Status was still "draft, pending legal wording review" in v2 — treat the EULA content itself as a starting draft, not final legal copy, in any rebuild too.

**Row 7 — KRV quarantine.** This is the single most important row — see dedicated section below.

**Row 8 — Per-language PD verification process.** The process itself is `docs/SEED_COPYRIGHT_PROCESS.md`, mined in full below. Status ✅ (the *process* was completed; individual seeds like KRV are separately gated by row 7/9).

**Row 9 — Copyrighted-translation attribution + API-key gating.** For non-PD translations (ESV, and anything served via API.Bible), the app must (a) attribute per the publisher's required notice, and (b) gate access behind the operator's own API key rather than bundling/proxying the text. Implementation was `bible/providers/` (provider abstraction per translation source) + a `bible_translations` table (presumably tracking which translations are PD-bundled vs. API-key-gated live).

**Row 10 — Ultralytics YOLOv8 AGPL.** AGPL is viral/copyleft and incompatible with closed distribution unless either (a) a commercial Ultralytics license is purchased, or (b) the detector is swapped for a permissively-licensed model. v2's resolution: hard-disable the YOLOv8 path entirely in Phase 1, plan an RT-DETR (Apache-2.0) swap in Phase 6, final call marked ⏸ owner decision. **Lesson: do not bundle/depend on AGPL ML models without an explicit licensing decision — default to Apache/MIT-licensed alternatives.**

**Row 16/17 — runtime and dependency license bundling.** Whatever runtime you actually ship (in v2: Tauri/wgpu/wry; MIT/Apache-2.0) requires its LICENSE text bundled into a release NOTICE file. Same for every permissive dependency actually shipped (they enumerate whisper.cpp/MIT, FAISS/MIT, SQLite/public-domain, ONNX Runtime/MIT as their concrete shipped list) — "None" risk-tier still requires notice inclusion, it does not mean "skip the notice." **Pattern to replicate: maintain an explicit inventory of "components actually shipped in this build" cross-checked against whatever the blueprint/spec lists, and explicitly note components the spec mentions that the build does NOT depend on (so future readers don't chase phantom obligations).**

## 2. Seed Copyright Verification Process (`docs/SEED_COPYRIGHT_PROCESS.md`) — full process, step by step

**Scope statement (verbatim):** "Applies to any Bible translation or song added to the bundled seed sets (`src-tauri/assets/bibles/*.json`, `src-tauri/assets/songs/*.json`) — i.e. anything shipped inside the app rather than fetched live from a licensed API or imported by the operator." References ADR-013 (`Rhema_Blueprint_v3.4.md` PART 1) and `docs/LEGAL_OBLIGATIONS.md`.

**Why this exists (verbatim rationale, this is the load-bearing sentence):**
> "RHEMA bundles ONLY public-domain content offline. Bundling a copyrighted work — even one that 'everyone assumes' is public domain — exposes every install to statutory-damages liability ($750–$150,000 per work)."

The KRV Korean Bible seed was added *without* this process (tracked as PROBLEMS.md #54) and is now under legal hold pending exactly this review. The doc explicitly says: "Do not repeat that mistake for any future seed."

### The 6 required steps before bundling ANY new seed file

1. **Identify the exact edition/printing.** PD status is determined per *specific edition*, not per "the Bible" or "this hymn" generally. Record translation name, year, AND edition (their example: "KJV 1769 Oxford standard text," not just "KJV").

2. **Verify public-domain status per jurisdiction.** Copyright term/PD status differs by country. At minimum check:
   - The country the text originates from.
   - The United States (RHEMA ships to US customers; US copyright law applies regardless of origin country for US distribution).
   - Any other jurisdiction the target congregation/language primarily serves.
   Explicit non-sufficiency warning: "A translation being 'commonly available online' or 'in a printed hymnal without a copyright notice' is NOT sufficient evidence — it must be verified against an authoritative source (national copyright office, publisher's own permissions page, or a documented legal opinion)."

3. **Cite the source.** Record the specific citation establishing PD/PD-equivalent status (copyright office record, publisher's own "this edition is public domain" statement, or a legal database/treatise entry). Explicit callout: "A vague 'believed to be public domain' is not a citation."

4. **Record a sign-off row in `docs/LEGAL_OBLIGATIONS.md`.** Row must include: the work, jurisdiction(s) checked, the citation from step 3, the reviewer, and the date. Status starts 🟡 (in progress) until an owner/counsel sign-off flips it to ✅.

5. **Do not add the file to the loader until sign-off is ✅.** Until then the file may exist in the repo (staged for review) but MUST be added to the `LEGAL_HOLD_SEED_FILES` list (or the equivalent for songs, if added later) so the loader skips it. This mirrors the KRV quarantine already in place.

6. **Contested or unclear status → do not bundle.** If PD status can't be cleared with confidence (as happened with KRV), options are: license it properly, drop it, or gate it behind a live licensed API instead of bundling text.

### PR checklist (copy-paste block from the source, verbatim)

```
- [ ] Exact edition/printing identified and recorded
- [ ] PD status verified for the US
- [ ] PD status verified for the primary target jurisdiction(s)
- [ ] Citation recorded (not just "commonly believed PD")
- [ ] Sign-off row added to `docs/LEGAL_OBLIGATIONS.md`
- [ ] File is NOT added to any legal-hold/quarantine list (or is, if sign-off
      is still pending)
```

## 3. The KRV quarantine — concrete mechanism (contested Korean translation)

The Korean 개역한글 1961 ("KRV") Bible translation is the one seed that actually triggered this whole process, and its status is **still unresolved/contested** as of the mined docs (obligations table row 7 shows ⏸, "owner legal review", "seed quarantined in Phase 1").

Confirmed implementation mechanism (verified by grepping the only in-repo occurrence of `LEGAL_HOLD_SEED_FILES`, inside a worktree copy of `bible/mod.rs`):

```rust
/// Seed files under legal hold: excluded from bundled seeding pending owner
/// legal review (PROBLEMS.md #54, ADR-013 "per-language PD verification before
/// bundling"). The Korean KRV (개역한글 1961) seed's public-domain status in
/// Korea is contested — see HUMAN_TASKS.md section A.2. The file stays on disk
/// (never deleted) so a future release can re-enable it once cleared; this list
/// only gates the loader below and the translation picker no longer offers it
/// on fresh installs.
const LEGAL_HOLD_SEED_FILES: &[&str] = &["seed_ko_krv.json"];
```

Behavior at load time: the seeding loader iterates seed files and skips any whose filename is in `LEGAL_HOLD_SEED_FILES`, logging a warning (`tracing::warn!("skipping legal-hold bible seed {:?} (PROBLEMS.md #54, HUMAN_TASKS.md A.2); file kept on disk but not loaded", ...)`). Tests assert two things explicitly: (a) `KRV` never appears in the loaded/queryable translations list even though `KJV` does, and (b) `LEGAL_HOLD_SEED_FILES` contains `"seed_ko_krv.json"` as a standing regression guard.

**Key design properties to replicate in Verger, regardless of runtime:**
- The quarantined file stays **on disk**, never deleted — it's excluded only from the *load/index* path, so it can be re-enabled later without re-shipping data.
- The gate is a simple **allowlist-exclusion list checked by filename** at load time — cheap, auditable, and trivially testable (`assert!(LEGAL_HOLD_SEED_FILES.contains(...))` as a standing regression test is a pattern worth keeping).
- The **translation picker/selection UI must also stop offering the quarantined translation** on fresh installs, not just the backend loader — quarantine has to be enforced at both the data layer and the UI layer.
- Legal-hold reasoning is documented inline as a code comment at the point of the gate, with a pointer to the tracking issue number (PROBLEMS.md #54) and the human-task section (HUMAN_TASKS.md A.2) — i.e. don't just quarantine silently, leave a breadcrumb trail in the code itself.

## 4. Licensed-API attribution requirements (ESV / API.Bible)

From obligations row 9: copyrighted translations (ESV specifically named, plus anything served through API.Bible) require:
- **Attribution** per the publisher's required notice (the mined docs don't give exact wording — that would need to come from ESV's/API.Bible's own licensing terms at implementation time, not fabricated here).
- **API-key gating**: the app does not bundle or proxy this text — it is fetched live using the *operator's own* API key. This keeps RHEMA out of the distribution chain for copyrighted verse text; the operator's own license/API agreement with the publisher covers the usage.
- v2 architecture: a `bible/providers/` abstraction (pluggable provider per translation source: local PD seed vs. live licensed API) backed by a `bible_translations` table that presumably tracks, per translation, whether it's a bundled-PD seed or an API-key-gated live source.

This is the same shape as row 3/4 (auto-attribution overlay + missing-metadata warning) applied to Bible text instead of song text — the general pattern is: **any copyrighted text surfaced by the app must either (a) come with auto-composed attribution derived from stored metadata, or (b) be fetched live via the operator's own licensed credentials, never bundled.**

## 5. Third-party NOTICE/LICENSE bundling obligations

Two distinct bundling obligations captured in the tracker (rows 16 and 17):

1. **Runtime license.** Whatever GUI runtime framework is actually shipped needs its license bundled. v2 used Tauri (their row 16 explicitly says Tauri 2 "supersedes blueprint's Electron (MIT) dependency" and that the blueprint's Electron/MIT row is "not applicable" to their build — Tauri/wgpu/wry (MIT/Apache-2.0) took its place). **This is the inverse of what Verger needs**: Verger *is* the Electron rebuild, so Electron's MIT license (and Chromium/Node's bundled licenses) becomes the applicable row again, not a superseded one — see application notes.

2. **Permissive-dependency notices.** Every dependency actually shipped — even "None" risk-tier permissive ones — needs its upstream LICENSE text included in a release NOTICE bundle. v2's concrete shipped list: whisper-rs/whisper.cpp (MIT), FAISS (MIT, feature-gated), SQLite (public domain), ONNX Runtime (MIT, via `ort`). The general rule, independent of which specific libraries: **maintain a generated/maintained NOTICE file at release time enumerating every shipped dependency's license, not just the copyleft/risky ones.**

Process lesson embedded in the tracker's own trailing note: they did a **"Phase 13 cross-check"** — re-verifying rows against the blueprint PART 15.1 and explicitly recording which blueprint-listed components the codebase does *not* actually depend on (ASIO SDK, Tesseract OCR, Llama 3.1 — verified via dependency-manifest grep, no matches) so those are not falsely tracked as outstanding obligations. **Worth repeating in Verger: periodically reconcile the obligations tracker against the actual dependency manifest (`package.json`), not just against the spec document.**

## 6. EULA (`EULA.md`) — points that affect app UI

Document header note: "Version 1.0 — Engineering draft, pending legal counsel review... Do not treat this as final legal advice." Governs use "by clicking 'I Accept' during setup" — i.e. **acceptance is a first-run gate, not a passive footer link.**

Section-by-section, UI-relevant obligations:

**§1 License Grant** — non-exclusive, non-transferable license for "organization's worship production, presentation, and streaming activities." No UI implication beyond the acceptance flow itself.

**§2 AS-IS Disclaimer** — standard no-warranty/no-merchantability/no-liability boilerplate. No specific UI surface beyond the EULA text itself.

**§3 AI Features — Accuracy Disclaimer.** This is the most operationally important section:
- Explicitly names the AI features covered: "automatic scripture reference detection, live speech-to-text captions, live translation, and AI-suggested slide/service assistance."
- States plainly AI features "can and will produce inaccurate results, including hallucination."
- **Critical architectural guarantee stated in the EULA itself** (this is a product commitment, not just legal text): "Detected scripture references are resolved against your locally configured Bible database and are never generated from a language model's memory; when a reference cannot be resolved, only the reference is shown, never invented verse text." — i.e. the EULA documents an actual anti-hallucination design constraint (verse text always DB-lookup, never LLM-generated) that the implementation must actually honor for the disclaimer to be true. **Verger must preserve this exact behavioral guarantee**: any scripture-reference-detection feature must resolve against a local DB, and must never let an LLM fabricate verse text — if a reference can't be resolved, show only the (unresolved) reference, not invented content.
- Live captions/translation "WILL contain errors... particularly with accents, background noise, technical/theological vocabulary, and overlapping speech" — sets expectation that caption UI needs an always-visible low-confidence framing, tying back to obligations-table row 5 (persistent "Live AI captions — may contain errors" marker on monitor/settings/output).
- "No AI Feature output should be treated as verified, final, or authoritative without human review" — operator is responsible for reviewing AI content before it's displayed/streamed.

**§4 No Theological or Professional Advice** — disclaims theological/doctrinal/pastoral/legal advice for *any* surfaced content, AI-assisted or not. No specific UI surface, but reinforces that scripture/slide suggestions must read as suggestions, not authoritative output.

**§5 Accessibility — Captions Are Not a Certified Accommodation.** Live captions are "an accessibility aid, not... a certified ADA accommodation or a professional interpretation service." Explicit recommendation: for legally-required-accommodation services, engage a qualified human interpreter in addition to/instead of AI captions. **UI implication: caption settings/marketing copy must not imply ADA-compliance-grade accuracy.**

**§6 Copyright and Licensing Responsibilities.** Operator (not RHEMA) is solely responsible for holding CCLI Church Copyright License, CCLI Streaming License, and Bible-translation publisher licenses. Explicit non-affiliation statement: "RHEMA is not affiliated with or endorsed by CCLI or any Bible-translation publisher." Points to `docs/LEGAL_OBLIGATIONS.md` as the "current tracked list of third-party licensing obligations" — i.e. the EULA itself references the obligations tracker as a living document, which is a pattern worth keeping (EULA text stays stable, tracker stays current).

**§7 Limitation of Liability** — standard indirect/incidental/consequential damages exclusion.

**§8 Changes to This Agreement** — "Material changes will require re-acceptance before continued use." **UI implication: EULA acceptance state needs versioning, and a material EULA update must re-trigger the first-run-style acceptance gate**, not just a silent update.

Footer disclaimer (verbatim): "This document is an engineering draft prepared to satisfy the disclosure requirements identified in the project's legal-compliance review. It has not yet been reviewed by qualified legal counsel... Do not distribute this build publicly until that review is complete." — treat any EULA text carried into Verger as a draft requiring the same counsel review before public distribution, not as ready-to-ship legal copy.

## 7. Content-filter lesson (verbatim, from `PLAN.md`)

Found under "Orchestrator resume context (survives /compact)" in `C:\Side projects\rhema_v2\PLAN.md`. Quoted in full because the mining brief flags this as critical:

> **Content-filter lesson (critical for any bulk-text phase):** never prompt a subagent to
> OUTPUT bulk scripture/lyrics/large copyrighted text — the API content-filter blocks it
> regardless of public-domain status, killing the agent. Route large text via files
> (download / validated seed JSON) and LOAD it in code; agents write code + tiny fixtures
> only. (This is why Phase 03's first dispatch failed and the second succeeded.)

**Practical translation for anyone (human or agent) building/seeding Bible or song content in Verger:** never ask an LLM agent to generate, transcribe, retype, or echo back bulk verse/lyric text in its output/response, even if the underlying text is public domain — Anthropic's own API-side content filter does not distinguish PD status from copyrighted status and will block the response, which in an agentic build pipeline manifests as the whole subagent task failing/crashing. The correct pattern: bulk text moves through **files** (downloaded once from a verified source, or pre-validated seed JSON checked into the repo/resource pool) and is **loaded programmatically in code**, never typed/output by an agent turn. Agents should only ever write the loader code and minimal fixtures (e.g. a single test verse), never the bulk corpus itself. This is a hard operational constraint for any future seed-import tooling or content-generation agent work in Verger, independent of the legal PD question.

## Verger application notes

What the Electron/TypeScript rebuild should do differently, given the Tauri/Rust engine is not being ported:

1. **Recreate the obligations tracker as a first-class doc, not a v2 artifact to copy.** Port the *table shape* (`#`, Obligation, Source, Status, Where handled) and the legend (✅🟡🔴⏸), but every "Where handled" cell needs new Electron-side file names — there is no `FirstRunWizard.tsx`/`StreamSettings.tsx`/`stream_start` command until Verger builds its own equivalents. Do not assume any v2 filenames carry over.

2. **Row 16 flips: Electron IS the runtime, not a superseded one.** v2's row 16 treats Electron/MIT as "not applicable" because they chose Tauri instead. For Verger, the opposite is true: Electron's MIT license (plus Chromium and Node.js licenses bundled inside Electron) becomes an *active* obligation requiring LICENSE text in the release NOTICE bundle — likely via `electron-builder`'s built-in license-file aggregation or a dedicated `license-checker`/`npm-license-crawler` step in the packaging pipeline, since there's no Cargo-ecosystem tomfoolery to translate.

3. **No Rust dependencies to inventory (whisper-rs, FAISS-via-Cargo, `ort`, etc.) — re-derive the shipped-dependency license list from `package.json`/`package-lock.json`.** Whatever npm packages replace whisper.cpp (STT), a vector/embedding store (FAISS equivalent), SQLite bindings, and ONNX Runtime bindings in the Electron stack each need the same "shipped → needs NOTICE entry" treatment. Row 10's AGPL lesson (YOLOv8) applies with full force to npm too — audit any ML/CV package's license before adopting it; AGPL/GPL npm packages are just as viral as their Cargo counterparts.

4. **The KRV quarantine mechanism is runtime-agnostic — reimplement the same shape in TypeScript.** An allowlist-exclusion array of filenames (e.g. `LEGAL_HOLD_SEED_FILES: string[] = ["seed_ko_krv.json"]`) checked at seed-load time, file kept on disk but excluded from the load/index path and from the translation-picker UI, plus a standing unit test asserting the quarantined translation never appears in the loaded set. Since Verger's data layer is presumably a different DB (not necessarily SQLite via Rust), the equivalent gate needs to live wherever Verger's seed-loading code runs (likely a main-process module, given Electron's split), not just in a renderer-side filter — quarantine must hold even if a compromised/buggy renderer tries to query it directly.

5. **The scripture-reference "never LLM-generate verse text" guarantee (EULA §3) is a hard product/architecture requirement, not just legal copy — preserve it structurally.** Whatever Verger's AI/LLM integration point is for reference detection or slide suggestions, the actual code path must resolve references against a local Bible DB lookup and must be structurally incapable of emitting LLM-fabricated verse text. This should be enforced in code (e.g. the LLM only ever outputs a *reference string*, which is then resolved via a separate deterministic DB lookup step — never fed back as "generate the verse text too"), so the EULA disclaimer remains true by construction.

6. **Re-run the Content-filter lesson for any Verger seed-import or content-generation tooling.** If Verger's build process uses agentic workflows (per the user's global CLAUDE.md, this project may use ruflo/swarm tooling) to import or validate Bible/song seed data, the same constraint applies: never have an agent's conversational output contain bulk scripture/lyric text. Seed JSON must be downloaded/validated via file-based tooling and loaded in code; agents only write loader/validation code plus minimal single-verse fixtures.

7. **CCLI/streaming-license gating logic ports as a UI/workflow pattern, not code.** The two-checkpoint gating pattern (settings-time confirmation + go-live-time enforcement) and the pre-flight missing-metadata warning are UI/UX patterns worth reimplementing in whatever streaming-start flow Verger builds, independent of the underlying streaming stack (v2 used ffmpeg via Rust child-process; Verger's stack is TBD and out of scope for this note).

8. **EULA content can likely be reused near-verbatim as a starting draft** (it's explicitly marked as an engineering draft pending legal counsel review in v2 too, so no loss of rigor by carrying it forward) — but re-verify every feature claim against what Verger actually ships (e.g. if Verger drops live translation or camera auto-direction, trim the corresponding EULA AI-feature bullet rather than disclaiming a feature that doesn't exist). Re-acceptance-on-material-change (§8) and the first-run "I Accept" gate (not a footer link) should both be treated as required UI behavior, not optional polish.

9. **Missing-source check:** all four assigned source files existed and were read in full; no missing sources to report for this brief. The one referenced-but-absent path is `src-tauri/src/bible/mod.rs` at repo root (only exists inside a worktree copy) — flagged in the header, not a missing *source document* for this mining task since it was only used to double check a mechanism already documented in the two primary sources.
