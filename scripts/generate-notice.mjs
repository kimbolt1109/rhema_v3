#!/usr/bin/env node
/**
 * generate-notice.mjs — build `NOTICE.md`, the third-party attribution bundle.
 *
 *   node scripts/generate-notice.mjs            # writes ./NOTICE.md
 *   node scripts/generate-notice.mjs --check    # exit 1 if NOTICE.md is stale
 *   node scripts/generate-notice.mjs --out X.md
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `docs/v2-notes/LEGAL_AND_CONTENT.md` §5: every dependency actually shipped needs its
 * upstream licence text reproduced in a release NOTICE bundle — including the boring
 * permissive ones. "None" risk tier means "no royalty and no copyleft", not "no notice".
 * MIT, BSD and ISC all require the copyright notice and permission text to travel with
 * binary distributions, and Verger ships an NSIS installer, so this file is an obligation,
 * not a courtesy.
 *
 * ---------------------------------------------------------------------------
 * What counts as "shipped"
 * ---------------------------------------------------------------------------
 *  1. Every package reachable from `dependencies` in package.json, transitively. These are
 *     what electron-builder copies into the asar.
 *  2. `electron` itself. It is a devDependency by npm convention, but its prebuilt binary
 *     IS the runtime that gets installed — Electron (MIT) plus the Chromium and Node.js
 *     licences vendored inside it. v2's row 16 marked Electron "not applicable" because
 *     that build was Tauri; for Verger it flips to an active obligation.
 *
 * DevDependencies other than Electron (vitest, playwright, typescript, tailwind…) are not
 * distributed and are deliberately excluded. Listing them would be padding, and padding a
 * legal document makes it less trustworthy, not more.
 *
 * ---------------------------------------------------------------------------
 * Honest limits of this script — do not oversell its output
 * ---------------------------------------------------------------------------
 *  * It reports the licence a package DECLARES (its `license` field) and reproduces whatever
 *    LICENSE/COPYING/NOTICE file it ships. It does not audit whether the declaration is
 *    truthful, and it cannot see licences of vendored code inside a package that ships no
 *    licence file of its own.
 *  * Electron's own bundle contains Chromium, Node.js, V8, ffmpeg and hundreds of third
 *    party components under their own terms. This script reproduces the licence files
 *    present in the `electron` npm package; the full Chromium credits are shipped inside
 *    the Electron binary itself (`LICENSES.chromium.html`) and are referenced, not inlined.
 *  * A human still has to read the result before a real release. That review is a
 *    HUMAN_TASKS.md item.
 *
 * No dependencies beyond `node:` builtins, so it runs anywhere `npm` does.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * DevDependencies that are nonetheless distributed to end users.
 * Keep this list short and justify every entry in a comment.
 */
const SHIPPED_DEV_DEPENDENCIES = [
  // The Electron runtime binary IS the app. MIT, and it vendors Chromium + Node.js.
  'electron',
]

/** Files that, by convention, carry the licence text of a package. */
const LICENCE_FILE_PATTERN = /^(licen[sc]e|copying|notice|unlicense)([-_.].*)?(\.(md|txt|rst))?$/i

/** Refuse to inline anything pathological; Chromium credit dumps are megabytes. */
const MAX_LICENCE_TEXT_BYTES = 60_000

// ---------------------------------------------------------------------------
// Filesystem helpers — every one of them is failure-tolerant on purpose. A missing
// or malformed package must degrade to "unknown", never abort the generation.
// ---------------------------------------------------------------------------

/** Parse JSON, returning `null` on any failure. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve a package directory the way Node does: look in `node_modules` of `fromDir`,
 * then each ancestor. Handles both hoisted and nested installs, and scoped names.
 */
