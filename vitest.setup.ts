/**
 * Renderer-project test setup (jsdom only).
 *
 * Loaded exclusively by the `renderer` project in `vitest.config.ts`; the `node`
 * project never sees this file, so nothing here may run in a DOM-less environment.
 * Everything jsdom-dependent is still guarded so that accidentally wiring this file
 * into a node project degrades to a no-op instead of throwing.
 *
 * NOTE: this file is intentionally excluded from `tsconfig.json` / the typecheck
 * projects. `jest-axe@10` ships no type declarations and `@types/jest-axe` is not
 * installed, so a static import of it cannot satisfy `noImplicitAny`. Vitest
 * transpiles this file with esbuild (no type checking), so runtime is unaffected.
 * If someone installs `@types/jest-axe`, drop the exclude in `tsconfig.json`.
 */
import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { toHaveNoViolations } from 'jest-axe'
import { afterEach, expect } from 'vitest'

// `expect(...).toHaveNoViolations()` for the a11y tests every UI phase must add.
expect.extend(toHaveNoViolations)

afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
})
