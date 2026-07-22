# Network & Hardware — mined from rhema_v2

> Sources: `C:\Side projects\rhema_v2\docs\NETWORK_SETUP.md`, `C:\Side projects\rhema_v2\docs\HARDWARE_REQUIREMENTS.md`

This note is the SPEC baseline for Verger's networking (remote control, REST, captions,
DMX/NDI/streaming) and hardware-tier gating. rhema_v2 is Tauri/Rust; none of its Rust
listener code is portable, but the **port numbers, bind posture, auth model, and tier
thresholds are product decisions** that should carry forward unless Verger has a reason
to change them.

## 1. Socket / port table (verbatim from v2)

| Service | Port | Protocol | Default Bind | Purpose |
|---|---|---|---|---|
| **Remote Control WS** | **7320** | WebSocket | 127.0.0.1 (unless `remote_enabled: true` + a concrete LAN IP) | Mobile/tablet operator panel + Stream Deck |
| Remote Control WS (legacy alias) | 3001 | WebSocket | 127.0.0.1 only | Deprecated pre-migration endpoint; loopback-only, not LAN-reachable. New pairings should use 7320, not 3001. |
| **REST API** | **7321** | HTTP | 127.0.0.1 (unless `remote_enabled: true` + a concrete LAN IP) | `/v1/*` control surface (slides, cameras, DMX, streams, AI mode, `/v1/status` health) |
| **Caption Server** | 8765 | WebSocket | **127.0.0.1** (loopback only, unconditionally) | Attendee live captions (QR-linked PWA); LAN devices reach it via the venue host's own LAN IP, never via a wildcard bind |
| **Campus Sync WS** | 3002 | WebSocket | Configured per satellite (concrete IP, e.g. `192.168.10.100`) | Multi-campus HQ↔satellite relay |
| **ArtNet/sACN** | 6454 / 5568 | UDP | Broadcast/multicast on configured production interface | DMX lighting control |
| **NDI** | 5353–5368 | UDP | Configured trusted interface | Camera feed discovery + video (Pro tier) |
| **RTMP/SRT** | 1935 / 10080+ | TCP/UDP | Outbound only | Streaming to YouTube, Facebook, custom RTMP/SRT |

**No "Operator Control API" socket exists.** v2 docs previously (incorrectly) listed a port
8420. That number is a dead settings field (`NetworkSettings.control_port`) never wired to
any listener — v2's in-process operator control ran over Tauri IPC, which has no TCP
equivalent. **Do not carry a phantom control port into Verger's port table.** In Electron,
the analogous "operator control" is main↔renderer IPC (`ipcMain`/`ipcRenderer` or a
preload bridge) — it should not have a network port either, matching v2's posture.

Gotcha the v2 docs flag explicitly: keep documented ports in sync with the actual listener
code as you build — v2's own docs drifted from the code once already (their PROBLEMS.md
#104) and had to be rewritten against source.

## 2. Bind posture — loopback-first, LAN is explicit two-part opt-in

This is the core security posture to replicate in Verger:

> "Loopback-first, LAN is explicit opt-in, never blind `0.0.0.0`."

- Remote WS (7320) and REST API (7321) both default to `bind_address = "127.0.0.1"` and
  `remote_enabled = false`.
- LAN exposure requires the operator to **both**:
  1. flip `remote_enabled = true`, **and**
  2. set `bind_address` to a concrete interface IP (e.g. `"192.168.1.100"`).
  There is no code path that binds a wildcard `0.0.0.0`.
