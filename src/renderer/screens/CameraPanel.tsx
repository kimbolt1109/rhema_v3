/**
 * The Camera panel — four big buttons, and the operator's answer to "which camera is live?".
 *
 * BLUEPRINT.md §6: each camera is an OBS scene, the app maps a button to `SetCurrentProgramScene`,
 * and **that is all a press does**. There is deliberately no control on this screen that touches an
 * overlay layer, and no control on the Overlay panel that touches a camera. `CameraPanel.test.tsx`
 * asserts the first half of that against the real command log, and the Overlay panel's own suite
 * asserts the second — a comment claiming independence is worth nothing next to a test that fails
 * when someone wires the two together.
 *
 * Design notes, all of them about a dark booth and a service that only happens once:
 *
 * - **72px targets (`min-h-touch-xl`).** `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §9.4 (FITTS-1)
 *   requires ≥48px for primary actions and ≥64px for the highest-stakes ones, and records v2's
 *   28×28px PTZ buttons as a shipped defect. These are the most-pressed controls in the app.
 * - **LIVE is a word, not a colour.** The live button carries the text "LIVE" and an icon as well
 *   as `aria-pressed`, per §9.5's colour-is-never-the-only-signal rule. A `role="status"` line
 *   above the grid says the same thing in a sentence, so a screen-reader user learns of a camera
 *   change made *inside OBS* rather than only of ones they made here.
 * - **`activeSlot === null` is a first-class state, not a bug.** The operator can switch scenes in
 *   OBS directly. When the live scene maps to no button, nothing lights and the panel says why.
 *   Leaving the last-pressed button lit would be a lie the operator acts on.
 * - **An unmapped button is disabled and says what to do about it.** It never fires a request for
 *   a scene that does not exist; `isBindingUsable` in `@shared/camera` is the single decision.
 * - **A disconnected OBS disables the whole panel with a reason.** Silently dead buttons cost more
 *   diagnostic time mid-service than any amount of copy.
 * - **The bound scene name is printed under every label**, so the mapping is verifiable at a glance
 *   without opening settings — the check an operator actually performs during a soundcheck.
 */

import clsx from 'clsx'
import { CircleAlert, Radio, Video, VideoOff } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionId, DEFAULT_KEY_BINDINGS } from '@shared/actions'
import type { CameraSlot } from '@shared/camera'
import { DEFAULT_CAMERA_LABELS } from '@shared/camera'

import { cameraButtons, useCameraStore } from '../store/cameraStore'
import { useObsStore } from '../store/obsStore'

/**
 * Which key fires which camera, read from the action contract rather than typed in here.
 *
 * `@shared/actions` is the one place bindings are declared, so a remap in Phase 10 changes the
 * hint on these buttons for free and the label can never drift from what the key actually does.
 */
const SHORTCUT_BY_SLOT: ReadonlyMap<string, string> = new Map(
  DEFAULT_KEY_BINDINGS.flatMap((binding) =>
    binding.action === ActionId.cameraSelect && binding.param !== undefined
      ? [[binding.param, binding.key] as const]
      : [],
  ),
)

/** Why the panel is inert, or `null` when it is usable. */
type PanelBlock = 'bridge' | 'obs' | null

