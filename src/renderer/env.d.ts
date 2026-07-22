/// <reference types="vite/client" />

/**
 * Renderer ambient types.
 *
 * Two jobs:
 *
 * 1. Pull in Vite's client types (`import.meta.env`, `*.css` / `*.json` module shims) — this is
 *    the only place that reference lives, because `tsconfig.web.json` sets
 *    `"types": ["vite/client"]` and nothing else.
 * 2. Teach `expect(...)` about the two matcher packs the renderer test project installs in
 *    `vitest.setup.ts`. That setup file is deliberately excluded from every tsconfig (see its
 *    header), so without these augmentations `toBeInTheDocument()` and `toHaveNoViolations()`
 *    exist at runtime but not at typecheck time.
 */

import '@testing-library/jest-dom/vitest'
import 'vitest'

declare module 'vitest' {
  // `T = any` is not a style choice: interface merging requires the type parameter list to match
  // vitest's own `Assertion<T = any>` exactly, or TypeScript rejects the augmentation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    /** From `jest-axe`, registered via `expect.extend(toHaveNoViolations)` in `vitest.setup.ts`. */
    toHaveNoViolations(): T
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): unknown
  }
}
