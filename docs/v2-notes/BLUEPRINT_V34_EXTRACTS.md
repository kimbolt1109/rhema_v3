# Blueprint v3.4 Extracts — mined from rhema_v2
> Sources: `C:\Side projects\rhema_v2\Rhema_Blueprint_v3.4.md` (3143 lines; read via targeted Grep + Read offset/limit, never in full)

This note pulls the specifics from the v2 Blueprint that are directly reusable for the Verger
(Electron/TS) rebuild: scripture detection math, cue/service-plan schemas, streaming/CCLI rules,
edge-case thresholds. Line numbers below are approximate anchors into the source file as it exists
today (search patterns are given so you can re-locate them if the file is edited).

---

## 1. Scripture reference detection & confidence math

Source region: lines ~1116–1194 (Stage 2/7.4 pipeline prose) and ~2873–2937 (OPUS-007 task spec).

**Key architectural decision (ADR-015, line ~180–184, and PART 7.4 line ~1189–1190):**
Detection and *text resolution* are two different, deliberately separated concerns:
- `ScriptureNER` only ever detects a **reference** (e.g. "John 3:16") from transcript/document text. It **never** produces verse text.
- Verse **text** is resolved from a licensed/bundled Bible source (never from a generative model — LLMs hallucinate scripture; the doc cites a documented fabricated "John 5:5" case, Missio Nexus 2024). If the reference can't be resolved in the configured translation, show the **reference only** plus "verse text unavailable in [translation]" — never invented text.

**Detector shape (`src/main/ai/ScriptureNER.ts` in v2, pure JS/regex + Levenshtein, no ML model):**
```typescript
export interface ScriptureReference {
  book: string           // canonical book name, e.g. "John"
  chapter: number
  verseStart: number
  verseEnd?: number      // for ranges like John 3:16-18
  confidence: number     // 0.0–1.0
  rawText: string        // the original text that matched
}

export class ScriptureNER {
  detect(transcript: string): ScriptureReference[]
  // Returns all detected references, sorted by confidence desc. Empty array if none found.
}
```

**Regex forms to support (minimum viable set):**
- Explicit: `"John 3:16"`, `"Jn 3:16"`, `"John chapter 3 verse 16"`
- Range: `"John 3:16-18"`, `"John 3 16 through 18"`
- Book abbreviations (verbatim list from source): `Gen|Ex|Lev|Num|Dt|Josh|Judg|Ruth|1Sam|2Sam|1Kgs|2Kgs|1Chr|2Chr|Ezra|Neh|Est|Job|Ps|Prov|Eccl|Song|Isa|Jer|Lam|Ezek|Dan|Hos|Joel|Amos|Obad|Jon|Mic|Nah|Hab|Zeph|Hag|Zech|Mal|Mt|Mk|Lk|Jn|Acts|Rom|1Cor|2Cor|Gal|Eph|Phil|Col|1Th|2Th|1Tim|2Tim|Tit|Phlm|Heb|Jas|1Pet|2Pet|1Jn|2Jn|3Jn|Jude|Rev`
- Canonical full names, plus spoken forms: `"the book of John"`, `"in Romans"`, `"Psalm 23"`, `"First Corinthians"`.

**Confidence scoring table (verbatim thresholds):**
| Match type | Confidence |
|---|---|
| Full book name match | 0.98 |
| Explicit abbreviation match | 0.95 |
| Levenshtein-1 match (1-char-off book name, e.g. "Jon" vs "John") | 0.65 |
| Levenshtein-2 match | 0.50 |
| "Spoken form" (no verse number, e.g. "in the book of Philippians") | 0.40 |

**Levenshtein fallback rule:** if a word is within 2 characters of a known book name and precedes a `chapter:verse` pattern, treat as low-confidence (0.50–0.70). Example given: `"Jon 3:16"` → matches "Jon" at Levenshtein distance 1 from "John" → confidence 0.65.

