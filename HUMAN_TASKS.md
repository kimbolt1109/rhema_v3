# Verger (rhema_v3) — human tasks

Everything here needs a human: an account, a key, a purchase, a legal call, or physical hardware.
The build never blocks on these — the affected subsystem ships in "not configured" mode (Standing
Rule 5) and this list records the exact steps to light it up.

Ordered by what an operator needs first. Group A is required to run a service at all; Group B is
required to publish to YouTube; Group C makes the automation useful; Group D is legal; Group E is
distribution. Nothing below is blocking the code.

Format: `- [ ] [TYPE] task — what it unblocks, exact resolution steps.`
Types: `[SETUP]` `[ACCOUNT]` `[KEY]` `[LEGAL]` `[HARDWARE]` `[DECISION]` `[PURCHASE]`

---

## Group A — needed before Verger can run a service at all

- [ ] **[SETUP] Install OBS Studio 30+ and enable its WebSocket server.**
  **Unblocks:** everything video — cameras, GO LIVE, the local recording, stream health, and the
  surface the overlay is drawn on. This is the only item on this page without which Verger cannot
  run a service.

  > **If the USB folder has an `obs` sub-folder, steps 1–5 are already done and you should not do
  > them.** `npm run obs:assemble` ships a portable OBS with the WebSocket server enabled, a unique
  > password, and a `Cam 1` scene already holding a correctly configured `Overlays` browser source.
  > `START.bat` launches it, and Verger finds it without anything being typed — verified end to end
  > on 2026-07-28 (see *Resolved*). **What is left is step 6, plus adding the room's camera to the
  > `Cam 1` scene.** The steps below are for a machine using its own installed OBS instead.

  **Steps:**
  1. Install OBS Studio 30 or newer.
  2. `Tools → WebSocket Server Settings` → tick **Enable WebSocket server**.
  3. Note the port (default `4455`) and click **Show Connect Info** to copy the password.
  4. Put them in `.env` as `OBS_WEBSOCKET_URL=ws://127.0.0.1:4455` and
     `OBS_WEBSOCKET_PASSWORD=<password>` — or type them into Verger's Connection screen.
     An empty password is valid and means OBS authentication is off.
  5. Build one scene per camera, and add **one shared** `Overlays` browser source on top of every
     one of them, following [`docs/OBS_SETUP.md`](./docs/OBS_SETUP.md). The two checkboxes
     *Shutdown source when not visible* and *Refresh browser when scene becomes active* must both
     be **OFF**.
  6. Set the recording path: `Settings → Output → Recording Path`, on a drive with room.
  **Until then:** the Connection screen reads "Not configured" or "Down", camera buttons are
  disabled with an explanation, and GO LIVE is switched off. Nothing crashes.

---

## Group B — needed to publish to YouTube

- [ ] **[ACCOUNT] [KEY] Google Cloud project + OAuth client for YouTube Live.**
  **Unblocks:** creating the weekly broadcast, binding the persistent stream, and GO LIVE's final
  "make the broadcast public" step.
  **Steps:**
  1. Create a project at `console.cloud.google.com`.
  2. Enable **YouTube Data API v3** in it.
  3. **OAuth consent screen** → *External*; add yourself as a test user while it is unverified.
  4. **Credentials → Create OAuth client ID → application type "Desktop app"**.
  5. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then
     restart Verger.
  6. Go Live settings → **Sign in with Google**, once. The refresh token is stored in Electron
     `safeStorage`; later Sundays are silent.
  7. **Check the channel name Verger reports** before the first go-live. Google signs you in as
     whichever account the browser was already using, and a service published to a personal channel
     cannot be quietly undone.
  **Note:** `liveBroadcasts.insert` is the expensive call against the daily API quota; a few
  services a day is comfortably inside it.
  **Until then:** Go Live settings shows "not set up" with these steps on screen and every control
  disabled. **GO LIVE still streams and records** — it just publishes nothing, and says so
  explicitly on the panel.

- [ ] **[SETUP] Paste the persistent YouTube stream key into OBS, once.**
  **Unblocks:** OBS actually reaching YouTube's ingest. Verger reuses **one** persistent stream
  forever precisely so this is done once and never again.
  **Steps:** YouTube Studio → the persistent stream Verger created (or your existing one) → copy
  the stream key → OBS `Settings → Stream` → Service: YouTube (or Custom) → paste → Apply.
  **Verger never sees or stores this key.** It is deliberately absent from every type, log and IPC
  payload in the codebase, and a test asserts the Go Live screen renders no stream-key field.

---

## Group C — makes the automation useful

