/**
 * Assemble the copy-to-USB portable folder.
 *
 * electron-builder's `--dir` build produces `release/<version>/win-unpacked/` — a self-contained
 * folder with `Verger.exe` and everything it needs (the audit confirmed zero native dependencies, so
 * it runs on any Windows x64 machine with no install step). This script drops the operator-facing
 * files that must sit NEXT TO the exe — the launcher, the default config.json, the runbook, the OBS
 * setup guide, and the asset-folder guidance — into that folder, by copying everything under
 * `portable/` on top of it.
 *
 * Run it via `npm run portable`, which builds the dir target first. Running it standalone assumes the
 * dir build already exists and fails with a clear message if it does not.
 *
 * This is a build tool, not shipped code: it may use the filesystem and `console` freely.
 */

import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(scriptsDir, '..')

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const version = pkg.version
const unpacked = join(repoRoot, 'release', version, 'win-unpacked')
const portableTemplate = join(repoRoot, 'portable')

function fail(message) {
  console.error(`\n  make-portable: ${message}\n`)
  process.exit(1)
}

if (!existsSync(join(unpacked, 'Verger.exe'))) {
  fail(
    `no dir build found at\n    ${unpacked}\n` +
      `  Run "npm run package:portable" first (it builds the unpacked folder), or just "npm run portable".`,
  )
}

if (!existsSync(portableTemplate)) {
  fail(`the template folder is missing:\n    ${portableTemplate}`)
}

// Copy portable/** on top of win-unpacked/, next to Verger.exe. Recursive + overwrite so re-running
// after editing a template file refreshes it.
cpSync(portableTemplate, unpacked, { recursive: true, force: true })

console.log(`
  Portable folder ready:

    ${unpacked}

  It contains Verger.exe, START.bat, config.json, assets\\, obs\\ and RUNBOOK.md.

  To deploy:
    1. Copy the whole "win-unpacked" folder onto the USB stick.
    2. Rename it to something friendly like "Verger" (optional).
    3. On the church PC: open the folder and double-click START.bat.

  Nothing else is required — no install, no Node, no admin, no internet at launch.
`)
