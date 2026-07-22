# Phase Lessons & Cross-Cutting Gotchas — mined from rhema_v2

> Sources read in full:
> - `C:\Side projects\rhema_v2\PLAN.md` (28KB, full read)
> - `C:\Side projects\rhema_v2\PROBLEMS.md` (22KB, full read — "Full Delta Audit vs Rhema Blueprint v3.4", audited 2026-07-02)
>
> Source code cross-referenced (rhema_v2 checkout has no top-level `src-tauri/`; the actual
> implementation lives in the git worktree below — still read-only, never edited):
> - `C:\Side projects\rhema_v2\.claude\worktrees\optimistic-neumann-1b8932\src-tauri\src\bin\rhema_sandbox.rs`
> - `...\src-tauri\src\importer\mod.rs`
> - `...\src-tauri\src\media\mod.rs`
> - `...\src-tauri\src\cue\mod.rs`
> - `...\src\components\playlist\ServicePlaylist.tsx`, `...\src\components\playlist\CueCard.tsx`
> - `...\src-tauri\src\slidemind\mod.rs`, `...\src-tauri\src\slidemind\bible_detector.rs`
> - `...\src-tauri\src\overlay\mod.rs`, `...\model.rs`, `...\engine.rs`, `...\animation.rs`
> - `...\src-tauri\assets\lower_thirds\*.json` (50 files, listed in full below)
> - `...\src-tauri\src\knowledge\loader.rs`, `...\vector.rs`, `...\intelligence.rs`
> - `...\src-tauri\assets\theological_entities\seed_*.json` (6 files)
> - `...\src-tauri\src\panic\mod.rs`
> - `...\src-tauri\src\security\file_guard.rs`

This is the cross-cutting lessons file for all 10 Verger (rhema_v3, Electron/TS) build prompts.
rhema_v2 was a **Tauri 2 + Rust** desktop app; **none of the Rust engine is being ported** — only
the architecture decisions, data shapes, thresholds, and mistakes are being mined here.

---

## Phase 04 — Sandboxed file import, media library, playlist

### The sandbox-child-process pattern (the core lesson)

rhema_v2 never parses an untrusted PPTX/XLSX/DOCX/PDF **in the main process**. It spawns a
**separate OS process** (`rhema_sandbox`, a second Rust binary built as a Cargo `[[bin]]`
alongside the main Tauri exe) and talks to it over stdin/stdout as one-shot JSON request/response:

- **Request** (stdin, one write, then close/EOF): `{"path": "...", "file_type": "pptx|xlsx|docx|pdf"}`
- **Success response** (stdout): `{"slides":[...], "text":"...", "images":[...]}`
- **Failure response** (stdout): `{"error": "reason"}`
- The parsers themselves live in the **library crate** (`rhema_lib::importer`) so they stay
  unit-testable in-process; the `bin/rhema_sandbox.rs` file is a **thin transport shell** — it
  does nothing but read stdin, call `parse()`, serialize the result, write stdout.
- The **launcher** (`run_sandbox`, called from the main engine) spawns the child with
  `Stdio::piped()` for stdin/stdout, `Stdio::null()` for stderr, and **`kill_on_drop(true)`**.
  It races the child's stdout-read against `tokio::time::timeout(SANDBOX_TIMEOUT, ...)`.
  **`SANDBOX_TIMEOUT = Duration::from_secs(30)`** — if the child hasn't produced output in 30s,
  it is `.kill()`ed and the caller gets `ImportError::Timeout`.
- If the child panics, segfaults, or hangs, **the engine only ever observes a failed/timed-out
  import** — it can never take the whole app down. This was the explicit design goal, stated
  verbatim in the module doc: *"a malformed/malicious file could make them panic or run away"*
  and the launcher exists so *"the engine can never be taken down by a bad import."*
- Defence in depth **before** the sandbox even sees the path: `validate_path()` rejects any path
  containing a `..` `ParentDir` component and requires `p.is_file()`.
- A separate pre-flight guard (`security::file_guard`) runs **before spawning the sandbox**:
  1. Read only the first 8 bytes and match **magic bytes**: `PK\x03\x04` (0x50 0x4B 0x03 0x04) →
     `FileKind::Zip` (covers .pptx/.xlsx/.docx); `%PDF-` (0x25 0x50 0x44 0x46 0x2D) → `FileKind::Pdf`.
  2. Enforce **`MAX_IMPORT_BYTES = 50 * 1024 * 1024`** (50 MiB) against `fs::metadata().len()`.
  3. `preflight_check(path) -> Result<FileKind, ImportGuardError>` combines both; call this
     BEFORE the sandbox launch, not after.
- Locating the sandbox binary: `sandbox_bin_path()` looks for `rhema_sandbox[.exe]` **next to the
  running executable** (`std::env::current_exe().parent()`) — Cargo places sibling `[[bin]]`
  targets in the same output dir. No PATH search, no bundling logic beyond "ship it next to the
  main exe."

### Data shapes (importer)

```rust
struct ParsedSlide {
    text: String,             // visible body text for the slide
    notes: String,             // presenter notes (PPTX) or empty
    image_paths: Vec<String>,  // absolute paths to images extracted FOR THIS SLIDE (temp dir)
}
struct ParsedDocument {
    slides: Vec<ParsedSlide>,
    text: String,               // flattened full-text, newline-joined
    images: Vec<String>,        // absolute paths to ALL images extracted from the doc
}
struct ImportRequest { path: String, file_type: String }
struct SandboxOutput { slides: Vec<ParsedSlide>, text: String, images: Vec<String>, error: Option<String> }
```

### Per-format parsing notes