**Downstream gating thresholds (PART 7.4, line ~1193–1194) — these are the numbers to port:**
- Confidence **> 0.95** (exact reference): auto-queue in the operator's AI suggestion panel.
- Confidence **0.70–0.95** (fuzzy): show with a `?` indicator, requires operator confirmation.
- Confidence **< 0.70**: discard entirely.
- **Auto-show to the congregation** (skip operator confirmation) only if ALL of: `AI mode === 'auto'` AND `confidence > 0.95` AND the reference actually resolved to real verse text. Otherwise it always waits in the operator's suggestion panel.

**ReDoS safety requirement (T14 in threat table, line ~1417, detail at line ~2925):** book/chapter/verse patterns MUST avoid nested quantifiers / ambiguous alternation that backtracks catastrophically. Prefer anchored/atomic patterns or a linear-time engine (RE2-style) over the native JS regex engine for any pattern applied to untrusted transcript/document text. Detector runs under a per-call wall-clock timeout in an isolated worker; on timeout it returns `[]` and logs — never blocks the UI thread.

**Test cases specified (8 minimum, verbatim from source, line ~2929–2936):**
1. `"John 3:16"` → `[{book: "John", chapter: 3, verseStart: 16, confidence: 0.98}]`
2. `"Jn 3:16"` → `[{book: "John", chapter: 3, verseStart: 16, confidence: 0.95}]`
3. `"Romans 8:28-30"` → `[{book: "Romans", chapter: 8, verseStart: 28, verseEnd: 30}]`
4. `"Jon 3:16"` → `[{book: "John", confidence: ~0.65}]` (Levenshtein-1)
5. `"in the book of Philippians"` → `[{book: "Philippians", confidence: ~0.40}]`
6. `"the weather forecast is sunny"` → `[]` (no reference)
7. Multiple references in one transcript → returns both in order
8. `"Psalm 23"` → `[{book: "Psalms", chapter: 23, verseStart: undefined}]`

**Related — general slide/semantic matching confidence (`SemanticSlideMatcher`, OPUS task, line ~1197–1258):** separate from scripture detection — matches live transcript embeddings against a FAISS index of already-loaded slide content only (closed set; never generates text). `MatchContext.confidenceThreshold` default **0.75**. Cosine-similarity score. Test: known lyric from indexed song must match with confidence > 0.80; random noise text must return null.

**Bible text sourcing (ADR-013, line ~155–165):** bundle ONLY public-domain translations offline (KJV, ASV, WEB, plus a public-domain text per target language, e.g. Reina-Valera 1909 Spanish, Luther 1912 German — verify PD status per language before bundling). Copyrighted modern translations (ESV, NIV, NLT, NASB, CSB) are fetched live at display time only, from **ESV API** (api.esv.org, free tier 5,000 queries/day) or **API.Bible** (scripture.api.bible) — never bundled, never persisted beyond session (publisher permission limits cap royalty-free quotation at ~500 verses / 25% of host work). Required publisher attribution rendered with each copyrighted verse, sourced from a `bible_translations.attribution` column.

---

## 2. Post-service workflow / summary

Source region: OPUS-009, lines ~3013–3066. **Note:** searches for "archive" and "chapter marker" (as in video chapter markers) returned **no hits** in this document — that content, if it exists, is not in Rhema_Blueprint_v3.4.md. What v2 does define is a **post-service summary generator**, not a video-archival/chaptering pipeline.

**`ServiceSummary` shape (`src/main/service/SummaryGenerator.ts`):**
```typescript
export interface ServiceSummary {
  serviceId: string
  serviceName: string
  durationMinutes: number
  aiDecisions: number           // total AI slide advances
  manualCorrections: number     // number of times operator overrode AI
  aiAccuracyPercent: number     // (aiDecisions - manualCorrections) / aiDecisions * 100
  streamStats?: {
    peakViewers: number
    totalMinutesLive: number
    dropEvents: { timestamp: string; durationSec: number }[]
  }
  cameraPresetsFired: number
  dmxScenesFired: number
  macrosFired: number
  firstSlideAt: string          // ISO timestamp
  lastSlideAt: string
  errors: ServiceError[]
  comparedToPrevious?: {
    manualCorrectionsDelta: number  // negative = improvement
    aiAccuracyDelta: number         // positive = improvement
  }
  motivationalMessage: string   // generated from templates based on metrics
}

export class SummaryGenerator {
  generate(serviceId: string, db: Database.Database): ServiceSummary
}
```