- [ ] **[KEY] Deepgram API key** (cloud speech-to-text).
  **Unblocks:** the low-latency cloud recogniser, which is noticeably better at Korean than the
  local one.
  **Steps:** create a Deepgram account → create an API key → put it in `.env` as
  `DEEPGRAM_API_KEY` → restart Verger → Speech settings → choose **Auto** (cloud while healthy,
  local fallback) or **Cloud**.
  **Until then:** the local recogniser is used if installed; if neither exists the console runs
  fully manual and nothing is blocked.

- [ ] **[SETUP] Install LibreOffice** (PowerPoint import).
  **Unblocks:** converting a `.pptx` into one image per slide. Verger runs it headlessly and never
  reads the words on your slides.
  **Steps:** install LibreOffice (free), restart Verger, then confirm the Plan tab's importer line
  names a converter path. It is auto-detected at `C:\Program Files\LibreOffice\program\soffice.exe`,
  the x86 path, and `%LOCALAPPDATA%\Programs\LibreOffice\...`; set the `VERGER_SOFFICE` environment
  variable to your `soffice.exe` for a non-standard install.
  **Until then:** the **Import deck…** button is disabled and explains why. Export slides to PNG
  yourself, drop them in the plan's asset folder, and add one slide cue per image.

- [ ] **[KEY] ESV and/or API.Bible keys** (verse text at cue time).
  **Unblocks:** fetching copyrighted translations live, with attribution. No verse text is ever
  bundled into this repository — that is Standing Rule 4, and the `scripture` cue payload has no
  `text` field so a plan carrying verse text is invalid by construction.
  **Steps:** request an API key from Crossway (ESV) and/or API.Bible, put them in `.env` as
  `ESV_API_KEY` / `API_BIBLE_KEY`, restart.
  **Caveat, and it is a real one:** even with keys, **the scripture resolver is not connected in
  this build's composition root**, so `Resolve scripture` answers *not configured* and a detected
  reference is offered without its text. That is a code gap, not a human one — it is recorded in
  [`docs/WIRING.md`](./docs/WIRING.md) §4 and must be closed before these keys do anything.

- [ ] **[DECISION] [LEGAL] Korean translation licensing — the KRV question.**
  **Unblocks:** offering a Korean translation at all.
  The catalogue row for **개역한글 (Korean Revised Version, 1961)** is **quarantined in code**:
  `LEGAL_HOLD_TRANSLATION_CODES = ['KRV']`, its licence field reads *"Contested — public-domain
  status in Korea unconfirmed"*, and a filter keeps it out of every picker and every resolution
  path. It was inherited from the prior project without the per-language public-domain verification
  process.
  **Steps — pick one, and record which:**
  (a) obtain a licence from the Korean Bible Society and clear the quarantine flag;
  (b) obtain written confirmation of public-domain status in Korea and clear it on that basis; or
  (c) leave it quarantined and serve Korean text only from a licensed API with attribution.
  Do not clear the flag on a hunch — the row is deliberately auditable and re-enableable so that
  the decision is a decision, not a diff.

---

## Group D — legal

- [ ] **[LEGAL] Record the CCLI Streaming Licence number.**
  **Unblocks:** nothing technically — the pre-flight check *warns*, it does not block — but
  streaming worship music without a current **Streaming** licence (which is separate from the
  ordinary church copyright licence) is a real legal exposure, and the required attribution has to
  go out with the stream.
  **Steps:** confirm the church's CCLI licence explicitly covers **streaming**, record the number,
  and put the required attribution into the broadcast description template in Go Live settings.
  See [`docs/v2-notes/LEGAL_AND_CONTENT.md`](./docs/v2-notes/LEGAL_AND_CONTENT.md).

- [ ] **[LEGAL] Final legal review before distributing a build.** Three things, together:
  1. **Bundled translations** — confirm every entry in the translation catalogue that is marked
     public-domain genuinely is, in the jurisdictions this is used in, and that the KRV decision
     above has been made and applied.
  2. **CCLI / attribution wording** — confirm the on-screen and in-description attribution text
     satisfies the licence terms.
  3. **EULA and third-party notices** — [`NOTICE.md`](./NOTICE.md) is generated by
     `scripts/generate-notice.mjs` from the `dependencies` tree plus Electron, and reproduces the
     licence text each component requires. It names each package's **declared** licence; it is not
     an audit of whether that declaration is correct, and that audit is the lawyer's job. Confirm
     it ships alongside the installer, and settle the EULA wording for distribution.

---

## Group E — distribution and updates

