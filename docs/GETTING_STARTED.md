# Getting started with Verger

First run, in the order a real person does it. Budget about 45 minutes the first time, most of it
spent inside OBS rather than inside Verger.

If you are looking for the Sunday-morning sheet rather than the setup, you want
[`RUNBOOK.md`](./RUNBOOK.md).

> **Read this before you start.** This build has **never connected to a real OBS Studio, a real
> Google/YouTube account, or Deepgram.** Those subsystems are built, typechecked and unit-tested
> against injected fakes, and the machine this was built on has none of the three. Everything in
> this document that involves OBS, YouTube or Deepgram is therefore *the procedure*, not a report
> of a procedure that has been run. Where a step has actually been executed, it says so.
> The honest per-phase gaps are in [`../STATUS.md`](../STATUS.md) under each cycle's
> "Not verified" heading.

---

## 0. What you need

| | Requirement | Needed for |
|---|---|---|
| **Required** | Windows 10 or 11, x64 | Verger is Windows-first; packaging is configured for Windows only. |
| **Required** | **OBS Studio 30 or newer**, with **Tools → WebSocket Server Settings → Enable WebSocket server** ticked | Everything video: cameras, streaming, recording, and the surface the overlay is drawn on. Verger drives OBS over obs-websocket v5, which ships inside OBS from version 28 and is current from 30. |
| Development only | **Node.js 20+** and **npm 10+** (built on Node 24 / npm 11) | Running from source. Not needed if you install a packaged build. |
| Optional | A Google Cloud OAuth client, a Deepgram key, LibreOffice, a local Python ASR environment | See §5. Every one of these is optional and has a documented degraded mode. |

**Verger is not a video engine.** OBS composites, streams and records; Verger tells it what to do
and gets out of the way. If Verger is closed, or crashes, OBS carries on streaming and recording
and you can drive it by hand. That is the whole architecture, and it is the reason nothing here can
take your service off the air.

---

## 1. Get it running

### From a packaged installer

Run `Verger-<version>-x64-setup.exe`.

**The installer is not code-signed.** There is no Windows Authenticode certificate for this
project, so on first run SmartScreen will say *"Windows protected your PC — unknown publisher"* and
you have to click **More info → Run anyway**. That warning is correct and you should not learn to
ignore warnings in general — this specific build genuinely has no publisher signature. Getting a
certificate is an open item in [`../HUMAN_TASKS.md`](../HUMAN_TASKS.md).

For the same reason, **auto-update is off** and this build ships no update manifest.

### From source

```bash
git clone https://github.com/kimbolt1109/rhema_v3.git
cd rhema_v3

copy .env.example .env      # PowerShell/cmd. On a POSIX shell: cp .env.example .env
npm install
npm run dev
```

`npm run dev` starts the electron-vite dev server on `127.0.0.1:5273` and launches the Electron
shell against it with hot reload.

The app will start and show every subsystem as "not configured". **That is the designed first-run
state, not a failure.** Nothing you do in the next few sections can crash it, and you can stop at
any point and still have a working manual console.

---

## 2. `.env` — what each key unlocks

Copy `.env.example` to `.env` (it is gitignored) and fill in what you have.

**Every key is optional.** An empty value means "run this subsystem in not-configured mode". It
never means a crash, a retry storm, or a silent failure — each empty key produces a specific,
named, on-screen state and the rest of the console is untouched. That is Standing Rule 5 in
[`../CLAUDE.md`](../CLAUDE.md), and it is asserted by tests.

