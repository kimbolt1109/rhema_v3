# ASR / AI Pipeline (Whisper two-tier, VAD, hallucination filter, scripture confidence) — mined from rhema_v2

> Sources: `C:\Side projects\rhema_v2\docs\AI_PIPELINE.md`, `C:\Side projects\rhema_v2\config\models.json`,
> `C:\Side projects\rhema_v2\docs\HARDWARE_REQUIREMENTS.md`, `C:\Side projects\rhema_v2\Rhema_Blueprint_v3.4.md`
> (grepped, not read whole — line refs given), `C:\Side projects\rhema_v2\STATUS.md`,
> `C:\Side projects\rhema_v2\PLAN.md` (build-log detail on what actually got implemented/broke — not in the
> original mining brief's file list but directly relevant to VAD thresholds and the hallucination filter, which
> AI_PIPELINE.md only names without specifying).

## 0. Important context: two different tech-stack eras in rhema_v2

`Rhema_Blueprint_v3.4.md` (the master spec) is itself written **for Electron/TypeScript** — ADR-004 (line 77)
explicitly says **"Tauri ruled out: per-OS WebView behavior varies, no NDI/DMX ecosystem."** It specs
`onnxruntime-node`, `faiss-node`, `node-portaudio`, `better-sqlite3`, and gives literal TypeScript
interfaces (see §6 below) for the exact classes Verger should be building.

`docs/AI_PIPELINE.md`, `STATUS.md`, and `PLAN.md` document a **later pivot to Tauri/Rust** (`src-tauri/**`,
`cargo`, `whisper-rs`, `ort` crate) that actually got built out over many cycles — this is the "mature prior
project" the brief refers to. **This Rust engine is NOT being ported to Verger.** But its *design decisions*
(thresholds, gating logic, confidence bands, filter behavior, model registry pattern) are stack-agnostic and:

- Confirm the numbers in the original Electron-flavored blueprint (same 0.95/0.65/0.50 bands, same 500ms/5s
  cadence appear in both eras, ~5 months and a full rewrite apart) — treat these numbers as validated twice.
- Add real-world implementation gotchas (Silero v5 vs v3 I/O shape mismatch, liturgical-repeat false positives
  in the hallucination filter, port-binding mistakes) that the Electron-era blueprint didn't yet know.

The `src-tauri/` directory itself no longer exists in the checked-out rhema_v2 repo (verified: not present under
the repo root) — only the docs/config artifacts survive. Do not go looking for Rust source; it's gone.

## 1. Two-tier Whisper scheduler

**Design (both eras agree):**

| Tier | Model | Cadence | Latency | Purpose |
|---|---|---|---|---|
| Draft | `whisper-tiny-int8` (37 MB) | every ~500ms | ~150ms | word-level timestamps, immediate UI/caption feedback |
| Final | `whisper-large-v3-int8` (375 MB, INT8, <2% WER regression vs fp32) | every ~5s | ~2.5s on CPU | high-accuracy transcript for AI slide matching |

Exact blueprint wording (Rhema_Blueprint_v3.4.md:1180-1185):
```
|Draft transcription|Whisper tiny INT8|Every 500ms → word-level timestamps. Latency ~150ms. For UI feedback.|
|Final transcription|Whisper large-v3 INT8|Every 5s → high-accuracy transcript. Latency ~2.5s on CPU. For AI slide matching.|
|Output: subtitles|IPC → Stage Display|Draft shown immediately. Replaced by final when available. Persistent
  "Live AI captions — may contain errors" marker (ADR-015). Marketed as an aid, never a certified ADA
  accommodation; deaf-ministry copy recommends a human interpreter where accommodation is legally required.|
```

**"Final REPLACES the draft"**: draft text is shown immediately for perceived responsiveness; when the final-tier
result for that time window becomes available, it overwrites the draft segment in place (not appended) — one
subtitle stream, one active hypothesis per window, no diff/merge logic. AI_PIPELINE.md corroborates: "its result
REPLACES the draft."

AI_PIPELINE.md (lines 63-78) frames this as ADR-006 in the Rust era: `TwoTierScheduler` cadence logic is pure
Rust and unconditionally compiled/tested (i.e., testable without any model loaded); only the actual ONNX/whisper.cpp
session is feature-gated. **Design lesson: separate the scheduler's timing/replace logic from the inference
backend so the scheduler can be fully unit-tested with fake/injected transcripts.**

