# `whisper_sidecar.py` — Verger's local ASR sidecar

This directory holds the Python process that runs **faster-whisper** on the operator's own
machine. It is Verger's offline recogniser: when the internet dies mid-service — and the internet
is already carrying the stream — this is what keeps a transcript arriving.

It is spawned and supervised by `src/main/asr/WhisperProvider.ts`. Nothing else talks to it.

---

## 1. What it is

A single dependency-light Python file. It has no server, no config file, no state on disk and no
network listener. It reads audio from stdin, writes JSON to stdout, and exits when stdin closes.

| | |
|---|---|
| **Interpreter** | `resources/asr-venv/` (gitignored, provisioned per machine) |
| **Engine** | `faster-whisper` on top of `ctranslate2` |
| **VAD** | faster-whisper's built-in Silero **v5** (`vad_filter=True`) |
| **Audio in** | 16 kHz, mono, signed 16-bit little-endian, raw — no WAV header |
| **Protocol out** | one JSON object per line on **stdout**; diagnostics on **stderr** |

The audio format is not negotiable: it must match `ASR_SAMPLE_RATE`, `ASR_CHANNELS` and
`ASR_BITS_PER_SAMPLE` in `src/shared/asr.ts`. Change one side alone and you get chipmunks.

---

## 2. The two-tier scheduler

From `docs/v2-notes/ASR_PIPELINE.md` §1, which records the design as having survived two full
rewrites of the prior project unchanged:

| Tier | Model | Cadence | Emits |
|---|---|---|---|
| **draft** | `tiny` | every ~500 ms | `isFinal: false`, `isDraft: true` |
| **final** | `small` | every ~5 s | `isFinal: true`, `isDraft: false` |

**Both carry the same `id`.** The final *replaces* the draft in place — it is not appended, and
there is no diff or merge step. One subtitle stream, one live hypothesis per window. A consumer
keys on `id` and replaces; it must never append until `isFinal` arrives, or the transcript panel
flickers half-heard sentences at the operator.

The id increments only when a final is emitted. On the TypeScript side each id is additionally
prefixed with a restart epoch (`w1-w3`, `w2-w0`, …) so that a sidecar restart — which resets the
Python counter to zero — cannot overwrite transcript the operator has already read.

The note specifies `large-v3` for the final tier. **We deliberately use `small`** — see §5.

### A latency note that is easy to lose

The draft tier runs with `temperature=0.0` and the compression-ratio / logprob fallbacks
disabled. Whisper's default temperature ladder retries the same window up to six times whenever
those thresholds trip, and a half-finished sentence — the draft tier's *normal* input — trips them
constantly. Measured on the dev machine that turned a ~0.7 s `tiny` pass into ~4.5 s, which
defeats the entire purpose of having a draft tier. The final tier keeps the full ladder: that is
where accuracy is supposed to live.

---

## 3. The stdin/stdout protocol

### stdin

1. **One line of JSON**, terminated by `\n`. Read with `readline()` on the *buffered* reader, so
   any PCM that arrived in the same TCP-ish read stays queued rather than being eaten.
2. **Then raw PCM**, forever, until the pipe closes.

Config fields (all optional; every one is validated and clamped):

```jsonc
{
  "draftModel":    "tiny",     // allow-listed model sizes only
  "finalModel":    "small",
  "language":      "ko",       // "ko" | "en"; omit to let Whisper detect
  "device":        "auto",     // "auto" | "cuda" | "cpu"
  "computeType":   "auto",     // "auto" | "int8" | "int8_float16" | "float16" | "float32"
  "customVocabulary": ["Pastor Name", "Church Name", "Hymn Title"],
  "draftIntervalMs":  500,
  "finalIntervalMs":  5000,
  "maxUtteranceMs":   30000,   // hard cap; a stuck-open VAD cannot grow the buffer past this
  "maxVramMb":        4096,    // model downgrade budget, see §5
  "beamSize":         1,
  "vadThreshold":     0.5,
  "vadMinSilenceMs":  500,
  "vadSpeechPadMs":   400,     // the note's 500 ms pre-roll, so the first syllable is not clipped
  "downloadRoot":     null,    // override the HuggingFace cache location
  "localFilesOnly":   false    // true = never touch the network; fail if weights are absent
}
```

`localModel` reaches this process from operator settings as a free-form string, and
faster-whisper would happily read an arbitrary string as a HuggingFace repo id or a local
directory to load weights from. `ALLOWED_MODELS` is an allow-list precisely to close that door.

### stdout

Exactly one JSON object per line, and **nothing else, ever**.

```jsonc
{"type":"ready","device":"cpu","computeType":"int8","draftModel":"tiny","finalModel":"small", …}
{"type":"segment","id":"w0","text":"…","isFinal":false,"tsStart":0,"tsEnd":500,
 "confidence":0.42,"isDraft":true}
{"type":"segment","id":"w0","text":"…","isFinal":true,"tsStart":0,"tsEnd":3000,
 "confidence":0.78,"isDraft":false}
{"type":"error","message":"…"}
{"type":"bye"}
{"type":"selftest", …}   // --selftest only
```