- **PPTX** (`parse_pptx`): opened as a raw ZIP (`zip::ZipArchive`). Iterates every entry once
  (ZipArchive borrows mutably, so raw XML + media bytes are collected into `Vec`s first, *then*
  processed). Slide XML lives at `ppt/slides/slideN.xml`, notes at
  `ppt/notesSlides/notesSlideN.xml`, media at `ppt/media/*`. Slide/notes numbers are parsed by
  stripping non-digit chars from the filename and sorted by that number. Text is extracted by a
  streaming `quick_xml::Reader` that tracks depth inside `<a:t>` tags and joins runs with `\n`,
  then collapses/trims blank lines.
  **Media is extracted to a per-import temp dir** (`std::env::temp_dir().join("rhema_import_<uuid>")`)
  and the doc-level `images: Vec<String>` is populated — but **`ParsedSlide.image_paths` is ALWAYS
  `Vec::new()`** in the current code (`slides.push(ParsedSlide { text, notes, image_paths: Vec::new() })`).
  This is the exact documented gap: **`ppt/slides/_rels/slideN.xml.rels` (which maps each slide's
  `r:embed` relationship IDs to the actual `ppt/media/imageN.png` file) was never parsed**, so
  there is no way to know *which* image(s) belong to *which* slide — only that the deck has
  images, dumped in one flat bucket. `PLAN.md` backlog records this explicitly: *"PPTX per-slide
  `image_paths` are empty — slide `_rels` media mapping not parsed yet (text works; slide images
  won't render on cues)."*
- **XLSX** (`parse_xlsx`, via the `calamine` crate): if the header row contains a column matching
  `.contains("time")` AND one matching `.contains("item")`/`"description"`/`"element"`, the sheet
  is treated as a **schedule/runbook** and **each data row becomes one slide** (`"HH:MM  Item"` text).
  Otherwise it falls back to a **generic flatten**: every non-blank row becomes one tab-joined text
  line, all rows collapsed into a single slide.
- **DOCX** (`parse_docx`, via `docx_rs`): walks `DocumentChild::Paragraph`s; a paragraph whose
  style name contains `"heading"` (case-insensitive) **flushes the current slide and starts a new
  one** — i.e. headings become slide breaks, everything else accumulates into the current slide's
  text.
- **PDF** (`parse_pdf`): **feature-gated behind `pdf-render`**, off by default, because it needs a
  bundled `pdfium` native dynamic library. Without the feature it returns a typed
  `"pdf rendering unavailable: build with --features pdf-render and a bundled pdfium binary"`
  error rather than failing to compile. With the feature on: rasterises each page to a 1280px-wide
  PNG via `pdfium_render`, extracts page text via `page.text()`, one `ParsedSlide` per page with
  that page's single rendered image in `image_paths` (PDF unlike PPTX gets per-page images right,
  because there's no relationship-mapping problem for a rasterised page).
  **Known sandbox-invariant violation**: `media::MediaLibrary::document_thumbnail` (behind the same
  feature) calls `crate::importer::parse()` **in-process** for PDF/PPTX first-page thumbnails —
  explicitly flagged in-code with `// TODO(sandbox-invariant): ... route document thumbnails
  through run_sandbox() like import_file does.` This is a real bug pattern to avoid: a second call
  site quietly bypassing the sandbox boundary that was built for exactly this file type.

### Media library

`MediaItem` (row shape returned to frontend):
```rust
struct MediaItem {
    id: String, path: String,
    #[serde(rename = "type")] media_type: String, // "image"|"video"|"audio"|"pdf"|"presentation"|"document"|"other"
    title: Option<String>, duration_secs: Option<f64>,
    thumbnail_path: Option<String>, tags: Option<String>,
    ai_summary: Option<String>,  // literally the placeholder string "Analyzing..." until an LLM lands
    created_at: String,
}
```
- `classify(path)` maps extension → type: images `png|jpg|jpeg|webp|gif|bmp`; video
  `mp4|mov|mkv|avi|webm|m4v`; audio `mp3|wav|flac|aac|ogg|m4a`; `pdf`→pdf;
  `pptx|ppt|key`→presentation; `docx|doc|txt|md`→document; else `other`.
- Import is **idempotent on path** via `ON CONFLICT(path) DO UPDATE` — re-importing the same file
  updates rather than duplicates.
- Thumbnail generation is **spawn_blocking + fully best-effort**: a missing ffmpeg, an unreadable
  image, or a panic inside the blocking task all degrade to "no thumbnail," never fail the import.
  Thumbnails are 320×180 (`THUMB_W`/`THUMB_H`), written under `~/.rhema/cache`.
  **Decompression-bomb guard**: images over `MAX_IMAGE_BYTES = 64 * 1024 * 1024` (64MB) are
  skipped rather than decoded.
- Video thumbnails shell out to ffmpeg: `-y -ss 5 -i <path> -frames:v 1 -vf scale=320:180:force_original_aspect_ratio=decrease`.
  ffmpeg resolution order (`locate_ffmpeg`): `RHEMA_FFMPEG` env var → sidecar dir next to the exe
  → sidecar dir next to `CARGO_MANIFEST_DIR` (dev) → `~/.rhema/bin` → a hardcoded shared
  resource-pool path (`C:\ClaudeFlow\projects\rhema\resources\bin\win\ffmpeg.exe` — irrelevant to
  Verger, but shows the fallback-chain *pattern*) → bare `ffmpeg` on PATH as a last resort. Always
  returns `Some` (never fails to produce *a* candidate); the actual spawn is what may fail, silently.
- Duration probing has no dedicated ffprobe dependency — it shells `ffmpeg -i <file>` and regexes
  `"Duration: HH:MM:SS.xx"` out of **stderr**.
- yt-dlp download: `-f "best[ext=mp4][height<=1080]" -o <cache>/<cue_id>.%(ext)s <url>`, falls back
  to scanning the cache dir for any file whose stem matches `cue_id` if the expected `.mp4` isn't
  where expected (yt-dlp may pick a different container).

### Cue / Playlist system

`CueContent` is a Rust enum, **internally tagged** `#[serde(tag = "kind", rename_all = "camelCase")]`
so the frontend gets a discriminated union on `kind`. Full variant list (this is the exhaustive
cue-type vocabulary a Verger service-playlist needs to reproduce):

```
Slide      { media_id?, image_path?, text? }
Video      { media_id?, path? }
Audio      { media_id?, path? }
Song       { song_id }
BibleVerse { reference, translation? }
LowerThirdCue { template_id, fields: json }
LightingCue { scene_id }
CameraPreset { camera_id: u8, preset_id: u8 }
Wait       { seconds: f64 }
Announcement { text }
Countdown  { seconds: u64, message? }
YouTube    { url, cached_path? }
```
Wire `kind` values are camelCase, e.g. `"bibleVerse"`, `"lowerThirdCue"`, `"youTube"`.

`MediaCue`: `{ id, label, content: CueContent, transition (reuses render-engine TransitionKind:
cut/fade/crossdissolve/wipe), duration_override?, auto_advance: bool, ai_summary?, tags: [],
order: u32 }`.

`Playlist { cues: Vec<MediaCue>, active_index: Option<usize> }` owns ALL playlist mutation logic,
fully unit-tested, worth copying the *behavior* even in a new stack:
- `reindex()` re-stamps `order` to a dense 0..n after every mutation.
- `insert(index, cue)` and `remove(id)` both **shift `active_index`** to keep pointing at the same
  logical cue (not the same numeric slot).
- `reorder(from, to)` tracks the active cue **by id**, not index, across the move, then restores
  the pointer by re-finding that id.
- `duplicate(id)` clones + gives a fresh id + appends `" (copy)"` to the label + inserts
  immediately after the original.
- `advance()`/`previous()` **hold** at the boundaries (never wrap, never go out of range) —
  advancing past the last cue repeatedly just keeps returning the last index.
- Persistence: the WHOLE playlist serializes to one JSON blob stored under a **single well-known
  row id** (`"live-playlist"`) in a generic plans table — `ON CONFLICT(id) DO UPDATE`, so saving
  twice never creates a duplicate row. Named "saved services" are separate snapshot rows
  (id/name/saved_at/cue_count/playlist_json) with list/save/load/rename/delete.

### Frontend: @dnd-kit ServicePlaylist pattern

Exact library usage (`@dnd-kit/core` + `@dnd-kit/sortable`) worth replicating verbatim in React for
Verger:
```tsx
// Container:
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";

const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

function onDragEnd(event: DragEndEvent) {
  const { active, over } = event;
  if (!over || active.id === over.id) return;
  const from = cues.findIndex(c => c.id === active.id);
  const to = cues.findIndex(c => c.id === over.id);
  if (from === -1 || to === -1) return;
  // Optimistic local reorder, THEN persist; on failure, refetch from source of truth.
  setState(s => ({ cues: arrayMove(s.cues, from, to) }));
  void persistReorder(from, to).catch(() => refetch());
}

<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
  <SortableContext items={cues.map(c => c.id)} strategy={verticalListSortingStrategy}>
    {cues.map(cue => <CueCard key={cue.id} cue={cue} />)}
  </SortableContext>
</DndContext>

// Per-item (CueCard.tsx):
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cue.id });
const style = { transform: CSS.Transform.toString(transform), transition, ... };
// spread {...attributes} {...listeners} on the drag-handle element only
```
- Activation `distance: 4` (px) on `PointerSensor` avoids hijacking simple clicks as drags.
- The pattern is: **optimistic client-side reorder first**, fire the persistence call, and on
  failure **refetch the authoritative list** rather than trying to reconcile — simple and correct.
- Tauri-specific bits that need an Electron equivalent, NOT reusable as-is:
  `getCurrentWebview().onDragDropEvent(...)` for native OS file-drop-onto-window (Tauri's own
  drag/drop API, distinct from `@dnd-kit`'s in-app reordering) and `convertFileSrc()` for turning a
  local path into a webview-loadable URL. In Electron: OS file drops arrive via the standard HTML5
  `ondrop`/`DataTransfer` API (`webUtils.getPathForFile()` in newer Electron to recover a real
  filesystem path from a dropped `File`), and local files are served via a custom protocol handler
  or `file://` (with sandboxing considerations) rather than `convertFileSrc`.

---

## Phase 06 — SlideMind: 2-tier Bible detector, confidence gate, dwell, human-always-wins

### Two-tier Bible/scripture detector

- **Tier 1 — regex, confidence 0.98** (`TIER1_CONFIDENCE`). One alternation regex built from every
  canonical book name/abbreviation (EN + Korean), **longest tokens sorted first** so multi-word/
  digit-prefixed names ("1 Corinthians", "Song of Solomon") win over substring collisions. Pattern
  shape (Rust regex, case-insensitive):
  ```
  \b(BOOK_ALTERNATION)\s*([0-9]{1,3})(?:\s*[:장]\s*([0-9]{1,3})\s*절?(?:\s*[\-~]\s*([0-9]{1,3}))?)?
  ```
  i.e. `book chapter [ (":"|"장") verse "절"? ( ("-"|"~") verse )? ]` — handles English `John 3:16`,
  `1 Corinthians 13:4-8`, whole-chapter `Psalm 23`, and Korean colon-form (`요한복음 3:16`) and
  Korean marker-form (`창세기 1장 1절`) in the same expression.
- **Tier 2 — Aho-Corasick over theological-entity names, confidence 0.82** (`TIER2_CONFIDENCE`).
  Built from `(entity_name, primary_scripture)` pairs — e.g. "Prodigal Son" → resolves to
  `Luke 15:11-32`. Case-insensitive, `MatchKind::LeftmostLongest`. **Aliases** (author-supplied
  alternate phrasings, e.g. "the Pharisee who came at night" → Nicodemus → `John 3`) are folded
  into the SAME automaton as extra patterns mapping to the identical resolved reference — this is
  how a detector recognizes an indirect/descriptive reference to a Bible story without the speaker
  ever saying the book name.
- `BibleDetector::detect(text)` runs Tier 1 then Tier 2 and concatenates results (Tier-1 first —
  higher confidence, explicit references surface before entity guesses).
- The ~25/585 seeded entities and their scripture mappings are **METADATA ONLY** — `(name,
  entity_type, primary_scripture)` triples, never verse text. This is intentional and load-bearing
  for the content-filter lesson (see below): scripture *references* are just short strings, never
  bulk copyrighted content.

### SlideMind decision pipeline (the exact order matters)

`SlideMindEngine::on_transcript_chunk(text, now_ms, embed_fn)` processes one rolling-window chunk
and returns a `Decision` (`Idle` | `AutoAdvance{to_slide, confidence, reason}` |
`Recommend{confidence, reason}`), in this fixed order:

1. Push the chunk into a **rolling ~10s window** (`DEFAULT_WINDOW_MS = 10_000`), trim anything
   older than `now_ms - window_ms`.
2. **Verbal trigger check FIRST** — if the text matches a trigger phrase (Aho-Corasick,
   case-insensitive), this **bypasses the confidence/semantic gate entirely** but still must clear
   `min_dwell_ms`. If a trigger fires before min-dwell, it is **silently dropped** (not queued) —
   the operator has to speak/wait past the dwell floor.
3. **Max-dwell failsafe** — if `dwell >= max_dwell_ms`, **force an advance regardless of director
   mode** (even in recommend-only mode). This guarantees a service can never get permanently stuck
   on one slide even if the confidence gate never fires. Reason: `MaxDwellReached`.
4. **Min-dwell floor** — below `min_dwell_ms`, always `Idle` (nothing below this point runs).
5. **Semantic drift** (only reached if an embedder is available — degrades cleanly to `Idle` when
   not): `switch_score = cos(window_embedding, next_slide_embedding) − cos(window_embedding,
   current_slide_embedding)`. If `score > auto_threshold` → gated-advance; **else if `score >=
   recommend_threshold` (inclusive lower bound, verified by a dedicated boundary test) →
   Recommend**; else `Idle`.

Confidence-gate constants (matching the project-wide invariant restated at the top of `PLAN.md`:
*">0.95 auto / 0.80–0.95 recommend / <0.80 ignore"*): default test config uses
`auto_threshold = 0.95`, `recommend_threshold = 0.80`, `min_dwell_ms = 8_000`,
`max_dwell_ms = 120_000`. These are all **live-reloadable** from settings — `SlideMindConfig` is
rebuilt from `AiSettings` on every chunk, so an operator changing thresholds mid-service takes
effect immediately without a restart.

**Director mode gating** (`director_auto: bool`): when true, a gate-clearing decision **advances
immediately**; when false ("recommend-only"), the exact same decision instead stores a
`PendingRecommendation` and publishes an event for the operator to confirm/dismiss — **the slide
literally does not move** until `confirm_pending()` is called. The one exception that always
force-advances regardless of director mode is the max-dwell failsafe.

**Verbal trigger phrases** (`TRIGGER_PHRASES`, EN + KO, case-insensitive substring match):
```
next, moving on, let's look at, now let's, secondly, third, point two, point three,
number two, number three, turning to, in conclusion, finally, to close, to wrap up, as we close,
다음으로, 이제, 두번째로, 세번째로, 마지막으로
```

### Human-always-wins (exact mechanism)

The engine **never directly writes the authoritative current-slide state**. The app's real
`current_slide_index` lives outside the engine; every pipeline tick calls
`engine.sync_current_slide(app_slide, now_ms)` **first**, which:
- If the incoming `app_slide` differs from what the engine thinks, the engine snaps its internal
  `current_slide` to match, **resets the dwell clock to `now_ms`**, and **clears any pending
  recommendation**. So a manual operator jump (via `slide_advance`/`slide_goto`) instantly
  invalidates whatever SlideMind was about to recommend, and restarts the dwell timer from zero —
  a verbal trigger 2 seconds after a manual jump is blocked by min-dwell exactly as if the AI had
  just switched slides itself. This is the concrete, tested mechanism behind "human always wins":
  the operator's action is authoritative and the AI resyncs to it every single chunk, never the
  reverse.

### Confidence status bar / Y⁄N banner UI concept

PLAN.md Phase 06 line item: *"confidence status bar + Y/N banner; human-always-wins"* — i.e. the
UI shows the live confidence score continuously (status bar) and, only in recommend mode, surfaces
a lightweight Yes/No confirmation banner tied to `PendingRecommendation` rather than a modal that
blocks other operator actions. (Note: PROBLEMS.md item #94 flags that a whole separate
`ConfidenceStatusBar.tsx` component was fully built in rhema_v2 but **never mounted** — dead code
competing with the real `StatusBar.tsx`. Lesson: build the status surface directly into the one
real status bar from day one; don't build a parallel unmounted component "for later.")

---

## Phase 07 — OverlayForge: 50 lower-third templates, animation, auto-injection

### Template JSON shape (`LowerThirdTemplate`)

All positions/sizes are **normalised 0.0..=1.0 output-frame units** (resolution-independent);
font sizes are virtual pixels against a 1080-tall canvas.

```rust
enum LowerThirdCategory { Speaker, Scripture, Song, Announcement, Social, Giving, Event, Broadcast, Minimal, Custom }
enum FieldType { Text, LargeText, Url, Number, Date, Color }
struct FieldDefinition { key, display_label, placeholder, required: bool, field_type }
enum AnimationKind { SlideUp, SlideRight, Fade, Wipe, Reveal, Elastic, FlipUp }
struct Animation { kind: AnimationKind, duration_ms: u32 }
struct Rgba { r, g, b, a }  // 0.0..=1.0 each
enum Anchor { TopLeft, TopCenter, TopRight, CenterLeft, Center, CenterRight, BottomLeft, BottomCenter, BottomRight }
struct LowerThirdLayout {
  anchor, x, y, width, height, corner_radius,
  color_primary, color_secondary, color_text,
  title_font_size, subtitle_font_size,
}
struct LowerThirdTemplate {
  id,          // deterministic UUIDv5 of `name`, filled by the loader if absent from JSON
  name, category, layout,
  animation_in: Animation, animation_out: Animation,
  default_duration_ms: Option<u32>,   // None = holds until explicit dismiss
  fields: Vec<FieldDefinition>,
}
```

Real example (`scripture_crimson_verse.json`, verbatim — small enough to be a legitimate schema
sample, not bulk content):
```json
{
  "name": "Scripture — Crimson Verse",
  "category": "scripture",
  "layout": {
    "anchor": "bottom_center", "x": 0.5, "y": 0.72, "width": 0.84, "height": 0.22,
    "corner_radius": 10.0,
    "color_primary": {"r":0.55,"g":0.08,"b":0.12,"a":0.95},
    "color_secondary": {"r":0.86,"g":0.69,"b":0.22,"a":1.0},
    "color_text": {"r":1.0,"g":1.0,"b":1.0,"a":1.0},
    "title_font_size": 52.0, "subtitle_font_size": 32.0
  },
  "animation_in": {"kind":"fade","duration_ms":600},
  "animation_out": {"kind":"fade","duration_ms":400},
  "default_duration_ms": null,
  "fields": [
    {"key":"reference","display_label":"Reference","placeholder":"John 3:16","required":true,"field_type":"text"},
    {"key":"text","display_label":"Verse Text","placeholder":"For God so loved the world...","required":true,"field_type":"large_text"},
    {"key":"translation","display_label":"Translation","placeholder":"KJV","required":false,"field_type":"text"}
  ]
}
```

### The 50 bundled templates (exact filenames, `assets/lower_thirds/*.json`)

Category minimums asserted by a unit test (`all_fifty_bundled_templates_deserialize`): **≥10
speaker, ≥10 scripture, ≥5 song, ≥5 announcement**; every category used by auto-injection
(Speaker/Scripture/Song) must have at least one template so the engine can never fail to find one.

```
announcement_banner, announcement_card, announcement_event_promo, announcement_notice_bar,
announcement_ticker, broadcast_chapter_marker, broadcast_live_indicator, broadcast_satellite_site,
broadcast_score_bug, countdown_service_start, emergency_notice, event_calendar_strip,
event_upcoming, giving_qr_banner, giving_text_to_give, giving_tithes_reminder, minimal_clean_bar,
prayer_points, scripture_crimson_verse, scripture_elegant_serif, scripture_flip_reveal,
scripture_full_reveal, scripture_lower_banner, scripture_memory_verse, scripture_minimal_ref,
scripture_responsive_reading, scripture_side_quote, scripture_wipe_in, series_branding,
social_handle_bug, social_hashtag_bug, song_ccli_bug, song_corner_credit, song_hymn_number,
song_title_card, song_worship_banner, speaker_broadcast_wide, speaker_centered_lower,
speaker_classic_navy, speaker_elastic_pop, speaker_flip_card, speaker_gold_accent,
speaker_guest_speaker, speaker_minimal_bar, speaker_panel_name, speaker_right_aligned,
sponsor_credit, talking_points, translator_credit, welcome_banner
```
(10 speaker_*, 10 scripture_*, 5 song_*, 5 announcement_* + emergency_notice — category coverage
in the filenames roughly mirrors the `category` field but is not 1:1; always read `category` from
the JSON, not the filename.)

### Loader semantics (idempotent, name-deterministic ids)

- `template_id_for_name(name)` = **UUIDv5** in a fixed namespace, so re-loading the same bundled
  JSON on every app start never creates duplicates: `INSERT OR IGNORE` keyed on that id.
  A file may contain a single template object OR a JSON array of templates; malformed files are
  **logged and skipped**, never abort the whole load.
- **Operator-authored/custom templates get a RANDOM UUIDv4**, not the deterministic v5 — this is
  deliberate so two custom templates saved with the same name never collide/overwrite each other
  under `ON CONFLICT(id)`. Only the *bundled* loader uses name-derived ids for its dedup property.
- `select_template_for_category(catalog, category)` = first catalog match — noted in PLAN.md
  backlog as a known limitation: *"auto-injection picks the first catalog template of a category —
  add per-event template preference/config later."* If Verger wants smarter selection (most
  recently used, operator-pinned default per category), build it from day one rather than
  retrofitting.

### Animation math (pure, CPU-side; mirror in CSS/WAAPI or a shader if GPU-driven)

- Easing per `AnimationKind`: `Fade`/`Wipe`/`Reveal` → **linear** `t`; `SlideUp`/`SlideRight` →
  **ease-out cubic** `1 − (1−t)³`; `FlipUp` → **smoothstep** `3t² − 2t³`; `Elastic` →
  `t + sin(t·6π)·(1−t)·0.3` (overshoot-and-settle).
- Lifecycle: `In` (0→in_ms) → `Hold` (duration = `hold_ms`, or **indefinite** if `None`) → `Out`
  (out_ms→0) → `Done`. `hold_ms` is **derived**, not authored directly: it's
  `auto_dismiss_ms.saturating_sub(in_ms).saturating_sub(out_ms)` — i.e. the template author sets a
  *total visible window* and the in/out animation time is carved out of it automatically.
- `ActiveOverlay` carries a **monotonic `generation` id** specifically so a delayed/scheduled
  auto-dismiss timer can verify it's still dismissing the *same* overlay instance it was scheduled
  against (guards against a rapid show→dismiss→re-show sequence dismissing the wrong instance).
  Manual dismiss **aborts the pending scheduled-dismiss task** rather than leaving it to fire
  later into a no-op — worth copying so rapid re-shows don't pile up dangling timers.

### Auto-injection engine (event-bus → lower-third, pure routing + async resolution split)

Routing is a **pure function** `classify_event(event) -> EventRoute` (unit-testable with synthetic
events, no I/O), separate from the async pipeline that resolves verse text / song metadata:

| Source event | Route | Resulting category | Auto-dismiss |
|---|---|---|---|
| `BibleReferenceDetected` | `Scripture{book,chapter,verse_start,verse_end}` | Scripture | **None** (holds until dismissed) |
| `SlideAdvanced` | `SongOnSlideAdvance` (only injects if the **active playlist cue** is `CueContent::Song`) | Song | `SONG_AUTO_DISMISS_MS = 6_000` |
| `DmxSceneActivated` (any lighting scene — noted gap: not scoped to prayer scenes specifically) | `PrayerDismissAll` | — clears every active overlay | — |
| `SpeakerIdentified` | `Speaker{name}` | Speaker | `SPEAKER_AUTO_DISMISS_MS = 8_000` |
| everything else | `None` | — | — |

Each `route_*` function is also pure (`route_scripture`, `route_song`, `route_speaker`), returning
an `InjectionPlan{category, fields, auto_dismiss_ms}` that a separate async step resolves against
the live template catalog and shows. This pure/async split is exactly why the whole thing was
unit-testable without spinning up a real bible service or DB.

**Known gap worth deliberately avoiding in Verger**: `DmxSceneActivated` dismisses ALL overlays for
*any* lighting scene change, not just prayer scenes specifically — PLAN.md backlog: *"DmxSceneActivated
triggers dismiss_all for ANY scene — add prayer-scene classification... later."* If Verger has a
lighting/scene system feeding this same auto-dismiss idea, classify the scene type up front instead
of wiring a blanket "any scene change clears the screen" rule.

---

## Phase 13 — Theological entity lists

**What they are**: a bundled, curated reference index of ~585 named theological "things a preacher
might refer to without citing chapter/verse" — people, parables, events, doctrines/concepts,
books/themes/symbols — each mapped to a canonical scripture *reference* (never verse text) plus a
short original biographical/descriptive blurb and alternate names. This is METADATA, not scripture
content, and it powers two features: (1) Tier-2 fuzzy Bible-reference detection (Phase 06, above)
and (2) semantic sermon-context suggestions (SermonIntelligence, below).

**How they were built**: six flat JSON arrays under `assets/theological_entities/seed_*.json`,
grep-counted (`"name"` occurrences) at:
```
seed_nt-persons.json:              103
seed_ot-persons.json:               97
seed_books-themes-symbols.json:    102
seed_concepts-doctrines.json:       98
seed_events-places.json:            96
seed_parables-miracles.json:        89
                                  -----
                                    585 total
```
(`PLAN.md`'s Phase-13 summary line says "556 theological entities seeded" — a slightly stale
figure vs. the ~585 the loader doc-comment and the on-disk files now show; use the on-disk count as
ground truth if this ever matters, and don't be surprised the two numbers in the same repo
disagree slightly — the loader's own doc-comment already says "~585" and hedges with "~".)

Each entity (`SeedEntity`):
```json
{
  "name": "Peter",
  "type": "person",
  "primary_scripture": "Matthew 4:18",
  "related_scriptures": ["Matthew 16:18", "John 21:15-17", "Acts 2:14", "1 Peter 1:1"],
  "description": "Simon Peter was a fisherman from Galilee who became one of the twelve apostles and a foundational leader of the early church. He is traditionally regarded as the first bishop of Rome.",
  "aliases": ["Simon Peter", "Cephas", "Simon son of Jonah"]
}
```
(This is one representative record, quoted to show shape — not a bulk dump; each file holds
~90-103 such records across 6 files.) Rust field `type` renames to `entity_type` (`type` is a
keyword). `related_scriptures` and `aliases` both default to empty when absent.

**Loading is idempotent and merge-friendly**:
- Deterministic id = `UUIDv5(NAMESPACE_OID, name.trim())` — the SAME scheme used by the earlier
  inline Phase-06 seeder (25 entities), so the two sources **reconcile by name**: loading the
  richer 585-entity JSON set `ON CONFLICT(name) DO UPDATE` **upserts over** any sparse Phase-06
  row with the same name, while `embedding = COALESCE(excluded.embedding,
  theological_entities.embedding)` **preserves an already-computed embedding** rather than
  clobbering it with NULL when the richer load runs without an embedder available.
- `dedupe_entities()`: case-insensitive dedup by trimmed name, **first occurrence wins**, blank
  names dropped. Pure function, independently unit-tested.
- Without an ONNX/embedding build, `embedding` stays NULL — Tier-2 Aho-Corasick name/alias
  matching still works (it's pure string matching, no vectors needed); only the *semantic*
  suggestion path degrades.

**Vector store built on top of these entities** (`knowledge::vector`, fully pure/no native
extension — no `sqlite-vss`, no FAISS):
- Embeddings persisted as **little-endian f32 byte BLOBs** in a plain SQLite column
  (`encode_embedding`/`decode_embedding` — 4 bytes per dimension, no header).
- `rank_top_k(query, candidates, k, min_score)`: linear cosine scan, sorted descending, truncated
  to k, filtered by `min_score`. Explicitly justified as fine at this scale: *"a few hundred
  entities / N sermons is trivially fast."* A dimension mismatch or zero-magnitude vector yields
  cosine `0.0`, **never `NaN`** (important: `NaN` would break the sort or silently pass a `>=`
  threshold check depending on comparison direction).

**SermonIntelligence** (live sermon-context awareness built on the same entity table):
- Rolling context buffer: `DEFAULT_CONTEXT_WINDOW_MS = 60_000` (60s, vs. SlideMind's separate 10s
  window — a deliberately longer horizon for "what is this sermon about" vs. "should the slide
  change now").
- Repeat-suppression: `DEFAULT_SUPPRESS_MS = 30_000` — the same entity is not re-suggested within
  30s of its last suggestion (`SuggestionTracker`, a simple `HashMap<id, last_suggested_ms>`).
- Suggestion threshold: `DEFAULT_ENTITY_THRESHOLD = 0.45` cosine — notably much lower than the
  Bible-detector's 0.80/0.95 confidence gates, because this is a soft "you might want to know
  about..." suggestion, not an auto-action; **suggestions are operator-confirmed only** — the
  engine "never acts," only ever publishes `SermonContextSuggested`.
- History-recall trigger phrases (EN + KO, substring match) — separate from SlideMind's
  `TRIGGER_PHRASES`, this set specifically detects the preacher referencing a *past* sermon so the
  UI can suggest that prior sermon:
  ```
  last week, last sunday, last time, we studied, we looked at, we talked about, as we saw,
  previously, 지난주, 지난 주, 지난번, 저번에
  ```
- The full-service transcript is separately accumulated (reset on `ServiceStarted`) so
  `ServiceEnded` can trigger post-service indexing of the whole sermon for future semantic search —
  distinct from the rolling 60s live-context window.

---

## Phase 19 — Watchdog / Deadman-switch (PANIC)

### Pure state machine (`PanicPhase`)

Three states — `Idle`, `Panicked`, `Recovering` — with a **hard-coded legal-transition table**;
any illegal transition is logged and the state is left unchanged rather than corrupted:
```
Idle → Panicked      (only legal forward transition from Idle)
Panicked → Recovering
Recovering → Idle
```
Anything else (e.g. `Idle → Recovering`, `Panicked → Idle` directly) is rejected with a
`tracing::warn!` and the current state is returned unchanged. This tiny table is worth copying
verbatim into any TS state machine for the same feature — it prevents "recover" being callable
twice in a row or panic being re-entered mid-recovery from silently corrupting state.

### WatchdogTracker (pure, heartbeat/deadman logic)

```rust
struct WatchdogTracker { last_ping: HashMap<String, u64> }  // module name -> last-ping ms
register(module, now_ms)   // no-op if already registered (won't reset an existing ping)
ping(module, now_ms)       // update/insert heartbeat
deregister(module)         // stop monitoring (e.g. clean shutdown)
tick(now_ms, timeout_ms) -> Vec<String>  // names of modules whose last ping is >= timeout_ms stale
```
Documented default operating cadence: **ping every 5,000ms, timeout at 10,000ms** (i.e. a module
gets 2 missed heartbeats of grace before being declared offline). A background task calls `tick()`
periodically and is responsible for turning stale-module names into `AiModuleOffline`-style events
— the tracker itself does not publish anything, it's pure query logic, independently unit-tested
including exact-boundary cases (`timeout_at_exact_deadline`, `ping_refresh_resets_timer`, "register
does not overwrite an existing ping").

### PanicSystem (the deadman switch itself)

Holds: a `Vec<AbortHandle>` registry (every long-running AI task is expected to register its
`JoinHandle::abort_handle()` right after spawn), the `PanicPhase` mutex, and a `WatchdogTracker`
mutex.

**`activate_panic()` sequence** (this exact order, all steps best-effort/non-fatal past step 1):
1. State machine: `Idle → Panicked`.
2. Flags: `panic_mode = true`, **`director_mode = false`** (force-disable AI director — recovery
   deliberately does NOT auto-re-enable it; the operator must manually re-engage the AI director
   after a panic — "human always wins" applied to recovery too, not just steady-state operation).
3. **Abort every registered AI task handle** (`abort_all_handles()` — drains the `Vec` and calls
   `.abort()` on each).
4. **Emergency neutral-white DMX wash**: raw channel writes to **channels 1-5 at full (255) on
   universe 1** — deliberately bypasses the normal `scene_activate` path (which takes a
   human-override mutex) so PANIC can never be blocked by another lock; covers single-channel
   dimmer / RGB / RGBW / RGBWA fixture layouts with one blanket write.
5. **Stop camera tracking** on every configured camera, best-effort (errors logged, loop
   continues) — but **streaming is deliberately NOT stopped**: the operator may want the broadcast
   to stay live through the emergency; PANIC silences AI + normalizes lighting + parks cameras, it
   does not black out the stream.
6. Publish `PanicActivated` + `ManualModeEngaged` events.

Explicitly deferred in the source comments (real gaps, not implemented): a live render-thread
frame swap to a logo/safe image on panic (needs a wired video frame source that didn't exist yet),
and full AI-handle registration coverage (only the pieces that actually called
`register_abort_handle` at their spawn site get killed — the panic flag is the real backstop for
anything that forgot to register).

**`recover_from_panic()` sequence**:
1. `Panicked → Recovering`.
2. Publish `AiModuleRestored` for each of a **fixed known-module-name list**: `stt`, `slide_mind`,
   `camera_director`, `overlay_forge`, `bible_detector` — and **re-ping the watchdog** for each so
   they immediately read as "live" again post-recovery rather than instantly re-triggering a
   stale-timeout warning.
3. `panic_mode = false`.
4. `Recovering → Idle`.

Honest note in the source: in this build the "AI modules" aren't actually *restarted* (there was
no live socket/engine to reconnect) — each `AiModuleRestored` event is purely a UI signal that
normal mode has resumed. If Verger's AI features are structured as restartable workers/processes,
recovery needs a REAL restart step here, not just an event.

### Confirm-gate placement (human-always-wins for the panic trigger itself)

The module doc is explicit that the backend command executes IMMEDIATELY once called — **all
confirmation logic lives in the UI layer**: either a SPACE-key hold for ≥3 seconds, or a
click-through dialog requiring the operator to type the literal word "PANIC". The backend trusts
the frontend already gated it. (Cross-reference PROBLEMS.md #86: rhema_v2's plain-ESC key was
*documented* as instantly clearing overlays with no hold-confirm, which the blueprint's own UX
rules explicitly forbade for destructive actions — the panic *trigger* itself got 3s-hold-to-arm
right, but ESC-to-clear did not. Don't let one destructive-action confirm pattern (panic) exist
without applying the same discipline to every other destructive one-key action (clear-all, dismiss
overlay, etc.) in Verger's keymap.)

---

## The Content-filter lesson (verbatim, from `PLAN.md`)

> **Content-filter lesson (critical for any bulk-text phase):** never prompt a subagent to
> OUTPUT bulk scripture/lyrics/large copyrighted text — the API content-filter blocks it
> regardless of public-domain status, killing the agent. Route large text via files
> (download / validated seed JSON) and LOAD it in code; agents write code + tiny fixtures
> only. (This is why Phase 03's first dispatch failed and the second succeeded.)

Directly relevant to Verger's own build process (not just the app's runtime behavior): if any
Verger build prompt needs bulk scripture, song lyrics, or other large copyrighted/quasi-copyrighted
text seeded into the app, **do not ask a coding subagent to generate or transcribe that text
inline**. Pre-stage the data as a validated JSON/data file (downloaded or otherwise sourced outside
the agent's own output stream) and have the agent write loader **code** that reads it — the agent's
own conversational output should never contain the bulk text itself, only small fixtures for tests.
This bit rhema_v2 once already (Phase 03's first dispatch failed for exactly this reason).

There is a companion lesson recorded right next to it in `PLAN.md`, also worth carrying over
process-wise (not architecture, but relevant if Verger's own build orchestration uses subagents):
> **Workflow lesson (Phase 04):** in Workflow scripts, build/implementation agents must return
> PROSE (NO `schema`) — a large/strict StructuredOutput schema hit the retry cap and CRASHED the
> whole run... Reserve `schema` only for small outputs (review verdicts).

---

## PROBLEMS.md — every numbered problem (107 total: 24 Critical, 38 High, 33 Medium, 12 Low)

This is a delta audit of rhema_v2 against its own (different, later) blueprint — most items are
**"X was never built"** gaps, not bugs-with-fixes. Read each as "this is what Verger must decide
to build, skip, or build differently," not "this was fixed." Grouped by the source document's own
lettered sections; severity tag kept from the original.

### A. Governance & Foundation
1. (C) The governing spec (`BLUEPRINT.md`) was a 7-line stub pointing at an external Obsidian file
   — every prior "blueprint complete" claim was unverifiable. **Verger: keep the governing spec
   in-repo, never point at an external/personal-vault file the build can't read.**
2. (C) Runtime was built as Tauri+Rust despite an ADR mandating Electron (no documented decision
   to override it). **Moot for Verger — Electron is the actual target — but the lesson is: don't
   silently diverge from a recorded architecture decision without writing a new ADR.**
3. (H) No Electron/Tauri-equivalent hardening ported over for the blueprint's PART 10.4 (asset
   scope lockdown, devtools-disabled release check, updater pubkey pinning).
4. (H) A status/state doc went stale and contradicted the actual completion tracker.
5. (M) Human-escalation-required decisions (blueprint-stub, translation copyright, ML licensing)
   were made autonomously instead of being logged for a human — one was logged as "AUTONOMOUS...
   don't ask, just do it," an anti-pattern worth explicitly avoiding.
6. (M) Toolchain drift: npm used where the spec mandated pnpm; no `engines` pinning for
   reproducibility.
7. (L) A stray 0-byte junk file (`NOT`) survived at repo root from a prior cleanup.
8. (L) Status-log entries ballooned into 20-40 line narratives instead of the mandated 2-line
   format — **discipline the changelog format from day one.**
9. (L) `.env`/`.env.example` both empty — no drafted env-var contract for future cloud keys.

### B. Database
10. (C) Actual schema was a wholesale replacement of the spec'd schema — ~19 different tables,
    several mandated tables/FTS5 virtual tables simply absent.
11. (H) Missing recommended SQLite pragmas beyond WAL+busy_timeout: no `synchronous=NORMAL`,
    `foreign_keys=ON`, `cache_size`, `temp_store=MEMORY`, `mmap_size`. **Verger (better-sqlite3 or
    equivalent): set these explicitly at connection-open, don't rely on defaults.**
12. (H) No startup corruption recovery path (`PRAGMA quick_check`, rename-corrupt-and-restore).
13. (H) No real migration runner / `schema_versions` table — ad-hoc `CREATE TABLE IF NOT EXISTS` +
    error-swallowing `ADD COLUMN` instead. **Use a real migration tool from the start.**
14. (H) Async multi-connection pool (8 connections) instead of the mandated single-writer +
    read-pool model — no write-queue backpressure. **SQLite in Electron: prefer a single writer
    connection/serialized-write-queue pattern; avoid a naive connection pool for the write path.**
15. (H) Secrets (camera passwords, stream keys) stored **in plaintext** in SQLite — no
    OS-keychain-class encryption anywhere. **Verger: use Electron `safeStorage` (or OS keychain via
    `keytar`-equivalent) for any credential/token field, never a plain DB column.**
16. (M) No WAL checkpoint policy, no periodic VACUUM/`foreign_key_check` sweep.
17. (M) A CCLI usage-log table diverged from spec (missing FKs, missing per-display timestamp).
18. (H) No dedicated Bible-translations metadata table (attribution strings, PD flags, API-key
    gating) despite an ADR requiring one.

### C. IPC / Command-Surface Security
19. (C) No centralized IPC-handler wrapper — ~150 Tauri commands had **zero sender validation,
    zero schema-validation layer, zero session lookup** at the boundary. **Verger: build one
    central `safeHandle`-style wrapper for every `ipcMain.handle` from the FIRST command, not
    retrofitted at #150.**
20. (C) No RBAC enforced on the local IPC surface at all — role checks existed only on the remote
    WS layer, so any local renderer code could call destructive hardware commands unconditionally.
21. (C) No centralized payload validation — serde typing only, no reject-and-log layer.
22. (H) No rate limiting anywhere, including on destructive hardware commands.
23. (H) CSP allowed `unsafe-inline`/`unsafe-eval`, reopening an XSS→IPC escalation path.
    **Verger/Electron: strict CSP, `contextIsolation: true`, `nodeIntegration: false`, a narrow
    preload allowlist — don't let the renderer touch privileged IPC directly.**
24. (M) Overly broad filesystem/shell capability grants applied to ALL windows including
    output/stage windows that should get nothing.
25. (M) No IPC message-size cap or high-frequency channel coalescing.

### D. Network servers (REST/WebSocket)
26. (C) A mandated REST API (24 endpoints, health endpoint) was never built at all.
27. (C) WebSocket servers used the wrong ports and a bespoke protocol vs. the spec'd contract (12
    named events never implemented). **Verger: decide the real port/protocol scheme up front and
    keep docs in lock-step — see #104 below for what happens when docs and code drift.**
28. (C) No Host-header allow-list — open to DNS-rebinding attacks.
29. (C) No Origin allow-list — open to cross-site WebSocket hijacking (CSWSH).
30. (H) Remote control server defaulted to binding `0.0.0.0` instead of loopback-first opt-in LAN.
    **Verger: any local server must default to `127.0.0.1`, require explicit operator opt-in to
    bind LAN-wide.**
31. (H) Auth used JWT/HS256 instead of the spec'd hashed-random-token + QR-pairing design.
32. (H) No LAN TLS/wss — tokens and captions traveled plaintext on the LAN, QR codes emitted
    `ws://` with the token in the URL query string (cleartext, proxy-loggable).
33. (H) No WebSocket heartbeat/timeout protocol.
34. (M) No request-id echo/ack correlation on the WS protocol.
35. (M) No per-token rate limiting with proper 429/Retry-After semantics.

### E. AI Pipeline
36. (C) No real vector index (FAISS or equivalent) — a linear cosine scan substituted throughout
    (acceptable at small N — see Phase 13 notes above — but was a spec deviation, not a documented
    decision).
37. (C) No cloud-AI (Claude API) integration stage at all — fully local small-model substitution
    with no consent gate / call-budget / cache table.
38. (H) STT engine substituted (whisper.cpp instead of ONNX Whisper) with a different tiering model
    than spec'd.
39. (H) ALL ML was **off by default** — the default build had transcription/embedding/classification
    fully stubbed out; only opt-in feature flags enabled them, and those flag-gated paths were
    largely **unverified/never compiled** in CI. **Verger: if a feature is off-by-default and
    untested by default, it is effectively unimplemented — track that honestly rather than
    claiming it "exists."**
40. (H) No formal multi-stage ingest pipeline (format-detect→extract→chunk→embed→index→classify→
    cloud) — ad hoc regex/keyword detection substituted.
41. (H) Image embedding (CLIP) and language-ID (FastText) were entirely absent.
42. (M) No model manifest with SHA-256 pinning — models loaded from a local dir by filename with
    zero hash/integrity verification (a real supply-chain gap). **Verger: pin and verify any
    downloaded/bundled model or binary by hash.**
43. (M) Confidence-threshold model differed from the spec's named scripture-confidence bands.

### F. Hardware protocols
44. (M) VISCA-over-IP was missing its 8-byte UDP envelope header (inner payload bytes were
    correct, the wrapper wasn't).
45. (M) Art-Net had no keep-alive resend and no discovery.
46. (M) sACN spec details (multicast formula, terminate/discovery) unverified.
47. (C) NDI was feature-gated-off entirely in the default build; Dante was entirely unaddressed;
    NDI OEM licensing status was untracked in-repo. **If Verger touches NDI, track licensing
    obligations in-repo, not in someone's head.**

### G. Security / Threat model
48. (C) The blueprint's own top-marked threat (DNS rebinding/CSWSH) was fully unmitigated (dupes
    #28-29).
49. (H) No crash-reporting log-scrubbing (moot since no crash reporter existed) and plaintext
    secrets meant any structured log line was a leak risk.
50. (H) No privilege-elevation confirmation flow with on-device confirm + short TTL — token
    generation accepted an arbitrary caller-specified role/TTL.
51. (M) RBAC model used ad hoc functional roles instead of a clean tiered model, and was enforced
    only on the remote surface, never locally (dupes #20).
52. (M) No OS-keychain-class secret backend at all (dupes #15, from the security-architecture
    side).

### H. Legal & licensing — RED FLAGS (read before Verger touches Bible/song/AI content)
53. (C) **No CCLI disclaimer anywhere** in the app (first-run or song-import screens) despite a
    hard requirement to show one.
54. (C) **A Korean Bible translation (개역한글 1961 / KRV) was bundled as "public domain" without
    verification** — PD status is contested, and this was made as an unescalated "autonomous data
    decision." **Verger: get explicit legal/human sign-off before bundling ANY translation whose
    PD status is not ironclad — do not let an agent self-certify copyright status.**
55. (C) **A commercial closed-source app exported an ML detector using AGPL-3.0-licensed tooling
    (Ultralytics YOLOv8)** with no commercial license purchased and no alternative — a real license
    violation, never escalated. **Verger: check the license of every ML tool/model used to
    PRODUCE an asset, not just runtime dependencies — export/training tooling licenses apply too.**
56. (C) No CCLI Streaming License gating — streaming could go live with zero license checks.
57. (C) No auto-composed streaming attribution text, and the songs table lacked the
    writer/copyright/publisher columns needed to generate it.
58. (C) **No "Live AI captions — may contain errors" disclaimer** anywhere captions were shown.
    **Verger: any AI-generated live text output (captions, translations, auto-lower-thirds) needs
    a visible errata disclaimer; this is cheap to add and easy to forget.**
59. (H) No pre-stream warning for songs missing copyright metadata.
60. (H) No attribution UI for copyrighted Bible translations (only the PD-translation half of the
    feature existed).
61. (H) **No EULA/ToS/AI-disclaimer file existed at all** (no "may hallucinate, not theological
    advice" clause anywhere).
62. (M) No in-repo tracker mirroring the blueprint's legal-obligations table (NDI OEM, font
    licenses, etc.).
63. (M) No AV1 encode path and no deliberate off-by-default+warning for HEVC.
64. (L) Older public-domain-looking song/scripture seeds had no documented copyright-clearance
    process even though they spot-checked as fine.

**Verger takeaway for this whole section**: legal/licensing gaps were the single worst category in
this audit (mostly Critical). If Verger bundles any Bible translation, song, or ML
model/tool, get an explicit human decision and a written record BEFORE bundling — never let an
agent self-certify "this is public domain" or "this license is fine for commercial use."

### I. Missing infrastructure (0% built)
65. (C) No auto-update mechanism at all.
66. (C) No crash reporting (no Sentry-equivalent, no opt-out toggle, no scrubbing).
67. (C) **No licence-activation/seat-enforcement system — the product had no monetization gate at
    all.** Directly relevant if Verger is meant to be sold: decide licensing strategy early, it
    was flagged as the single most business-critical infrastructure gap.
68. (C) No server-side component existed (no backend for sync/licensing/analytics) despite an ADR
    assuming one.
69. (C) Multi-seat/campus sync used a bespoke WS relay instead of the spec'd serverless-Postgres
    offline-first sync with conflict resolution — no CRDT, no single-writer lock.
70. (C) Planning Center integration had no OAuth 2.0/PKCE, no webhook HMAC verification — just a
    feature-gated JSON mapper.
71. (H) **No CI at all** — no lint/test/build gate, no signed release pipeline, nothing mechanically
    enforced. **Verger: stand up CI from the first commit, not phase 20.**
72. (H) No SBOM/supply-chain scanning tooling (no dependency vulnerability scanning, no Dependabot).
73. (M) Code signing + native sidecar bundling (ffmpeg/ONNX/NDI) remained unresolved but was at
    least honestly tracked in a human-tasks file.

### J. Startup / shutdown / observability
74. (H) Startup fired every subsystem via fire-and-forget spawns with no health-gating signal
    distinguishing "ready" from "still warming up."
75. (H) **No graceful shutdown sequence** — no live-service confirm prompt, no stream termination
    step, no WAL checkpoint+fsync, no session persist, no hardware release; relied on raw process
    teardown. **Verger: build an explicit graceful-shutdown sequence (esp. flushing the DB and
    releasing hardware handles) rather than relying on process-exit cleanup.**
76. (M) A DB migration/init failure caused a raw panic (`.expect`) instead of a recovery dialog.
77. (M) No exponential-backoff supervised restart for crashed subsystems, no hardware circuit
    breaker.
78. (M) Session restore was an unconditional playlist reload instead of "detect unfinished service
    → offer opt-in resume, output stays black until confirmed."
79. (M) Logging was plain-text stdout only — no structured JSON, no rotation policy.

### K. Frontend render engine
80. (C) No GPU compositor / layered render model — output was plain absolutely-positioned DOM/CSS,
    no frame-budget mechanism.
81. (C) No frame pacing, color management, or "safe rendering mode."
82. (H) No real encoder/bitrate-ladder UI — stream settings were destination CRUD only.
83. (M) No frame-budget/performance warning surface in the status bar.

### L. Frontend UX / psychology rules
84. (C) **A light mode existed and was one click away, despite an explicit design rule that this
    app has NO light mode as a hard invariant, not a preference.** Concrete lesson: when a design
    doc states an invariant that strongly ("not a preference"), don't quietly add the opposite as a
    convenience toggle.
85. (C) No real three-tier progressive-disclosure UI (only a two-way toggle existed; the
    mandated minimal volunteer-mode UI never got built).
86. (H) **ESC key semantics were wrong for a destructive action**: plain ESC instantly cleared
    overlays with no hold-to-confirm, despite a rule requiring a 2-second-hold for exactly this
    kind of action (separate from the panic hold, which WAS done correctly at 3s). **Verger:
    audit every single-keypress destructive shortcut and apply hold-to-confirm consistently, not
    just to the flagship "panic" action.**
87. (H) Touch/click targets for hold-buttons were 28×28px against a documented 48×48 minimum
    (64×64 for "go live"-class controls). **Verger: enforce a minimum hit-target size as a design
    token/lint rule, not tribal knowledge.**
88. (H) A mandated always-visible status bar was missing 2 of 6 required situational-awareness
    items (stream health + viewer count; service elapsed/position).
89. (H) A mandated mid-service "manual check" rehearsal interlude was never built.
90. (H) A mandated passive-monitoring engagement nudge was never built.
91. (H) **No multimodal (audible) alerting** — all alerts were visual-only, meaning a critical
    alert could be missed entirely if the operator wasn't looking at the screen. **Verger: any
    "critical" severity notification needs a non-visual channel too (sound, at minimum).**
92. (H) No end-of-service positive-summary UI (only a manual export utility existed).
93. (M) No streak/progression gamification, no historical accuracy trend view, no
    contextualized (non-blaming) error framing in the UI.
94. (M) **A fully-built alternate status-bar component was never mounted** — dead code competing
    with the real status bar (cross-ref Phase-06 notes above). Concrete "don't build a parallel
    unmounted component" lesson.
95. (M) Design system self-contradicted: components were still named/commented "glassmorphism"
    (`GlassCard`, "frosted glass") while the actual stylesheet had moved to solid surfaces with
    zero blur — naming/comments drifted from the real implementation.
96. (L) An HTML root element hardcoded a dark-mode class while the runtime otherwise claimed to
    support light mode — a second symptom of #84/#95's drift between stated intent and code.
97. (L) No offline-fallback notice on the Bible search UI despite that being a documented
    requirement.

### M. i18n & accessibility
98. (C) **No i18n framework at all** despite 100+ components with hardcoded English strings — the
    only i18n-adjacent code was language pickers for AI caption/translation *targets*, not the
    operator UI itself. **If Verger needs multi-language operator UI (the source app clearly
    intended EN/KO), wire an i18n framework from the first screen, not retrofitted onto 100+
    components later.**
99. (H) WCAG 2.1 AA was unevidenced — ARIA present in only ~20 of 100+ component files, no
    axe-core/jest-axe automated checks, no enforced contrast ratio.

### N. Testing
100. (H) **Zero JS/TS test infrastructure** — no test runner configured at all for the frontend,
     despite ~875 passing Rust tests on the backend. **This is a real, concrete, avoidable
     asymmetry: don't let frontend test coverage lag this far behind backend coverage.**
101. (H) No security-regression test suite (no tests asserting Host/Origin rejection, RBAC denial,
     etc.) — the underlying code paths didn't exist to test in the first place.
102. (H) No soak/chaos/fuzz/pen-test scaffolding, no offline-mode CI proof.
103. (M) Rust tests existed and passed but no coverage-percentage tooling verified the mandated
     per-subsystem thresholds — passing tests existing is not the same as coverage being adequate.

### O. Docs (drift & contradictions)
104. (M) **Docs described a completely different port scheme than the spec, and the docs matched
     the ACTUAL code** — i.e. the drift was consistent and self-reinforcing (nothing flagged it as
     wrong), so a downstream integration (a Stream Deck plugin) targeted a port that literally
     didn't exist per the original spec. **Lesson: "docs match code" is not the same as "docs match
     the design intent" — periodically diff both against the actual governing spec, not just
     against each other.**
105. (M) A shortcuts doc documented the blueprint-violating ESC/PANIC behavior (dupes #86) — again,
     docs and code agreed with each other while both diverged from the design spec.
106. (L) A remote-control-panel subdirectory was excluded from the TypeScript project's type-check
     include list — untyped code shipping silently.
107. (L) A plugin/WASM subsystem was built that the governing blueprint never asked for (scope
     creep) while spec'd subsystems (REST API, licensing) were entirely absent. **Lesson: scope
     creep on optional/interesting subsystems while mandatory ones are skipped is a sign priorities
     drifted — periodically check effort spent against the spec's actual priority order.**

**What checked out** (from the audit's own fairness section, worth knowing what NOT to worry about
re-litigating): VISCA inner byte encoding was correct and unit-tested; the codec-licensing choice
(OpenH264/LGPL FFmpeg) was compliant; the UI was genuinely wired to real backend calls with real
loading/empty states, no mock data gating any page; ~875 Rust tests passed; the remote-control
server did default to loopback when off; a human-tasks file honestly tracked signing/SDK blockers
rather than hiding them.

---

## Verger application notes

What the Electron/TypeScript rebuild should do differently, given the Tauri/Rust engine is **not**
being ported:

1. **Reproduce the sandbox-child-process pattern using Node's `child_process`, not a native
   binary.** Spawn a separate Node process (or a `utilityProcess` in modern Electron, which is
   purpose-built for exactly this) for PPTX/XLSX/DOCX/PDF parsing, talk to it over stdin/stdout
   JSON exactly as rhema_v2 did, enforce the same ~30s kill-timeout, and do the magic-byte + 50MB
   size pre-flight check BEFORE spawning it. Electron's `utilityProcess.fork()` is arguably a
   *better* fit than rhema_v2's raw sibling-binary approach — it gets sandboxing and lifecycle
   management from Electron itself. Do NOT parse untrusted office/PDF files on the main process or
   even a renderer process.
2. **Fix the PPTX per-slide-image gap instead of inheriting it.** When implementing PPTX parsing,
   parse `ppt/slides/_rels/slideN.xml.rels` to map each slide's `r:embed` relationship IDs to their
   `ppt/media/imageN.*` target — this is the one concrete, named, still-open bug in the source
   project. A JS ZIP+XML library (e.g. `jszip` + `fast-xml-parser`) can do this in the sandboxed
   child process the same way.
3. **Route large/bulk text through data files, never through agent-authored code or prose**,
   exactly per the Content-filter lesson above — this applies to Verger's own build process if any
   future prompt needs to seed scripture/song/liturgy text.
4. **Get explicit human legal sign-off before bundling any Bible translation, song, or ML
   tool/model with an ambiguous license** — this was the single worst-scoring category in the whole
   audit (problems #53-64) and every one of the Critical items there was avoidable with one human
   decision logged up front instead of an autonomous agent guess.
5. **Build the IPC security wrapper, RBAC, and rate-limiting from command #1, not command #150.**
   rhema_v2 shipped ~150 unguarded Tauri commands before anyone circled back to add a central
   validation layer, and it never actually got retrofitted. In Electron: a single typed
   `ipcMain.handle` wrapper (schema validation + role check + rate limit) that every handler goes
   through, written before the second IPC handler exists.
6. **Default every local/LAN server to `127.0.0.1`**, require explicit opt-in for LAN-wide binding,
   and add Origin/Host allow-lists before any WebSocket server ships — three of the audit's Critical
   findings were exactly this class of gap (DNS rebinding, CSWSH, blind `0.0.0.0`).
7. **Stand up CI (lint + typecheck + test) at the first commit**, and get frontend test
   infrastructure (Vitest/Playwright) running before the second component ships — the ~875-Rust-
   tests-vs-zero-JS-tests asymmetry in rhema_v2 is a concrete, avoidable failure mode to not repeat
   with Electron/TS.
8. **Use Electron's `safeStorage` (or an OS-keychain wrapper) for every credential/token field**
   from the first schema migration — never a plaintext DB column for a password/API key/stream key.
9. **Reuse the *behavioral* contracts, not the Rust code**: the `Playlist` mutation semantics
   (active-index-follows-by-id across insert/remove/reorder, dense re-indexed `order`, hold-at-
   boundaries `advance`/`previous`), the SlideMind decision-pipeline order (trigger → max-dwell →
   min-dwell → semantic), the `WatchdogTracker`/`PanicPhase` state machine, and the
   two-tier-detector confidence split (0.98 explicit / 0.82 entity-alias) are all pure, well-tested
   logic that should be ported as **TypeScript logic with the same unit tests**, not redesigned from
   scratch. Every one of these modules in rhema_v2 was written to be dependency-injectable
   (fake clocks, injected embeddings, synthetic events) specifically so it was unit-testable without
   a real engine — keep that property in the TS port.
10. **Apply hold-to-confirm consistently across every destructive single-keypress action**, not just
    the flagship PANIC key — rhema_v2 got the 3s-hold right for PANIC but shipped instant-clear on
    plain ESC despite its own design rules requiring the same discipline there (audit #86).
11. **Any live AI-generated on-screen text (captions, auto-suggested lower-thirds, translations)
    needs a visible "may contain errors" disclaimer** baked in from the first version of that
    feature — this was audit item #58, Critical, and trivial to add proactively vs. retrofitting.
12. **Don't build parallel unmounted "for later" UI components** (audit #94's dead
    `ConfidenceStatusBar.tsx`) — build the real status surface directly into the one real status bar
    component from day one.
13. **If Verger's operator UI needs Korean support** (rhema_v2's EN/KO verbal-trigger and
    Bible-reference bilingual work throughout Phases 06/13 strongly suggests the target audience is
    bilingual EN/KO churches), wire an i18n framework in from the first screen — rhema_v2 never did
    this for its 100+ component operator UI and it was flagged as a Critical gap (#98).