Rust-era engine choice note: whisper.cpp (`whisper-rs`, feature `whisper-stt`) and an ONNX Whisper path (feature
`whisper-onnx`) coexisted during a transition; both fed the same shared `HallucinationFilter`. STATUS.md records
the model actually verified at runtime was `ggml-small.bin` (Standard tier, not large-v3 — the owner's dropped
model file), transcribing successfully with "silence → filtered, as designed" (see §3).

## 2. Silero VAD gating — exact thresholds

**Not in AI_PIPELINE.md or the blueprint text** (blueprint doesn't spell out VAD numbers) — these exact
thresholds come from STATUS.md's Cycle 5 build log (Phase 05), which is the only source that states them:

> "Silero VAD engine + speech-gate state machine (**open >0.5×2 chunks, close <0.35×8 chunks, 500ms pre-roll**)."
> — STATUS.md:188

Read as a state machine:
- **Open (speech starts)**: probability > 0.5 for **2 consecutive chunks**.
- **Close (speech ends / hangover)**: probability < 0.35 for **8 consecutive chunks** — i.e. the hangover is
  asymmetric and biased toward staying "open" (8 low-confidence chunks required to close vs only 2 high-confidence
  chunks to open), which avoids clipping words at the end of an utterance.
- **Pre-roll**: 500ms of audio captured *before* the open transition is retained/prepended, so the buffer sent
  to Whisper isn't missing the first syllable while VAD was still deciding.

Audio pipeline feeding it: `cpal` audio capture → **16kHz mono ring buffer** (STATUS.md:187), matching the
blueprint's ADR-007/PART-7.3 spec: **16kHz mono PCM, buffer 512 samples (32ms), ASIO if available** on Windows
(Rhema_Blueprint_v3.4.md:1180, ADR-007 line 114-118). Chunk size for VAD itself isn't stated beyond "chunks" —
Silero v5 canonically expects 512-sample (32ms @16kHz) or 256-sample windows; treat the ring-buffer's native
32ms/512-sample framing as the VAD chunk unless you have reason to differ.

**Model version gotcha (STATUS.md:988-990, a real bug that was hit and fixed):**
> "Silero engine rewritten for the **v5** model the owner supplied (single combined `state`↔`stateN`, scalar
> `sr`, outputs `output`/`stateN`) — the Cycle-5 code assumed v3 `h`/`c` and failed at runtime with 'Invalid
> input name: h'. Caught by the smoke test."

`config/models.json` pins `silero-vad-v5` (`silero_vad.onnx`, MIT, 2,327,524 bytes, source
`github.com/snakers4/silero-vad`) — **confirm you are integrating the v5 ONNX I/O contract** (single
`state`/`stateN` recurrent tensor + scalar sample-rate input, output tensors named `output`/`stateN`), not the
older v3/v4 shape (`h`/`c` LSTM-style state pair). This is a common integration trap for any Silero ONNX wrapper,
not Rust-specific — the same mismatch will bite a Node.js `onnxruntime-node` integration if you copy a v3-era
example.

## 3. HallucinationFilter — exact rules