| Key | Unlocks | If left empty |
|---|---|---|
| `OBS_WEBSOCKET_URL` | Everything OBS: cameras, GO LIVE, recording, stream health. | The Connection screen shows **Not configured** and the reconnect loop stays idle rather than dialling nothing. You can also type the address into the Connection screen instead of the file. |
| `OBS_WEBSOCKET_PASSWORD` | Authentication to that OBS. | **An empty password is valid** and means "OBS has authentication turned off". It is not a not-configured state. |
| `GOOGLE_CLIENT_ID` | YouTube: OAuth, broadcast creation, the GO LIVE publish step. | Go Live settings shows a "not set up" panel with the exact console steps, and all its controls are disabled. **GO LIVE still works** — it starts the OBS stream and the local recording, and publishes nothing. The panel spells out precisely what it will and will not do. |
| `GOOGLE_CLIENT_SECRET` | as above | as above |
| `DEEPGRAM_API_KEY` | Cloud speech-to-text (lower latency, noticeably better Korean). | Cloud recognition is off. Verger uses the local recogniser if one is installed (§5.4), and if neither exists the console runs fully manual — every cue, camera and overlay works exactly as before. |
| `ESV_API_KEY` | Fetching ESV verse text at the moment a scripture cue fires. | Only translations you can legally use are offered. See the note in §7 about scripture text in this build. |
| `API_BIBLE_KEY` | Fetching verse text from API.Bible. | as above |
| `SENTRY_DSN` | Nothing yet. The key is read and reported, but **no crash reporter is wired into this build** and no telemetry leaves the machine under any setting. | No change. |

Verger never writes a secret to a log. The OAuth refresh token is kept in Electron `safeStorage`
(OS-encrypted), never in `.env`; and the **RTMP stream key is deliberately absent from every type,
log and IPC payload in this codebase** — it lives in OBS's own Stream settings and nowhere else.

---

## 3. Connect to OBS

1. In OBS: **Tools → WebSocket Server Settings**. Tick **Enable WebSocket server**, note the port
   (default `4455`), and click **Show Connect Info** to copy the password.
2. In Verger: the **Connection** tab. Enter `ws://127.0.0.1:4455` and the password, and press
   **Connect**. (Or put them in `.env` as `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD` and
   restart.)
3. You should get **Connected**, the OBS version, and OBS's scene list.

Two behaviours worth knowing before Sunday:

- **Reconnect is automatic and unbounded.** Close OBS and Verger goes to *Reconnecting* with a
  visible attempt count and a countdown, backing off from 0.5 s to a 30 s ceiling. Reopen OBS and
  it re-attaches by itself.
- **A rejected password never retries.** Verger stops and says *"OBS refused the password"*. This
  is deliberate: repeating a rejected password cannot succeed, and a scrolling "reconnecting…"
  would bury the real cause mid-service.

Verger only ever *reads* OBS's state on connect. It issues no `Set*`, no `Start*` and no `Stop*`
during a connect or a reconnect — launching Verger mid-service can never push a second stream.
That is enforced by an allowlist in the OBS client (seven write requests, total) and by tests, not
by convention.

---

## 4. Add the Overlays browser source

This is the step that makes lower-thirds independent of cameras, and it is the one to get right.
The full guide with the scene diagram, every checkbox and the troubleshooting tree is
**[`OBS_SETUP.md`](./OBS_SETUP.md)** — read it. The short version:

1. In Verger's **Overlay** tab, copy the URL it shows. It is `http://127.0.0.1:7320/overlay`
   (loopback only — nothing is exposed to the network, and there is no wildcard-bind code path).
2. In OBS, in your first camera scene: **Sources → + → Browser**. Name it exactly **`Overlays`**.
   URL as copied, Width `1920`, Height `1080`, **Custom CSS empty**.
3. Turn **Shutdown source when not visible** **OFF** and **Refresh browser when scene becomes
   active** **OFF**. Both destroy and recreate the page on a scene change, which is precisely when
   you least want it destroyed — your lower-third would flicker or vanish at every camera cut.
4. Right-click the source → **Copy**, then in every other camera scene right-click in Sources →
   **Paste (Reference)**. *Paste (Duplicate)* is the wrong one. Keep it at the **top** of each
   scene's source list.
5. Back in Verger's Overlay tab, confirm **Attached overlays: 1**. Fire a test lower-third
   (type a name, press Show). It should appear over the camera within a frame or two.
6. **The test that matters:** with the lower-third still showing, switch cameras in OBS. It must
   stay exactly where it is, un-flickered, through every cut.

If the overlay comes back blank after a refresh, that is a bug — report it. The server holds the
state and sends a full snapshot the instant a page connects, so an overlay that reconnects always
recovers whatever should be on screen. Resync is not a special case in this design; it is the only
case.

Then map your four camera buttons in **Camera setup**. The scene pickers are populated from OBS's
own live scene list, so a typo cannot produce a button that fires at a scene which does not exist.
A button with no scene mapped stays disabled and says why.

