/**
 * Renderer entry point.
 *
 * Import order matters:
 *  1. the stylesheet, so the booth palette is applied before the first paint (the BrowserWindow
 *     already paints `#0a0a0f`, so there is no white flash either way — but a flash of unstyled
 *     content in a dark room is just as unwelcome);
 *  2. i18n, whose module side-effect initialises the singleton synchronously against bundled
 *     resources, so `App` never renders raw translation keys on its first frame;
 *  3. the app.
 *
 * Nothing here throws. If `#root` is missing the document is not the one we shipped, and the
 * failure is reported rather than left as a silently blank window.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/index.css'
import './i18n'
import { App } from './App'

const container = document.getElementById('root')

if (container === null) {
  // eslint-disable-next-line no-console -- there is no UI to render the message into.
  console.error('Verger: #root is missing from index.html; the renderer cannot mount.')
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