`tsStart` / `tsEnd` are milliseconds of audio since the session began. `confidence` is
`exp(avg_logprob)` clamped to `[0, 1]`, or `null` when the model reported none.

**Never write a diagnostic to stdout.** One stray `UserWarning` on that stream and the parser on
the other end sees a line that is not JSON. (`WhisperProvider.ts` survives it — it ignores
unparseable lines rather than ending the session — but that is a safety net, not a licence.)

### stderr

Everything human: model loading, device fallback, per-final summaries, tracebacks. Verger routes
it into the rolling log at `debug`.

---

## 4. Provisioning the venv

The venv lives at `resources/asr-venv/` and is **gitignored**. It is per-machine; do not commit
it, and do not check model weights into the repository either.

```powershell
py -3 -m venv "resources\asr-venv"
& "resources\asr-venv\Scripts\python.exe" -m pip install --upgrade pip
& "resources\asr-venv\Scripts\python.exe" -m pip install faster-whisper
```

Verify it without downloading a single model weight:

```powershell
& "resources\asr-venv\Scripts\python.exe" "resources\asr\whisper_sidecar.py" --selftest
```

```json
{"type":"selftest","python":"3.14.6","fasterWhisper":"1.2.1","ctranslate2":"4.8.1",
 "onnxruntime":"1.27.0","numpy":"2.5.1","cudaDevices":1}
```

If that line appears and the exit code is 0, `WhisperProvider.isConfigured()` will be true.

Model weights are **not** bundled and **not** committed. They download from HuggingFace into the
user's HF cache (`~/.cache/huggingface/hub`) on first use — `tiny` is ~75 MB and `small` is
~480 MB, so the first run after provisioning is slow and every run after it is not. Set
`downloadRoot` to relocate the cache, or `localFilesOnly: true` on a machine that must never
reach the network.

---

## 5. GPU, VRAM and model choice

The development machine is an **NVIDIA GTX 1650 with 4 GB of VRAM**, and that is the constraint
the defaults are chosen against.

`docs/v2-notes/ASR_PIPELINE.md` specifies `large-v3` for the final tier. **It does not fit.** A
model that runs is worth more on a Sunday morning than one that OOMs at 10:30, so the default
final tier is `small` and the draft tier is `tiny`, at `int8_float16` on GPU or `int8` on CPU.

`MODEL_VRAM_MB` in the sidecar encodes an approximate working set per model and `maxVramMb`
budgets it; a model that does not fit is **downgraded with a stderr warning**, never loaded until
it crashes. Raising `maxVramMb` is the only change needed to run a larger model on a larger card.

> Provenance, because it matters: `docs/v2-notes/NETWORK_AND_HARDWARE.md` §7 is explicit that the
> prior project's docs contain **no per-model VRAM table** and that inventing one and attributing
> it to them would be wrong. The numbers in `MODEL_VRAM_MB` are order-of-magnitude figures taken
> from public faster-whisper guidance, and they are used only to pick between models — not as a
> benchmark and not as a promise.

### The CUDA fallback, and why it warms up first

`WhisperModel(..., device="cuda")` **succeeds** on a machine whose CUDA runtime is incomplete.
ctranslate2 constructs the model happily and only discovers a missing `cublas64_12.dll` when the
first matrix multiply runs. Probing device health at construction time therefore reports a healthy
GPU and then throws in the middle of the sermon — exactly the failure a fallback exists to prevent.

So the sidecar pushes one second of synthetic noise through **both** models before it emits
`ready`. If that pass fails on CUDA it reloads on **CPU `int8`**, says so on stderr, and carries
on. Verified on this machine:

```
[models] loading draft='tiny' final='small' on cuda/int8_float16
[models] cuda/int8_float16 unusable: Library cublas64_12.dll is not found or cannot be loaded
[models] falling back to CPU int8 — slower, but a live service keeps running
[models] loading draft='tiny' final='small' on cpu/int8
[models] warm-up passed in 4806 ms
```

That is the current state of this machine: `ctranslate2.get_cuda_device_count()` returns 1, but
the CUDA 12 math libraries are not installed, so **local ASR runs on CPU here**. Installing
`nvidia-cublas-cu12` and `nvidia-cudnn-cu12` into the venv would light up the GPU path; see
`HUMAN_TASKS.md`.

### Measured latencies (GTX 1650 machine, `tiny` draft + `small` final, CPU `int8`)

| | |
|---|---|
| cold start, first ever run (downloads `tiny`) | ~8.3 s to `ready` |
| cold start, first ever run (downloads `tiny` + `small`) | ~18.3 s to `ready` |
| warm start, weights cached | ~3.2 s to `ready` (incl. ~4.8 s CPU warm-up on some runs) |
| first draft partial after speech begins | **~1.27 s** |
| final pass (`small`, ~3–4 s of audio) | ~2.8 s |

