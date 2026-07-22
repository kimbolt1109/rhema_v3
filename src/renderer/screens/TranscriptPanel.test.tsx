/**
 * The transcript panel's contract.
 *
 * Four properties, in the order they matter mid-service:
 *
 *  1. `failed` and `not-configured` both say, in plain words, that Verger is running manual and
 *     that nothing is blocked. A dead recogniser must never read as a dead console.
 *  2. `degraded` names *which* provider is carrying the transcript and *why* the preferred one
 *     stopped — asserted separately from `failed`, because collapsing the two would hide a
 *     fallback the operator needs to know about.
 *  3. Drafts and partials are visibly distinct from finals, and by a **word**, not only a colour.
 *  4. Auto-scroll stops the moment the operator scrolls up, and does not resume on its own.
 *
 * All transcript text is invented placeholder wording (Standing Rule 4).
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ASR_CHUNK_BYTES } from '../audio/micCapture'
import type { MicCapture, MicCaptureSession, StartCaptureOptions } from '../audio/micCapture'
import { IpcEvent } from '@shared/ipc'
import type { Result } from '@shared/result'
import { ErrorCode, err, ok } from '@shared/result'

import '../i18n'
import { resetAsrStore, useAsrStore } from '../store/asrStore'
import type { InstalledMockVergerApi } from '../test/mockVergerApi'
import {
  installMockVergerApi,
  mockDegradedAsrStatus,
  mockDraftSegment,
  mockFailedAsrStatus,
  mockIdleAsrStatus,
  mockListeningAsrStatus,
  mockTranscriptSegment,
} from '../test/mockVergerApi'
import { TranscriptPanel, isPinnedToBottom, isSettling } from './TranscriptPanel'

function Landmark({ children }: { children: ReactNode }): React.JSX.Element {
  return <main>{children}</main>
}

/** A microphone that never touches a real device but exercises the whole push loop. */
function fakeCapture(): {
  capture: MicCapture
  starts: (string | null)[]
  stops: number[]
  /** Feed one chunk the way the audio graph would. */
  deliver: () => void
} {
  const starts: (string | null)[] = []
  const stops: number[] = []
  let onChunk: ((chunk: ArrayBuffer) => void) | null = null
  let session: MicCaptureSession | null = null

  const capture: MicCapture = {
    start: (options: StartCaptureOptions) => {
      starts.push(options.deviceId ?? null)
      onChunk = options.onChunk
      session = {
        deviceId: options.deviceId ?? null,
        deviceLabel: 'Pulpit mic',
        contextSampleRate: 16_000,
        transport: 'worklet',
      }
      return Promise.resolve(ok(session))
    },
    stop: () => {
      stops.push(stops.length)
      onChunk = null
      session = null
      return Promise.resolve()
    },
    isRunning: () => session !== null,
    session: () => session,
  }

  return {
    capture,
    starts,
    stops,
    deliver: () => {
      onChunk?.(new Int16Array(ASR_CHUNK_BYTES / 2).buffer)
    },
  }
}

/** Give a jsdom node the scroll geometry it otherwise reports as all zeroes. */
function setScrollGeometry(
  node: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(node, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
  Object.defineProperty(node, 'clientHeight', { value: metrics.clientHeight, configurable: true })
  Object.defineProperty(node, 'scrollTop', {
    value: metrics.scrollTop,
    writable: true,
    configurable: true,
  })
}

function scrollContainer(): HTMLElement {
  return screen.getByTestId('asr-transcript-scroll')
}

describe('isPinnedToBottom', () => {
  it('treats a few pixels of slack as still following', () => {
    expect(isPinnedToBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
    expect(isPinnedToBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
  })

  it('treats a real scroll up as not following', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 })).toBe(false)
    expect(isPinnedToBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 200 })).toBe(false)
  })
})

describe('isSettling', () => {
  it('counts both a fast-tier draft and an ordinary partial', () => {
    expect(isSettling(mockDraftSegment({}))).toBe(true)
    expect(isSettling(mockTranscriptSegment({ isFinal: false, isDraft: false }))).toBe(true)
    expect(isSettling(mockTranscriptSegment({}))).toBe(false)
  })
})

