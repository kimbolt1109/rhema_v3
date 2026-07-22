/**
 * Integration tests for the overlay server.
 *
 * These drive the REAL Express + `ws` stack over real loopback sockets, on an ephemeral port.
 * That is deliberate and it is not a violation of "no network in unit tests": there is no OBS,
 * no internet and no Electron here — just 127.0.0.1 talking to itself. The behaviour under test
 * (a browser source crashing and re-syncing) simply does not exist at the level of a mock.
 *
 * Port 0 everywhere, so these files can run in parallel with each other and with a developer's
 * running app on 7320.
 *
 * Standing Rule 4: no verse text is authored here. Scripture `text` is a placeholder.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { WebSocket } from 'ws'

import { createNullLogger } from '@main/logging/logger'
import type { OverlayServerInfo } from '@shared/ipc'
import { LOOPBACK_ADDRESS, OVERLAY_SOCKET_PATH, WILDCARD_ADDRESS, overlayAssetUrl } from '@shared/net'
import { emptyOverlayState } from '@shared/overlay'
import type { OverlayCommand, OverlayServerMessage, OverlayState } from '@shared/overlay'
import { ErrorCode } from '@shared/result'

import { MAX_INBOUND_FRAME_BYTES, OverlayServer, resolveOverlayStaticDir } from './OverlayServer'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Heartbeat far beyond any test's lifetime, so pings never interleave with assertions. */
const QUIET_HEARTBEAT_MS = 60_000

/**
 * The REAL overlay page directory in this repo.
 *
 * Most tests do not care what is on disk, but the "does the advertised URL actually serve the
 * page" regression does — pointing it at a fixture would have re-created the very bug it
 * guards, since the bug was a mismatch between the real filename (`overlay.html`) and the
 * configured index.
 */
const OVERLAY_SOURCE_DIR = fileURLToPath(new URL('../../overlay', import.meta.url))

const servers: OverlayServer[] = []
const openSockets: WebSocket[] = []

function makeServer(overrides: Partial<ConstructorParameters<typeof OverlayServer>[0]> = {}): OverlayServer {
  const server = new OverlayServer({
    logger: createNullLogger(),
    host: LOOPBACK_ADDRESS,
    port: 0,
    heartbeatMs: QUIET_HEARTBEAT_MS,
    ...overrides
  })
  servers.push(server)
  return server
}

/**
 * A connected test client that queues every inbound message.
 *
 * The queue matters: the server sends the state snapshot the instant the socket opens, so a
 * naive `once('message')` attached after `open` would race it and lose the very message these
 * tests exist to check.
 */
class TestClient {
  readonly socket: WebSocket
  private readonly queue: OverlayServerMessage[] = []
  private readonly waiters: ((message: OverlayServerMessage) => void)[] = []
  closed = false
  closeCode: number | null = null

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const parsed: unknown = JSON.parse(String(data))
      this.push(parsed as OverlayServerMessage)
    })
    socket.on('close', (code) => {
      this.closed = true
      this.closeCode = code
    })
    socket.on('error', () => {
      /* a terminated socket surfaces here on some platforms; `close` is the signal we use */
    })
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      openSockets.push(socket)
      const client = new TestClient(socket)
      socket.once('open', () => {
        resolve(client)
      })
      socket.once('error', (cause: Error) => {
        reject(cause)
      })
    })
  }

  private push(message: OverlayServerMessage): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(message)
    else this.queue.push(message)
  }

  next(timeoutMs = 2_000): Promise<OverlayServerMessage> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for an overlay server message'))
      }, timeoutMs)
      this.waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  /** The next `state` message, skipping any heartbeat pings. */
  async nextState(timeoutMs = 2_000): Promise<OverlayState> {
    for (;;) {
      const message = await this.next(timeoutMs)
      if (message.channel === 'state') return message.payload
    }
  }

  /** The next `error` message, skipping any heartbeat pings. */
  async nextError(timeoutMs = 2_000): Promise<{ code: string; message: string }> {
    for (;;) {
      const message = await this.next(timeoutMs)
      if (message.channel === 'error') return message.payload
    }
  }

  /** How many messages are sitting unread. Used to assert that nothing was broadcast. */
  pending(): number {
    return this.queue.length
  }

  send(raw: string): void {
    this.socket.send(raw)
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.socket.once('close', () => {
        resolve()
      })
      this.socket.close()
    })
  }

  waitForClose(timeoutMs = 3_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the socket to close'))
      }, timeoutMs)
      this.socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function socketUrlFor(info: OverlayServerInfo): string {
  return `ws://${info.host}:${info.port}${OVERLAY_SOCKET_PATH}`
}