---

## 5. The optional extras

Skip any or all of these. Each one has a documented degraded mode, and none of them is required to
run a service.

### 5.1 Google OAuth, for YouTube

Unlocks: creating the weekly broadcast, binding the persistent stream, and the final "make the
broadcast public" step of GO LIVE.

1. Create a project at `console.cloud.google.com`.
2. Enable the **YouTube Data API v3** in that project.
3. **OAuth consent screen** → External; add yourself as a test user while it is unverified.
4. **Credentials → Create OAuth client ID → application type "Desktop app"**.
5. Put the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
   restart Verger.
6. In **Go Live settings**, press **Sign in with Google** once. Your browser opens; approve.
   Verger keeps only the refresh token, OS-encrypted, so later Sundays are silent.
7. **Check the channel name it reports.** Google signs you in as whichever account the browser was
   already using, and a service published to somebody's personal channel cannot be quietly undone.

Verger reuses **one** persistent ingest stream forever, so the RTMP key in OBS is pasted once and
never again. Only the broadcast is new each week.

*Unverified:* no Google credentials exist on the machine this was built on. The OAuth round-trip
and the broadcast create/bind calls have never been exercised against real Google servers.

### 5.2 A Deepgram key, for cloud speech-to-text

Put it in `.env` as `DEEPGRAM_API_KEY`. In **Speech settings**, the provider modes are:

- **Cloud** — Deepgram. Lower latency, noticeably better at Korean; dies with the internet, and the
  internet is already carrying your stream.
- **Local** — faster-whisper on this machine (§5.4). Works with no network at all; slower, and
  wants a GPU.
- **Auto** — cloud while it is healthy, falling back to local the moment it is not. Recommended.

The single most effective setting on that screen is **custom vocabulary**: add the pastor's name,
the church name, hymn titles, recurring terms. Those are the words a general-purpose model has
never seen, so they are the ones it gets wrong.

*Unverified:* no Deepgram key exists on the build machine. Nothing in this repository has ever
spoken to Deepgram.

### 5.3 LibreOffice, for PowerPoint import

Verger converts a `.pptx` into one image per slide using LibreOffice headlessly. It never reads the
words on your slides.

Install LibreOffice (free) and restart Verger. It is found automatically in
`C:\Program Files\LibreOffice\program\soffice.exe`, the x86 equivalent, or
`%LOCALAPPDATA%\Programs\LibreOffice\...`; set the `VERGER_SOFFICE` environment variable to your
`soffice.exe` if yours lives somewhere else.

Without it, the **Import deck…** button is disabled and explains why. (The importer does contain a
reduced fallback that pulls out the pictures already embedded in each slide, but this build's UI
does not offer it while no renderer is installed.) You can still build the service by hand: export
the deck to PNG yourself, drop the images into the plan's asset folder, and add one slide cue per
image.

*Unverified:* LibreOffice is not installed on the build machine, and **no real deck has ever been
converted.**

### 5.4 The local ASR environment (faster-whisper)

This one **has** been provisioned and measured on the build machine, so the numbers below are real.

```powershell
python -m venv resources/asr-venv
resources/asr-venv/Scripts/python -m pip install faster-whisper
```

Then restart Verger and choose **Local** or **Auto** in Speech settings.

- It costs about **290 MB** on disk (faster-whisper, ctranslate2, onnxruntime and CUDA runtime
  bits). The directory is gitignored and is never committed.
- **A GPU helps a lot**, and its memory sets your ceiling. The build machine has a GTX 1650 with
  4 GB, which will not hold `large-v3`; the local tier defaults to `small` for final transcripts
  and `tiny` for drafts, at int8. If CUDA fails to initialise it falls back to CPU rather than
  refusing to run — a driver update must not stop a service.
- In a packaged install, put the venv at `<install dir>\resources\asr-venv`. It is deliberately not
  bundled into the installer: it is machine-specific, tied to the GPU and driver of the machine
  that created it, and its absolute paths do not survive being relocated.

