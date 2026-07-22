# `build-resources/` — packaging art

`electron-builder.yml` sets `directories.buildResources: build-resources`, so **this is the
folder electron-builder looks in** for the application icon and the NSIS installer artwork.

**This folder is currently empty of art.** Builds therefore ship the stock Electron icon and
electron-builder logs:

```
• default Electron icon is used  reason=application icon is not set
```

That is a real, visible defect in a shipped product — the operator gets a generic Electron
atom in the Start menu and the taskbar — but it is *not* a build failure, so the pipeline
stays green while the art is outstanding. **Producing this art is a HUMAN_TASKS.md item**, not
something an agent can invent: `rhema_v2/brand/logo.png`, the only brand asset the prior
project had, is a **0-byte placeholder file**. There is no logo to convert. Someone has to
design or commission one.

Do not commit AI-generated or scraped placeholder art here. A wrong logo shipped in an
installer is worse than an obviously-absent one, because it looks deliberate.

---

## What is needed, exactly

| File | Format | Size | Used for | Required? |
| --- | --- | --- | --- | --- |
| `icon.png` | PNG, 32-bit RGBA, transparent | **1024×1024** | Master source. electron-builder will derive platform icons from it if no `.ico` is present. | Source of truth |
| `icon.ico` | Windows ICO, multi-resolution | **256, 128, 64, 48, 32, 16** px layers, 32-bit | App icon, NSIS installer + uninstaller icon, Start-menu and desktop shortcuts, taskbar | **Yes** for a polished Windows build |
| `installerSidebar.bmp` | BMP, 24-bit, **no** alpha | **164×314** | The left-hand banner on the NSIS welcome/finish pages | Optional |
| `uninstallerSidebar.bmp` | BMP, 24-bit, no alpha | **164×314** | Same banner in the uninstaller | Optional (defaults to `installerSidebar.bmp`) |
| `installerHeader.bmp` | BMP, 24-bit, no alpha | **150×57** | Header strip on interior NSIS pages | Optional |
| `installerHeaderIcon.ico` | ICO | **48×48** | Icon shown in the one-click installer header | Not used — Verger's NSIS build sets `oneClick: false` |

### Notes that will save an hour

- **The `.ico` must be genuinely multi-resolution.** A single 256×256 layer renamed `.ico`
  renders as a smeared blob at 16 px in the taskbar and in Explorer's details view. Generate
  all six layers from the 1024 px master.
- **NSIS sidebar/header images must be BMP, and 24-bit without an alpha channel.** NSIS
  silently renders a 32-bit BMP with a black or garbage background. Export flattened onto the
  intended background colour.
- **164×314 and 150×57 are exact.** NSIS does not scale them; a mismatched size is clipped.
- Design for a **dark booth**. Verger's whole UI is a dark high-contrast theme; an icon that
  only reads on a white background will be invisible on the operator's taskbar.
- Keep the silhouette legible at 16 px. A verger carries a mace and leads a procession — a
  simple, high-contrast mark, not a detailed scene.

### After adding the files

`icon.ico` is picked up automatically — no config change. The optional NSIS art is **not**;
add the keys to the `nsis:` block in `electron-builder.yml` only once the files exist, because
electron-builder fails the build on a referenced-but-missing asset:

```yaml
nsis:
  installerIcon: build-resources/icon.ico
  uninstallerIcon: build-resources/icon.ico
  installerSidebar: build-resources/installerSidebar.bmp
  installerHeader: build-resources/installerHeader.bmp
```

Then re-run `npx electron-builder --win --config electron-builder.yml` and confirm the
"default Electron icon is used" line is gone from the output.

---

## What does *not* belong here

- **Signing certificates or any credential.** There is no code-signing certificate on this
  machine and none may be committed. See the header of `electron-builder.yml`.
- Renderer-facing UI assets. Those live under `src/renderer/` and are bundled by Vite;
  `build-resources/` is read by the packager, not by the app.
- Overlay assets. Those live in `src/overlay/` and ship as an `extraResources` entry so the
  overlay server can serve them as real files from disk.