async function startedServer(
  overrides: Partial<ConstructorParameters<typeof OverlayServer>[0]> = {}
): Promise<{ server: OverlayServer; url: string }> {
  const server = makeServer(overrides)
  const started = await server.start()
  expect(started.ok).toBe(true)
  if (!started.ok) throw new Error(started.error.message)
  return { server, url: socketUrlFor(started.value) }
}

const SHOW_LOWER_THIRD: OverlayCommand = {
  channel: 'command',
  name: 'lowerThird.show',
  payload: { line1: 'PRESENTER NAME', line2: 'ROLE', template: 'bar' }
}

const SHOW_SCRIPTURE: OverlayCommand = {
  channel: 'command',
  name: 'scripture.show',
  payload: {
    reference: 'REFERENCE PLACEHOLDER',
    text: 'VERSE TEXT PLACEHOLDER',
    translation: 'TRANSLATION PLACEHOLDER',
    attribution: null
  }
}

const SHOW_SLIDE: OverlayCommand = {
  channel: 'command',
  name: 'slide.show',
  payload: { src: 'slides/point1.png' }
}

/** Yield to the event loop a few times, so an in-flight broadcast would have landed. */
async function settle(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.removeAllListeners()
      socket.terminate()
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) {
    await server.stop()
  }
})

// ---------------------------------------------------------------------------
// Snapshot on connect — the watchdog-resilience requirement
// ---------------------------------------------------------------------------

describe('OverlayServer — snapshot on connect', () => {
  it('sends the full state to a newly connected client before any command', async () => {
    const { url } = await startedServer()
    const client = await TestClient.connect(url)

    const first = await client.next()
    expect(first.channel).toBe('state')
    if (first.channel !== 'state') throw new Error('expected a state message')
    expect(first.payload).toEqual(emptyOverlayState())
  })

  it('sends the CURRENT state, not the blank one, when commands preceded the connection', async () => {
    const { server, url } = await startedServer()
    expect(server.send(SHOW_LOWER_THIRD).ok).toBe(true)
    expect(server.send(SHOW_SLIDE).ok).toBe(true)

    const client = await TestClient.connect(url)
    const snapshot = await client.nextState()

    expect(snapshot.revision).toBe(2)
    expect(snapshot.lowerThird.visible).toBe(true)
    expect(snapshot.lowerThird.line1).toBe('PRESENTER NAME')
    expect(snapshot.slide).toEqual({ visible: true, src: 'slides/point1.png' })
  })
})

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

