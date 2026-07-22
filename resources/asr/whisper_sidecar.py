#!/usr/bin/env python3
"""
Verger's local ASR sidecar: faster-whisper behind a line-delimited JSON protocol.

Electron's main process cannot host a Whisper model, and the Python ecosystem is where
faster-whisper actually lives. So this file is a small, supervised child process that Verger
spawns (see ``src/main/asr/WhisperProvider.ts``) and talks to over three pipes:

    stdin   one JSON config line, then raw 16 kHz mono s16le PCM forever
    stdout  ONE JSON object PER LINE, and nothing else, ever
    stderr  human diagnostics, warnings, tracebacks

**Never print diagnostics to stdout.** A single stray warning line on stdout desynchronises the
parser on the other end. Every informational message in this file goes to ``diag()``, which
writes to stderr. The one thing that goes to stdout is ``emit()``, which writes exactly one
``json.dumps(...) + "\\n"`` under a lock.

## The two-tier scheduler (docs/v2-notes/ASR_PIPELINE.md §1)

The note's design, validated twice across two rewrites of the prior project:

    | tier  | model | cadence  | purpose                                        |
    | draft | tiny  | ~500 ms  | the operator sees *something* immediately      |
    | final | small | ~5 s     | the accurate transcript, which REPLACES it     |

"Replaces" is literal. A draft and the final that supersedes it carry the **same ``id``**; the
draft has ``isFinal: false, isDraft: true`` and the final has ``isFinal: true, isDraft: false``.
The consumer keys on ``id`` and replaces — it never appends until the final arrives. Get this
wrong and the transcript panel flickers gibberish.

The note specifies ``large-v3`` for the final tier. **We deliberately do not.** This machine has
a 4 GB GTX 1650 and large-v3 does not fit; a model that fits and runs is worth more on a Sunday
morning than one that OOMs at 10:30. ``MODEL_VRAM_MB`` below encodes that bound and
``_fit_model_to_vram`` enforces it, downgrading with a stderr warning rather than crashing.

## VAD

We use faster-whisper's **built-in Silero VAD** (``vad_filter=True``) rather than hand-rolling an
ONNX session. That is not laziness, it is the fix for a specific trap the note calls out
(§2, §"Verger application notes" 4): Silero v5 changed its ONNX I/O contract from v3's ``h``/``c``
LSTM state pair to a single ``state``/``stateN`` tensor plus a scalar ``sr``, and the prior
project shipped a v3-shaped wrapper that died at runtime with "Invalid input name: h".
faster-whisper 1.2.x vendors the v5 model *and* the matching wrapper, so the contract cannot
drift out from under us. ``faster_whisper.vad.VadOptions`` is the only VAD surface we touch.

A cheap RMS floor short-circuits **digital silence** before the model is invoked at all. That is
a cost optimisation, not a VAD decision — the real speech/no-speech judgement is always Silero's.

## Standing Rule 4

This file transcribes whatever the microphone hears and hands it to Verger. It contains no
transcript fixtures, no scripture, and no lyrics, and it writes nothing to disk.

Run it by hand for debugging — see ``resources/asr/README.md``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Audio format — must agree with ASR_SAMPLE_RATE / ASR_CHANNELS / ASR_BITS_PER_SAMPLE
# in src/shared/asr.ts. Changing one side alone silently produces chipmunk transcripts.
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16_000
CHANNELS = 1
BYTES_PER_SAMPLE = 2
BYTES_PER_MS = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE // 1000  # 32

# ---------------------------------------------------------------------------
# Defaults. Every one of these is overridable from the config line.
# ---------------------------------------------------------------------------

DEFAULT_DRAFT_MODEL = "tiny"
DEFAULT_FINAL_MODEL = "small"
DEFAULT_DRAFT_INTERVAL_MS = 500
DEFAULT_FINAL_INTERVAL_MS = 5_000
#: A stuck-open VAD must never grow the buffer without bound (ASR_PIPELINE.md §3).
DEFAULT_MAX_UTTERANCE_MS = 30_000
#: Below this much audio there is nothing worth asking a model about.
MIN_DRAFT_AUDIO_MS = 400
#: 4 GB card. Overridable for a machine with a real GPU.
DEFAULT_MAX_VRAM_MB = 4_096
#: Absolute cap on the PCM the reader will hold if the scheduler falls behind.
MAX_BUFFER_MS = 120_000
#: Anything quieter than this is digital silence, not quiet speech.
SILENCE_RMS = 1e-4
#: Keyword boosting is a prompt prefix in faster-whisper; an unbounded one costs accuracy.
MAX_HOTWORDS_CHARS = 400
#: Seconds of synthetic noise pushed through each model at load to prove the device really works.
WARMUP_SECONDS = 1.0
#: Consecutive failed transcription passes before we stop pretending and let the supervisor restart us.
FAILURE_LIMIT = 5
#: How long the scheduler gets to finish its flush pass once stdin closes.
SHUTDOWN_GRACE_S = 15.0

#: Model sizes we will load. An allow-list, because ``localModel`` reaches this process from
#: operator settings as a free-form string (``asrSettingsSchema`` only bounds its length) and
#: faster-whisper will happily interpret an arbitrary string as a HuggingFace repo id or a
#: local directory to load weights from. That is a remote-code/arbitrary-download surface we
#: simply decline to have.
ALLOWED_MODELS: Tuple[str, ...] = (
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v1",
    "large-v2",
    "large-v3",
    "large-v3-turbo",
    "turbo",
    "distil-small.en",
    "distil-medium.en",
    "distil-large-v3",
)

#: Rough VRAM working set per model at int8/int8_float16, in MB. These are ORDER-OF-MAGNITUDE
#: figures for picking a model that fits, not a benchmark — see resources/asr/README.md, which
#: records that rhema_v2's own docs contain no per-model VRAM table and that these numbers were
#: sourced from public faster-whisper guidance rather than mined from that project.
MODEL_VRAM_MB: Dict[str, int] = {
    "tiny": 400,
    "tiny.en": 400,
    "base": 600,
    "base.en": 600,
    "small": 1_200,
    "small.en": 1_200,
    "distil-small.en": 1_200,
    "medium": 2_600,
    "medium.en": 2_600,
    "distil-medium.en": 2_600,
    "large-v1": 5_000,
    "large-v2": 5_000,
    "large-v3": 5_000,
    "large-v3-turbo": 3_000,
    "turbo": 3_000,
    "distil-large-v3": 3_000,
}

#: Preference order when a requested model does not fit in the available VRAM.
DOWNGRADE_ORDER: Tuple[str, ...] = ("small", "base", "tiny")

_STDOUT_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# The wire protocol
# ---------------------------------------------------------------------------


def emit(message: Dict[str, Any]) -> None:
    """Write exactly one JSON object, on one line, to stdout, and flush.

    ``ensure_ascii=True`` on purpose: Korean transcript text is escaped to ``\\uXXXX`` so a
    console with a legacy code page cannot corrupt the byte stream between here and the parser.
    """
    line = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
    with _STDOUT_LOCK:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            # The parent went away mid-write. There is nowhere left to report that to.
            os._exit(0)


def diag(message: str) -> None:
    """Human-readable diagnostics. stderr ONLY — never mix these into the stdout stream."""
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
    except (BrokenPipeError, OSError):
        pass


def emit_error(message: str) -> None:
    """Report a failure on the protocol stream, so the supervisor sees it as a state and not a log."""
    emit({"type": "error", "message": message})


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class Config:
    """The parsed config line. Every field is validated; nothing here trusts its input."""

    __slots__ = (
        "draft_model",
        "final_model",
        "language",
        "device",
        "compute_type",
        "hotwords",
        "draft_interval_ms",
        "final_interval_ms",
        "max_utterance_ms",
        "max_vram_mb",
        "beam_size",
        "download_root",
        "local_files_only",
        "vad_threshold",
        "vad_min_silence_ms",
        "vad_speech_pad_ms",
    )

    def __init__(self, raw: Dict[str, Any]) -> None:
        self.draft_model = _clean_model(raw.get("draftModel"), DEFAULT_DRAFT_MODEL)
        self.final_model = _clean_model(raw.get("finalModel"), DEFAULT_FINAL_MODEL)
        self.language = _clean_language(raw.get("language"))
        self.device = _clean_choice(raw.get("device"), ("auto", "cuda", "cpu"), "auto")
        self.compute_type = _clean_choice(
            raw.get("computeType"),
            ("auto", "int8", "int8_float16", "int8_bfloat16", "float16", "float32"),
            "auto",
        )
        self.hotwords = _clean_vocabulary(raw.get("customVocabulary"))
        self.draft_interval_ms = _clean_int(
            raw.get("draftIntervalMs"), DEFAULT_DRAFT_INTERVAL_MS, 100, 5_000
        )
        self.final_interval_ms = _clean_int(
            raw.get("finalIntervalMs"), DEFAULT_FINAL_INTERVAL_MS, 1_000, 30_000
        )
        self.max_utterance_ms = _clean_int(
            raw.get("maxUtteranceMs"), DEFAULT_MAX_UTTERANCE_MS, 2_000, 120_000
        )
        self.max_vram_mb = _clean_int(raw.get("maxVramMb"), DEFAULT_MAX_VRAM_MB, 0, 200_000)
        self.beam_size = _clean_int(raw.get("beamSize"), 1, 1, 10)
        root = raw.get("downloadRoot")
        self.download_root = root if isinstance(root, str) and root else None
        self.local_files_only = bool(raw.get("localFilesOnly", False))
        # ASR_PIPELINE.md §2 records rhema_v2's speech gate as open >0.5, close <0.35. Silero's
        # own default neg_threshold is threshold-0.15, which lands on exactly 0.35 for a 0.5
        # open threshold — so the note's tuning and the library's default agree, and we take it.
        self.vad_threshold = _clean_float(raw.get("vadThreshold"), 0.5, 0.05, 0.95)
        self.vad_min_silence_ms = _clean_int(raw.get("vadMinSilenceMs"), 500, 0, 5_000)
        # The note's "500 ms pre-roll so the first syllable is not clipped".
        self.vad_speech_pad_ms = _clean_int(raw.get("vadSpeechPadMs"), 400, 0, 2_000)

        if self.final_interval_ms <= self.draft_interval_ms:
            self.final_interval_ms = self.draft_interval_ms * 4


def _clean_model(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value in ALLOWED_MODELS:
        return value
    if value is not None and value != fallback:
        diag(f"[config] model {value!r} is not on the allow-list; using {fallback!r}")
    return fallback


def _clean_language(value: Any) -> Optional[str]:
    # 'ko' and 'en' are what src/shared/asr.ts allows; None means "let Whisper detect".
    if isinstance(value, str) and value.strip().lower() in ("ko", "en"):
        return value.strip().lower()
    return None


def _clean_choice(value: Any, allowed: Tuple[str, ...], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _clean_int(value: Any, fallback: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if not math.isfinite(float(value)):
        return fallback
    return max(low, min(high, int(value)))


def _clean_float(value: Any, fallback: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if not math.isfinite(float(value)):
        return fallback
    return max(low, min(high, float(value)))


def _clean_vocabulary(value: Any) -> Optional[str]:
    """Flatten the custom-vocabulary list into faster-whisper's ``hotwords`` prompt prefix.

    BLUEPRINT.md §8 calls custom vocabulary the highest-leverage accuracy lever there is — the
    pastor's name, the church name, hymn titles. It is also the easiest thing to overdo: hotwords
    become a prompt prefix, and an unbounded one *costs* accuracy, so the joined string is capped.
    """
    if not isinstance(value, list):
        return None
    terms: List[str] = []
    for item in value:
        if isinstance(item, str):
            term = item.strip()
            if term and term not in terms:
                terms.append(term)
    if not terms:
        return None
    joined = ""
    for term in terms:
        candidate = term if not joined else joined + ", " + term
        if len(candidate) > MAX_HOTWORDS_CHARS:
            break
        joined = candidate
    return joined or None


# ---------------------------------------------------------------------------
# Model loading — CUDA first, CPU when the driver disagrees
# ---------------------------------------------------------------------------


def _fit_model_to_vram(name: str, budget_mb: int, tier: str) -> str:
    """Pick the largest allowed model that fits ``budget_mb``.

    A driver update that shrinks usable VRAM, or an operator who typed ``large-v3`` into
    settings on a 4 GB card, must produce a smaller model and a warning — never a crash at
    10:30 on a Sunday.
    """
    if budget_mb <= 0:
        return name
    need = MODEL_VRAM_MB.get(name, 0)
    if need <= budget_mb:
        return name
    for candidate in DOWNGRADE_ORDER:
        if MODEL_VRAM_MB.get(candidate, 0) <= budget_mb:
            diag(
                f"[models] {tier} model {name!r} needs ~{need} MB VRAM but only {budget_mb} MB "
                f"is budgeted; downgrading to {candidate!r}"
            )
            return candidate
    diag(f"[models] no model fits {budget_mb} MB; falling back to 'tiny'")
    return "tiny"


def _cuda_available() -> bool:
    try:
        import ctranslate2  # noqa: PLC0415 - imported lazily so --selftest stays cheap

        return int(ctranslate2.get_cuda_device_count()) > 0
    except Exception as exc:  # pragma: no cover - depends on the driver
        diag(f"[device] CUDA probe failed: {exc}")
        return False


def _resolve_device(config: Config) -> Tuple[str, str]:
    device = config.device
    if device == "auto":
        device = "cuda" if _cuda_available() else "cpu"
    compute = config.compute_type
    if compute == "auto":
        # int8_float16 is the sweet spot on a Turing card; int8 is the only sane CPU choice.
        compute = "int8_float16" if device == "cuda" else "int8"
    return device, compute


def _warmup(model: Any) -> None:
    """Force one real encoder+decoder pass, and let any device failure surface HERE.

    This function exists because of a failure observed on the development machine and it is the
    single most important thing in this file. ``WhisperModel(..., device="cuda")`` **succeeds**
    on a box whose CUDA runtime is incomplete: ctranslate2 constructs the model happily and only
    discovers that ``cublas64_12.dll`` is missing when the first matrix multiply runs. Probing
    device health at construction time therefore reports a healthy GPU and then throws in the
    middle of the sermon — which is exactly the failure a fallback is supposed to prevent.

    So we push a second of synthetic noise through the model before anyone is told we are ready.
    ``vad_filter`` is off on purpose: with it on, Silero would classify the noise as non-speech
    and faster-whisper would skip inference entirely, warming up nothing.
    """
    import numpy as np  # noqa: PLC0415

    rng = np.random.default_rng(0)
    noise = (rng.standard_normal(int(SAMPLE_RATE * WARMUP_SECONDS)) * 0.02).astype(np.float32)
    segments, _info = model.transcribe(
        noise,
        language="en",
        beam_size=1,
        vad_filter=False,
        without_timestamps=True,
        condition_on_previous_text=False,
    )
    # The generator is lazy — consuming it is what actually runs the model.
    for _segment in segments:
        pass


def _load_pair(config: Config) -> Tuple[Any, Any, str, str, str, str]:
    """Load the draft and final models, degrading rather than failing.

    Returns ``(draft, final, device, compute_type, draft_name, final_name)``.

    A GPU that will not run — a driver update, a missing cuDNN or cuBLAS, another process holding
    the card — falls back to CPU int8 with a stderr warning. A service must not stop because a
    driver updated. Each attempt is only accepted after {@link _warmup} has proven it.
    """
    from faster_whisper import WhisperModel  # noqa: PLC0415 - heavy; import after config parse

    device, compute = _resolve_device(config)
    budget = config.max_vram_mb if device == "cuda" else 0
    draft_name = _fit_model_to_vram(config.draft_model, budget, "draft")
    final_name = _fit_model_to_vram(config.final_model, budget, "final")

    kwargs: Dict[str, Any] = {"local_files_only": config.local_files_only}
    if config.download_root:
        kwargs["download_root"] = config.download_root

    attempts: List[Tuple[str, str]] = [(device, compute)]
    if device == "cuda":
        attempts.append(("cpu", "int8"))

    last_error: Optional[BaseException] = None
    for attempt_device, attempt_compute in attempts:
        draft = None
        final = None
        try:
            diag(
                f"[models] loading draft={draft_name!r} final={final_name!r} "
                f"on {attempt_device}/{attempt_compute}"
            )
            draft = WhisperModel(
                draft_name, device=attempt_device, compute_type=attempt_compute, **kwargs
            )
            final = (
                draft
                if final_name == draft_name
                else WhisperModel(
                    final_name, device=attempt_device, compute_type=attempt_compute, **kwargs
                )
            )
            started = time.monotonic()
            _warmup(draft)
            if final is not draft:
                _warmup(final)
            diag(f"[models] warm-up passed in {(time.monotonic() - started) * 1000:.0f} ms")
            return draft, final, attempt_device, attempt_compute, draft_name, final_name
        except Exception as exc:
            last_error = exc
            del draft, final
            diag(f"[models] {attempt_device}/{attempt_compute} unusable: {exc}")
            if attempt_device == "cuda":
                diag("[models] falling back to CPU int8 — slower, but a live service keeps running")

    raise RuntimeError(f"no usable inference device: {last_error}")


# ---------------------------------------------------------------------------
# Audio buffer
# ---------------------------------------------------------------------------


class AudioBuffer:
    """The PCM the scheduler has not yet turned into a final segment.

    Guarded by a lock because the reader thread appends while the scheduler drains. The absolute
    cap exists so a scheduler that has fallen behind (a slow CPU-only final pass) drops *oldest*
    audio rather than growing until the process is OOM-killed mid-service.
    """

    def __init__(self, max_ms: int) -> None:
        self._lock = threading.Lock()
        self._data = bytearray()
        self._max_bytes = max_ms * BYTES_PER_MS
        #: Milliseconds of audio that came before ``_data`` — the session clock for tsStart.
        self._consumed_ms = 0.0
        self.dropped_ms = 0.0

    def append(self, chunk: bytes) -> None:
        with self._lock:
            self._data.extend(chunk)
            overflow = len(self._data) - self._max_bytes
            if overflow > 0:
                del self._data[:overflow]
                dropped = overflow / BYTES_PER_MS
                self._consumed_ms += dropped
                self.dropped_ms += dropped

    def snapshot(self) -> Tuple[bytes, float, float]:
        """Return ``(pcm, start_ms, end_ms)`` without consuming anything."""
        with self._lock:
            data = bytes(self._data)
            start = self._consumed_ms
        return data, start, start + len(data) / BYTES_PER_MS

    def consume(self, length: int) -> None:
        """Drop the first ``length`` bytes — called once a final segment has covered them."""
        with self._lock:
            take = min(length, len(self._data))
            del self._data[:take]
            self._consumed_ms += take / BYTES_PER_MS

    def duration_ms(self) -> float:
        with self._lock:
            return len(self._data) / BYTES_PER_MS


def pcm_to_float32(pcm: bytes):
    """s16le bytes -> float32 numpy in [-1, 1), which is what WhisperModel.transcribe wants."""
    import numpy as np  # noqa: PLC0415

    usable = len(pcm) - (len(pcm) % BYTES_PER_SAMPLE)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(pcm[:usable], dtype="<i2").astype(np.float32) / 32768.0


def is_digital_silence(samples) -> bool:
    """A cost short-circuit for a buffer that is literally zeros. NOT a speech/no-speech call."""
    import numpy as np  # noqa: PLC0415

    if samples.size == 0:
        return True
    return bool(np.sqrt(np.mean(np.square(samples, dtype=np.float64))) < SILENCE_RMS)


# ---------------------------------------------------------------------------
# The two-tier scheduler
# ---------------------------------------------------------------------------


class Scheduler:
    """Draft every ``draft_interval_ms``, final every ``final_interval_ms``, same ``id``.

    The id increments only when a final is emitted, which is precisely what makes the
    draft/final replacement contract hold: every partial for one span carries the id its final
    will carry, so the consumer replaces in place and never appends a half-heard sentence.
    """

    def __init__(self, config: Config, buffer: AudioBuffer, draft_model: Any, final_model: Any) -> None:
        self.config = config
        self.buffer = buffer
        self.draft_model = draft_model
        self.final_model = final_model
        self.segment_index = 0
        self._draft_emitted_for: Optional[str] = None

    # -- transcription ----------------------------------------------------

    def _transcribe(self, model: Any, samples, draft: bool) -> Tuple[str, Optional[float]]:
        from faster_whisper.vad import VadOptions  # noqa: PLC0415

        vad = VadOptions(
            threshold=self.config.vad_threshold,
            min_silence_duration_ms=self.config.vad_min_silence_ms,
            speech_pad_ms=self.config.vad_speech_pad_ms,
        )
        kwargs: Dict[str, Any] = {
            "beam_size": self.config.beam_size,
            "vad_filter": True,
            "vad_parameters": vad,
            "condition_on_previous_text": False,
            "without_timestamps": True,
        }
        if draft:
            # Whisper's default temperature ladder retries the same window up to six times when
            # the compression-ratio or logprob threshold trips, which is exactly what happens on
            # a half-finished sentence — the draft tier's normal input. Measured on this machine
            # that turned a ~0.7 s tiny pass into ~4.5 s, which defeats the whole point of having
            # a draft tier. One greedy pass, no fallback: the final tier is where accuracy lives.
            kwargs["temperature"] = 0.0
            kwargs["compression_ratio_threshold"] = None
            kwargs["log_prob_threshold"] = None
        if self.config.language is not None:
            kwargs["language"] = self.config.language
        if self.config.hotwords:
            kwargs["hotwords"] = self.config.hotwords

        segments, _info = model.transcribe(samples, **kwargs)

        parts: List[str] = []
        logprobs: List[float] = []
        for segment in segments:
            text = (segment.text or "").strip()
            if text:
                parts.append(text)
            if segment.avg_logprob is not None and math.isfinite(segment.avg_logprob):
                logprobs.append(float(segment.avg_logprob))

        if not parts:
            return "", None
        confidence = None
        if logprobs:
            confidence = max(0.0, min(1.0, math.exp(sum(logprobs) / len(logprobs))))
        return " ".join(parts), confidence

    # -- passes -----------------------------------------------------------

    def run_draft(self) -> None:
        pcm, start_ms, end_ms = self.buffer.snapshot()
        if len(pcm) < MIN_DRAFT_AUDIO_MS * BYTES_PER_MS:
            return
        samples = pcm_to_float32(pcm)
        if is_digital_silence(samples):
            return
        text, confidence = self._transcribe(self.draft_model, samples, draft=True)
        if not text:
            return
        segment_id = self.current_id()
        self._draft_emitted_for = segment_id
        emit(
            {
                "type": "segment",
                "id": segment_id,
                "text": text,
                "isFinal": False,
                "tsStart": round(start_ms),
                "tsEnd": round(end_ms),
                "confidence": confidence,
                "isDraft": True,
            }
        )

    def run_final(self, reason: str) -> None:
        pcm, start_ms, end_ms = self.buffer.snapshot()
        if not pcm:
            return
        segment_id = self.current_id()
        samples = pcm_to_float32(pcm)
        text = ""
        confidence: Optional[float] = None
        if not is_digital_silence(samples):
            text, confidence = self._transcribe(self.final_model, samples, draft=False)

        # A final that found nothing still has to be emitted IF a draft went out under this id,
        # or the operator is left staring at a partial that will never be corrected. When no
        # draft went out, silence is silence and nothing is emitted at all.
        if text or self._draft_emitted_for == segment_id:
            emit(
                {
                    "type": "segment",
                    "id": segment_id,
                    "text": text,
                    "isFinal": True,
                    "tsStart": round(start_ms),
                    "tsEnd": round(end_ms),
                    "confidence": confidence,
                    "isDraft": False,
                }
            )
        diag(f"[final] id={segment_id} reason={reason} chars={len(text)}")
        self.buffer.consume(len(pcm))
        self.segment_index += 1
        self._draft_emitted_for = None

    def current_id(self) -> str:
        return f"w{self.segment_index}"


def scheduler_loop(
    scheduler: Scheduler,
    buffer: AudioBuffer,
    config: Config,
    eof: threading.Event,
    stop: threading.Event,
) -> None:
    """Cadence only. Every inference call it makes is one of two methods on ``Scheduler``."""
    next_draft = time.monotonic() + config.draft_interval_ms / 1000.0
    next_final = time.monotonic() + config.final_interval_ms / 1000.0
    failures = 0

    while not stop.is_set():
        if eof.is_set():
            break
        now = time.monotonic()
        try:
            if now >= next_final or buffer.duration_ms() >= config.max_utterance_ms:
                reason = "cadence" if now >= next_final else "max-utterance"
                scheduler.run_final(reason)
                next_final = time.monotonic() + config.final_interval_ms / 1000.0
                next_draft = time.monotonic() + config.draft_interval_ms / 1000.0
                failures = 0
            elif now >= next_draft:
                scheduler.run_draft()
                next_draft = time.monotonic() + config.draft_interval_ms / 1000.0
                failures = 0
        except Exception as exc:  # a bad pass must not take the process down
            failures += 1
            diag(f"[scheduler] pass {failures}/{FAILURE_LIMIT} failed: {exc}")
            emit_error(f"transcription pass failed: {exc}")
            # Retrying forever against a device that has stopped working produces a process that
            # is alive, silent, and indistinguishable from a healthy one. Give up loudly instead
            # and let the supervisor in WhisperProvider.ts restart us with backoff.
            if failures >= FAILURE_LIMIT:
                emit_error("giving up after repeated transcription failures")
                stop.set()
                return
            next_draft = time.monotonic() + config.draft_interval_ms / 1000.0
            next_final = time.monotonic() + config.final_interval_ms / 1000.0
        stop.wait(0.02)

    # Flush on stdin close: whatever is left is one last final, then we are done.
    if not stop.is_set():
        try:
            scheduler.run_final("flush")
        except Exception as exc:
            diag(f"[scheduler] flush failed: {exc}")


# ---------------------------------------------------------------------------
# stdin
# ---------------------------------------------------------------------------


def read_config_line(stream: Any) -> Dict[str, Any]:
    """Read the single JSON config line that precedes the PCM stream.

    ``readline()`` on the *buffered* reader is what makes this safe: any PCM bytes it happened
    to read past the newline stay in the same buffer and are handed back by the ``read1`` calls
    that follow. Reading the raw fd here would silently eat the first audio chunk.
    """
    line = stream.readline()
    if not line:
        raise ValueError("stdin closed before a config line arrived")
    return json.loads(line.decode("utf-8"))


def reader_loop(stream: Any, buffer: AudioBuffer, eof: threading.Event, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            chunk = stream.read1(65536)
        except (BrokenPipeError, OSError) as exc:
            diag(f"[stdin] read failed: {exc}")
            break
        if not chunk:
            break
        buffer.append(chunk)
    eof.set()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _selftest() -> int:
    """``--selftest`` proves the venv is usable without downloading a single model weight."""
    try:
        import ctranslate2
        import faster_whisper
        import numpy
        import onnxruntime
    except Exception as exc:
        emit_error(f"selftest import failed: {exc}")
        return 1
    emit(
        {
            "type": "selftest",
            "python": sys.version.split()[0],
            "fasterWhisper": getattr(faster_whisper, "__version__", "unknown"),
            "ctranslate2": ctranslate2.__version__,
            "onnxruntime": onnxruntime.__version__,
            "numpy": numpy.__version__,
            "cudaDevices": int(ctranslate2.get_cuda_device_count()),
        }
    )
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Verger faster-whisper ASR sidecar")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="report the environment on stdout and exit without loading any model",
    )
    args = parser.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except Exception:  # pragma: no cover - non-reconfigurable stream
            pass

    if args.selftest:
        return _selftest()

    stop = threading.Event()

    def _handle_signal(_signum: int, _frame: Any) -> None:
        stop.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signum = getattr(signal, name, None)
        if signum is not None:
            try:
                signal.signal(signum, _handle_signal)
            except (ValueError, OSError):  # pragma: no cover - platform dependent
                pass

    try:
        raw = read_config_line(sys.stdin.buffer)
    except Exception as exc:
        emit_error(f"could not read the config line: {exc}")
        return 2
    if not isinstance(raw, dict):
        emit_error("config line was not a JSON object")
        return 2

    config = Config(raw)

    try:
        draft, final, device, compute, draft_name, final_name = _load_pair(config)
    except Exception as exc:
        emit_error(f"could not load a Whisper model: {exc}")
        return 3

    buffer = AudioBuffer(MAX_BUFFER_MS)
    scheduler = Scheduler(config, buffer, draft, final)
    eof = threading.Event()

    emit(
        {
            "type": "ready",
            "device": device,
            "computeType": compute,
            "draftModel": draft_name,
            "finalModel": final_name,
            "language": config.language,
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "draftIntervalMs": config.draft_interval_ms,
            "finalIntervalMs": config.final_interval_ms,
            "hotwordCount": 0 if not config.hotwords else config.hotwords.count(",") + 1,
        }
    )

    worker = threading.Thread(
        target=scheduler_loop,
        args=(scheduler, buffer, config, eof, stop),
        name="verger-asr-scheduler",
        daemon=True,
    )
    worker.start()

    reader_loop(sys.stdin.buffer, buffer, eof, stop)
    # The worker is a daemon thread, so a pass wedged inside a native library cannot keep this
    # process alive past the grace period. Never hang on shutdown — the operator is closing the app.
    worker.join(timeout=SHUTDOWN_GRACE_S)
    if worker.is_alive():
        diag(f"[shutdown] scheduler did not finish within {SHUTDOWN_GRACE_S:.0f}s; exiting anyway")
    if buffer.dropped_ms > 0:
        diag(f"[shutdown] dropped {buffer.dropped_ms:.0f} ms of audio to stay within the buffer cap")
    emit({"type": "bye"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