*Measured on the build machine:* CUDA device count 1; `tiny` model load 0.8 s (CPU int8);
inference on 3 s of audio 0.12 s; the sidecar self-test exits 0 in 1.2 s. **No real speech has been
transcribed** — the pipeline was exercised with synthesised tones, which proves the plumbing and
says nothing about accuracy on a sermon.

---

## 6. Where Verger keeps things

| What | Where |
|---|---|
| Rolling log files | `%APPDATA%\Verger\logs` (this is the first thing to attach to a bug report) |
| Settings, camera mapping, templates, stored refresh token | `%APPDATA%\Verger` (the refresh token is OS-encrypted via `safeStorage`) |
| Service plans and their asset folders | Wherever you save them; the plan's assets sit next to the plan file |
| **Your recording** | Wherever **OBS** is configured to write it — Settings → Output → Recording Path. Verger shows the path but does not own the file. |

The last row matters: the recording is OBS's, not Verger's. It keeps being written if the internet
drops, if YouTube refuses the broadcast, or if Verger itself crashes.

---

## 7. What works with none of this

You have OBS, and nothing else — no Google account, no Deepgram key, no LibreOffice, no local ASR,
no keys in `.env` at all. Here is what still works:

- **All four camera buttons**, one tap each, with per-button transitions.
- **Lower-thirds** on their own layer: type two lines, pick a template, Show and Hide. A camera
  switch never touches them and showing one never touches the camera. This is asserted by tests at
  both the service and the UI level.
- **Scripture and slide overlay layers**, driven by hand from the Overlay panel, fully independent
  of each other and of the camera.
- **CLEAR ALL**, as a deliberate hold rather than a tap.
- **The Service Plan**: author an ordered list of cues, reorder them by drag or from the keyboard,
  save and reopen, fire any cue by hand, advance and step back. The plan screen needs no
  microphone, no cue engine and no network — it is the fallback everything else degrades to, which
  is why it was built before any of the automation.
- **GO LIVE and END.** With no Google credentials the YouTube steps are marked *skipped*, not
  failed, and GO LIVE still starts the OBS stream **and the local recording together**, then END
  stops them. The panel states exactly what it will and will not do.
- **Always-on local recording.** The primitive that starts a stream takes zero arguments, so there
  is no flag, option or overload by which a stream can start without a backup. A recording failure
  is reported loudly and does **not** stop the stream — the service in the room matters more than
  the backup.
- **Crash re-attach.** If Verger dies mid-service and you relaunch it, it reads what OBS is already
  doing and adopts it. It will not start a second stream or open a second recording file.
- **The status dashboard**: seven subsystem lights, each with a plain-words detail and a "what
  still works" line, and the one question that matters answered at the top — *is the service still
  going out?*
- **Recovery actions** that cannot touch the broadcast: reload the overlays, and rewind automation
  to a checkpoint. Neither can stop the stream or the recording; that is structural, not a promise.
- **PANIC**, which halts all automation and touches nothing else.
- **Korean and English UI**, dark high-contrast booth theme, large touch targets, status never
  signalled by colour alone.

What you do **not** get without the optional extras: speech-to-text and therefore any automatic
suggestion; PowerPoint import; and a YouTube broadcast link.

One further gap in this build, and it is worth knowing before you plan around it:
**verse text does not resolve.** The scripture resolver is written and unit-tested but is not
connected in the composition root, so `Resolve scripture` answers *not configured* and a detected
reference is offered without its text. Because Verger refuses to auto-show a scripture card whose
text failed to resolve, the practical effect is that scripture cues are a manual, paste-the-text
operation in this build. It is recorded in [`WIRING.md`](./WIRING.md) §4 and in
[`../HUMAN_TASKS.md`](../HUMAN_TASKS.md).

---

## 8. Next

- **[`RUNBOOK.md`](./RUNBOOK.md)** — the service-day sheet. Read it before your first live service,
  not during.
- **[`SHORTCUTS.md`](./SHORTCUTS.md)** — the keyboard card. Print it and tape it to the booth
  keyboard.
- **[`OBS_SETUP.md`](./OBS_SETUP.md)** — the full OBS scene contract and troubleshooting.
- **[`../HUMAN_TASKS.md`](../HUMAN_TASKS.md)** — everything still outstanding that only a human can
  do, with exact steps.