**`motivationalMessage` template rules (priority order, verbatim):**
- `aiAccuracyPercent >= 99 AND manualCorrections === 0` → "Perfect! Zero manual corrections. The AI had it handled from start to finish."
- `aiAccuracyPercent >= 95` → "Excellent service. AI accuracy: {x}%. Your best of the month."
- `manualCorrections === 0` → "Flawless run. Not a single manual correction needed."
- `comparedToPrevious.manualCorrectionsDelta < 0` → "{n} fewer manual corrections than last week. Getting better every Sunday."
- `errors.length === 0 AND streamStats?.dropEvents.length === 0` → "Zero errors. Perfect technical execution."
- `streamStats?.peakViewers > 0` → "{n} people joined your livestream. That's {n} more who heard the message."
- fallback → "Good service. Check your stats below."

**Design intent (this is deliberate "Peak-End Rule" engineering, not incidental copy — PART 17.10/17.22, line ~2295, 2378):** the summary is built to be the *dopamine-maximizing* peak at end of service: (a) a number bigger than expected, (b) a comparison to previous sessions, (c) social encouragement. Errors are explicitly *contextualized, not concealed* (TRUST-3, line 2324): e.g. "AI advanced to Verse 2 but the band repeated Chorus 1 — confidence was 71%, below typical threshold" — turns an error into information rather than hiding it. Must appear within 30s of service end (design rules matrix, line ~2483).

**Tests specified (4 minimum):**
1. 127 AI decisions, 0 corrections → `aiAccuracyPercent = 100`, message contains "Perfect" or "Zero"
2. Service with errors → `errors[]` populated, message does NOT claim "zero errors"
3. No previous service data → `comparedToPrevious = undefined` (not null)
4. `motivationalMessage` always non-empty regardless of data completeness

---

## 3. CCLI compliance

Source region: ADR-012 (line ~143–153), ADR-014 (line ~167–178), `usage_log` schema (line ~704–716), `songs` schema (line ~504–524).

**Hard legal constraint (ADR-012, CRITICAL RISK):** Rhema/Verger must NOT embed, automate, scrape, or inject into CCLI SongSelect. The CCLI SongSelect **API Partner Program was retired in 2024** — it is not available to new entrants. CCLI ToS §12 forbids modifying/scraping their software and forbids unauthorized re-export of content; violation risks injunction, statutory damages, and account termination for every customer.

**The only three compliant song-content channels:**
1. Operator manually pastes/types lyrics they've legitimately retrieved from their own SongSelect subscription — app auto-detects verse/chorus/bridge structure and CCLI song number if present ("paste-and-parse importer").
2. File importer for formats CCLI itself exports: `.txt`, ChordPro, OpenSong `.xml`, plus ProPresenter `.pro`/OpenLP exports.
3. Import from an existing ProPresenter/OpenLP/OpenSong library the church already owns.

**Reporting:** log song usage **locally only** (`usage_log` table) — never auto-transmit to CCLI (no partnership exists). Generate a CSV the operator uploads to their own CCLI account themselves, matching CCLI's documented manual-reporting workflow.

**Required first-run / song-import disclosure (verbatim):** *"Rhema is not affiliated with or endorsed by CCLI. You are responsible for holding the CCLI licenses your usage requires."* Legal sign-off required before GA.