- [ ] **[PURCHASE] Windows code-signing certificate** — the biggest single item for anyone else
  installing this.
  **Unblocks:** two things at once.
  1. **The installer.** It is currently **unsigned**: `forceCodeSigning: false` in
     `electron-builder.yml` states that deliberately. SmartScreen shows *"Windows protected your PC
     — unknown publisher"* and the operator must click *More info → Run anyway*. That warning is
     correct and should not be explained away as a habit.
  2. **Auto-update.** `electron-updater` on Windows verifies the publisher name on a downloaded
     installer against the installed app's signature, so an unsigned build cannot be safely
     auto-updated at all.
  **Steps:** buy an EV code-signing certificate or set up **Azure Trusted Signing**, then wire it
  into the *release workflow* — never into this repository. Do **not** add `certificateFile`,
  `certificatePassword` or `signtoolOptions` to `electron-builder.yml`; signing material belongs in
  a hardware-backed store. See `docs/v2-notes/OPS_AND_UPDATE.md` §5.

- [ ] **[SETUP] A host for the update manifest** — only if auto-update is wanted.
  **Unblocks:** `electron-updater`. There is currently **no update server**, no `publish:` block,
  no `latest.yml` and no embedded `app-update.yml`; the updater module reads its feed URL from
  configuration and stays completely inert — makes no network call at all — while that is unset.
  **Steps:** provision a bucket/CDN (Cloudflare R2, S3, or any static host), uncomment the
  `publish:` block in `electron-builder.yml` with its URL, re-release, and upload **both** the
  installer and the generated `latest.yml`. Prefer a versioned path so old installers stay
  retrievable for a rollback. Do this **after** the certificate above, not before.

- [ ] **[DECISION] Real brand art.** The prior project's `brand/logo.png` is a 0-byte placeholder,
  so there is nothing to inherit and `build-resources/` is empty — the current build ships the
  stock Electron icon and electron-builder logs "default Electron icon is used".
  **Unblocks:** app icon, installer branding, and the overlay logo/holding-slate layer.
  **Steps:** supply a square **1024×1024 PNG** (app-icon source), a **256×256 `.ico`** at
  `build-resources/icon.ico`, and a transparent SVG/PNG wordmark for the lower-third and logo
  slate. Installer sidebar art is optional — do not add `installerIcon` / `installerSidebar` keys
  to `electron-builder.yml` until the files actually exist, because electron-builder fails the
  build on a missing referenced asset.

---

## Verification still owed

These are not code tasks. They are the things **only a real environment can prove**, and until
somebody does them this build's claims about the outside world rest on mocks. Each one is a single
afternoon.

- [ ] **OBS reconnect and wrong-password behaviour.** *The connection itself is no longer owed.* As
  of **2026-07-28** Verger has spoken to a live obs-websocket many times (OBS 32.1.2 /
  obs-websocket 5.7.3): version and scene list confirmed, the generated password accepted, and the
  **packaged `Verger.exe` on the stick** observed holding an ESTABLISHED socket to the bundled OBS
  on 4455 — discovery, password read and authentication, performed from its own directory.
  **What is still owed are the two failure paths:** close OBS mid-service and watch the reconnect
  succeed, and get the password wrong once to confirm it stops rather than retrying forever.
- [ ] **One real OBS Browser Source over a live camera.** *Partly advanced 2026-07-28.* OBS's own
  browser source has now loaded `http://127.0.0.1:7320/overlay` from a running Verger and held an
  ESTABLISHED WebSocket to it — an `obs-browser-page` process connected to the overlay server, which
  is more than "fetched and parsed". **Still owed:** it has never been composited over live video,
  so transparency is unproven, a lower-third surviving a camera cut un-flickered is unproven, and
  right-click → Refresh restoring the same content is unproven.
  **A defect was found while establishing this — see the item below.**

- [ ] **[SETUP] Work around the launch-order defect until it is fixed in code.**
  **The problem, measured on 2026-07-28, not inferred:** a browser source loads its URL when OBS
  starts. `START.bat` starts OBS *first* and Verger eight seconds later, so the overlay server is
  not listening yet, the page load is refused, and — because `restart_when_active` is deliberately
  **off** so camera cuts do not re-animate the overlay — it never retries. OBS reports connected,
  Verger reports connected, and **nothing ever reaches the stream**. Confirmed by netstat: no
  `obs-browser-page` connection to 7320 at all, and one forced `refreshnocache` immediately produced
  two ESTABLISHED sockets.
  Reversing the order is not a fix either: `src/main/index.ts` does a **one-shot**
  `isObsPortListening` check at launch and deliberately does not dial a closed port, so starting
  Verger first gives a working overlay and no OBS connection.
  **Until it is fixed, after `START.bat` has finished:** in OBS, right-click the **Overlays** source
  → **Refresh**, once. Verger's overlay watchdog already detects the dead state and says exactly
  this, so the console will tell you if you forget.
  **The real fix** is for Verger to press the refresh itself when it is connected to OBS and its
  overlay server has no client — precisely the watchdog's existing condition. That is a code task,
  recorded here only because an operator carrying the stick before it lands needs the workaround.
