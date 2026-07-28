/**
 * Diagnostic, not a test. Presses OBS's "Refresh cache of current page" on the Overlays browser
 * source, to establish whether a browser source that loaded before Verger's overlay server was
 * listening is permanently dead until refreshed.
 *
 * Usage: npx tsx --tsconfig ./tsconfig.node.json scripts/diag-refresh-overlay.mts <obs-folder>
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import OBSWebSocket from 'obs-websocket-js'

const obsDir = resolve(process.argv[2] ?? '')
const cfgPath = join(obsDir, 'config', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
  server_password: string
  server_port: number
}

const obs = new OBSWebSocket()
await obs.connect(`ws://127.0.0.1:${String(cfg.server_port)}`, cfg.server_password)
console.log('connected to OBS')

const list = await obs.call('GetInputList')
console.log('GetInputList:', JSON.stringify(list, null, 2))

const settings = await obs.call('GetInputSettings', { inputName: 'Overlays' })
console.log('Overlays settings:', JSON.stringify(settings, null, 2))

await obs.call('PressInputPropertiesButton', {
  inputName: 'Overlays',
  propertyName: 'refreshnocache',
})
console.log('pressed refreshnocache on the Overlays source')

await delay(4000)
await obs.disconnect()
console.log('done')