export function CameraPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const config = useCameraStore((store) => store.config)
  const state = useCameraStore((store) => store.state)
  const bridgeAvailable = useCameraStore((store) => store.bridgeAvailable)
  const lastError = useCameraStore((store) => store.lastError)
  const hydrate = useCameraStore((store) => store.hydrate)
  const subscribe = useCameraStore((store) => store.subscribe)
  const select = useCameraStore((store) => store.select)

  const obsState = useObsStore((store) => store.status.state)
  const hydrateObs = useObsStore((store) => store.hydrate)
  const subscribeObs = useObsStore((store) => store.subscribe)

  useEffect(() => {
    // Subscribe BEFORE hydrating, so a state pushed while the initial read is in flight is not
    // dropped on the floor.
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  useEffect(() => {
    // The panel owns its own view of the OBS connection rather than trusting a sibling screen to
    // have hydrated it: sections unmount when the operator switches tabs.
    const unsubscribe = subscribeObs()
    void hydrateObs()
    return unsubscribe
  }, [hydrateObs, subscribeObs])

  const block: PanelBlock = !bridgeAvailable ? 'bridge' : obsState === 'connected' ? null : 'obs'

  const buttons = cameraButtons(config, state)
  const liveButton = buttons.find((button) => button.live) ?? null

  /** The operator-configured name if it has been renamed, otherwise the translated default. */
  const labelFor = (slot: CameraSlot, configured: string): string =>
    configured.length > 0 && configured !== DEFAULT_CAMERA_LABELS[slot]
      ? configured
      : t(`camera.slot.${slot}`)

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('camera.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('camera.subtitle')}</p>
      </header>

      {block === 'bridge' ? (
        <Callout title={t('camera.bridgeUnavailable.title')}>
          {t('camera.bridgeUnavailable.body')}
        </Callout>
      ) : null}

      {block === 'obs' ? (
        <Callout title={t('camera.disconnected.title')}>{t('camera.disconnected.body')}</Callout>
      ) : null}

      <section
        aria-label={t('camera.programScene')}
        className="rounded-glass-lg border border-border bg-surface p-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
            {t('camera.programScene')}
          </h2>
          <p data-testid="camera-program-scene" className="select-text font-mono text-sm text-text">
            {state.currentProgramScene ?? t('camera.programSceneUnknown')}
          </p>
        </div>

        {/* A live region, because the most important change here is one the operator did not
            make: someone switched a scene in OBS itself. */}
        <p role="status" className="mt-2 text-sm text-text-muted">
          {liveButton === null
            ? t('camera.noneLive')
            : t('camera.liveNow', { camera: labelFor(liveButton.slot, liveButton.label) })}
        </p>

        {liveButton === null && state.currentProgramScene !== null ? (
          <p className="mt-2 max-w-3xl text-xs text-text-muted">
            {t('camera.unmappedProgramScene', { scene: state.currentProgramScene })}
          </p>
        ) : null}
      </section>

      <ul
        aria-label={t('camera.buttonsLabel')}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {buttons.map((button) => {
          const shortcut = SHORTCUT_BY_SLOT.get(button.slot)
          const label = labelFor(button.slot, button.label)
          const disabled = block !== null || !button.usable

          return (
            <li key={button.slot}>
              <button
                type="button"
                data-slot={button.slot}
                data-live={button.live ? 'true' : 'false'}
                aria-pressed={button.live}
                disabled={disabled}
                onClick={() => {
                  void select(button.slot)
                }}
                className={clsx(
                  'flex min-h-touch-xl w-full flex-col items-start justify-center gap-1',
                  'rounded-glass-lg border-2 px-4 py-3 text-start transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  button.live
                    ? 'border-live bg-surface-2 shadow-glow'
                    : 'border-border bg-surface hover:border-accent/60',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-2xl font-bold uppercase tracking-wide text-text">
                    {label}
                  </span>
                  {/* Text first, colour second: this badge is the reason an operator across the
                      booth knows which camera is live. */}
                  <span
                    className={clsx(
                      'flex shrink-0 items-center gap-1 rounded-glass border px-2 py-0.5',
                      'text-xs font-semibold uppercase tracking-wide',
                      button.live ? 'border-live text-live' : 'border-border text-text-muted',
                    )}
                  >
                    {button.live ? (
                      <Radio aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <Video aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {button.live ? t('camera.live') : t('camera.standby')}
                  </span>
                </span>

                <span className="flex w-full flex-wrap items-center gap-2 text-xs text-text-muted">
                  {button.sceneName === null ? (
                    <span className="flex items-center gap-1 font-medium text-panic">
                      <VideoOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      {t('camera.unmapped.badge')}
                    </span>
                  ) : (
                    <span className="truncate font-mono">{button.sceneName}</span>
                  )}
                  {shortcut !== undefined ? (
                    <span className="ms-auto shrink-0 rounded border border-border px-1.5 font-mono">
                      {t('camera.shortcut', { key: shortcut })}
                    </span>
                  ) : null}
                </span>

                {button.sceneName === null ? (
                  <span className="text-xs text-text-muted">{t('camera.unmapped.hint')}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      {lastError !== null ? (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-panic" />
          <span className="select-text">
            {t(`errors.code.${lastError.code}`)} — {lastError.message}
          </span>
        </p>
      ) : null}
    </div>
  )
}

function Callout({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="rounded-glass-lg border border-panic/50 bg-surface p-5"
    >
      <h2 className="font-semibold text-panic">{title}</h2>
      <p className="mt-2 max-w-3xl text-sm text-text-muted">{children}</p>
    </section>
  )
}

export default CameraPanel