function resolvePackageDir(name, fromDir) {
  let current = fromDir
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** The licence texts a package ships, largest-first, capped. */
function readLicenceTexts(packageDir) {
  let entries
  try {
    entries = readdirSync(packageDir)
  } catch {
    return []
  }
  const texts = []
  for (const entry of entries.filter((e) => LICENCE_FILE_PATTERN.test(e)).sort()) {
    const file = join(packageDir, entry)
    try {
      if (!statSync(file).isFile()) continue
      let text = readFileSync(file, 'utf8')
      let truncated = false
      if (Buffer.byteLength(text, 'utf8') > MAX_LICENCE_TEXT_BYTES) {
        text = text.slice(0, MAX_LICENCE_TEXT_BYTES)
        truncated = true
      }
      texts.push({ file: entry, text: text.replace(/\r\n/g, '\n').trimEnd(), truncated })
    } catch {
      // Unreadable licence file: skip it rather than fail the run. It shows up in the
      // report as "no licence file found", which is the actionable signal.
    }
  }
  return texts
}

/** Normalise the many shapes of the `license` field into one string. */
function declaredLicence(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim() !== '') {
    return manifest.license.trim()
  }
  if (manifest.license && typeof manifest.license === 'object' && manifest.license.type) {
    return String(manifest.license.type)
  }
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((l) => (l && l.type ? String(l.type) : null)).filter(Boolean)
    if (types.length > 0) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

/** Best-effort project URL for the attribution table. */
function homepageOf(manifest) {
  if (typeof manifest.homepage === 'string' && manifest.homepage !== '') return manifest.homepage
  const repository = manifest.repository
  const raw =
    typeof repository === 'string' ? repository : repository && repository.url ? repository.url : ''
  if (raw === '') return ''
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

// ---------------------------------------------------------------------------
// Dependency walk
// ---------------------------------------------------------------------------

/**
 * Breadth-first walk of the production dependency graph.
 *
 * `optionalDependencies` are followed when actually installed (they end up in the asar if
 * present) and silently skipped when not. `peerDependencies` are not followed: npm 7+
 * installs them as real dependencies of somebody, so they are reached through that edge.
 */
function collectPackages(rootManifest) {
  const roots = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...SHIPPED_DEV_DEPENDENCIES.filter((name) => (rootManifest.devDependencies ?? {})[name]),
  ]

  /** @type {Map<string, object>} keyed by `name@version` so two majors both get listed. */
  const found = new Map()
  const missing = new Set()
  const queue = roots.map((name) => ({ name, fromDir: REPO_ROOT }))
  const visited = new Set()

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift()
    const packageDir = resolvePackageDir(name, fromDir)
    if (packageDir === null) {
      missing.add(name)
      continue
    }
    const visitKey = packageDir
    if (visited.has(visitKey)) continue
    visited.add(visitKey)

    const manifest = readJson(join(packageDir, 'package.json'))
    if (manifest === null) {
      missing.add(name)
      continue
    }

    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0-unknown'
    const key = `${name}@${version}`
    if (!found.has(key)) {
      found.set(key, {
        name,
        version,
        licence: declaredLicence(manifest),
        homepage: homepageOf(manifest),
        direct: roots.includes(name),
        texts: readLicenceTexts(packageDir),
        relativeDir: packageDir.slice(REPO_ROOT.length + 1).split(sep).join('/'),
      })
    }

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, fromDir: packageDir })
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      // Only follow optional deps that were actually installed.
      if (resolvePackageDir(dependency, packageDir) !== null) {
        queue.push({ name: dependency, fromDir: packageDir })
      }
    }
  }

  return {
    packages: [...found.values()].sort((a, b) =>
      a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
    ),
    missing: [...missing].sort(),
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapePipes(value) {
  return value.replace(/\|/g, '\\|')
}

function anchorFor(pkg) {
  return `${pkg.name}@${pkg.version}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function render(rootManifest, { packages, missing }) {
  const licenceCounts = new Map()
  for (const pkg of packages) {
    licenceCounts.set(pkg.licence, (licenceCounts.get(pkg.licence) ?? 0) + 1)
  }
  const licenceSummary = [...licenceCounts.entries()].sort((a, b) =>
    b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]
  )

  // Identical licence texts are emitted once and cross-referenced. Dozens of packages
  // ship byte-identical ISC/MIT boilerplate; repeating it 40 times makes the document
  // unreadable without adding a single word of legal content.
  const textGroups = new Map()
  const withoutText = []
  for (const pkg of packages) {
    if (pkg.texts.length === 0) {
      withoutText.push(pkg)
      continue
    }
    const joined = pkg.texts.map((t) => t.text).join('\n\n')
    const digest = createHash('sha256').update(joined).digest('hex').slice(0, 16)
    const group = textGroups.get(digest)
    if (group === undefined) {
      textGroups.set(digest, { digest, text: joined, packages: [pkg] })
    } else {
      group.packages.push(pkg)
    }
  }
  const groups = [...textGroups.values()].sort((a, b) =>
    a.packages[0].name.localeCompare(b.packages[0].name)
  )

  const lines = []
  const push = (line = '') => lines.push(line)

  push('# Third-Party Notices — Verger')
  push()
  push(
    `Verger ${rootManifest.version} bundles the third-party software listed below. Each component ` +
      'remains under its own licence; this file reproduces the notices those licences require to ' +
      'accompany a binary distribution.'
  )
  push()
  push('> Generated by `scripts/generate-notice.mjs`. Do not edit by hand — re-run the script.')
  push()
  push('## Scope, and what this file does not claim')
  push()
  push(
    '- Listed: every package reachable from `dependencies` in `package.json`, transitively, plus ' +
      '`electron` — which is a devDependency by npm convention but is the runtime that actually ' +
      'gets installed on the operator machine.'
  )
  push(
    '- Not listed: build and test tooling (vitest, playwright, typescript, tailwind, ' +
      'electron-builder …). None of it is distributed.'
  )
  push(
    '- The licence named for each package is the one that package **declares**. This file ' +
      'reproduces licence files as shipped; it is not an audit of whether a declaration is correct.'
  )
  push(
    '- **Electron vendors Chromium, Node.js, V8 and ffmpeg**, each under its own terms. The ' +
      'complete Chromium attribution set is shipped inside the Electron distribution itself as ' +
      '`LICENSES.chromium.html` and lands in the installed application directory; it is far too ' +
      'large to inline here and is incorporated by reference.'
  )
  push(
    '- Some third-party services Verger can talk to (YouTube Data API, Deepgram) are governed by ' +
      'their own terms of service, which bind the operator, not this codebase. Those are ' +
      'obligations of use, not of distribution, and are tracked in `HUMAN_TASKS.md`.'
  )
  push(
    '- No Bible translation text, hymn text or song lyric is bundled with Verger in any form. ' +
      'Copyrighted translations are fetched live with the operator’s own API credentials and ' +
      'attributed at render time (Standing Rule 4).'
  )
  push()
  push('## Summary')
  push()
  push(`- Components: **${packages.length}**`)
  push(`- Distinct declared licences: **${licenceCounts.size}**`)
  push()
  push('| Licence | Components |')
  push('| --- | ---: |')
  for (const [licence, count] of licenceSummary) {
    push(`| ${escapePipes(licence)} | ${count} |`)
  }
  push()
  if (missing.length > 0) {
    push('### Declared but not resolvable in `node_modules`')
    push()
    push(
      'These were named as dependencies but could not be found on disk when this file was ' +
        'generated. Re-run after a clean `npm install`; if they persist, they are a real gap.'
    )
    push()
    for (const name of missing) push(`- \`${name}\``)
    push()
  }
  push('## Components')
  push()
  push('| Component | Version | Licence | Direct | Project |')
  push('| --- | --- | --- | :---: | --- |')
  for (const pkg of packages) {
    const link = pkg.homepage === '' ? '' : `<${pkg.homepage}>`
    push(
      `| <a id="${anchorFor(pkg)}"></a>\`${escapePipes(pkg.name)}\` | ${pkg.version} | ` +
        `${escapePipes(pkg.licence)} | ${pkg.direct ? 'yes' : ''} | ${escapePipes(link)} |`
    )
  }
  push()
  if (withoutText.length > 0) {
    push('### Components shipping no licence file')
    push()
    push(
      'These packages declare a licence in their manifest but ship no `LICENSE`/`COPYING` file. ' +
        'The declared identifier below is the authoritative statement of terms for them; the ' +
        'canonical text of each SPDX identifier is available from <https://spdx.org/licenses/>.'
    )
    push()
    for (const pkg of withoutText) {
      push(`- \`${pkg.name}@${pkg.version}\` — ${pkg.licence}`)
    }
    push()
  }
  push('## Licence texts')
  push()
  push(
    'Byte-identical texts are reproduced once and attributed to every component that ships them.'
  )
  push()
  for (const group of groups) {
    const names = group.packages.map((p) => `\`${p.name}@${p.version}\``).join(', ')
    push(`### ${group.packages[0].name}${group.packages.length > 1 ? ' and others' : ''}`)
    push()
    push(`Applies to: ${names}`)
    push()
    const truncated = group.packages[0].texts.some((t) => t.truncated)
    if (truncated) {
      push(
        `> Truncated at ${MAX_LICENCE_TEXT_BYTES} bytes. The complete text ships inside the ` +
          `package at \`${group.packages[0].relativeDir}\`.`
      )
      push()
    }
    push('```text')
    // Fence-safe: a licence file containing ``` would break the block.
    push(group.text.replace(/```/g, "'''"))
    push('```')
    push()
  }
  push('---')
  push()
  push(
    'Verger itself is not open source and is distributed under its own end-user licence. ' +
      'Nothing in this file grants rights to Verger; it grants and preserves the rights that ' +
      'attach to the third-party components listed above.'
  )
  push()

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(argv) {
  const outIndex = argv.indexOf('--out')
  const outFile = resolve(
    REPO_ROOT,
    outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : 'NOTICE.md'
  )
  const checkOnly = argv.includes('--check')

  const rootManifest = readJson(join(REPO_ROOT, 'package.json'))
  if (rootManifest === null) {
    process.stderr.write('generate-notice: cannot read package.json\n')
    return 1
  }

  const collected = collectPackages(rootManifest)
  const content = render(rootManifest, collected)

  if (checkOnly) {
    const existing = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
    if (existing === content) {
      process.stdout.write(`generate-notice: ${outFile} is up to date\n`)
      return 0
    }
    process.stderr.write(
      `generate-notice: ${outFile} is STALE — run \`node scripts/generate-notice.mjs\`\n`
    )
    return 1
  }

  writeFileSync(outFile, content, 'utf8')
  process.stdout.write(
    `generate-notice: wrote ${outFile} — ${collected.packages.length} components, ` +
      `${Buffer.byteLength(content, 'utf8')} bytes\n`
  )
  if (collected.missing.length > 0) {
    process.stdout.write(
      `generate-notice: ${collected.missing.length} declared dependencies not found on disk: ` +
        `${collected.missing.join(', ')}\n`
    )
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
