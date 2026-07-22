/**
 * Network constants — the single source of truth for every port and bind address.
 *
 * `docs/v2-notes/NETWORK_AND_HARDWARE.md` records what happens without this file: rhema_v2's
 * documented port table drifted from its actual listeners, and a `control_port` (8420) sat in
 * its settings for months wired to nothing at all. Ports are declared here once, and both the
 * code and `docs/OBS_SETUP.md` read from this list.
 *
 * Node-global free — the renderer displays these values in the Overlay panel.
 */

/**
 * Loopback. The default bind for every server Verger runs.
 *
 * Standing Rule 7: loopback-first. OBS runs on the same machine as Verger and loads overlay
 * pages over `http://127.0.0.1`, so nothing needs to be reachable off-box for the product to
 * work. LAN exposure is a deliberate, explicit opt-in — and when it happens it must bind a
 * CONCRETE interface IP, never `0.0.0.0`. A wildcard bind on a church network is how a
 * production console ends up reachable from the guest wifi.
 */
export const LOOPBACK_ADDRESS = '127.0.0.1'

/** Never bind this. Named only so the guard that rejects it reads clearly. */
export const WILDCARD_ADDRESS = '0.0.0.0'

/**
 * The overlay server port.
 *
 * ONE port serves both the static overlay pages (HTTP) and the overlay WebSocket — they share
 * a single Node HTTP server, with the WebSocket attached via an upgrade handler. v2 ran these
 * as separate listeners on separate ports and gained nothing but a second number to keep in
 * sync across docs, firewall rules and settings.
 *
 * 7320 is inherited from v2's remote-control port, chosen over inventing a new number.
 */
export const OVERLAY_SERVER_PORT = 7320

/** The overlay page path, appended to the server origin. */
export const OVERLAY_PAGE_PATH = '/overlay'

/** The WebSocket upgrade path on the same server. */
export const OVERLAY_SOCKET_PATH = '/ws'

/** Build the `http://host:port` origin for the overlay server. */
export function overlayOrigin(
  host: string = LOOPBACK_ADDRESS,
  port: number = OVERLAY_SERVER_PORT,
): string {
  return `http://${host}:${port}`
}

/**
 * The exact URL to paste into an OBS Browser Source.
 *
 * `docs/OBS_SETUP.md` and the renderer's Overlay panel both render this, so the operator can
 * never be given a URL that disagrees with what the server is actually listening on.
 */
export function overlayPageUrl(
  host: string = LOOPBACK_ADDRESS,
  port: number = OVERLAY_SERVER_PORT,
): string {
  return `${overlayOrigin(host, port)}${OVERLAY_PAGE_PATH}`
}

/** The WebSocket URL the overlay page dials back on. */
export function overlaySocketUrl(
  host: string = LOOPBACK_ADDRESS,
  port: number = OVERLAY_SERVER_PORT,
): string {
  return `ws://${host}:${port}${OVERLAY_SOCKET_PATH}`
}

/**
 * Whether a bind address is allowed.
 *
 * Loopback is always fine. Anything else is LAN exposure and must be a concrete IPv4 address
 * that the operator typed deliberately — never a wildcard, never a hostname we would have to
 * resolve (and could resolve differently later).
 */
export function isAllowedBindAddress(address: string): boolean {
  if (address === LOOPBACK_ADDRESS) return true
  if (address === WILDCARD_ADDRESS) return false
  const octets = address.split('.')
  if (octets.length !== 4) return false
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}