describe('TranscriptPanel', () => {
  let installed: InstalledMockVergerApi

  beforeEach(() => {
    installed = installMockVergerApi()
    resetAsrStore()
  })

  afterEach(() => {
    installed.restore()
  })

  it('says plainly that the system is running manual when nothing is configured', async () => {
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })

    await screen.findByRole('region', { name: /speech recognition is not set up/i })
    expect(screen.getByText(/running manual and nothing is blocked/i)).toBeInTheDocument()
    // And the control that would open a microphone into nowhere is disabled.
    expect(screen.getByRole('button', { name: /start listening/i })).toBeDisabled()
  })

  it('says the same thing, differently, when recognition has failed outright', async () => {
    installed.mock.responses.asrGetStatus = ok(mockFailedAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })

    await screen.findByRole('region', { name: /speech recognition failed/i })
    expect(screen.getByText(/no transcript is arriving/i)).toBeInTheDocument()
    expect(
      screen.getByText(/every cue, camera and overlay still works/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/speech recognition is not set up/i)).not.toBeInTheDocument()
  })

  it('names WHICH provider is running, and why, when degraded', async () => {
    installed.mock.responses.asrGetStatus = ok(mockDegradedAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })

    await screen.findByRole('region', { name: /running on whisper \(local\)/i })
    expect(screen.getByText(/deepgram closed the socket/i)).toBeInTheDocument()
    // Degraded is emphatically not "failed": no "running manual" copy anywhere.
    expect(screen.queryByText(/running manual and nothing is blocked/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('asr-provider')).toHaveTextContent(/whisper \(local\)/i)
  })

  it('shows provider, latency and health prominently', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })

    const status = await screen.findByRole('status', { name: /speech recognition status/i })
    expect(status).toHaveAttribute('data-asr-state', 'listening')
    expect(within(status).getByTestId('asr-provider')).toHaveTextContent(/deepgram \(cloud\)/i)
    expect(within(status).getByTestId('asr-latency')).toHaveTextContent('320 ms')
    expect(within(status).getByText(/^listening$/i)).toBeInTheDocument()
  })

  it('says the latency is not measured yet rather than printing a zero', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus({ latencyMs: null }))
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })

    await waitFor(() => {
      expect(screen.getByTestId('asr-latency')).toHaveTextContent(/not measured yet/i)
    })
  })

  it('renders drafts distinctly from finals, by a word and not only a colour', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })
    await screen.findByRole('status', { name: /speech recognition status/i })

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockTranscriptSegment({ id: 'a', text: 'PLACEHOLDER SETTLED LINE' }),
    )
    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockDraftSegment({ id: 'b', text: 'PLACEHOLDER DRAFT LINE' }),
    )

    const settled = await screen.findByText('PLACEHOLDER SETTLED LINE')
    const draft = await screen.findByText('PLACEHOLDER DRAFT LINE')

    expect(settled.closest('li')).toHaveAttribute('data-settling', 'false')
    expect(draft.closest('li')).toHaveAttribute('data-settling', 'true')
    expect(draft.closest('li')).toHaveAttribute('data-draft', 'true')
    // The word, not the colour, is what carries the meaning.
    expect(within(draft.closest('li') as HTMLElement).getByText(/^draft$/i)).toBeInTheDocument()
    expect(
      within(settled.closest('li') as HTMLElement).queryByText(/^draft$/i),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/still being revised and will be replaced/i)).toBeInTheDocument()
  })

  it('replaces a draft in place when the final arrives — it never appends', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })
    await screen.findByRole('status', { name: /speech recognition status/i })

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockDraftSegment({ id: 'span-1', text: 'PLACEHOLDER DRAFT' }),
    )
    await screen.findByText('PLACEHOLDER DRAFT')

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockTranscriptSegment({ id: 'span-1', text: 'PLACEHOLDER FINAL' }),
    )

    await screen.findByText('PLACEHOLDER FINAL')
    expect(screen.queryByText('PLACEHOLDER DRAFT')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('pauses auto-scroll when the operator scrolls up, and offers to resume', async () => {
    const user = userEvent.setup()
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })
    await screen.findByRole('status', { name: /speech recognition status/i })

    for (let index = 0; index < 5; index += 1) {
      installed.mock.emit(
        IpcEvent.asrTranscript,
        mockTranscriptSegment({ id: `seg-${String(index)}`, text: `PLACEHOLDER ${String(index)}` }),
      )
    }
    await screen.findByText('PLACEHOLDER 4')

    const node = scrollContainer()
    setScrollGeometry(node, { scrollTop: 0, scrollHeight: 2000, clientHeight: 200 })
    node.dispatchEvent(new Event('scroll', { bubbles: true }))

    await screen.findByText(/auto-scroll paused/i)
    const resume = screen.getByRole('button', { name: /jump to the newest line/i })

    // A new line must NOT drag the view back down while the operator is reading history.
    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockTranscriptSegment({ id: 'seg-late', text: 'PLACEHOLDER LATE' }),
    )
    await screen.findByText('PLACEHOLDER LATE')
    expect(node.scrollTop).toBe(0)

    await user.click(resume)
    await screen.findByText(/following the newest line/i)
    expect(node.scrollTop).toBe(2000)
  })

  it('keeps following while the operator is already at the bottom', async () => {
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })
    await screen.findByRole('status', { name: /speech recognition status/i })

    const node = scrollContainer()
    setScrollGeometry(node, { scrollTop: 1800, scrollHeight: 2000, clientHeight: 200 })
    node.dispatchEvent(new Event('scroll', { bubbles: true }))

    expect(screen.getByTestId('asr-follow-state')).toHaveTextContent(/following the newest line/i)
    expect(
      screen.queryByRole('button', { name: /jump to the newest line/i }),
    ).not.toBeInTheDocument()
  })

  it('opens the microphone on start and pushes 100 ms chunks to the main process', async () => {
    const user = userEvent.setup()
    const mic = fakeCapture()
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())
    installed.mock.responses.asrGetSettings = ok({
      mode: 'auto',
      language: 'ko',
      deviceId: 'mock-pulpit-mic',
      customVocabulary: [],
      localModel: 'small',
    })

    render(<TranscriptPanel createCapture={() => ok(mic.capture)} />, { wrapper: Landmark })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start listening/i })).toBeEnabled()
    })

    await user.click(screen.getByRole('button', { name: /start listening/i }))

    await waitFor(() => {
      expect(installed.mock.calls.asrStart).toHaveLength(1)
    })
    expect(mic.starts).toEqual(['mock-pulpit-mic'])

    mic.deliver()
    mic.deliver()
    await waitFor(() => {
      expect(installed.mock.calls.asrPushAudio).toEqual([ASR_CHUNK_BYTES, ASR_CHUNK_BYTES])
    })
  })

  it('releases the microphone on stop, and stops the session too', async () => {
    const user = userEvent.setup()
    const mic = fakeCapture()
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())

    render(<TranscriptPanel createCapture={() => ok(mic.capture)} />, { wrapper: Landmark })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start listening/i })).toBeEnabled()
    })
    await user.click(screen.getByRole('button', { name: /start listening/i }))

    const stop = await screen.findByRole('button', { name: /stop listening/i })
    await user.click(stop)

    await waitFor(() => {
      expect(mic.stops).toHaveLength(1)
    })
    expect(installed.mock.calls.asrStop).toHaveLength(1)
    expect(useAsrStore.getState().capturing).toBe(false)
  })

  it('releases the microphone when the panel unmounts', async () => {
    const user = userEvent.setup()
    const mic = fakeCapture()
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())

    const view = render(<TranscriptPanel createCapture={() => ok(mic.capture)} />, {
      wrapper: Landmark,
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start listening/i })).toBeEnabled()
    })
    await user.click(screen.getByRole('button', { name: /start listening/i }))
    await screen.findByRole('button', { name: /stop listening/i })

    view.unmount()

    await waitFor(() => {
      expect(mic.stops).toHaveLength(1)
    })
  })

  it('explains a microphone that will not open, and does not leave the session running', async () => {
    const user = userEvent.setup()
    installed.mock.responses.asrGetStatus = ok(mockIdleAsrStatus())
    const refuse = (): Result<MicCapture> =>
      err(ErrorCode.NOT_CONFIGURED, 'Permission denied by the operating system')

    render(<TranscriptPanel createCapture={refuse} />, { wrapper: Landmark })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start listening/i })).toBeEnabled()
    })
    await user.click(screen.getByRole('button', { name: /start listening/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/microphone could not be opened/i)
    expect(alert).toHaveTextContent(/permission denied/i)
  })

  it('offers to clear the transcript only once there is one', async () => {
    const user = userEvent.setup()
    installed.mock.responses.asrGetStatus = ok(mockListeningAsrStatus())
    render(<TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />, {
      wrapper: Landmark,
    })
    await screen.findByRole('status', { name: /speech recognition status/i })

    expect(screen.getByRole('button', { name: /clear transcript/i })).toBeDisabled()

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockTranscriptSegment({ id: 'a', text: 'PLACEHOLDER LINE' }),
    )
    await screen.findByText('PLACEHOLDER LINE')

    await user.click(screen.getByRole('button', { name: /clear transcript/i }))
    expect(screen.queryByText('PLACEHOLDER LINE')).not.toBeInTheDocument()
    await screen.findByText(/nothing transcribed yet/i)
  })

  it('has no axe violations while not configured', async () => {
    const { container } = render(
      <TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />,
      { wrapper: Landmark },
    )
    await screen.findByRole('region', { name: /speech recognition is not set up/i })

    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations with a mixed draft/final transcript on screen', async () => {
    installed.mock.responses.asrGetStatus = ok(mockDegradedAsrStatus())
    const { container } = render(
      <TranscriptPanel createCapture={() => ok(fakeCapture().capture)} />,
      { wrapper: Landmark },
    )
    await screen.findByRole('status', { name: /speech recognition status/i })

    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockTranscriptSegment({ id: 'a', text: 'PLACEHOLDER SETTLED LINE' }),
    )
    installed.mock.emit(
      IpcEvent.asrTranscript,
      mockDraftSegment({ id: 'b', text: 'PLACEHOLDER DRAFT LINE' }),
    )
    await screen.findByText('PLACEHOLDER DRAFT LINE')

    expect(await axe(container)).toHaveNoViolations()
  })
})