- The caption server (8765) binds `127.0.0.1` **unconditionally**, always — it is never
  configurable to bind elsewhere. LAN attendees reach it not because the process opened a
  LAN-facing socket, but because connecting to the host machine's own LAN IP routes to the
  loopback listener at the OS/NIC level (the same mechanism that makes any loopback service
  reachable via the host's own address). This is a subtle but important distinction — copy
  this exact bind behavior in Verger's caption server, don't accidentally bind `0.0.0.0`
  for "convenience."
- There is no separate `rest_enabled` flag in v2 — REST starts/stops together with remote
  WS, gated by the single `remote_enabled` flag. (Worth deciding explicitly for Verger
  whether to keep them coupled or split them — v2 treats this as a known simplification,
  not a documented deliberate choice.)

### Settings shape (TOML, `~/.rhema/settings.toml` in v2)

```toml
[network]
bind_address = "127.0.0.1"        # or a concrete LAN IP, e.g. "192.168.1.100"
artnet_enabled = true
remote_enabled = false            # gates BOTH remote WS (7320) and REST (7321)
ndi_bind_interface = null         # or e.g. "eth0"

[ai]
director_mode_enabled = false
```

For Verger this maps to an analogous config object (JSON/electron-store), e.g.:
```ts
interface NetworkSettings {
  bindAddress: string;       // default "127.0.0.1"
  remoteEnabled: boolean;    // default false — gates remote WS + REST together
  artnetEnabled: boolean;
  ndiBindInterface: string | null;
}
```

## 3. Authentication — two independent mechanisms (not unified in v2)

Verger should decide up front whether to unify these two auth domains, since v2 never did.

### Remote WS (7320) + REST API (7321): hashed token + TLS TOFU pairing

- **No JWT.** Pairing mints a random **256-bit token**; only its **SHA-256 hash** is
  stored server-side (v2: `api_tokens` table). The raw token is shown to the operator
  **exactly once**, inside a pairing QR payload — never embedded in a `ws://…?token=…` URL.
- Paired device presents the raw token on every request; server hashes and does a
  **timing-safe compare** against the stored hash.
- WS handshake: token via query param or handshake header (client-dependent).
  REST: `Authorization: Bearer <raw>` preferred, `?token=<raw>` query fallback (for simple
  clients like Stream Deck that can't set headers).
- **LAN TLS + TOFU pinning:** when LAN access is enabled, the server generates a
  self-signed cert (v2 used `rcgen`, persisted as `~/.rhema/lan_cert.pem` / `lan_key.pem`).
  The pairing QR carries the cert's **SHA-256 fingerprint**; client pins it on first
  connect (trust-on-first-use) and can detect a MITM'd cert on reconnect.
- **Request pipeline order** (replicate this order in Verger):
  1. Host allow-list (DNS-rebinding defense)
  2. Origin allow-list (cross-site WebSocket hijacking defense)
  3. Token auth (hash + timing-safe compare)
  4. RBAC tier check
  5. Per-token rate limit: **100 req/min**, `429` + `Retry-After` header on exceed.
- Role → RBAC tier mapping is identical across WS and REST — one pairing grants the same
  authority on both surfaces.
- **Token revocation:** Settings → Security → Revoke Token marks the token row revoked;
  the snapshot query used on every request excludes revoked rows immediately (no caching
  lag mentioned — treat revocation as effective-immediately).
- v2 legacy note (do not replicate): an older HS256-JWT path existed for the pre-migration
  3001 alias. Not relevant to a fresh Verger build — go straight to the hashed-token model.

### Caption Server (8765): separate HS256 JWT, its own auth domain

- Caption/attendee PWA authenticates with a signed **HS256 JWT** carried as
  `?token=<JWT>`, issued/verified via dedicated issue/verify functions — a **completely
  separate token system** from the `api_tokens` hashed-token model above.
- v2 explicitly never migrated this to the hashed-token model — treat it as intentionally
  its own domain if replicating, or as a deliberate unification opportunity for Verger.
- QR pairing: the operator's Main screen shows a QR encoding a caption-pairing JSON payload
  carrying the current caption JWT — a **separate QR flow** from the remote-control pairing
  QR (which carries the hashed-token payload).

## 4. Firewall guidance

### Outbound (RHEMA → Internet) — allow:
- **TCP 443** (HTTPS: updates, cloud services)
- **TCP 1935** (RTMP to YouTube/Facebook)
- **UDP 10080+** (SRT streaming, if using a custom SRT endpoint)

### Inbound rules table

| Port | Protocol | Allow From | Purpose |
|---|---|---|---|
| 8765 | WS | LAN only (host's own LAN IP; process itself binds loopback) | Attendee captions |
| 7320 | WS | 192.168.0.0/16 (local LAN) | Remote panel (disable if unused) |
| 7321 | HTTP | 192.168.0.0/16 (local LAN) | REST control surface / Stream Deck (disable if unused) |
| 3001 | WS | 127.0.0.1 only | Legacy remote alias — not LAN-reachable by design |
| 3002 | WS | 192.168.10.0/24 (production VLAN) | Campus satellite sync (HQ only) |
| 6454 | UDP | 192.168.0.0/16 | ArtNet DMX lighting |
| 5568 | UDP | 192.168.0.0/16 | sACN E1.31 lighting |
| 5353–5368 | UDP | 192.168.10.0/24 (production VLAN) | NDI camera ingest (Pro tier) |

### Internet-facing captions (advanced, not recommended)
If exposing captions beyond the venue LAN: port-forward 8765 TCP, require WSS (TLS
terminated at router), mandatory valid caption token (no public/anonymous access),
firewall rate-limit **max 100 connections/min per IP**. v2's docs explicitly recommend
against this — keep captions LAN-only and share the QR via a local display instead.

### ArtNet/sACN specific
UDP broadcast/multicast, **no authentication** at the protocol level. Restrict bind to the
production interface (not WiFi) — configurable in Settings → Network → ArtNet Interface.
Best practice: put the lighting rig on a separate VLAN or at least separate physical
network from the attendee WiFi.

### NDI specific
**Default: disabled.** NDI multicast sends the live video feed unencrypted to any device
listening on the subnet — enable only on a trusted, isolated (production Ethernet) network,
never on guest/public WiFi.

## 5. Network architecture patterns (reference topologies)

**Small venue (single router, 1 IP/device):** operator PC binds 127.0.0.1:7320 +
127.0.0.1:7321 (loopback/off if no tablet operator), 127.0.0.1:8765 for captions (LAN
reachable via host IP), plus 192.168.1.0/24 broadcast for ArtNet.

**Multi-site / VLAN-isolated:** production VLAN (e.g. 192.168.10.0/24) carries HQ + N
satellites + camera, fully isolated from a congregation/attendee VLAN (e.g.
192.168.20.0/24) that carries WiFi attendees + paired mobile operators. HQ binds
`<vlan-ip>:3002` for campus relay, `<vlan-ip>:7320/:7321` for remote (explicit opt-in),
broadcast for ArtNet/sACN, and always `127.0.0.1:8765` for captions. Satellites bind
`<vlan-ip>:3002` to receive HQ sync and run their own local `127.0.0.1:8765`.

## 6. Hardware tiers — capability matrix

| Capability | Lite (8GB) | Standard (16GB) | Pro (32GB+) |
|---|---|---|---|
| Slide playback | yes | yes | yes |
| Multiple displays | up to 2 | up to 4 | unlimited |
| RTMP/SRT streaming | yes | yes | yes |
| Bible/song library | yes | yes | yes |
| Live captions (Whisper STT) | no | yes | yes |
| NLLB translation | no | yes | yes |
| AI slide-switching ("SlideMind") | no | yes | yes |
| Bible auto-detect | no | yes | yes |
| AI Camera Director (PTZ) | no | no | yes |
| Speaker biometric identity | no | no | yes |
| Multi-campus satellite mode | no | no | yes |
| Local LLM (sermon summary) | no | no | yes |
| Parallel inference tasks | 1 | 2 | 4+ |

### Lite (8GB RAM)
- Full: slides/overlays/lower-thirds, Bible & song library, RTMP/SRT streaming, MP4
  recording w/ chapter markers, ArtNet/sACN DMX, MIDI/LTC timecode.
- **No AI inference at all** (SlideMind, STT, biometrics disabled).
- Operator-only control — **no remote tablet/phone panel** (implies 7320/7321 effectively
  unused at this tier).
- Max 2 displays (operator + one output).
- CPU: quad-core Intel/AMD or Apple Silicon.
- Network: **2 Mbps upstream** (RTMP) + 20 Mbps LAN (ArtNet/sACN/NDI).
- Use case: small chapels, streaming-only, manual slide control.

### Standard (16GB RAM) — default/recommended tier
All Lite features plus:
- Live captions: Whisper STT, output to dedicated caption display or attendee PWA at
  `127.0.0.1:8765` (attendees reach via host LAN IP).
- NLLB-200 on-device translation, 200+ languages.
- SlideMind: confidence-gated auto-switching — **80% confidence = recommend, 95% =
  auto-advance**.
- Bible auto-detect: watches transcript, 2-tier regex + entity matching to suggest verses.
- Sermon Intelligence: 60-second context window, sermon indexing, entity search.
- Up to 4 displays: Main, Stage, Lobby, Caption.
- Remote control (optional): mobile panel on 7320 (WS) / 7321 (REST), Stream Deck plugin.
- Constraints: no computer-vision AI; **single inference task, strict FIFO** (if caption
  processing is running, SlideMind pauses); no multi-campus mode.
- CPU: **6+ cores** (Whisper transcription is CPU-intensive).
- Network: **5 Mbps upstream** + 50 Mbps LAN (video frame relay, caption server).
- GPU optional but improves transcription latency (NVIDIA CUDA or AMD ROCm).
- Use case: 100–500 attendee churches, multi-camera venues (VISCA PTZ via UDP only, no AI
  cut), sermon indexing/post-service automation.

### Pro (32GB+ RAM)
All Standard features plus:
- AI Camera Director: YOLOv8 object detection, autonomous multi-camera cut-switching with
  "respiratory pause gating" (waits for a natural pause before cutting).
- Speaker biometric identity: FaceNet (face) + x-vector (voice) recognition driving
  identity-based automation (presets, lighting, lower-thirds).
- Multi-campus HQ mode: SRT video relay + WS event sync to satellites, automated
  scene/slide/lighting sync.
- Local LLM (on-device Llama 2 / Mistral) for sermon summarization and YouTube metadata
  auto-generation.
- Unlimited displays, arbitrary roles, multi-monitor grids.
- Parallel inference: **4+ concurrent AI tasks** (caption + director + identity + LLM run
  in parallel — no FIFO gating at this tier).
- Constraints: GPU **strongly recommended** — NVIDIA RTX 3060+ or AMD equivalent, for
  **<5ms inference**. Requires NDI SDK (camera ingest) and SRT tools (video relay).
- CPU: **12+ cores**.
- Network: **10+ Mbps upstream** (multi-stream encode), **100 Mbps LAN** (NDI video +
  campus relay).
- GPU: **6+ GB VRAM** (NVIDIA CUDA or AMD ROCm). This is the only VRAM figure the source
  gives — it is not broken out per individual Whisper model size, just a floor for the
  whole Pro feature set (director + biometrics + LLM + captions running concurrently).
- Use case: multi-site churches/streaming networks, broadcast studios, full autonomous
  production.

## 7. GPU-for-Whisper guidance (as documented — this is thin)

The source docs do **not** give a per-model-size VRAM table for Whisper (tiny/base/small/
medium/large-v2/v3 etc.) — that level of detail is not present in NETWORK_SETUP.md or
HARDWARE_REQUIREMENTS.md. What is stated:
- Standard tier: **GPU optional**, improves transcription latency; NVIDIA CUDA or AMD ROCm.
  Transcription runs at **16 kHz**; lower quality = faster (a stated CPU-load lever).
- Pro tier: GPU **strongly recommended**, target **<5ms inference**, minimum **6+ GB VRAM**
  (NVIDIA CUDA or AMD ROCm), for the combined AI workload (not Whisper alone).
- Feature gate table (Cargo features) lists `whisper-stt` + `onnx-inference` together as
  "Standard+", requiring "ONNX Runtime + Whisper model (~500MB)" — so v2 runs Whisper via
  ONNX Runtime, not whisper.cpp directly, and the bundled/downloaded model is ~500MB (this
  reads as roughly a "small"/"medium"-class model size, but the doc does not name the exact
  Whisper variant — do not invent one).
- Each additional caption **target language adds ~50ms latency** (performance tuning note).
- **Note for Verger implementer:** if a real per-model VRAM table is needed (tiny ~1GB,
  base ~1GB, small ~2GB, medium ~5GB, large ~10GB is the well-known public Whisper
  guidance), that number is *not* sourced from rhema_v2 docs and must be sourced/verified
  independently — flag it as such rather than attributing it to this mining pass.

## 8. Feature gate table (Cargo features — Rust-specific, informs Verger's tier-gating logic only)

| Feature | Tier | Locked behind |
|---|---|---|
| `gstreamer-video` | Any | GStreamer SDK |
| `pdf-render` | Any | pdfium binary (bundled) |
| `whisper-stt` + `onnx-inference` | Standard+ | ONNX Runtime + Whisper model (~500MB) |
| `onnx-inference` | Standard+ | General ONNX inference (biometrics, embeddings) |
| `ndi` | Pro | NDI SDK (camera ingest) |
| `ndi-out` | Pro | NDI SDK (video output) |
| `virtual-cam` | Pro | Virtual camera driver |
| `serial-ptz` | Pro | Serial camera control (VISCA-serial) |
| `usb-dmx` | Any | USB-DMX adapter driver |
| `local-llm` | Pro | Llama.cpp backend |
| `ableton-link` | Any | Ableton Link native lib (off by default) |
| `wasm-plugins` | Any | Wasmtime (WASM plugin execution) |

Default Cargo build enables **none** of these — all opt-in. The *concept* (tier → feature
flag → capability unlock, defaulting to nothing enabled) is the reusable part; the specific
crate/SDK names are Rust/Tauri-only.

## 9. Auto-detection & tier suggestion logic

On first launch, v2:
1. Detects RAM via `sysinfo` (Linux `/proc/meminfo`, Windows API, macOS `vm_stat`).
2. Suggests a tier:
   - `<8 GB` → Lite (with a warning)
   - `8–15 GB` → Lite
   - `16–31 GB` → Standard (recommended)
   - `32+ GB` → Pro (recommended)
3. Operator can override in Settings regardless of detected RAM (e.g. "32GB but only need
   captions" → stay on Lite/Standard).

Electron equivalent: Node's `os.totalmem()` (cross-platform, no per-OS branching needed —
simpler than the Rust `sysinfo` approach) can replace step 1 directly.

## 10. Performance tuning levers (documented in v2)

- **Reduce latency:** disable unused AI features per-toggle (Settings → AI); on Pro,
  confirm GPU utilization isn't stuck at 0% (driver/CUDA issue); reduce caption target
  language count (**~50ms per added language**).
- **Reduce CPU load:** Standard transcribes at 16 kHz (lower quality = faster is the stated
  tradeoff); Pro can reduce parallel inference task count (Settings → Hardware → max
  concurrent tasks).
- **Network optimization / streaming bitrate tiers vs. upload bandwidth:**
  - upload **< 5 Mbps** → cap at **480p @ 2 Mbps**
  - upload **< 10 Mbps** → cap at **720p @ 5 Mbps**
  - (no explicit tier given above 10 Mbps in the source — Pro's own stated upstream
    requirement is 10+ Mbps for multi-stream encode, implying 1080p-class bitrates, but no
    exact "1080p @ X Mbps" pairing is written down in these two docs)
  - ArtNet/sACN: default refresh 30 fps, lower if lighting changes are infrequent.
  - Remote panel: disabling `remote_enabled` saves a **100ms state broadcast loop** — i.e.
    v2 runs a periodic ~100ms state-push to paired remote clients when remote control is on.

## 11. Tier upgrade/downgrade behavior

- **Upgrade** (Lite→Standard, Standard→Pro): Settings → Hardware → select tier → Restart;
  app prompts to download/enable feature models (Whisper, YOLO, LLM) on next launch; new
  features activate immediately on return to the main interface.
- **Downgrade** (not recommended, e.g. Pro→Standard): running AI tasks using now-unavailable
  features halt gracefully; feature-specific settings (e.g. camera director presets) are
  preserved but inactive; **reset is not automatic** — operator must manually disable
  Pro-only settings to avoid error logs. This is called out as a real gap in v2 — Verger
  should design downgrade to auto-disable orphaned settings rather than repeat this.

## 12. Troubleshooting notes worth preserving as UX copy/logic

- Remote panel won't connect → checklist: `remote_enabled: true` + concrete LAN
  `bind_address`; firewall allows 7320+7321 from the client IP; re-pair if token
  revoked/TLS fingerprint changed; **if client still targets legacy 3001, re-pair against
  7320** (3001 is loopback-only, intentionally unreachable from another device).
- ArtNet/sACN not working → check `artnet_enabled`, same subnet/broadcast domain, firewall
  UDP 6454/5568, correct bind interface selected.
- Attendees can't see captions → firewall inbound 8765 on operator's LAN IP (check router
  port-forward if off-LAN), caption token not expired, captioning enabled, Whisper STT not
  stuck (restart).
- NDI feed freezes → check VLAN latency (**<10ms ping to camera** as the health bar), GPU
  utilization active, reduce inference parallelism to free CPU, confirm camera is actually
  outputting NDI.

## Verger application notes

The Tauri/Rust engine is not being ported, but nearly everything above is a **product/
security decision**, not an implementation detail — Verger (Electron/TS) should replicate
the externally-visible contract exactly, and only change the internals:

1. **Keep the port numbers as the default contract** unless there's a concrete reason to
   renumber: 7320 (remote WS), 7321 (REST), 8765 (captions WS), 3002 (campus sync), 1935/
   10080+ (RTMP/SRT outbound), 6454/5568 (ArtNet/sACN UDP), 5353–5368 (NDI UDP). Do **not**
   resurrect the 3001 legacy alias or the phantom 8420 control port in a greenfield build —
   those existed only for v2's own migration history.
2. **Replicate the bind posture exactly:** default `bindAddress = "127.0.0.1"`,
   `remoteEnabled = false`; LAN exposure requires both a boolean flip and a concrete IP;
   never call `.listen()`/`createServer().listen(port, '0.0.0.0')` for these services. In
   Node terms: explicitly pass the bind address string to `http.Server.listen()` /
   `WebSocketServer({ host })` — never omit `host` (which defaults to all interfaces) and
   never hardcode `0.0.0.0`.
3. **Caption server binds loopback unconditionally**, same as v2 — do not add a
   "LAN caption bind" toggle; keep the "reachable via host's own LAN IP" behavior which
   falls out naturally from loopback + routing, not from an open bind.
4. **Auth:** implement the hashed-random-token + TOFU-TLS-pinning model for remote/REST
   from day one (skip v2's abandoned HS256-JWT legacy path entirely — it's dead weight in
   v2, don't reintroduce it). For Node: `crypto.randomBytes(32)` for the token,
   `crypto.createHash('sha256')` for storage, `crypto.timingSafeEqual` for comparison,
   self-signed cert via a lib like `node-forge` or `selfsigned`, fingerprint pinned in the
   pairing QR. Decide explicitly whether Verger unifies caption-JWT and remote-token auth
   into one system — v2 never did this and called it out as a known split; unifying is a
   legitimate simplification opportunity for a fresh build, not something to blindly copy.
5. **Preserve the request pipeline order:** Host allow-list → Origin allow-list → token
   auth → RBAC check → rate limit (100 req/min, 429 + Retry-After). This order matters for
   security (DNS rebinding and WS-hijack defenses must run before auth, not after).
6. **Operator control channel:** v2's Tauri IPC has no direct Electron equivalent as a
   "socket" — this is genuinely fine, because v2's point is that operator control was
   *never* a network service either. Implement it as Electron `ipcMain.handle` / a
   `contextBridge` preload API, and do **not** invent a TCP control port for it.
   `NetworkSettings.control_port` (8420) should not be resurrected in Verger's settings
   schema at all — it was vestigial even in v2.
7. **Hardware tiers:** carry forward the Lite/Standard/Pro thresholds (8/16/32GB) and the
   RAM-detection tier-suggestion table verbatim — they're product-level, not engine-level.
   Use `os.totalmem()` for detection (simpler than v2's per-platform `sysinfo` calls).
   Re-derive the feature-flag-per-tier concept using whatever gating mechanism Verger uses
   for optional native modules (e.g. dynamic `require()`/lazy-load behind a tier check)
   instead of Cargo features — but keep the "nothing enabled by default, everything opt-in"
   posture.
8. **GPU/Whisper VRAM:** the source docs do not contain a real per-model-size VRAM table —
   only "6+GB VRAM for Pro's combined AI workload" and "GPU optional/recommended" framing.
   Do not fabricate a Whisper model→VRAM table and attribute it to v2; if Verger's Whisper
   integration needs that spec, it must be sourced fresh (e.g. from whisper.cpp/faster-
   whisper docs) and documented as such, separate from this mining note. Also note v2 ran
   Whisper via **ONNX Runtime** (not whisper.cpp) with a **~500MB** bundled/downloaded
   model — Verger's Node-side STT integration (e.g. whisper.cpp bindings, ONNX Runtime
   Node, or a cloud fallback) is an open implementation decision, not specified here.
9. **Streaming bitrate ladder:** only two data points exist (<5Mbps→480p@2Mbps,
   <10Mbps→720p@5Mbps) — Verger will need to define its own bitrate ladder above 10Mbps
   (e.g. 1080p tier) since v2's docs don't specify one; flag this as a genuine gap to fill,
   not an oversight in this note.
10. **Firewall/VLAN guidance** (ArtNet on production interface not WiFi, NDI only on
    trusted isolated networks, captions LAN-only by default, rate-limit any internet-facing
    exposure at 100 conn/min/IP) is all protocol-level and hardware-agnostic — carry it
    into Verger's setup docs/UI copy essentially unchanged.
11. **Downgrade UX gap:** v2 admits tier-downgrade doesn't auto-disable orphaned Pro
    settings, causing error logs. Verger should close this gap rather than reproduce it —
    on tier downgrade, actively clear/disable settings for now-unavailable features rather
    than leaving them "preserved but inactive."
