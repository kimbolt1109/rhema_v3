# Local speech recognition (the bottom-bar percentage)

This is the plain-language version. For the script that sets this up, see **SETUP-ASR.bat** next to
START.bat in your Verger folder.

## What the percentage actually is

While Verger is listening, the bottom bar shows a match-confidence percentage next to the suggested
next cue. That number is Verger comparing what it just heard — via a speech recognizer — against the
words attached to your slides and scripture cues, and telling you how sure it is that the next cue
is the right one.

It is **advisory only**. Verger's default mode (assist) always waits for you to confirm before
switching anything — the percentage is there to help you decide faster, not to act on its own.
Manual advance (Space, click, your own judgment) always works, with or without this number ever
appearing.

## Two ways to get that number: cloud or local

- **Cloud (Deepgram)** — faster, and noticeably better at Korean. Needs an API key and an internet
  connection that is still healthy enough to carry the transcript alongside your stream.
- **Local (Whisper, via `faster-whisper`)** — runs entirely on this PC. **Free, works fully offline,
  no API key, no account, no ongoing cost.** Slower, and does best with a GPU (see below). This is
  what `SETUP-ASR.bat` provisions.

You can also run Verger with **neither configured**. Everything else — OBS control, the overlay,
slides, scripture lookup, manual cue firing — works exactly the same. You simply won't see a
confidence percentage, and Verger will never auto-suggest a next cue from listening to the room.

## The one-time setup

Local Whisper is a self-contained Python environment that lives *inside* your Verger folder, at
`resources\asr-venv`. It is deliberately **not** included when you copy Verger to a USB stick or a
new PC, because it's about 290 MB and tied to the exact machine that built it.

So: **run `SETUP-ASR.bat` once on each PC** that will run Verger with local speech recognition. It
will:

1. Check that Python is installed (and tell you exactly where to get it if not — this is the only
   thing it cannot do for you).
2. Create the Python environment inside your Verger folder.
3. Install `faster-whisper`, the speech engine itself.
4. Verify everything imports correctly.
5. Download the two speech models it needs (about 550 MB combined).

**Steps 3 and 5 need the internet.** Do this once, ahead of time, on a decent connection — not five
minutes before the service. After that, local speech recognition works completely offline.

If you re-run `SETUP-ASR.bat` later, it reuses what's already there and only fills in what's
missing — safe to run again if you're not sure it finished.

## CPU vs. GPU

- **No GPU, or a GPU without the right CUDA libraries:** local Whisper still works, on the CPU.
  It's just slower — expect a noticeable delay before a suggestion appears on an older laptop.
- **A working NVIDIA GPU:** meaningfully faster, and is what makes the quick "draft" pass feel
  closer to real-time.
- Verger checks GPU health for real before it trusts it, and falls back to CPU automatically and
  silently if the GPU can't actually run the model. You will never see a crash from this.
- Getting GPU acceleration working is a driver/library matter specific to your hardware, so it isn't
  something the setup script can guarantee. `SETUP-ASR.bat` prints the extra command to try if you
  want to chase it, but it is entirely optional.

## Bottom line

- Nothing else in Verger requires this. It only affects the confidence percentage and
  auto-suggestions in the cue engine.
- It costs nothing and sends nothing anywhere — the model runs on this PC and never phones home
  except to download itself, once.
- If you skip it, or it's not set up yet on a given PC, Verger says so plainly in Speech settings
  and keeps working in manual mode.