**Streaming-specific requirement (ADR-014):** when driving a livestream that includes worship music, the app MUST (a) require the operator to enter a CCLI **Streaming License** number in Settings before streaming is enabled — the base CCLI Church Copyright License does NOT cover streaming, a separate license is required — and (b) auto-compose the required on-screen/description attribution: *"'[Title]' words and music by [Writer] © [Year] [Publisher]. Used by Permission. CCLI Streaming License #[number]."* `songs` table needs `writer_credits`, `copyright_year`, `publisher` columns to auto-generate this string. Warn (don't block) if a manually-imported song has no copyright metadata and is about to stream. The app does NOT and cannot prevent platform Content-ID strikes — Settings copy must state this plainly.

**`usage_log` schema (verbatim):**
```sql
CREATE TABLE IF NOT EXISTS usage_log (
  id           TEXT PRIMARY KEY,
  service_id   TEXT REFERENCES services(id),
  song_id      TEXT REFERENCES songs(id),
  ccli_number  TEXT,
  displayed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  service_date TEXT
);
CREATE INDEX idx_usage_service ON usage_log(service_id);
```

**Deferred background task discipline (FLOW-3, line ~2044):** CCLI export (and updates, model downloads, library sync) must be completely invisible during a live service — deferred until `service.status = 'complete'`. Only exception: an urgent security patch, and even then offer deferral rather than forcing an interrupt.

---

## 4. Cue / service plan modeling

Source region: schema block lines ~485–664 (`schedule_items`, `songs`, `song_sections`, `slides`, `dmx_scenes`, `macros`, `looks`, `themes`, `venues`).

**`schedule_items` (the service-plan / run-of-show table):**
```sql
CREATE TABLE IF NOT EXISTS schedule_items (
  id          TEXT PRIMARY KEY,
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,        -- 0-indexed sort order
  item_type   TEXT NOT NULL,           -- song|scripture|sermon|video|image|announcement|countdown|custom
  content_id  TEXT,
  title       TEXT,
  duration_s  INTEGER,
  notes       TEXT,
  look_id     TEXT REFERENCES looks(id),
  macro_id    TEXT REFERENCES macros(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_schedule_service ON schedule_items(service_id, position);
```
Each schedule item can carry an associated lighting `look_id` and a `macro_id` to auto-fire on entry — this is how "cueing" is modeled: not a separate cue-list entity, but attributes hung off the run-of-show row.

**`dmx_scenes` (lighting cue, i.e. what actually gets "triggered"):**
```sql
CREATE TABLE IF NOT EXISTS dmx_scenes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  swatch      TEXT,                      -- hex color for UI thumbnail
  cue_data    TEXT NOT NULL,             -- JSON: [{fixture_id, channels:{ch:value}}]
  fade_in_ms  INTEGER DEFAULT 500,
  hold_ms     INTEGER DEFAULT -1,        -- -1 = hold until next cue
  fade_out_ms INTEGER DEFAULT 500,
  category    TEXT
);
```

**`macros` (the generic trigger/automation primitive):**
```sql
CREATE TABLE IF NOT EXISTS macros (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  trigger     TEXT,                      -- 'manual'|'slide:<id>'|'midi:<sig>'|'timecode:<tc>'|'schedule:<pos>'
  steps_json  TEXT NOT NULL              -- JSON: MacroStep[] {action, params, delay_ms, parallel_group}
);
-- MacroStep.action enum: slide:next | slide:clear:<layer> | dmx:scene | cam:preset | look:set |
--                        midi:note | osc:send | stream:start | stream:stop | ai:mode | stage:message | wait | http:post
```
Trigger types are a closed union: `manual`, `slide:<id>` (fires when a specific slide goes live), `midi:<sig>` (MIDI note/CC signature), `timecode:<tc>` (MTC-driven), `schedule:<pos>` (fires at a schedule-item position). Steps support `parallel_group` for concurrent execution and `delay_ms` for sequencing.

**`looks` (named output configuration bundle, assignable per schedule item):**
```sql
CREATE TABLE IF NOT EXISTS looks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,             -- 'Worship'|'Sermon'|'Offering'|'PreService'
  config_json TEXT NOT NULL              -- JSON: {outputs:[{id, layers:LayerConfig[]}]}
);
```

**UI constraint tied to macros (MILLER-2, line ~2255):** the macro quick-trigger panel MUST show exactly **8 macros max per page** (2×4 grid) — matches Miller's 7±2 working-memory bound. More than 8 macros → additional pages via swipe, each page a separate spatial-memory unit. This is a hard design rule, not a suggestion.

**Macro rate-limiting (T9 in threat table, line ~1412):** destructive macro/hardware actions get a per-session token-bucket rate limit; imported macros are shown for review before first run; "Clear All" requires a 2-second hold even via the remote API (not just double-click — a hold, because holds can't be triggered by System-1 muscle memory; see KAHNEMAN-2, line ~2009).

**6-layer render architecture (line ~973–982) — relevant since "cue" ultimately drives what's composited:**
| Layer | Name | Description |
|---|---|---|
| 0 | Background | Color, gradient, image, or looping video |
| 1 | Live Video | NDI/HDMI camera feed or video file, alpha-composited over background |
| 2 | Slide Content | Primary slide (lyrics, sermon points, scripture) |
| 3 | Props | **Lower thirds**, overlays, bugs, announcements — independent of slide layer |
| 4 | Mask | Edge blending, projection mapping, hole-punching — applied last |
| 5 | Annotation | Telestrator; always on top; auto-clears after 60s without input |

---

## 5. Lower-thirds

Source region: line ~176 (ADR-014), line ~980 (layer table).

There is **no dedicated lower-third data model/OPUS spec** in this document — lower-thirds are mentioned only twice, both in passing:
- As part of **Props (Layer 3)** in the render/layer architecture: "Lower thirds, overlays, bugs, announcements. Independent of slide layer." (line 980)
- As one of two operator-chosen rendering options for CCLI streaming attribution (ADR-014, line 176): *"Rhema auto-renders the attribution either as a lower-third at song start or appended to the stream description, operator's choice."*

No lower-third schema, timing/duration model, template system, or animation spec exists in this file. If v2 has a deeper lower-third design, it is in a different source document, not this blueprint.

---

## 6. OBS integration

Source region: line ~1614 (PART 11 header, false-positive match), line ~1734.

**There is no OBS-websocket integration in this document.** The only OBS mention: in the hardware-in-loop manual test plan (13.2, line 1734), OBS is used as an **NDI receiver to verify Rhema's own NDI output** — "NDI: PTZOptics NDI camera as source, OBS as receiver for Rhema output. Test: 60fps stable, alpha key." This is a QA harness note, not a product integration. Rhema v2's actual streaming path is a native FFmpeg-based encoder (see §7 below) that talks RTMP directly to ingest endpoints — it does not drive or depend on OBS at all.

---

## 7. YouTube / streaming

Source region: PART 6.6 Livestream Encoder Pipeline, lines ~1019–1029.

**There is no YouTube Data API / `liveBroadcast` integration** in this document — streaming is generic RTMP, not YouTube-API-driven. Specifics:
- **Encoder:** hardware H.264 via NVENC/Apple VideoToolbox/Intel QuickSync, selected at runtime by capability probe; software x264 `veryfast` fallback. Audio: AAC-LC 128–160 kbps from the PortAudio program-mix bus.
- **Muxer/transport:** FLV over RTMP/RTMPS to configured ingest URL(s). Multi-target (e.g. YouTube + Facebook simultaneously) via parallel encoder outputs or an internal tee — operator is warned that N targets multiply upload bandwidth.
- **Bitrate ladder (default, operator-adjustable):** 1080p30 → 4500 kbps; 1080p60 → 6000 kbps; 720p30 → 2500 kbps. **Keyframe interval 2s** — called out explicitly as a YouTube/Facebook ingest requirement.
- **Resilience:** auto-reconnect with exponential backoff on RTMP drop; buffer up to 3s during reconnect; every drop/reconnect surfaced in the post-service report; NEVER silently stop streaming.
- **Upload-bandwidth guard:** probe upstream bandwidth at stream start; if measured upstream < 1.5× target bitrate, warn and offer to drop to a lower bitrate-ladder rung before going live.
- **Performance budget:** must sustain target fps with < 1 dropped frame per 1000 under nominal load on recommended hardware; on minimum hardware, 720p30 software encode is the stated ceiling.
- **`streams` table** (line ~688–701) holds `rtmp_url`, `stream_key_ref` (a safeStorage reference, never the raw key), `resolution` (default `1920x1080`), `bitrate_kbps` (default 4500), `fps` (default 30), `active` flag.

---

## 8. Edge cases & failure modes (numeric thresholds worth porting)

Source region: scattered — PART 6.7 (line 1031), PART 9.1 threat table (line 1400), PART 17.17 SRK rules (line 2338), PART 17.23 design-rules matrix (line 2465), PART 11 observability (line 1614+).

**Offline / degraded-mode operation (PART 6.7, line 1031–1046) — core reliability requirement, "a church service cannot stop because the internet did":**
| Capability | Offline behavior |
|---|---|
| Slides, schedule, library, looks, macros | Fully local (SQLite), zero network dependency |
| Transcription, embedding, classification, scripture reference detection | Fully local (ONNX models), zero network dependency |
| DMX, VISCA, MIDI, OSC, NDI | LAN-only protocols, work without internet |
| Cloud AI (Stage 7) | Gracefully disabled; local pipeline continues; status bar shows "Cloud AI offline" |
| Copyrighted Bible translations via API | Unavailable offline; auto-falls back to bundled public-domain translation, notes the fallback |
| Planning Center sync | Queues; resyncs when connectivity returns |
| Auto-update | Skipped silently |
| Crash reporting | Queued locally, uploaded later |

CI must actually test this: run the app with network namespace severed and assert a full service can run end-to-end.

**Known "surface the rule" situation types (SRK-3, line 2351) — these are the specific failure classes v2 identified as needing a pre-written recovery script, not ad-hoc handling:** stream drop, **AI confidence < 60%**, DMX node disconnect, camera VISCA timeout, microphone silence detection, **disk space < 2 GB**, **CPU > 85% for > 30 seconds**. Each needs a specific actionable response surfaced at the moment of detection (example format: "Stream dropped — typical fix: [Reconnect button]. If that fails: [Manual fallback steps]. Est. time: 10 seconds.")

**Threat-model edge cases relevant to a rebuild (PART 9.1, line 1400+, selected):**
- T8 (H) DNS rebinding/CSWSH against the local REST/WS server — mitigated by Host-header allow-list + WS Origin allow-list; token auth alone is called out as **insufficient** because browsers auto-attach credentials.
- T11 (H) Local code injection via Electron flipped into Node mode — mitigated via Electron Fuses: `runAsNode=false`, `enableNodeCliInspectArguments=false`, `enableNodeOptionsEnvironmentVariable=false`, `onlyLoadAppFromAsar=true`, `embeddedAsarIntegrityValidation=true`, `grantFileProtocolExtraPrivileges=false`.
- T13 (M) DoS via malicious import (decompression bomb, image bomb, zip-slip) — cap uncompressed size (e.g. 500 MB) and entry count; reject `..`/absolute paths; cap image pixel dimensions before decode (e.g. 100 MP cap); run extraction in a resource-limited worker with wall-clock timeout.
- T15 (M) SSRF via user-supplied URLs (RTMP ingest, webhook target, Bible-API base) — allow-list schemes (`rtmp`/`rtmps`, `https`); block link-local/loopback/metadata ranges (169.254.0.0/16, 127.0.0.0/8, ::1, fc00::/7); no auto redirect-following into private ranges.
- **Linux `safeStorage` caveat:** silently falls back to a plaintext-equivalent `basic_text` backend when no OS secret store is available. Must call `safeStorage.getSelectedStorageBackend()` at startup; if `basic_text`, warn the operator and refuse to persist high-value secrets to disk (API keys, stream keys) — prompt per-session instead. Never claim "encrypted at rest" on a `basic_text` system.

**Automation-failure recovery (Bainbridge irony, line 1952, and design-matrix line 2476):** any automation failure (AI offline, ONNX model crash, internet disconnect) MUST immediately and unambiguously switch to full manual mode, UI identical to "Simple Mode" (large buttons, clear labels). Target from the fault-injection test: manual mode active **within 2 seconds** of AI process death. Separate simulated-service test targets: awareness of AI failure **< 3s**, takeover **< 10s**, error rate in first 5 manual advances after takeover **< 20%**.

**Renderer crash recovery (line 1652):** main process listens for `render-process-gone` on every `BrowserWindow`. The **output** window is critical — on crash, immediately recreate and re-push current slide state so the congregation screen recovers in **< 2s**; raise a status alert. Per-subsystem **circuit breakers** (line 1655): after repeated failures (e.g. a camera that keeps timing out), open the breaker, stop hammering it, mark offline, let the operator re-arm — prevents one bad device from degrading the whole app.

**Display hotplug (line 1015):** on removal of a display holding an active output role, must NOT crash — reassigns that role to the operator's primary monitor in a windowed safe state, raises a (H) status alert. ("A projector cable pulled mid-service must never take down the app.")

**Performance/reliability numeric targets worth carrying forward (PART 6.3, line 991–1002):**
- Output frame rate: 60fps ± 2fps over any 10s window
- Slide go-live latency: < 100ms from IPC receipt to first rendered frame
- File ingest (40-slide PPTX): < 3s to first slide visible
- AI embedding (40-slide deck): < 2s to index updated
- Bible verse display: < 2s from detection to visible in suggestion panel
- DMX refresh: 30Hz minimum, 44Hz target, never below 20Hz
- VISCA round-trip: < 200ms on LAN; timeout 500ms, log error
- Memory ceiling: < 2GB RSS per BrowserWindow; alert if main process > 1.5GB
- Startup time: < 4s from icon click to ready-to-operate

**Salient-alert requirement tied to AI confidence (OOTL-2/3, line 1982–1984; design matrix #7, line 2478):** any AI decision with confidence < 0.80 must produce a visual+auditory cue *qualitatively* different (not just louder) from normal events — cites research that operators miss low-probability automated-system events 30–50% of the time without a qualitative difference. Confidence level (0–100%) for current AND next predicted slide must be continuously visible, not just shown at decision moments. Default alert tone if used: 880Hz pure tone, 100ms, repeated twice (line 2439).

---

## 9. Korean-specific handling

Searches for "Korean", "한국", and "KO " turned up **no scripture/transcription/UI-localization content specific to Korean**. The only Korean-related mentions in this document are business/payments context, not product features:
- Line 262: Paddle (Merchant of Record payment processor) is noted as explicitly supporting Korean businesses (payouts to Korean accounts, KakaoPay + Naver Pay support).
- Line 1777: the underlying company is described as "a 4-person Korean team selling primarily to US churches" — this is a business-model/COGS note (why an MoR payment processor matters for their tax situation), not a language/i18n feature spec.

General i18n context that *does* exist but is not Korean-specific (line 1740–1744, PART 13.3): the product transcribes 30+ languages via Whisper + FastText LID-176 (176-language ID model, < 1ms), but the **operator-facing UI's own i18n/a11y was flagged as previously unspecified** in v2 and only loosely defined: all operator strings in resource bundles, RTL support for Arabic/Hebrew markets, locale-aware date/number/Bible-reference formatting, pseudo-localization in CI, WCAG 2.1 AA target for the operator UI specifically (not the congregation output). No Korean font/IME/vertical-text/hangul-specific handling is discussed anywhere in this file.

---

## Verger application notes

What the Electron/TypeScript rebuild should do differently, given the Tauri/Rust engine is NOT being ported:

1. **Port the scripture-confidence math as pure TypeScript, unchanged.** The `ScriptureNER` design (regex + Levenshtein fallback, the 0.98/0.95/0.65/0.50/0.40 confidence table, and the 0.70/0.95 gating thresholds) is language-agnostic logic with zero Rust/Tauri dependency — copy the algorithm and test cases verbatim into `ScriptureNER.ts`. Do NOT skip the ReDoS hardening (T14) just because the runtime changed — Node's regex engine has the same catastrophic-backtracking risk as any JS engine; still worth an RE2-style/atomic-pattern approach or a wall-clock timeout around the call.

2. **Re-architect the native-module boundaries that Tauri handled differently.** v2 relied on Rust/N-API-style native modules for DMX/VISCA/NDI/SDI and FFmpeg invocation (`OPUS Media task`, DeckLink via native module). In Electron these become either (a) Node native addons / N-API modules called from the main process, or (b) a separate helper/UtilityProcess talking over IPC — the "isolate untrusted/crashy work off the render/IPC critical path" pattern (Stage 1 ingestion hardening, circuit breakers, worker-based ReDoS timeout) should be preserved regardless of runtime, since it's about fault isolation, not Rust specifically.

3. **The `safeStorage` Linux `basic_text` caveat applies identically in Electron** (it's an Electron API, not a Tauri/Rust concern) — keep this exact runtime check (`safeStorage.getSelectedStorageBackend()`) and the "refuse to persist high-value secrets, prompt per-session instead" fallback.

4. **The Electron Fuses hardening list (T11) is Electron-specific and MUST be added explicitly** — this wasn't a Tauri concern at all (Tauri has a different process/capability model), so it's new work for Verger, not a port: `runAsNode=false`, `enableNodeCliInspectArguments=false`, `enableNodeOptionsEnvironmentVariable=false`, `onlyLoadAppFromAsar=true`, `embeddedAsarIntegrityValidation=true`, `grantFileProtocolExtraPrivileges=false`.

5. **CCLI/legal constraints (ADR-012/013/014) are 100% engine-independent** — port the compliance decisions as-is (paste-and-parse importer only, local-only `usage_log`, CCLI Streaming License gate before enabling streaming, public-domain-only Bible bundling). None of this changes with a rebuild; re-verify the CCLI SongSelect API Partner Program status is still retired before assuming otherwise.

6. **No OBS-websocket or YouTube Data API integration exists to port** — v2 never built either. If Verger's blueprint calls for OBS-websocket control or YouTube `liveBroadcast` API automation (auto-creating broadcasts, setting titles), that is net-new design work, not something to mine further from this document. Check other v2 sources (or accept it's undesigned) before assuming prior art exists.

7. **No lower-third data model or Korean-language handling exists in v2 to port** — both would be net-new design for Verger if required. Don't assume v2 solved these; the blueprint only name-drops lower-thirds as a render layer / attribution-placement choice, and "Korean" only appears in payments/business context.

8. **The offline-first requirement (PART 6.7) is a product requirement independent of engine choice** — Electron's IPC/main-process model can satisfy it the same way (local SQLite, local ONNX inference via onnxruntime-node instead of whatever Tauri used, LAN-only hardware protocols) but Verger should still write the same CI test discipline: run the packaged app with networking severed and assert a full service completes end-to-end.

9. **The 6-layer render/compositor architecture and 16ms frame-budget table (PART 6.1/6.2) describes rendering behavior, not a Rust dependency** — it was likely WebGL2/Canvas-based already (the doc explicitly discusses `requestVideoFrameCallback`, WebCodecs `VideoDecoder`, WebGL2 shaders, `offscreenRendering` with `useSharedTexture`), i.e. renderer-process web-standard APIs that carry over to Electron's Chromium renderer unchanged. This is one of the more directly portable subsystems.