- [ ] **One real dry-run go-live**, unlisted, five minutes, with nobody watching. Confirm all five
  GO LIVE steps complete, the LIVE and RECORDING indicators are both on, and — afterwards — that
  **the local recording file exists and plays**. Then END and confirm the broadcast reads
  *Finished*. This is the single most valuable item on this page: it is the only way to test the
  path where a mistake is un-repeatable.
- [ ] **One real deck imported.** A genuine Sunday `.pptx`, converted through LibreOffice, with the
  slide order spot-checked (slide 10 must come after slide 2) and the images confirmed to appear on
  the congregation screen.
- [ ] **One real sermon transcribed**, on both engines if both are configured. Measure: does Korean
  recognition track well enough to be useful, what is the end-to-end speech→suggestion latency, and
  does the custom vocabulary meaningfully improve the pastor's name and the church's name?
- [ ] **One install on a clean Windows profile.** Run the unsigned installer, click through
  SmartScreen, launch, and walk [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) end to end. Confirm the
  overlay static files and the ASR sidecar resolve from `resources/` in a packaged build, and that
  the absence of the ASR venv degrades to "local recogniser unavailable" rather than an error.
- [ ] **One rehearsal service before a real one.** Not a Sunday.

---

## Notes

- The out-of-repo resource pool `C:\ClaudeFlow\projects\rhema\resources\` **exists** and is
  reusable: `bin/win/ffmpeg.exe`, `models/` (ONNX Whisper encoder/decoder, `lid.176.bin`), and
  `bibles/catalog.json` — a curated **public-domain-only** translation catalogue with per-entry
  licence, attribution and pinned source URL. That catalogue is the model this project's
  translation catalogue follows: public-domain data downloaded at runtime, never committed, with
  copyrighted translations left to a licensed API.
- Nothing in this file blocks development. Every item has a defined not-configured state that is
  visible in the UI, covered by a test, and documented in
  [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) §2.

---

## Resolved

- [x] **[SETUP] OBS setup on the stick — steps 1–5 of Group A.** *Resolved 2026-07-28 (Cycle 20).*
  `npm run obs:assemble` wires a portable OBS into the USB folder: `portable_mode.txt` so it keeps
  its settings inside its own folder, a generated scene collection with one `Cam 1` scene holding an
  `Overlays` browser source already pointed at the overlay port with the five settings correct, a
  profile stripped through an allowlist so no machine-specific value ships, and obs-websocket
  enabled with a **freshly generated password per assembly** that the operator never sees or types —
  Verger reads it from OBS's own config file, so it never enters Verger's `config.json` (Standing
  Rule 5). `START.bat` launches that OBS, but only when nothing is already on 4455, so an OBS the
  operator opened themselves always wins.
  **Proven, not assumed:** `npm run obs:verify` scores 17/17 against the real assembled folder,
  including that the generated password authenticates and that OBS itself reports `shutdown`,
  `restart_when_active` and `reroute_audio` correct — the three values a mis-click gets wrong. The
  packaged `Verger.exe` was then launched from the stick and observed connecting to the bundled OBS
  on its own.
  **What remains for the operator is step 6** (a recording path with room) **and adding the room's
  camera to the `Cam 1` scene.** This item does not apply to a machine using its own installed OBS.

- [x] **[HARDWARE] Confirm the local-ASR plan.** *Resolved during Phase 7.* The concern was that
  `faster-whisper` / `ctranslate2` might not publish wheels for Python 3.14, and that 4 GB of VRAM
  would not hold a useful model. Outcome: `ctranslate2` **does** ship a cp314 Windows wheel, so a
  project-local venv was provisioned at `resources/asr-venv` (gitignored, ~290 MB) with
  faster-whisper 1.2.1 + ctranslate2 4.8.1 + onnxruntime 1.27.0. Measured on this machine:
  `get_cuda_device_count()` → 1 (GTX 1650, 4 GB); `tiny` loads in 0.8 s (CPU int8) and transcribes
  3 s of audio in 0.12 s. **Decision: accept the smaller model** — the local tier defaults to
  `small` for finals and `tiny` for drafts at int8, with a CPU fallback if CUDA init fails, since a
  driver update must not stop a service. `large-v3` will not load on 4 GB and is not offered.
  *Still owed:* real speech. See "Verification still owed" above.