AI_PIPELINE.md only names it ("The shared `HallucinationFilter` cleans both backends' output identically. Stub
inference surfaces as an error, never fabricated text" — line 77-78) without listing rules. The concrete rule
that *is* documented, from a real bug fix (STATUS.md:219, Cycle 5 post-review fix #3):

> "hallucination filter now preserves **≤3 liturgical repeats** ('holy holy holy') **while still collapsing long
> runs** — worship-specific correctness."

Read this as: the filter's default behavior is to collapse repeated-word/phrase runs (a standard Whisper
hallucination pattern — Whisper is known to loop on repeated tokens during silence or noise), but a naive
repeat-collapse breaks legitimate liturgical/worship repetition ("Holy, holy, holy", "Hallelujah hallelujah
hallelujah"). The fix: **allow up to 3 repeats of the same word/phrase to pass through unmodified; only collapse
runs longer than 3.**

Corroborating signal: the smoke test in STATUS.md:1000-1001 verified "Whisper loads `ggml-small.bin` and
transcribes (**silence → filtered, as designed**)" — i.e., the filter (or the VAD gate upstream of it) is
expected to suppress Whisper's well-known tendency to emit phantom text ("Thank you for watching", "Subscribe",
etc.) during silence/no-speech segments. No exact phrase blocklist is recorded in the surviving docs — if Verger
needs one, standard Whisper hallucination phrases during silence (channel outros, "thanks for watching",
repeated single words) are a known public list to seed from; rhema_v2's docs don't give you a verbatim list to
copy.

**Also documented: a 30-second max-utterance staging cap** (STATUS.md:220, fix #4 same cycle): "30s max-utterance
staging cap + spawn_blocking TODO" — i.e. the buffer accumulating audio for one utterance is hard-capped at 30s
so a VAD failure-to-close (stuck "open") can't grow the buffer unboundedly or block Whisper indefinitely on a
single giant utterance.

## 4. Scripture confidence bands — exact numbers

Two independently-stated, numerically consistent sets exist (Electron-era blueprint uses 4 bands with slightly
different framing than the Rust-era's 3-band `ConfidenceBand`; treat the Rust-era `confidence.rs` framing as
canonical for Verger since it's the more recent, more precisely specified version):

**AI_PIPELINE.md (Rust era, PART 7.4, canonical for implementation):**
> "The PART 7.4 scripture-confidence bands: **`0.95`** (exact/abbreviation → auto-queue, eligible to auto-show),
> **`0.65`** (Levenshtein-1 → show with `?`), **`0.50`** (Levenshtein-2 → show with `?`), **below `0.50` →
> discard**. `ConfidenceBand::classify` maps a raw score; `should_auto_show` enforces the auto-show gate (AI
> mode = auto AND confidence `> 0.95` AND verse text resolved — never invented scripture). Wired into
> `slidemind::handle_bible`."

**Rhema_Blueprint_v3.4.md (Electron era, PART 7.4, line 1193-1194) — same shape, slightly different band edges:**
> "Confidence threshold: exact reference > 0.95 → auto-queue in AI suggestion panel. Fuzzy 0.70–0.95 → show with
> '?' indicator. Below 0.70 → discard."
> "Auto-show to the congregation only if `AI mode = 'auto'` AND confidence > 0.95 AND the reference resolved to
> real text. Otherwise it waits in the operator's suggestion panel for confirmation."

**Discrepancy note (flag for the implementer):** the Electron-era blueprint's discard line is `< 0.70`; the
later Rust-era `confidence.rs` spec discards only `< 0.50` and adds an intermediate 0.65 band. The Rust version
is the more mature/later design (it's what actually shipped and was tested — STATUS.md:1114 confirms "confidence
bands 0.95/0.65/0.50" landed and passed 1156 lib tests). **Use 0.95 / 0.65 / 0.50 / discard-below-0.50 as the
spec for Verger.**

**Exact scoring rubric for the reference-detection step itself** (`ScriptureNER`, Rhema_Blueprint_v3.4.md
lines 2917-2925 — this is the score that then gets classified into the bands above):
```
Explicit abbreviation match: 0.95
Full book name match: 0.98
Levenshtein-1 match: 0.65
Levenshtein-2 match: 0.50
"spoken form" (no verse number): 0.40
```
Levenshtein rule: "If a word within 2 characters of a known book name precedes a chapter:verse pattern: treat as
low-confidence detection (0.50–0.70)." Example given: `"Jon 3:16"` → matches `"Jon"` at Levenshtein distance 1
from `"John"` → confidence 0.65.

Rust-era Bible auto-detector (STATUS.md:238-240) is a **2-tier design**:
- **Tier 1**: regex explicit references (EN + KO), pure-language, no model — confidence **0.98** on explicit match.
- **Tier 2**: AhoCorasick match over a seeded `theological_entities` table (~25 entities initially, later "~556
  entity names + aliases" per PLAN.md:197-198) — **metadata only, never scripture text** — confidence **0.82**
  for an entity match. PLAN.md flags a real tuning risk: "broad single-word names may raise false positives
  (tuning deferred)" — worth building a stopword/ambiguity guard for common-word entity aliases in Verger rather
  than discovering it in production.

## 5. The "never auto-show unless verse text resolved" gate

This is a hard, repeatedly-restated rule across both eras — implement it as a single gate function, not scattered
checks:

- **ADR-015 (Rhema_Blueprint_v3.4.md:190, :1190):** verse *text* resolution is **non-generative** — the detected
  *reference* (e.g. "John 3:16") may come from fuzzy/regex/NER matching, but the *text* shown to the congregation
  is always looked up from a configured Bible source (bundled public-domain KJV/WEB/ASV, or a licensed API —
  ESV API / API.Bible). **A generative model must never produce verse text.** Documented real-world justification
  cited in the blueprint: "an LLM fabricated a non-existent 'John 5:5' quote (Missio Nexus, 2024)."
  - If the reference cannot be resolved in the configured source: show the **reference only** plus an inline
    "verse text unavailable in [translation]" note — **never invented text**.
- **Auto-show gate, stated identically in both eras:** `AI mode == 'auto'` **AND** `confidence > 0.95` **AND**
  the reference **actually resolved to real verse text**. All three conditions required; fail any one → the
  suggestion sits in the operator's confirmation panel instead of going live. AI_PIPELINE.md's
  `should_auto_show()` function name/shape: gate = `mode == Auto && confidence > 0.95 && verse_resolved`.
- **Fatigue/long-service exception is scoped to the *suggestion* threshold only, never the auto-show threshold**
  (Rhema_Blueprint_v3.4.md:2418, FATIGUE-1): after 90 minutes of service, the threshold at which Rhema *proposes*
  a suggestion to the operator may drop from 0.80 → 0.70 (configurable) — making the assist panel more eager to
  help a tired operator — but **"the threshold for unattended auto-advance to the congregation stays fixed at
  > 0.95 regardless of service length."** Model this as two entirely separate threshold variables in Verger: a
  tunable `suggestThreshold` and an immutable `autoShowThreshold` — never let a single "confidence knob"
  accidentally govern both.
- General principle stated once more, generically (Rhema_Blueprint_v3.4.md:183-189): **all AI-produced
  congregation-facing text is advisory by default**; auto-advanced lyrics only ever select among slides the
  operator already loaded for the service (closed set) — the AI "never generates lyric text," bounding failure
  mode to "wrong existing slide" rather than fabricated content. Apply the same closed-set principle to any
  Verger AI-driven slide/verse selection.

## 6. SlideMind confidence-gated switching — exact thresholds

From HARDWARE_REQUIREMENTS.md:49 — "confidence-gated AI slide switching (**80% recommend, 95% auto-advance**)."

Rust-era implementation detail (STATUS.md:234-266, Cycle 6): pure-Rust `switch_score = relevance_next −
relevance_current`; gates read from `settings.ai` as three bands (`> auto` / `> recommend` / else ignore);
`director-mode` chooses auto-vs-recommend behavior; **manual override (spacebar) ALWAYS wins** regardless of AI
state — verified in review as real, not cosmetic: "engine never calls slide commands, re-syncs from the same
`Arc<RwLock<u32>>` manual control writes." A late review fix (STATUS.md:265) corrected the recommend-band
**lower bound to be inclusive** (`>=`) so it matches the documented "0.80–0.95" band exactly, while the
**auto-advance bound stays exclusive** (`> 0.95`) — i.e. **recommend is `[0.80, 0.95]` closed-open... actually
inclusive at 0.80, and auto fires strictly above 0.95, leaving `(0.95]` as a razor's edge you should decide
deliberately in Verger** rather than copy blindly (the exact boundary-inclusivity choice at 0.95 itself isn't
pinned down beyond "auto stays exclusive `>`").

Also relevant, from HARDWARE_REQUIREMENTS.md:52 — "Sermon Intelligence: 60-second context window" for the
sermon-indexing feature (separate from the SlideMind slide-switch window).

## 7. Streaming partial cadence (subtitle/caption delivery)

- Draft (tiny model) fires **every ~500ms**, replaced in place by final (large-v3) **every ~5s** — see §1.
- Blueprint's SemanticSlideMatcher spec (Rhema_Blueprint_v3.4.md:1240) treats the **final transcript** as
  "a 5-second segment of speech, pre-cleaned" — i.e. AI slide-matching runs against 5-second final-tier windows,
  not the 500ms draft stream. Total latency budget from transcript receipt to a slide-match result: **< 500ms on
  an Intel i5 CPU**; embedding inference **< 50ms per 5s segment** (MiniLM-L6 INT8 CPU); FAISS flat search
  **< 5ms for < 50,000 vectors**.
- Each additional caption target language adds **~50ms latency** (HARDWARE_REQUIREMENTS.md:132).
- Caption delivery transport (Rust era, Phase 05): a JWT-gated WebSocket caption server. **Bind address is a
  real gotcha that was fixed mid-project**: default `127.0.0.1:8765` is wrong for this feature — the caption
  server needs to be reachable by attendee phones on the LAN, so it must bind **`0.0.0.0:8765`**, distinct from
  the *operator* control API which correctly stays on `127.0.0.1` (a separate Phase-17 server). STATUS.md:216-217:
  "caption WS server bind 127.0.0.1→0.0.0.0 — DELIBERATE: the deliverable requires attendee phones to join over
  LAN, gated by the HS256 JWT; the 127.0.0.1 default belongs to the operator control-API." Also served as a PWA
  reachable via the operator machine's LAN IP, with a QR code for attendees to join (HARDWARE_REQUIREMENTS.md:47:
  "127.0.0.1:8765 PWA, reached by attendees via the operator machine's LAN IP" — note this line in
  HARDWARE_REQUIREMENTS.md predates/contradicts the later 0.0.0.0 fix; trust the STATUS.md fix, it's the actual
  shipped behavior). **Other ports in the same system, for context/collision-avoidance:** remote-control
  WebSocket on **7320**, REST API on **7321** (Rhema_Blueprint_v3.4.md:907,936; HARDWARE_REQUIREMENTS.md:53).
- WS heartbeat pattern used across these servers (remote/caption/campus): server pings every 10s; client must
  pong within 5s or the socket is closed with code `4002` / reason `HEARTBEAT_TIMEOUT` (Rhema_Blueprint_v3.4.md:
  2971-3006, confirmed shipped per STATUS.md Cycle 34).
- Persistent UI affordance requirement: captions must carry a **standing, non-dismissible** "Live AI captions —
  may contain errors" marker (ADR-015) — marketed as an aid, explicitly never a certified ADA accommodation.

## 8. Model registry + SHA-256 pin pattern

**Entry shape** (both eras agree, `config/models.json` schemaVersion 1):
```json
{ "id": "string", "file": "relative/path", "sha256": "hex-or-empty", "sizeBytes": 0, "license": "string", "source": "url-or-bundled" }
```

**The rule, verbatim (config/models.json top-level `"//"` comment):**
> "Model registry with SHA-256 pins (Blueprint PART 7.1, threat T12 supply-chain defense). The loader computes
> each file's SHA-256 before load and REFUSES to load on mismatch. Models not listed here load with a
> pass-with-warning (unknown model) so existing working paths never hard-fail; add a pin below to enforce a
> model. **`sha256 == ""` means the pin is not yet captured** (the file hasn't been provisioned on this machine)
> and the loader treats it as unpinned pass-with-warning."

So there are exactly **three outcomes** for a load attempt, not two:
1. **Known id + non-empty pinned `sha256` + hash matches** → load.
2. **Known id + non-empty pinned `sha256` + hash mismatch** → **REFUSE to load** (hard fail, supply-chain defense).
3. **Unknown id, OR known id with empty `sha256`** → **load anyway, emit a warning** ("pass-with-warning") — this
   is deliberate, not a bug: "existing working paths never hard-fail." AI_PIPELINE.md (line 94-105) restates this
   identically for the Rust implementation (`resources/model_registry.rs`) and notes it's wired into the MiniLM,
   RT-DETR, CLIP, and ONNX-Whisper loaders specifically.

**Live model registry contents at time of mining** (every entry in `config/models.json` currently has
`"sha256": ""` — i.e. every single model in the registry is *unpinned* / pass-with-warning today; none are
hash-enforced yet):

| id | file | sizeBytes | license | source |
|---|---|---|---|---|
| whisper-large-v3-int8 | ggml-large-v3-turbo.bin | 393,216,000 | MIT | huggingface.co/ggerganov/whisper.cpp |
| whisper-tiny-int8 | ggml-tiny.bin | 38,797,000 | MIT | huggingface.co/ggerganov/whisper.cpp |
| whisper-small-int8 | ggml-small.bin | 244,000,000 | MIT | huggingface.co/ggerganov/whisper.cpp |
| whisper-large-v3-onnx-encoder-int8 | whisper-large-v3/encoder_model.onnx | 393,216,000 | MIT | huggingface.co/onnx-community/whisper-large-v3-turbo |
| whisper-large-v3-onnx-decoder-int8 | whisper-large-v3/decoder_model_merged.onnx | 200,000,000 | MIT | huggingface.co/onnx-community/whisper-large-v3-turbo |
| whisper-tiny-onnx-encoder-int8 | whisper-tiny/encoder_model.onnx | 37,000,000 | MIT | huggingface.co/onnx-community/whisper-tiny |
| whisper-tiny-onnx-decoder-int8 | whisper-tiny/decoder_model_merged.onnx | 20,000,000 | MIT | huggingface.co/onnx-community/whisper-tiny |
| all-minilm-l6-v2-int8 | minilm/model.onnx | 23,068,672 | Apache-2.0 | huggingface.co/sentence-transformers/all-MiniLM-L6-v2 |
| multilingual-minilm-l12 | minilm-multilingual/model.onnx | 123,731,968 | Apache-2.0 | huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 |
| silero-vad-v5 | silero_vad.onnx | 2,327,524 | MIT | github.com/snakers4/silero-vad |
| rtdetr-r18-int8 | rtdetr-r18.onnx | 78,643,200 | Apache-2.0 | github.com/lyuwenyu/RT-DETR |
| clip-vit-b32-int8 | clip-vit-b32/model.onnx | 157,286,400 | MIT | huggingface.co/openai/clip-vit-base-patch32 |
| rhema-classifier-v1 | rhema-classifier-v1.onnx | 1,048,576 | Proprietary-Rhema | bundled |
| fasttext-lid-176 | lid.176.bin | 131,266,198 | CC-BY-SA-3.0 | fasttext.cc |
| nllb-200-distilled-600m-int8 | nllb/model.onnx | 629,145,600 | CC-BY-NC-4.0 | huggingface.co/facebook/nllb-200-distilled-600M |

Note the **YOLOv8 → RT-DETR swap** (AI_PIPELINE.md §"RT-DETR detector swap", line 107-116): the blueprint's
original camera-tracking model, YOLOv8, is **AGPL-3.0** (Ultralytics), a licensing blocker for commercial
distribution unless an Ultralytics commercial license is held (Rhema_Blueprint_v3.4.md:1114, flagged `(H)` —
legal must confirm). The later Rust build swapped to `rtdetr-r18-int8` (Apache-2.0, `lyuwenyu/RT-DETR`,
end-to-end, sigmoid scores, no NMS needed) specifically to clear that license blocker. **If Verger does any
person/camera detection, do not default to YOLOv8/Ultralytics — use RT-DETR or another Apache/MIT-licensed
detector**, or explicitly budget for an Ultralytics commercial license.

Also note: `nllb-200-distilled-600m-int8` is **CC-BY-NC-4.0 — non-commercial only**. If Verger ships NLLB
translation in a commercial product, this license needs the same `(H)` legal flag the blueprint gives YOLOv8.

Rust-era runtime note (STATUS.md:965-1033, Cycle 22-23): models are **not bundled in the installer** — loaded at
runtime from a user-writable path (`~/.rhema/models/` in the Rust build) and downloaded from HuggingFace on first
use when a feature is enabled and the file is absent. Real model files that were verified working: `ggml-small.bin`
(not large-v3 — Standard tier default in practice), `ggml-tiny.bin` (Lite fallback), MiniLM `model.onnx` +
`tokenizer.json`, `silero_vad.onnx` (v5), later also InsightFace `buffalo_l` (`det_10g.onnx` + `w600k_r50.onnx`),
a locally-exported `yolov8n.onnx` (superseded by RT-DETR per the license swap above, kept for reference), and
Xenova's NLLB-200-distilled-600M quantized encoder + non-merged decoder + tokenizer (~900MB total).

**Toolchain gotchas hit integrating ONNX Runtime (`ort` crate) that likely have JS/Node equivalents to watch
for:** `ort` needed `features=["std","download-binaries"]` to statically link a version-matched onnxruntime;
without `std` a used API (`commit_from_file`) wasn't available. An `ort` API rename across versions
(`try_extract_raw_tensor` → `try_extract_tensor`, changed return shape to `(&Shape, &[T])`) broke 6 call sites
during a version bump — **pin your onnxruntime binding version and re-verify all extract-tensor call sites on
any upgrade.** (`onnxruntime-node`'s API surface is different but the lesson — pin the version, expect breaking
renames on minor bumps — transfers.)

## 9. GPU/CPU tiering and expected latencies

From HARDWARE_REQUIREMENTS.md (full tier table, condensed to AI-relevant rows):

| Tier | RAM | AI features unlocked | Parallel inference tasks |
|---|---|---|---|
| Lite | 8GB | **None** — "SlideMind, speech-to-text, biometrics are disabled" | 0 |
| Standard (default) | 16GB | Live captions (Whisper), NLLB translation, SlideMind, Bible auto-detect, Sermon Intelligence | **1** (strict FIFO — "if caption processing is running, SlideMind pauses") |
| Pro | 32GB+ | + AI Camera Director (YOLOv8/RT-DETR), speaker biometrics (FaceNet + x-vector), multi-campus, local LLM (sermon summary) | **4+** concurrent |

Auto-detection on first launch (HARDWARE_REQUIREMENTS.md:117-125): detect RAM via sysinfo →
`<8GB` → Lite with warning; `8–15GB` → Lite; `16–31GB` → Standard (recommended); `32+GB` → Pro (recommended).
Operator can override in Settings.

**CPU/GPU specifics per tier:**
- Standard: 6+ cores ("Whisper transcription is CPU-intensive"); GPU optional, "improves transcription latency"
  (NVIDIA CUDA or AMD ROCm).
- Pro: 12+ cores; GPU **strongly recommended**, "NVIDIA RTX 3060+ or AMD equivalent for **<5ms inference**"; 6+GB
  VRAM.
- ONNX Runtime backend selection per platform (ADR-006, Rhema_Blueprint_v3.4.md:112): **DirectML on Windows,
  Core ML on macOS Apple Silicon**, CPU fallback everywhere — "from one API." This is the abstraction Verger's
  Node/Electron ONNX binding (`onnxruntime-node`) should also lean on rather than hand-rolling per-platform
  branches.
- Transcription runs at **16kHz** regardless of tier; "lower quality = faster" is the stated Standard-tier
  tuning lever (HARDWARE_REQUIREMENTS.md:135).
- Feature-gate mapping (HARDWARE_REQUIREMENTS.md:100-113): `whisper-stt` + `onnx-inference` → Standard+
  (~500MB model download); general `onnx-inference` (biometrics/embeddings) → Standard+; camera/NDI/local-llm
  features → Pro only.
- Startup discipline: AI model loading happens **in the background after the UI is interactive** — "startup is
  never gated on the 375MB Whisper load," surfaced instead as an "AI warming up" indicator
  (Rhema_Blueprint_v3.4.md:331). Apply the same pattern in Verger: never block first paint on ONNX/model load.

## 10. Audio format / sample rate (confirmed twice, both eras agree)

- **16kHz mono PCM** input, everywhere in the pipeline (VAD, both Whisper tiers).
- Capture buffer: **512 samples = 32ms** at 16kHz (Rhema_Blueprint_v3.4.md:1180); ASIO used on Windows when
  available for sub-10ms latency (ADR-007), Core Audio on macOS.
- Rust-era capture library: `cpal` → resampled to a 16kHz mono ring buffer. A **separate, not-yet-wired** raw
  48kHz capture path is called out for LTC timecode (PLAN.md:181-183) — don't conflate the 48kHz timecode-audio
  need with the 16kHz ASR need if Verger ever touches timecode.
- ASIO buffer-size rationale for the general audio ADR (not ASR-specific but same subsystem, ADR-007 line 118):
  "buffer sizes of 64–256 samples (1.5–5.8ms at 44.1kHz)."

## Verger application notes

Given the Tauri/Rust engine is **not** being ported, and Verger is Electron/TypeScript:

1. **Follow the Electron-era blueprint's literal API shapes, not the Rust module names.** The blueprint's own
   `SemanticSlideMatcher` spec (Rhema_Blueprint_v3.4.md:1197-1258) already gives you a ready-to-implement
   TypeScript class using `onnxruntime-node` + `faiss-node` + `better-sqlite3` — this is a truer template for
   Verger than anything in AI_PIPELINE.md's Rust code. Key shape to reuse directly:
   ```ts
   class SemanticSlideMatcher {
     constructor(embeddingModel: ONNXEmbeddingModel, faissIndex: FaissIndex, db: Database) {}
     async matchTranscript(transcript: string, context: MatchContext): Promise<SlideMatch | null>
   }
   // MatchContext: { currentSlideId, serviceId, mode: 'song'|'sermon'|'scripture', confidenceThreshold: number /* default 0.75 */ }
   // SlideMatch: { slideId, confidence: number /* 0.0-1.0 cosine */, reason: string, chunkText: string }
   ```
   Algorithm: embed transcript (same model used for indexing) → L2-normalize → FAISS `search(embedding, k=5)` →
   join chunks from SQLite by `faiss_idx` → filter by `source_type == mode` and by `serviceId` → if top score >
   `confidenceThreshold` return match else null. Errors (FAISS error, embedding error, empty index) all resolve
   to `null`, never throw — log and degrade, don't crash the caption/slide pipeline.

2. **Port the exact numeric thresholds, not the Rust code.** Everything in §1-§7 above (500ms/5s cadence,
   0.5/0.35/2-chunks/8-chunks/500ms-pre-roll VAD gate, 0.95/0.65/0.50 confidence bands, 0.80/0.95 SlideMind
   gate, ≤3-repeat hallucination-filter carve-out, 30s max-utterance cap) is stack-agnostic behavior spec. Treat
   it as the acceptance criteria for Verger's Prompt 7/8 implementations regardless of what runtime executes it.

3. **`onnxruntime-node` is the direct equivalent of the Rust `ort` crate** — same DirectML/CoreML/CPU backend
   story applies (ADR-006). Expect the same class of pitfall the Rust build hit: pin the exact `onnxruntime-node`
   version and re-verify every tensor-extraction call site on any upgrade (see §8 toolchain gotchas) — the
   equivalent Node API surface (`session.run()`, output tensor access) has had breaking changes across versions
   historically too.

4. **Silero VAD v5 I/O contract is the one detail most likely to bite Verger exactly as it bit rhema_v2.** Verify
   whatever ONNX Silero wrapper you use (or write) expects the v5 shape (single `state`/`stateN` recurrent
   tensor + scalar `sr` input, `output`/`stateN` outputs) before wiring it up — many public examples online are
   still v3/v4-shaped (`h`/`c` LSTM state pair) and will fail with an "invalid input name" error identical to
   the one rhema_v2 hit.

5. **Model files should not be bundled in the Electron installer.** Mirror rhema_v2's Rust-era pattern: ship no
   model weights, download to a user-writable app-data directory on first enable of a feature, verify SHA-256
   against `config/models.json` before load. Adopt the exact three-way pass/refuse/warn semantics from §8 — it's
   a deliberately permissive default (empty pin = warn, not refuse) that keeps a fresh Verger install usable
   before pins are filled in, while still giving you a real supply-chain gate once you populate real hashes.

6. **Do not default to YOLOv8/Ultralytics for any camera/person-detection work** — it's AGPL-3.0 and was
   specifically swapped out in rhema_v2 for RT-DETR (Apache-2.0) over licensing. Same caution for
   `nllb-200-distilled-600m-int8` (CC-BY-NC-4.0, non-commercial) if Verger ships translation commercially.

7. **Bind captions/remote WebSocket servers deliberately, not by copying a `127.0.0.1` default.** rhema_v2 shipped
   the wrong bind address once (caption server defaulted to loopback-only, then had to be fixed to `0.0.0.0` for
   LAN-reachable attendee devices, while the separate operator control API correctly stays on `127.0.0.1`). Decide
   Verger's caption-server bind address up front based on whether it needs LAN reachability, and gate it with a
   token/JWT exactly because it's LAN-exposed.

8. **Verse text must never come from a generative/LLM path in Verger, full stop** — resolve references against a
   local Bible database/API only, and implement the auto-show gate (§5) as one single function with three
   required conditions (`mode==='auto' && confidence>0.95 && verseResolved`), not scattered inline checks that
   could drift out of sync.

9. **No `src-tauri` source survives to port.** AI_PIPELINE.md is a design document, not a code source — Verger's
   implementers should treat every Rust file path mentioned in it (`stt/whisper_onnx.rs`, `knowledge/confidence.rs`,
   `resources/model_registry.rs`, etc.) as **naming a design concept to reimplement in TypeScript**, not a file to
   look up or copy from.
