# Ops, First-Run, Service-Day Flow & Auto-Update — mined from rhema_v2
> Sources read (verbatim/full):
> - `C:\Side projects\rhema_v2\docs\GETTING_STARTED.md` (full)
> - `C:\Side projects\rhema_v2\docs\AUTO_UPDATE.md` (full)
> - `C:\Side projects\rhema_v2\cloud\README.md` (full)
> - `C:\Side projects\rhema_v2\cloud\update-manifest\README.md` (full)
> - `C:\Side projects\rhema_v2\cloud\update-manifest\build-manifest.mjs` (full)
> - `C:\Side projects\rhema_v2\cloud\update-manifest\latest.example.json` (full)
> - `C:\Side projects\rhema_v2\cloud\workers\src\index.js` (full)
> - `C:\Side projects\rhema_v2\cloud\workers\schema.sql` (full)
> - `C:\Side projects\rhema_v2\cloud\workers\wrangler.toml` (full)
> - `C:\Side projects\rhema_v2\.env.example` (full)
> - `C:\Side projects\rhema_v2\PROBLEMS.md` (items #2, #65, #67, #68, plus header)
> - `C:\Side projects\rhema_v2\Rhema_Blueprint_v3.4.md` — grepped sections: ADR-010, ADR-011, PART 10.3–10.7, threat table rows T8–T16, Appendix B env vars (**not read in full — 238KB, per instructions**)
> - Git history only (files deleted from the working tree but present at `HEAD`, read via `git show HEAD:<path>`, read-only): `src-tauri/src/updater.rs`, `src-tauri/src/licensing/mod.rs`, `src-tauri/src/licensing/activation.rs`, `src-tauri/src/licensing/machine_id.rs`, `src-tauri/src/licensing/hmac.rs`, `src-tauri/src/licensing/client.rs` (partial), and commit `7b76a26` message.

---

## 0. CRITICAL CONTEXT — read this before trusting anything below

This is the single most important finding of this mining pass, and it reframes everything else in this note:

- **The rhema_v2 working tree has no `src-tauri/` directory at all.** `find`/`ls` confirm it. Every Rust module described below (`updater.rs`, `licensing/*.rs`) was recovered with `git show HEAD:<path>` — it exists in git history (committed at `7b76a26`, "feat(cloud): Phase 5") but is **not present on disk** in this checkout. Treat the Rust code quoted here as historical reference only, not as something you can build against.
- **`docs/AUTO_UPDATE.md` and `cloud/*` were written to satisfy an internal audit, not real production experience.** `PROBLEMS.md` (dated 2026-07-02 23:45) flags, verbatim:
  - `65. **(C) [implementation] No auto-update mechanism** (ADR-010, PART 10.3): no updater code, no R2 manifests, gap not even tracked in HUMAN_TASKS.md.`
  - `67. **(C) [implementation] No licence-activation system (PART 10.7):** no Workers/D1 endpoints, no machine-ID HMAC, no first-launch gate, no offline grace, no Paddle webhooks. Product currently has **no monetization/seat enforcement**.`
  - `68. **(C) [structure] No server-side component exists at all** (ADR-017 premise): no Cloudflare/Neon/Resend code, infra-as-code, or stubs.`
  The `cloud/` directory and `AUTO_UPDATE.md` were added the very next day (2026-07-03, commit `7b76a26`) specifically to close those three findings. **No real Cloudflare account, R2 bucket, or D1 database was ever provisioned** — `HUMAN_TASKS.md` still escalates that. The "Verification (mock)" section of `AUTO_UPDATE.md` says it plainly: `cargo test -p rhema updater::` only validates a parser against a static JSON fixture; "Real end-to-end verification requires a signed build + an R2 bucket; those steps are gated on the human tasks."
- **The Rust `updater.rs` never actually performs a network check or a signature verification itself.** Its `check()` function, when the `updater` feature is compiled in and env vars are set, returns `UpdaterStatus::UpToDate { current }` unconditionally — a hardcoded placeholder. The doc comment admits this directly: *"The actual network check + signature verification is performed by the tauri-plugin-updater at the app layer... this function reports 'configured' readiness; the plugin drives the update."* So: **all real download/verify/install logic in v2 was 100% delegated to the `tauri-plugin-updater` crate's built-in behavior — the team wrote zero lines of signature-verification or download code themselves.** This matters for Verger: `electron-updater` gives you the same kind of built-in verify/download/install; don't re-implement it, but also don't assume "we wrote an updater" — you're wiring a library, and the wiring (feature flags, manifest shape, env-var plumbing, UI gating) is the actual work product.
- **Root architecture mismatch that produced all of this**: PROBLEMS.md #2 — *"Runtime is Tauri 2 + Rust; ADR-001 mandates Electron and explicitly rules Tauri out... Every Electron-specific requirement downstream (ADR-010 electron-updater, ADR-011 @sentry/electron, PART 3 `rhema://` scheme/BrowserWindow model, PART 10.4 Fuses/ASAR) is inapplicable as written and none has a documented Tauri-equivalent decision (no ADR recorded for the swap)."* `docs/AUTO_UPDATE.md` line 1 even says outright: *"The Electron→Tauri swap (PROBLEMS.md #2) replaces ADR-010's `electron-updater` with `tauri-plugin-updater`; the contract below is the Tauri-equivalent decision."* — an ad hoc reinterpretation of the spec, done without ever writing the ADR that PROBLEMS.md says is missing.

**Lesson for Verger**: since Verger is Electron, you are going *back* to the original, authoritative blueprint decision (ADR-010) rather than the ad hoc Tauri workaround. Section 5 below extracts ADR-010/PART 10.3–10.7 verbatim from `Rhema_Blueprint_v3.4.md` because it is the more directly applicable source for an Electron rebuild than the Tauri doc is.

---

## 1. First-run flow (`docs/GETTING_STARTED.md`)

### Installation
1. Download installer from the releases page (Windows 11 Pro+, 8GB+ RAM recommended).
2. Run `rhema-setup.exe`; choose install folder and hardware tier (**Lite / Standard / Pro**).
3. App initializes `~/.rhema/` with default settings, empty service library, bundled models.
4. Launch app → first-run wizard appears.

### First-Run Wizard (5 steps, verbatim structure)
1. **Hardware & Performance** — confirms RAM/GPU against tier thresholds (Lite: 8GB, Standard: 16GB, Pro: 32GB+); auto-detect or manual pick; warns if system is below the chosen tier.
2. **Display Setup** — scans monitors; assigns roles: **Main** (program output), **Stage** (lyrics/speaker notes), **Lobby/Overflow** (waiting area), **Caption** (live captions), **Stream** (encoder monitoring). Skippable per-stage.
3. **Network Binding** — bind address default `127.0.0.1` (loopback only). Quote: *"If you have mobile/tablet operators on your venue LAN, set this to your machine's concrete LAN IP (e.g. `192.168.1.100`) and enable remote control — RHEMA never binds a blind `0.0.0.0`."* Remote control can be skipped entirely if only using the operator keyboard.
4. **Import Your First Deck** — prompts for PowerPoint/PDF/playlist import (drag-and-drop or browse); creates one Media Cue per slide/page.
5. **Confirm & Start** — saves to `~/.rhema/settings.toml`; launches main interface.

## 2. Service-day operator flow (verbatim structure)

### Pre-Service (5 minutes before)
1. Open app, select "New Service" or load a saved runbook.
2. Click "Import Slides" (if not already done) or select existing playlist.
3. Press **SPACE** once to advance to slide 1; verify video/audio on Main display.
4. Check each display role: Main shows slides, Stage shows speaker notes/lyrics.
5. Audio check: tap microphone, verify caption panel shows live text (if Whisper STT enabled on Standard/Pro).

### During Service — keymap (verbatim)
| Key | Action |
|---|---|
| **SPACE (tap)** | advance slide |
| **SPACE (hold 3 seconds)** | **PANIC** — emergency stop; halts all AI, holds last slide |
| **B** | black screen (mute video/audio outputs; sermon continues) |
| **L** | show logo/branding screen |
| **F** | freeze current slide (useful during prayers) |
| **ESC** | clear all overlays (captions, lower thirds, Bible verses) |
| **Y/N** | confirm/dismiss an AI recommendation (SlideMind, Bible-detect) |

AI features (tier-gated): **SlideMind** (slide-advance recommendation, confidence thresholds **80% recommend / 95% auto-advance**), **Bible Auto-Detect**, **Live Captions** (Standard+, caption display + QR-linked attendee panel), **Camera Director** (Pro, autonomous PTZ switching). Governing rule, verbatim: *"All AI recommendations are gated: **the operator always wins**. Press Y to accept or N to dismiss."*

### Post-Service
1. Press "Stop Service" (or auto-stop at scheduled end time).
2. **AI Modules Restore** — summarizes sermon, generates sermon notes, indexes transcript.
3. **Post-Service Dashboard**: export podcast clip (auto-trimmed), upload to YouTube with AI-generated metadata, export CCLI report, create vertical clips (9:16).
4. Operator approves/edits generated metadata before upload.
5. Archive to `~/.rhema/services/` (indexed by date and speaker).

## 3. Remote control (ports + pairing)

- **Mobile panel**: scan pairing QR on operator display (`Settings → Security → Remote Control`), or open `http://<venue-ip>:7320/panel`. Roles offered: Supervisor, Presentation, Camera, Lighting, Stream.
- **Stream Deck plugin**: pairs by scanning the same QR — *"it mints a one-time token, not a long-lived JWT."* Targets REST API on **`localhost:7321`** for simple button actions, or WebSocket on **`7320`**.
- Settings menu path for all pairing/token management: **Settings → Security → Remote Control** (also manages caption tokens, audit log).
- All settings persist to `~/.rhema/settings.toml` (auto-save).

## 4. Emergency Recovery (verbatim)

```
### If RHEMA Crashes
- **Relaunch** the app — it auto-recovers the last service state.
- **CTRL+D** recovers from the last safe checkpoint (rewinds ~10 seconds of AI state).

### If You Press PANIC Accidentally
- **SPACE (hold 3 seconds again)** to re-enable AI and resume normal operation.
- All AI systems (cameras, lighting, captions) return to their previous state.
- **Live stream and sermon recording continue uninterrupted** (PANIC never cuts video).
```

No further detail on the crash-recovery mechanism (e.g. what "last safe checkpoint" is stored as) exists in `GETTING_STARTED.md`; it isn't covered by the files this brief assigned. Flag as **not found in mined sources** if an implementer needs the storage format.

## 5. Auto-update — signed manifest design

### 5.1 What v2 actually built (Tauri-era, `docs/AUTO_UPDATE.md` + `cloud/`)

**Overview** (verbatim): *"RHEMA checks a **static JSON manifest** on Cloudflare R2 for a newer signed build, downloads the platform artifact, **verifies its minisign signature** against a pinned public key, and installs it. An unsigned or tampered artifact is refused (supply-chain defence, T12)."*

**Env keys** (from `.env.example`, section "Licensing & updates (PART 10.3/10.7, ADR-010, Phase 5)"):
```
RHEMA_LICENSE_API_URL=
RHEMA_UPDATE_MANIFEST_URL=
RHEMA_UPDATER_PUBKEY=
```
- `RHEMA_UPDATE_MANIFEST_URL` — points at `latest.json` on R2.
- `RHEMA_UPDATER_PUBKEY` — signing public key, mirrored into `tauri.conf.json → plugins.updater.pubkey`.
- With an **empty `.env`** the updater is fully disabled: no network check ever attempted, no crash.
- Feature gate: updater plugin only linked under Cargo feature `updater` (`--features updater`); default build reports `NotBuilt`.

**Manifest schema** (exact shape, from `updater.rs` structs + example file):
```json
{
  "version": "0.2.0",
  "pub_date": "2026-07-01T00:00:00Z",
  "notes": "Bug fixes and stability improvements.",
  "platforms": {
    "windows-x86_64": {
      "signature": "<minisign detached signature, base64>",
      "url": "https://updates.rhema.app/r2/rhema-0.2.0-setup.nsis.zip"
    }
  }
}
```
Rust types (`updater.rs`, recovered via git history):
```rust
pub struct UpdateManifest {
    pub version: String,          // semver e.g. "0.2.0"
    #[serde(default)] pub pub_date: String,  // ISO 8601
    #[serde(default)] pub notes: String,
    pub platforms: std::collections::BTreeMap<String, PlatformArtifact>,
    // keys are target triples: "windows-x86_64", "darwin-aarch64", "linux-x86_64"
}
pub struct PlatformArtifact {
    pub signature: String,  // minisign/base64, verified against RHEMA_UPDATER_PUBKEY
    pub url: String,        // R2 public object URL
}
```
`UpdaterStatus` enum the frontend gates UI on: `NotConfigured` (empty env), `NotBuilt` (updater feature off), `UpToDate { current }`, `Available { current, version, notes }`, `Error { message }`.

**Version comparison** — pure, dependency-free, numeric-segment semver compare (`is_newer(current, candidate) -> bool`): splits on `.`, strips leading `v`, compares each segment numerically if both parse as u64, else lexically; longer version wins on trailing segments. Tests confirm `0.1.9 < 0.2.0`, `0.1.0 < 1.0.0`, `v`-prefix tolerated.

**Signing key lifecycle**:
1. Generate once: `npx tauri signer generate -w rhema-updater.key`.
2. Public half → `RHEMA_UPDATER_PUBKEY` env + `tauri.conf.json` `pubkey`.
3. Private half → CI secret `TAURI_SIGNING_PRIVATE_KEY` (**never committed**); `.env.example` mirrors the name with an empty value.

**Release flow** (verbatim commands):
```sh
# Build a signed release with the updater feature:
export TAURI_SIGNING_PRIVATE_KEY="$(cat rhema-updater.key)"
npx tauri build --no-default-features --features updater

# Build + upload the manifest:
node cloud/update-manifest/build-manifest.mjs \
  --version 0.2.0 --base-url https://updates.rhema.app/r2 \
  --windows-artifact rhema-0.2.0-setup.nsis.zip \
  --windows-sig "$(cat rhema-0.2.0-setup.nsis.zip.sig)" > latest.json
wrangler r2 object put rhema-updates/latest.json --file=latest.json
wrangler r2 object put rhema-updates/rhema-0.2.0-setup.nsis.zip --file=rhema-0.2.0-setup.nsis.zip
```

**CDN layout**: Cloudflare R2 bucket `rhema-updates`, flat object keys — `latest.json` and `rhema-{version}-setup.nsis.zip` at bucket root (no versioned path prefix in this implementation; contrast with the *original blueprint* layout in §5.2 below, which does use `/stable/{version}/`). `RHEMA_UPDATE_MANIFEST_URL` points directly at the `latest.json` object URL, e.g. `https://updates.rhema.app/r2/latest.json`.

**`cloud/update-manifest/build-manifest.mjs`** (Node script, no deps beyond `node:process`):
- CLI args parsed as `--key value` pairs (positional pairing, no library).
- Required: `--version`, `--base-url`. At least one of `--windows-artifact` / `--macos-artifact` / `--linux-artifact` required or it exits 1.
- Platform key mapping: `--windows-artifact` → `platforms["windows-x86_64"]`, `--macos-artifact` → `platforms["darwin-aarch64"]`, `--linux-artifact` → `platforms["linux-x86_64"]`.
- `pub_date` defaults to `new Date().toISOString()` if `--pub-date` not given; `notes` defaults to `""`.
- Writes pretty-printed JSON to stdout (caller redirects to `latest.json`).
- Today only `windows-x86_64` is exercised (only Windows bundle target configured); macOS/Linux slots are dead code paths ("left for when those bundle targets are added").

**Rollout/rollback**: **Not designed.** Neither `AUTO_UPDATE.md` nor `build-manifest.mjs` nor `updater.rs` implements staged rollout (% of users), a rollback manifest, or a "pin to previous version" path — `latest.json` is a single mutable pointer to the current version, overwritten in place on each release. This is a real gap to design intentionally for Verger, not a pattern to copy.

**Mock verification only**: `cargo test -p rhema updater::` runs `parse_valid_manifest` (parses a manifest matching the example shape, asserts version/signature/URL fields), `is_newer_numeric_semver`, `parse_rejects_garbage` (garbage JSON → `Err`), `check_reports_not_built_or_configured`, `current_version_matches_cargo`. All of these are pure/offline — **no real R2 bucket or signed artifact was ever exercised end-to-end.**

### 5.2 The ORIGINAL authoritative spec — ADR-010 (Electron), `Rhema_Blueprint_v3.4.md`

This is the actually-Electron-relevant decision, extracted verbatim/near-verbatim via grep (the file was **not** read in full, per instructions — only these matched sections):

**ADR-010** (verbatim):
> **Status:** ACCEPTED
> **Decision:** `electron-builder` + `electron-updater`. macOS: Squirrel.Mac via ZIP + `releases.json`. Windows: NSIS + YAML manifest. Manifests on Cloudflare R2 (zero egress cost).
> **(C) WARNING:** MUST NOT call `autoUpdater.checkForUpdates()` when `process.argv` includes `--squirrel-firstrun` on Windows. Causes crash.

**PART 10.3 "Auto-Update Flow"** (verbatim, numbered steps):
1. Build produces: `Rhema-{version}-mac.dmg`, `-mac.zip`, `-win.exe`, `latest-mac.yml`, `latest.yml`.
2. GitHub Actions uploads **all artefacts** (installers + manifests) to Cloudflare R2: bucket `rhema-releases`, path `/stable/{version}/`. *"No GitHub Releases for binaries — R2 zero-egress means no per-download CDN cost as customer count grows."*
3. Update manifest URLs: `https://updates.syncsanctuary.io/stable/latest-mac.yml`, `/latest.yml`.
4. On app start: `autoUpdater.checkForUpdates()` after a **10s delay** (avoid first-run Squirrel.Windows lock).
5. `update-downloaded` event → notify operator in status bar. **NEVER force-restart during a service.**
6. Applied on next manual restart with explicit user consent.
7. **(H)** *"MUST NOT call `checkForUpdates()` when `process.argv` includes `--squirrel-firstrun`."* (repeated from ADR-010 — this is a well-known real electron-updater/Squirrel.Windows footgun, worth hard-coding a guard for.)

Note the CDN layout difference from what v2 actually built: blueprint uses a **versioned path** `bucket rhema-releases /stable/{version}/` with per-platform YAML manifests (`latest.yml`, `latest-mac.yml` — the native `electron-updater` manifest format), whereas the Tauri build used a **flat single `latest.json`** at bucket root with no version history retained in the path. For Verger, prefer the blueprint's versioned-path layout — it's what `electron-updater` expects natively and it preserves old versions on the CDN for potential rollback-by-republish.

**PART 10.4 "Electron Fuses & ASAR Integrity"** (directly applicable to Verger — Electron-specific hardening never done in v2 because Tauri has no Fuses/ASAR concept):
```
runAsNode:                         false   // block ELECTRON_RUN_AS_NODE code injection (T11)
enableNodeCliInspectArguments:     false   // block --inspect / --inspect-brk debugger attach
enableNodeOptionsEnvironmentVariable: false // block NODE_OPTIONS injection
enableEmbeddedAsarIntegrityValidation: true // validate app.asar contents at load (macOS+Windows)
onlyLoadAppFromAsar:               true   // only load app.asar; no app/ or default_app fallback
grantFileProtocolExtraPrivileges:  false   // file:// gets no bonus privileges (serve rhema:// instead)
enableCookieEncryption:            true   // encrypt Chromium cookie store at rest
loadBrowserProcessSpecificV8Snapshot: false
```
- **(C)** standalone Node helper processes MUST use Electron's `UtilityProcess` API, not `child_process.fork` (depends on the now-disabled `runAsNode`). Relevant if Verger has an SQLite writer worker or AI worker process.
- **(C)** Pin Electron to a version with the ASAR-integrity-bypass fix: **≥ 27, or patched 22.3.24 / 24.8.3 / 25.8.1 / 26.2.1**. Older builds let an attacker with `Resources/` write access replace `app.asar` and run code with the app's camera/mic TCC entitlements even with fuses on.
- **(M)** CI should audit the shipped build with a Fuses checker (e.g. `@electron/fuses` read mode) and fail the release if any high-risk fuse is enabled.
- **(M)** macOS entitlements must NOT include `com.apple.security.cs.disable-library-validation` or `com.apple.security.cs.allow-dyld-environment-variables`.

**PART 10.5 "Supply Chain, SBOM & Signing-Key Management"** (verbatim highlights):
- CycloneDX SBOM per release (`@cyclonedx/cyclonedx-npm`).
- SLSA-style build provenance / GitHub Actions artifact attestations.
- `pnpm audit` + `osv-scanner` gate the build; **`pnpm install --ignore-scripts`** in CI with an allow-list for native modules that legitimately need build scripts.
- **(C)** *"Signing keys never touch CI source: macOS Developer ID cert + Windows EV/Azure Trusted Signing credentials live in a hardware-backed store / cloud HSM (Azure Key Vault, GitHub OIDC-scoped secrets), are never committed, and are accessible only to the tag-triggered release workflow. Key compromise = revoke + re-issue runbook documented."*

**PART 10.6 "LAN Transport Security"**: when LAN remote control is enabled, serve REST/WS over **TLS** (`https://`/`wss://`) with a locally generated self-signed cert; the pairing QR carries the cert fingerprint so the Remote app pins it (TOFU). Loopback-only mode (default) may stay plaintext on `127.0.0.1`. LAN bind is always to a specific operator-chosen interface/IP, never `0.0.0.0`; mDNS advertises only while LAN mode is on. (Directly matches GETTING_STARTED.md's network-binding wizard step, §1 above.)

**Threat table rows relevant to updates** (verbatim from the T-table):
| ID | Sev | Threat | Mitigation |
|---|---|---|---|
| T10 | M | Update channel compromise (attacker serves malicious manifest) | *"electron-updater verifies code signature of the downloaded artifact against the pinned publisher cert; manifests served over HTTPS from R2; never auto-install during a service"* |
| T16 | M | Update downgrade attack (attacker offers older, vulnerable signed build) | *"electron-updater configured to refuse versions lower than the installed one; manifest is integrity-checked; release notes/version monotonicity enforced."* |
| T12 | H | AI model supply-chain poisoning | SHA-256 pinned per model in `config/models.json`; verify before load; HTTPS-only from pinned origin |

**Offline behavior** (PART "graceful degradation" table, verbatim row): *"Auto-update | Skipped silently."* — matches the "empty `.env` ⇒ never crashes" rule the Tauri build also followed.

**Appendix B env var** (blueprint's *original* naming — differs from what v2 actually shipped, flag this discrepancy explicitly):
| Variable | Default | Description |
|---|---|---|
| `RHEMA_UPDATE_URL` | `https://updates.syncsanctuary.io/stable` | Auto-update manifest **base URL** |
| `SENTRY_DSN` | (none) | Sentry project DSN, injected at build time |
| `GIT_SHA` | (none) | Injected at build time for Sentry release tagging |

**⚠ Naming discrepancy to resolve for Verger**: the blueprint's Appendix B calls it `RHEMA_UPDATE_URL` (a *base* URL you append `/latest.yml` etc. to); the actually-implemented Tauri code calls it `RHEMA_UPDATE_MANIFEST_URL` (a full URL pointing straight at `latest.json`). Since the mining brief explicitly names `RHEMA_UPDATE_MANIFEST_URL`/`RHEMA_UPDATER_PUBKEY` as the keys of record, treat those as canonical for Verger, but be aware the "PART 10.3" flow text talks in terms of a base URL + per-OS YAML files (`electron-updater`'s native format), which doesn't perfectly match a single `RHEMA_UPDATE_MANIFEST_URL` pointing at one JSON file. Reconcile explicitly in the Verger ADR rather than silently picking one (see §6).

## 6. Licensing API (`cloud/workers/` — read in full, included because it's the direct twin of the update-manifest problem: signed/verified artifacts from a trusted server, gated by env var)

**Endpoints** (`cloud/workers/src/index.js`, Cloudflare Worker):
```
POST /activate        { license_key, fingerprint }  -> { activated, plan, seats, seats_used, message }
POST /validate        { license_key, fingerprint }  -> { valid,     plan, seats, seats_used, message }
POST /paddle/webhook  (Paddle-Signature header, HMAC-SHA256 verified) -> issues/updates licenses
GET  /health                                        -> { ok: true }
```
- Seat model: one seat = one distinct `fingerprint`. Fingerprint = `HMAC-SHA256(key = license_key, msg = machine_id)`, computed **client-side**; raw machine id never reaches the server (matches the D1 schema comment: *"the raw machine id NEVER reaches the server"*).
- Paddle webhook signature check: extracts `h1=<hex>` from the `paddle-signature` header (or accepts bare hex), HMAC-SHA256 over the raw body with `PADDLE_WEBHOOK_SECRET`, constant-time compare (`timingSafeEqualHex`).
- Errors never leak internals — generic `{ error: "internal error" }` 500 on any thrown exception.
- `handleActivate`: idempotent (re-activating the same fingerprint succeeds without consuming a new seat); refuses when `seats_used >= lic.seats`; refuses revoked or expired licenses.
- `handleValidate`: updates `seats.last_seen_at` on success; used as the periodic heartbeat.

**D1 schema** (`cloud/workers/schema.sql`, exact):
```sql
CREATE TABLE IF NOT EXISTS licenses (
    license_key TEXT PRIMARY KEY,
    plan        TEXT NOT NULL DEFAULT 'standard',
    seats       INTEGER NOT NULL DEFAULT 1,
    revoked     INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER,                 -- unix seconds; NULL = perpetual
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
    license_key  TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    PRIMARY KEY (license_key, fingerprint),
    FOREIGN KEY (license_key) REFERENCES licenses(license_key)
);
CREATE INDEX IF NOT EXISTS idx_seats_license ON seats(license_key);
```
Test license insertion example (verbatim, useful for local dev seeding):
```sql
INSERT INTO licenses (license_key, plan, seats, revoked, expires_at, created_at)
VALUES ('RHEMA-TEST-0001', 'pro', 3, 0, NULL, strftime('%s','now'));
```

**`wrangler.toml`** deploy steps (verbatim):
```
1. wrangler d1 create rhema-licenses          # note the database_id below
2. wrangler d1 execute rhema-licenses --file=./schema.sql
3. wrangler secret put PADDLE_WEBHOOK_SECRET   # from Paddle dashboard
4. wrangler deploy
```
`database_id` in the committed `wrangler.toml` is a placeholder: `"REPLACE_WITH_D1_DATABASE_ID"` — never actually filled in (consistent with "no real Cloudflare account was provisioned").

**Client-side offline grace (from `licensing/activation.rs`, git-history only)**:
- `GRACE_PERIOD_DAYS = 14` — after the last *successful online* validation, failed validations are tolerated for 14 days before the app locks.
- `LICENSE_HTTP_TIMEOUT = 8s` — short so a dead API degrades to grace quickly instead of hanging app launch.
- `LicenseStatus` enum: `NotConfigured` | `Unlicensed` | `Licensed{plan,seats,seats_used}` | `Grace{days_remaining,plan}` | `Locked{reason}` where `reason` is `GraceExpired` or `Rejected{message}`.
- Revalidation happens on every launch (`revalidate()`), is idempotent, and treats any transport/parse error as the offline-grace path (not a rejection) — only an explicit server response of `valid:false`/`activated:false` locks immediately.
- Persisted record file: `~/.rhema/license.json` (plaintext JSON — `license_key`, `fingerprint`, `last_validated_at`, `seats`, `seats_used`, `plan`). Machine id cached at `~/.rhema/machine_id`.
- `machine_id()` resolution order: on-disk cache (authoritative once written) → OS-specific stable source (Windows: `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`, fallback `COMPUTERNAME` env; macOS: `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID`; Linux: `/etc/machine-id` or `/var/lib/dbus/machine-id`) → random UUID v4 fallback. The raw OS value is always re-hashed through UUID v5 (namespace `NAMESPACE_OID`) before use, and never transmitted — only the HMAC fingerprint is sent.
- HMAC implementation is a from-scratch RFC 2104 HMAC-SHA256 over the already-linked `sha2` crate (no extra dependency), constant-time compared via the `subtle` crate. Test-verified against RFC 4231 test case 2.

**Blueprint's original design differs from what got built** (`Rhema_Blueprint_v3.4.md` PART 10.7, grepped — not fully read):
- Original schema uses table names `licences`/`activations` (British spelling, UUID v4 `id` primary key referencing a `paddle_subscription_id`), tiers `'church' | 'church_pro' | 'campus' | 'enterprise'`, statuses `'trialing'|'active'|'past_due'|'cancelled'`.
- Original API base: `https://api.syncsanctuary.io/v1/` with paths `/licences/activate`, `/licences/deactivate`, `/licences/validate`, `/webhooks/paddle` — note the **British "licences" spelling and versioned `/v1/` prefix**, and a `/deactivate` endpoint that the actually-built Worker (`index.js`) never implements at all.
- machine_id in the original spec: HMAC-SHA256 of "motherboard UUID + OS install ID" specifically (the built version is looser — "stable per-machine hardware identifier" via whatever the OS exposes).

Reconcile: for Verger, the built v2 contract (`/activate`, `/validate`, `/paddle/webhook`, US spelling "license") is simpler and has working reference code; the blueprint's contract adds `/deactivate` (needed for seat transfer — a real gap in what shipped) and a versioned API path (`/v1/`) which is good practice for any new build. Recommend: keep the simpler v2 endpoint names but add `/deactivate` and put everything under `/v1/`.

## 7. Cloud subsystem inventory (`cloud/README.md` table, verbatim)

| Subsystem | Module (v2/Tauri) | Feature flag | Env var(s) |
|---|---|---|---|
| License activation + offline grace | `licensing/` | pure; HTTP behind `cloud-services` | `RHEMA_LICENSE_API_URL` |
| Crash reporting (Sentry) | `crash.rs` | `crash-reporting` | `SENTRY_DSN` |
| Auto-update | `updater.rs` + `tauri-plugin-updater` | `updater` | `RHEMA_UPDATE_MANIFEST_URL`, `RHEMA_UPDATER_PUBKEY` |
| Cloud AI (Claude) | `knowledge/claude.rs` | `cloud-services` | `ANTHROPIC_API_KEY`, `RHEMA_CLOUD_AI_MODEL` |
| Bible providers (ESV / API.Bible) | `bible/providers/` | `cloud-services` | `ESV_API_KEY`, `API_BIBLE_KEY` |
| Planning Center OAuth2 + PKCE | `runbook/planning_center_oauth.rs` | `cloud-services` | `PCO_CLIENT_ID`, `PCO_CLIENT_SECRET` |
| Neon offline-first sync | `campus/neon.rs` | `cloud-services` (Postgres) | `NEON_DATABASE_URL` |

Full `.env.example` (verbatim, all cloud-related keys in one place):
```
# --- Crash reporting (ADR-011, Phase 5) ---
SENTRY_DSN=

# --- Licensing & updates (PART 10.3/10.7, ADR-010, Phase 5) ---
RHEMA_LICENSE_API_URL=
RHEMA_UPDATE_MANIFEST_URL=
RHEMA_UPDATER_PUBKEY=

# --- Cloud AI (ADR-006 Stage 7, Phase 5) ---
ANTHROPIC_API_KEY=

# --- Bible translation providers (ADR-013, Phase 5) ---
ESV_API_KEY=
API_BIBLE_KEY=

# --- Planning Center OAuth (PART 12.1, Phase 5) ---
PCO_CLIENT_ID=
PCO_CLIENT_SECRET=

# --- Multi-site sync (ADR-017, Phase 5) ---
NEON_DATABASE_URL=

# --- Payments / license issuance (PART 10.7, Phase 5; used by cloud/workers, not the app) ---
PADDLE_API_KEY=
PADDLE_WEBHOOK_SECRET=
```
Governing rule stated at the top of `cloud/README.md`, verbatim: *"Everything is **env-var driven** and degrades to a clean 'not configured' state when unset — the desktop app boots and runs fully offline with an empty `.env`."* This "empty env = degraded, never crash" discipline is worth carrying into Verger unmodified — it's the one part of this subsystem that was actually well-designed and is UI-framework-agnostic.

Build flags referenced (Tauri-specific, N/A to Verger but shows the intended separation of concerns):
```sh
cargo build                                                          # no cloud deps, all cloud paths are typed stubs
cargo build --features cloud-services                                 # network clients (reqwest + sqlx-postgres)
npx tauri build --no-default-features --features updater,crash-reporting,cloud-services   # full release
```

---

## Verger application notes

The Tauri/Rust engine is **not** being ported. Concretely, for the Electron/TypeScript rebuild:

1. **Follow ADR-010/PART 10.3 directly — you don't need a "Tauri-equivalent" translation, you have the original.** Use `electron-builder` + `electron-updater` as designed: NSIS+YAML manifest on Windows, Squirrel.Mac ZIP+`releases.json` on macOS. This sidesteps the entire "undocumented architecture swap" problem that produced PROBLEMS.md #2/#65 in v2 — there is no swap to document.
2. **Hard-code the Squirrel.Windows first-run guard.** Both ADR-010 and PART 10.3 flag this as a **(C)/(H)** crash risk: never call `autoUpdater.checkForUpdates()` when `process.argv` includes `--squirrel-firstrun`. Also apply the blueprint's 10-second startup delay before the first check.
3. **Never auto-restart mid-service.** This is the one rule both the v2 doc and the blueprint agree on unconditionally: `update-downloaded` → notify only (status bar / toast), apply only on a manual restart with explicit consent. Given RHEMA/Verger's PANIC-button service-continuity design (§4 above), an update forcing a restart during a live service would be a severe regression — treat this as a hard invariant, ideally enforced by checking "is a service currently active" before ever surfacing the restart prompt.
4. **Reconcile the env-var naming before writing code, don't inherit the ambiguity.** Decide once, in an ADR: is `RHEMA_UPDATE_MANIFEST_URL` a full URL to a single JSON manifest (what v2's Rust code actually implements) or a *base* URL that `electron-updater` appends its own per-platform YAML filenames to (what the blueprint's Appendix B / PART 10.3 describes, and what `electron-updater` natively expects via its `publish` config in `electron-builder.yml`)? **Recommendation: let `electron-updater` use its native generic-provider config (`url: <base>`) and point `RHEMA_UPDATE_MANIFEST_URL` at that base** — this matches `electron-updater`'s actual API shape (`autoUpdater.setFeedURL({ provider: 'generic', url })`) far better than hand-rolling manifest parsing the way `updater.rs` did, and it means you don't need a bespoke `build-manifest.mjs`/`parse_manifest` at all — `electron-builder`'s publish step generates the YAML manifests for you.
5. **`RHEMA_UPDATER_PUBKEY` doesn't map 1:1 onto electron-updater.** `tauri-plugin-updater` does minisign verification against a pinned pubkey as a first-class feature; `electron-updater` instead relies on **OS-level code-signing verification** of the downloaded installer (Authenticode on Windows via EV cert/Azure Trusted Signing, Apple notarization on macOS) plus HTTPS transport — it does not do an independent minisign check by default. Options for Verger: (a) rely on OS code-signing alone (simpler, matches PART 10.5's actual signing-key guidance which is EV-cert/Azure-HSM based, not minisign) and drop `RHEMA_UPDATER_PUBKEY` entirely; or (b) keep an extra minisign-style verification step for defense-in-depth against a compromised CDN even after code-signing (belt-and-suspenders, matches T10/T16 threat rows). Decide explicitly rather than cargo-culting a pubkey env var whose verification path doesn't exist end-to-end in Electron by default.
6. **Design rollout/rollback intentionally — v2 never did.** Neither `latest.json` (flat, single-version, overwritten in place) nor the blueprint's `/stable/{version}/` layout implements staged rollout or a rollback lever. For Verger, prefer the blueprint's **versioned R2/CDN path layout** (`/stable/{version}/...`) so old installers stay retrievable, and add a deliberate rollback mechanism (e.g., a "pinned max version" flag in the manifest, or simply re-publishing an older version's manifest as `latest`). This is new design work, not extraction from v2.
7. **Port the "empty env = clean degraded state, never crash" discipline verbatim.** It's the one piece of `cloud/README.md`'s design that's framework-agnostic and genuinely good: every cloud subsystem (license, update, crash reporting, cloud AI, Bible APIs, PCO, Neon) must boot to a typed "NotConfigured" state on an empty `.env`/missing key, with the app fully functional offline. Mirror the `UpdaterStatus`/`LicenseStatus` enum pattern (`NotConfigured | NotBuilt-equivalent | UpToDate | Available | Error`) in TypeScript discriminated unions gating the renderer UI.
8. **Do not trust `cargo test -p rhema updater::` as evidence of a working updater**, and don't let Verger's equivalent test suite give false confidence either: those tests are pure/offline (JSON parsing + semver compare against a static fixture). Budget an explicit, separate task for a **real end-to-end update test**: a signed test build, a real (or emulated, e.g. MinIO) R2-compatible bucket, an actual `electron-updater` download+verify+install cycle. This was never done in v2 and is exactly the kind of "claimed done, never verified" gap the project's own audit called out repeatedly.
9. **Add the licensing `/deactivate` endpoint that v2's shipped Worker never implemented** (present only in the original blueprint's PART 10.7 API table) — needed for legitimate seat transfer between machines; its absence in v2 is a real product gap, not a deliberate simplification.
10. **The HMAC-fingerprint machine-binding scheme (client computes `HMAC-SHA256(license_key, machine_id)`, server never sees the raw machine id) is sound and framework-agnostic — port the design, not the Rust.** In Node/Electron: `crypto.createHmac('sha256', licenseKey).update(machineId).digest('hex')`, machine id from `node-machine-id` or platform-native reads (Windows registry `MachineGuid`, macOS `IOPlatformUUID` via `ioreg`, Linux `/etc/machine-id`) cached to a local file, same fallback-to-random-UUID discipline v2 used.
11. **Reuse the D1 schema and Worker verbatim if Cloudflare Workers/D1 is still the target** — `cloud/workers/schema.sql` and `cloud/workers/src/index.js` are real, runnable, framework-agnostic (plain JS Worker, no Tauri/Rust dependency) and were never actually deployed/tested against a live account. They're a reasonable starting point for Verger's license API as-is, but budget time to actually provision the Cloudflare account/D1 database and run it for real — `wrangler.toml`'s `database_id` is still the placeholder string `"REPLACE_WITH_D1_DATABASE_ID"`.
12. **14-day offline grace period, 8-second HTTP timeout for license checks** — both are reasonable, low-risk numbers to carry forward unchanged (`GRACE_PERIOD_DAYS = 14`, `LICENSE_HTTP_TIMEOUT = 8s`).
13. **Apply PART 10.4's Electron Fuses list verbatim** — this is pure upside for Verger since it's Electron-specific hardening the Tauri build never needed and therefore never got documented as "done" anywhere in v2; treat it as new, mandatory work, and gate CI on a Fuses-checker (e.g. `@electron/fuses` read mode) per PART 10.5.
14. **The first-run wizard, keymap, and Emergency Recovery UX in §1/§2/§4 are engine-agnostic product spec — port them as-is.** Nothing there depends on Tauri; it's IPC/UI/UX design that should transfer directly into Verger's Electron main/renderer split (per the blueprint's PART 3 container table: main process owns lifecycle/IPC hub/SQLite writer/hardware drivers/auto-updater/crash-reporter-init; renderer(s) are pure UI with no Node access via typed IPC bridge).