describe('OverlayServer — broadcast', () => {
  it('pushes the new full state to every connected client', async () => {
    const { server, url } = await startedServer()
    const a = await TestClient.connect(url)
    const b = await TestClient.connect(url)
    const c = await TestClient.connect(url)

    // Drain the three connect snapshots.
    for (const client of [a, b, c]) {
      expect((await client.nextState()).revision).toBe(0)
    }

    const result = server.send(SHOW_SCRIPTURE)
    expect(result.ok).toBe(true)

    for (const client of [a, b, c]) {
      const state = await client.nextState()
      expect(state.revision).toBe(1)
      expect(state.scripture.visible).toBe(true)
      expect(state.scripture.reference).toBe('REFERENCE PLACEHOLDER')
      expect(state.scripture.text).toBe('VERSE TEXT PLACEHOLDER')
    }
  })

  it('notifies onState subscribers with the same snapshot it broadcasts', async () => {
    const { server, url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    const seen: OverlayState[] = []
    const unsubscribe = server.onState((state) => {
      seen.push(state)
    })

    server.send(SHOW_LOWER_THIRD)
    const broadcast = await client.nextState()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(broadcast)
    expect(seen[0]).toBe(server.getState())

    unsubscribe()
    server.send(SHOW_SLIDE)
    await client.nextState()
    expect(seen).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Resync — the reason the protocol is state-based
// ---------------------------------------------------------------------------

describe('OverlayServer — resync after a client dies', () => {
  it("gives a late client the CURRENT state, never a replay of what it missed", async () => {
    const { server, url } = await startedServer()

    // Client A attaches and watches a couple of commands.
    const a = await TestClient.connect(url)
    expect((await a.nextState()).revision).toBe(0)

    server.send(SHOW_LOWER_THIRD)
    expect((await a.nextState()).revision).toBe(1)

    server.send(SHOW_SCRIPTURE)
    expect((await a.nextState()).revision).toBe(2)

    // A dies mid-service, exactly as an OBS browser source does.
    await a.close()
    await settle()
    expect(server.getInfo().clients).toBe(0)

    // The show goes on without any overlay attached.
    server.send({ channel: 'command', name: 'lowerThird.hide', payload: {} })
    server.send(SHOW_SLIDE)
    expect(server.getState().revision).toBe(4)

    // B attaches — this is A reloading. Its FIRST message must be the current state.
    const b = await TestClient.connect(url)
    const first = await b.next()

    expect(first.channel).toBe('state')
    if (first.channel !== 'state') throw new Error('expected a state message')
    expect(first.payload.revision).toBe(4)
    expect(first.payload.lowerThird.visible).toBe(false)
    // Text is retained behind a hide, so a re-show is instant.
    expect(first.payload.lowerThird.line1).toBe('PRESENTER NAME')
    expect(first.payload.scripture.visible).toBe(true)
    expect(first.payload.slide).toEqual({ visible: true, src: 'slides/point1.png' })

    // And nothing else is queued: it received one snapshot, not four events.
    await settle()
    expect(b.pending()).toBe(0)
  })

  it('survives a show -> hide -> show sequence with a reconnect in the middle', async () => {
    const { server, url } = await startedServer()

    server.send(SHOW_LOWER_THIRD)
    const a = await TestClient.connect(url)
    expect((await a.nextState()).lowerThird.visible).toBe(true)

    server.send({ channel: 'command', name: 'lowerThird.hide', payload: {} })
    expect((await a.nextState()).lowerThird.visible).toBe(false)

    await a.close()
    await settle()

    server.send(SHOW_LOWER_THIRD)

    const b = await TestClient.connect(url)
    const restored = await b.nextState()
    expect(restored.lowerThird.visible).toBe(true)
    expect(restored.revision).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

describe('OverlayServer — invalid command', () => {
  it('returns Err(INVALID_ARG), leaves state unchanged and broadcasts nothing', async () => {
    const { server, url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    const before = server.getState()
    const bad = server.send({
      channel: 'command',
      name: 'lowerThird.show',
      payload: { line1: 42 }
    } as unknown as OverlayCommand)

    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('expected the invalid command to be refused')
    expect(bad.error.code).toBe(ErrorCode.INVALID_ARG)

    expect(server.getState()).toBe(before)
    expect(server.getState().revision).toBe(0)

    await settle()
    expect(client.pending()).toBe(0)

    // A valid command afterwards still lands, and is revision 1 — proving the refused one
    // never reached the reducer.
    server.send(SHOW_SLIDE)
    const state = await client.nextState()
    expect(state.revision).toBe(1)
  })

  it('refuses an unknown command name', async () => {
    const { server } = await startedServer()
    const result = server.send({
      channel: 'command',
      name: 'lowerThird.explode',
      payload: {}
    } as unknown as OverlayCommand)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the unknown command to be refused')
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(server.getState().revision).toBe(0)
  })
})

describe('OverlayServer — malformed inbound frames', () => {
  it('replies with an error and keeps the connection alive', async () => {
    const { server, url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    client.send('this is not json {{{')
    const failure = await client.nextError()
    expect(failure.code).toBe(ErrorCode.INVALID_ARG)
    expect(failure.message).toContain('JSON')

    // Still attached.
    await settle()
    expect(client.closed).toBe(false)
    expect(server.getInfo().clients).toBe(1)

    // And still receiving state.
    server.send(SHOW_LOWER_THIRD)
    expect((await client.nextState()).revision).toBe(1)
  })

  it('replies with an error for a well-formed JSON message on an unknown channel', async () => {
    const { url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    client.send(JSON.stringify({ channel: 'command', payload: { name: 'clearAll' } }))
    const failure = await client.nextError()
    expect(failure.code).toBe(ErrorCode.INVALID_ARG)

    await settle()
    expect(client.closed).toBe(false)
  })

  it('replies with an error for a valid channel carrying an invalid payload', async () => {
    const { url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    client.send(JSON.stringify({ channel: 'applied', payload: { revision: -3 } }))
    const failure = await client.nextError()
    expect(failure.code).toBe(ErrorCode.INVALID_ARG)
    expect(failure.message).toContain('validation')

    await settle()
    expect(client.closed).toBe(false)
  })

  it('accepts the three legitimate inbound messages without complaint', async () => {
    const { server, url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    client.send(JSON.stringify({ channel: 'hello', payload: { page: 'overlay', userAgent: 'vitest' } }))
    client.send(JSON.stringify({ channel: 'applied', payload: { revision: 0 } }))
    client.send(JSON.stringify({ channel: 'pong', payload: { ts: 1 } }))

    await settle()
    expect(client.pending()).toBe(0)
    expect(client.closed).toBe(false)
    expect(server.getInfo().clients).toBe(1)
  })

  it('rejects an oversized frame without killing the connection', async () => {
    const { server, url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    client.send('x'.repeat(MAX_INBOUND_FRAME_BYTES + 1_000))
    const failure = await client.nextError()
    expect(failure.code).toBe(ErrorCode.INVALID_ARG)
    expect(failure.message).toContain('exceeds')

    await settle()
    expect(client.closed).toBe(false)
    expect(server.getInfo().clients).toBe(1)

    server.send(SHOW_SLIDE)
    expect((await client.nextState()).revision).toBe(1)
  })

  it('accepts a frame that is large but under the limit', async () => {
    const { url } = await startedServer()
    const client = await TestClient.connect(url)
    await client.nextState()

    // Under 64 KiB, but too long for the schema's 500-char userAgent cap: it must be a
    // validation error, which proves the size gate let it through to the parser.
    client.send(
      JSON.stringify({ channel: 'hello', payload: { page: 'overlay', userAgent: 'u'.repeat(4_000) } })
    )
    const failure = await client.nextError()
    expect(failure.message).toContain('validation')
    expect(client.closed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Client accounting
// ---------------------------------------------------------------------------

describe('OverlayServer — client count', () => {
  it('rises and falls, emitting an info update each time', async () => {
    const { server, url } = await startedServer()

    const updates: OverlayServerInfo[] = []
    const unsubscribe = server.onInfo((info) => {
      updates.push(info)
    })

    expect(server.getInfo().clients).toBe(0)

    const a = await TestClient.connect(url)
    await a.nextState()
    await settle()
    expect(server.getInfo().clients).toBe(1)

    const b = await TestClient.connect(url)
    await b.nextState()
    await settle()
    expect(server.getInfo().clients).toBe(2)
    expect(updates.map((info) => info.clients)).toContain(2)

    await a.close()
    await settle()
    expect(server.getInfo().clients).toBe(1)

    await b.close()
    await settle()
    expect(server.getInfo().clients).toBe(0)

    // The whole point: an operator can see "0 overlays attached" rather than discovering it
    // when the congregation does.
    const counts = updates.map((info) => info.clients)
    expect(counts).toContain(1)
    expect(counts).toContain(2)
    expect(counts[counts.length - 1]).toBe(0)
    expect(updates.every((info) => info.running)).toBe(true)

    unsubscribe()
  })

  it('reports a page URL that matches what it actually bound', async () => {
    const { server } = await startedServer()
    const info = server.getInfo()
    expect(info.running).toBe(true)
    expect(info.host).toBe(LOOPBACK_ADDRESS)
    expect(info.port).toBeGreaterThan(0)
    expect(info.pageUrl).toBe(`http://${LOOPBACK_ADDRESS}:${info.port}/overlay`)
    expect(info.lastError).toBeNull()
  })

  it('actually SERVES the page at the advertised pageUrl', async () => {
    // Regression. The assertion above only checked that `pageUrl` was the right STRING, and it
    // was — yet fetching it returned nothing. `express.static` was configured with
    // `index: ['index.html']` while the page file is `overlay.html`, so `/overlay` redirected
    // to `/overlay/` and then 404'd. The single URL an operator pastes into an OBS Browser
    // Source produced a blank overlay in a live service, with every unit test passing.
    //
    // Asserting a URL string is not the same as asserting the URL works. This fetches it.
    const server = makeServer({ staticDir: OVERLAY_SOURCE_DIR })
    await server.start()
    const { pageUrl } = server.getInfo()

    const response = await fetch(pageUrl)
    expect(response.status).toBe(200)

    const html = await response.text()
    expect(html.toLowerCase()).toContain('<!doctype html>')
    // The three independent layers the whole phase exists to provide.
    expect(html).toContain('lower-third')
    expect(html).toContain('scripture')
    expect(html).toContain('slide')
  })

  it('SERVES PLAN SLIDE IMAGES over HTTP from /assets', async () => {
    // Regression. Slide assets were handed to the overlay as `file://` URLs. Chromium — and an
    // OBS Browser Source is Chromium — refuses `file:` subresources inside an `http:` document,
    // and the overlay page's CSP is `img-src 'self' data:`, which rejects them too. The result
    // was that every imported slide silently failed to appear on the congregation screen while
    // every unit test passed.
    //
    // Serving the plan's asset folder from the SAME origin fixes both constraints at once.
    const assetDir = await mkdtemp(join(tmpdir(), 'verger-assets-'))
    // A one-pixel PNG; the bytes only need to survive the round trip.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
    await writeFile(join(assetDir, 'slide-001.png'), png)

    const server = makeServer({ staticDir: OVERLAY_SOURCE_DIR })
    await server.start()
    server.setAssetRoot(assetDir)

    const { port } = server.getInfo()
    const response = await fetch(overlayAssetUrl('slide-001.png', LOOPBACK_ADDRESS, port))

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true)

    await rm(assetDir, { recursive: true, force: true })
  })

  it('404s the asset route when no plan is open, rather than serving a stale folder', async () => {
    const server = makeServer({ staticDir: OVERLAY_SOURCE_DIR })
    await server.start()
    const { port } = server.getInfo()

    const response = await fetch(overlayAssetUrl('slide-001.png', LOOPBACK_ADDRESS, port))

    expect(response.status).toBe(404)
  })

  it('refuses to serve an asset outside the plan folder', async () => {
    // The asset folder holds files extracted from an untrusted .pptx. A traversal out of it
    // would turn the overlay server into an arbitrary-file-read endpoint on loopback.
    const assetDir = await mkdtemp(join(tmpdir(), 'verger-assets-'))
    const secretDir = await mkdtemp(join(tmpdir(), 'verger-secret-'))
    await writeFile(join(secretDir, 'secret.txt'), 'NOT FOR THE CONGREGATION')

    const server = makeServer({ staticDir: OVERLAY_SOURCE_DIR })
    await server.start()
    server.setAssetRoot(assetDir)
    const { port } = server.getInfo()

    for (const attempt of ['../', '..%2f', '%2e%2e%2f']) {
      const response = await fetch(
        `http://${LOOPBACK_ADDRESS}:${port}/assets/${attempt}${'secret.txt'}`
      )
      expect(response.status, `traversal "${attempt}" must not be served`).not.toBe(200)
    }

    await rm(assetDir, { recursive: true, force: true })
    await rm(secretDir, { recursive: true, force: true })
  })

  it('serves the overlay page assets alongside it', async () => {
    const server = makeServer({ staticDir: OVERLAY_SOURCE_DIR })
    await server.start()
    const { pageUrl } = server.getInfo()

    for (const asset of ['overlay.css', 'overlay.js', 'protocol.js']) {
      const response = await fetch(`${pageUrl}/${asset}`)
      expect(response.status, `${asset} should be served`).toBe(200)
    }
  })
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('OverlayServer — heartbeat', () => {
  it('pings attached clients', async () => {
    const { url } = await startedServer({ heartbeatMs: 20, now: () => 1_234 })
    const client = await TestClient.connect(url)
    await client.nextState()

    const message = await client.next(2_000)
    expect(message.channel).toBe('ping')
    if (message.channel !== 'ping') throw new Error('expected a ping')
    expect(message.payload.ts).toBe(1_234)
  })

  it('terminates a client that misses two consecutive pongs', async () => {
    const { server, url } = await startedServer({ heartbeatMs: 20 })
    const client = await TestClient.connect(url)
    await client.nextState()

    await client.waitForClose(3_000)
    await settle()
    expect(server.getInfo().clients).toBe(0)
  })

  it('keeps a client that answers with pong', async () => {
    const { server, url } = await startedServer({ heartbeatMs: 25 })
    const client = await TestClient.connect(url)
    await client.nextState()

    client.socket.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as OverlayServerMessage
      if (parsed.channel === 'ping') {
        client.send(JSON.stringify({ channel: 'pong', payload: { ts: parsed.payload.ts } }))
      }
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 300)
    })
    expect(client.closed).toBe(false)
    expect(server.getInfo().clients).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Bind posture — Standing Rule 7
// ---------------------------------------------------------------------------

describe('OverlayServer — bind address', () => {
  it('refuses to start on the wildcard address', async () => {
    const server = makeServer({ host: WILDCARD_ADDRESS })
    const result = await server.start()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the wildcard bind to be refused')
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
    expect(result.error.message).toContain(WILDCARD_ADDRESS)
    expect(server.getInfo().running).toBe(false)
    expect(server.getInfo().lastError).toContain(WILDCARD_ADDRESS)
  })

  it('refuses to start on a hostname', async () => {
    const server = makeServer({ host: 'localhost' })
    const result = await server.start()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the hostname bind to be refused')
    expect(result.error.code).toBe(ErrorCode.INVALID_ARG)
  })

  it('allows a concrete LAN IPv4 as an explicit opt-in', async () => {
    // Not bound here — binding an address this machine does not own would fail for reasons
    // unrelated to policy. What matters is that the POLICY gate lets it through.
    const server = makeServer({ host: '192.168.1.40', port: 0 })
    const result = await server.start()
    if (result.ok) {
      expect(result.value.host).toBe('192.168.1.40')
    } else {
      // EADDRNOTAVAIL on a machine without that interface — a bind failure, not a refusal.
      expect(result.error.code).toBe(ErrorCode.IO_ERROR)
    }
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('OverlayServer — lifecycle', () => {
  it('closes every socket and the listener on stop', async () => {
    const { server, url } = await startedServer()
    const a = await TestClient.connect(url)
    const b = await TestClient.connect(url)
    await a.nextState()
    await b.nextState()

    const stopped = await server.stop()
    expect(stopped.ok).toBe(true)

    await a.waitForClose()
    await b.waitForClose()

    const info = server.getInfo()
    expect(info.running).toBe(false)
    expect(info.clients).toBe(0)

    // The listener is gone: a fresh dial must fail rather than hang.
    await expect(TestClient.connect(url)).rejects.toThrow()
  })

  it('is safe to stop twice, and to stop a server that never started', async () => {
    const { server } = await startedServer()
    expect((await server.stop()).ok).toBe(true)
    expect((await server.stop()).ok).toBe(true)

    const neverStarted = makeServer()
    expect((await neverStarted.stop()).ok).toBe(true)
    expect(neverStarted.getInfo().running).toBe(false)
  })

  it('is idempotent on start and does not bind twice', async () => {
    const server = makeServer()
    const first = await server.start()
    const second = await server.start()

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected both starts to succeed')
    expect(second.value.port).toBe(first.value.port)
  })

  it('fails with a clear message rather than throwing when the port is taken', async () => {
    const first = makeServer()
    const started = await first.start()
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error(started.error.message)

    const second = makeServer({ port: started.value.port })
    const result = await second.start()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the duplicate bind to fail')
    expect(result.error.code).toBe(ErrorCode.IO_ERROR)
    expect(result.error.message).toContain(String(started.value.port))
    expect(second.getInfo().running).toBe(false)
    expect(second.getInfo().lastError).not.toBeNull()
  })

  it('starts even when the overlay static directory is missing', async () => {
    const server = makeServer({ staticDir: 'C:/definitely/not/a/real/overlay/directory' })
    const result = await server.start()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)

    // And the bus still works, which is the point: a missing asset must not cost the operator
    // OBS control.
    const client = await TestClient.connect(socketUrlFor(result.value))
    expect((await client.nextState()).revision).toBe(0)
  })

  it('rejects a websocket upgrade on any path but the overlay socket path', async () => {
    const { server } = await startedServer()
    const info = server.getInfo()
    await expect(TestClient.connect(`ws://${info.host}:${info.port}/not-the-bus`)).rejects.toThrow()

    // The server is unharmed and still accepting on the real path.
    const good = await TestClient.connect(socketUrlFor(info))
    expect((await good.nextState()).revision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Static directory resolution
// ---------------------------------------------------------------------------

describe('resolveOverlayStaticDir', () => {
  it('prefers the repo source directory in development', () => {
    const resolved = resolveOverlayStaticDir({
      isPackaged: false,
      resourcesPath: '/resources',
      moduleDir: '/repo/out/main',
      exists: (path) => path.replace(/\\/g, '/').endsWith('/repo/src/overlay')
    })
    expect(resolved.replace(/\\/g, '/')).toBe('/repo/src/overlay')
  })

  it('prefers the packaged resources directory when packaged', () => {
    const resolved = resolveOverlayStaticDir({
      isPackaged: true,
      resourcesPath: '/app/resources',
      moduleDir: '/app/resources/app.asar/out/main',
      exists: (path) => path.replace(/\\/g, '/') === '/app/resources/overlay'
    })
    expect(resolved.replace(/\\/g, '/')).toBe('/app/resources/overlay')
  })

  it('falls back to the first candidate rather than throwing when nothing exists', () => {
    const resolved = resolveOverlayStaticDir({
      isPackaged: false,
      resourcesPath: '/resources',
      moduleDir: '/repo/out/main',
      exists: () => false
    })
    expect(resolved.replace(/\\/g, '/')).toBe('/repo/src/overlay')
  })
})