On a working CUDA path these would be several times faster; the note's target for the draft tier
is ~150 ms.

---

## 6. VAD

`vad_filter=True`, using faster-whisper's own vendored Silero **v5** model.

That is a deliberate choice and not laziness. `docs/v2-notes/ASR_PIPELINE.md` §2 records the prior
project shipping a v3-shaped ONNX wrapper (`h`/`c` LSTM state pair) against a v5 model (single
`state`/`stateN` tensor plus a scalar `sr`), which died at runtime with `Invalid input name: h`.
Most Silero examples on the internet are still v3-shaped. Using faster-whisper's bundled wrapper
means that contract cannot drift out from under us; `faster_whisper.vad.VadOptions` is the only
VAD surface this file touches.

`vadThreshold` defaults to 0.5. Silero's own `neg_threshold` default is `threshold - 0.15`, which
lands on exactly 0.35 — the same open-0.5 / close-0.35 gate the note records from the prior
project's build log. The two agree, so we take the library default rather than re-deriving it.

An RMS floor short-circuits **digital silence** before any model is invoked. That is a cost
optimisation, not a VAD decision — the speech/no-speech judgement is always Silero's.

Hallucination filtering (`"thank you for watching"`, `"[음악]"`, and friends) is **not** done here.
It lives in `isLikelyHallucination()` in `src/shared/asr.ts` and is applied by
`WhisperProvider.ts`, so the cloud and local adapters are filtered by exactly the same rules.

---

## 7. Running it by hand

```powershell
$py = "resources\asr-venv\Scripts\python.exe"

# 1. Does the environment work at all?
& $py "resources\asr\whisper_sidecar.py" --selftest

# 2. Feed it a WAV. Requires the config line FIRST, then raw PCM with no header.
$cfg = '{"draftModel":"tiny","finalModel":"small","language":"en","finalIntervalMs":3000}'
```

Driving it properly needs a few lines of glue, because the config line and the PCM go down the
same pipe. This is the whole thing:

```python
import json, subprocess, sys, threading, wave

PY, SC, WAV = sys.argv[1], sys.argv[2], sys.argv[3]
with wave.open(WAV, "rb") as w:                       # must be 16 kHz mono 16-bit
    pcm = w.readframes(w.getnframes())

p = subprocess.Popen([PY, "-u", SC], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, bufsize=0)
p.stdin.write((json.dumps({"draftModel": "tiny", "finalModel": "small",
                           "language": "en"}) + "\n").encode())
p.stdin.flush()
threading.Thread(target=lambda: [print(l.decode().rstrip()) for l in p.stdout],
                 daemon=True).start()
for i in range(0, len(pcm), 3200):                    # 100 ms chunks, like the renderer
    p.stdin.write(pcm[i:i + 3200]); p.stdin.flush()
p.stdin.close()
print("exit", p.wait())
```

Watch stderr for the device it actually chose — that is the first thing to check when the
transcript is slower than expected.

To make a test WAV without touching a copyrighted recording, synthesise one (Windows):

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile("$env:TEMP\tts.wav", $f)
$s.Speak("Welcome to the morning service.")
$s.Dispose()
```

**Standing Rule 4: never commit an audio fixture or a transcript of copyrighted material to this
repository.** Generate throwaway audio outside the repo, as above, and delete it.

---

## 8. Shutdown, supervision and failure

- **Closing stdin is the shutdown signal.** The reader loop hits EOF, the scheduler runs one last
  final pass over whatever audio is left, and the process emits `{"type":"bye"}` and exits 0.
- The scheduler thread is a **daemon**, and shutdown waits at most `SHUTDOWN_GRACE_S` (15 s) for
  it. A pass wedged inside a native library cannot keep the process alive past that. It never
  hangs — the operator is closing the app.
- After `FAILURE_LIMIT` (5) consecutive failed transcription passes the sidecar emits an error and
  exits rather than staying alive and silent. A process that is running but producing nothing is
  indistinguishable from a healthy one, which is the worst possible failure mode; `WhisperProvider`
  restarts it with backoff instead.
- `SIGINT` / `SIGTERM` / `SIGBREAK` set the stop event and unwind the same way.
- If the scheduler falls behind, `AudioBuffer` drops the **oldest** audio to stay inside its cap.
  The same rule applies on the TypeScript side of the pipe. Buffering without bound would trade a
  few lost seconds for an out-of-memory crash during the sermon.

---

## 9. Packaging

`resources/asr-venv/` is gitignored and is **not** produced by `npm install`. A packaged build
must ship it as an unpacked extra resource next to the asar — `resolveWhisperRuntime()` in
`WhisperProvider.ts` looks in `process.resourcesPath` first when `app.isPackaged` is true, then
falls back to the development layout.

If neither the interpreter nor the script is found, the adapter reports `NOT_CONFIGURED` with the
path it looked for, the service drops it from the provider plan, and the operator runs on the
cloud adapter or on manual. That is a resting state, not a failure (Standing Rule 5).
