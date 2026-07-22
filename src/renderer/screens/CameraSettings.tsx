/**
 * Camera setup — which OBS scene each of the four buttons selects.
 *
 * The one rule this screen exists to enforce: **a button can only ever point at a scene OBS has
 * actually reported.** The scene picker is a `<select>` populated from the live scene list, never a
 * free-text field, because a typo in a free-text field produces a button that looks fine, is
 * enabled, and fails in front of the congregation. `src/shared/camera.ts` puts the same rule the
 * other way round: an unmapped slot is `sceneName: null`, and `CameraPanel` disables it.
 *
 * Two smaller decisions worth stating:
 *
 * - **A blank transition means "use whatever OBS is set to".** BLUEPRINT.md §6: transitions are
 *   configured once in OBS and reused. Verger picks one by NAME and never defines one, so the
 *   honest default is to change nothing at all. The copy says so in as many words, because an
 *   empty dropdown otherwise reads as "broken" rather than as "deliberate".
 * - **Scenes and transitions already saved are always offered, even when OBS is not connected.**
 *   Without that, opening this screen while OBS is down and pressing Save would quietly blank every
 *   mapping — the select would have no option matching the stored value. Losing a working camera
 *   map because OBS restarted is exactly the class of failure this app exists to remove.
 */

import clsx from 'clsx'
import { CircleAlert, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CameraConfig, CameraSlot } from '@shared/camera'
import {
  CAMERA_SLOTS,
  DEFAULT_CAMERA_LABELS,
  cameraConfigSchema,
  findBinding,
} from '@shared/camera'

import { Button } from '../components/Button'
import { useCameraStore } from '../store/cameraStore'
import { useObsStore } from '../store/obsStore'

/** The widest transition duration `cameraBindingSchema` will accept, in milliseconds. */
export const MAX_TRANSITION_DURATION_MS = 20_000

/** One slot's fields as typed, before validation. Empty string is the UI's spelling of `null`. */
interface SlotDraft {
  readonly sceneName: string
  readonly transition: string
  readonly duration: string
}

type Draft = Record<CameraSlot, SlotDraft>

function draftForSlot(config: CameraConfig, slot: CameraSlot): SlotDraft {
  const binding = findBinding(config, slot)
  const duration = binding?.transitionDurationMs ?? null
  return {
    sceneName: binding?.sceneName ?? '',
    transition: binding?.transition ?? '',
    duration: duration === null ? '' : String(duration),
  }
}

/** Written out slot by slot rather than via `Object.fromEntries`, which erases the key union. */
function draftFromConfig(config: CameraConfig): Draft {
  return {
    cam1: draftForSlot(config, 'cam1'),
    cam2: draftForSlot(config, 'cam2'),
    wide: draftForSlot(config, 'wide'),
    pulpit: draftForSlot(config, 'pulpit'),
  }
}

/**
 * Parse a typed duration.
 *
 * Returns `null` for "leave it to OBS", a number for a real duration, and `'invalid'` for anything
 * the schema would reject — surfaced as a field error rather than sent and refused.
 */
export function parseTransitionDuration(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!/^\d+$/.test(trimmed)) return 'invalid'
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRANSITION_DURATION_MS) return 'invalid'
  return value
}

/** De-duplicated, order-preserving, blanks dropped. */
function options(...values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (value === null || value === undefined || value.length === 0) continue
    seen.add(value)
  }
  return [...seen]
}

export function CameraSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const config = useCameraStore((store) => store.config)
  const state = useCameraStore((store) => store.state)
  const saving = useCameraStore((store) => store.saving)
  const lastError = useCameraStore((store) => store.lastError)
  const hydrate = useCameraStore((store) => store.hydrate)
  const subscribe = useCameraStore((store) => store.subscribe)
  const setConfig = useCameraStore((store) => store.setConfig)

  const sceneList = useObsStore((store) => store.sceneList)
  const hydrateObs = useObsStore((store) => store.hydrate)
  const subscribeObs = useObsStore((store) => store.subscribe)

  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(config))
  const [invalidSlots, setInvalidSlots] = useState<readonly CameraSlot[]>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  useEffect(() => {
    const unsubscribe = subscribeObs()
    void hydrateObs()
    return unsubscribe
  }, [hydrateObs, subscribeObs])

  // The store is the source of truth; the draft follows it whenever a new configuration arrives
  // (initial hydrate, or a successful save).
  useEffect(() => {
    setDraft(draftFromConfig(config))
  }, [config])

  const scenes = sceneList === null ? [] : sceneList.scenes.map((scene) => scene.name)
  const scenesUnavailable = scenes.length === 0

  const update = (slot: CameraSlot, patch: Partial<SlotDraft>): void => {
    setSaved(false)
    setDraft((current) => ({ ...current, [slot]: { ...current[slot], ...patch } }))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaved(false)

    const invalid: CameraSlot[] = []
    const bindings = CAMERA_SLOTS.map((slot) => {
      const entry = draft[slot]
      const duration = parseTransitionDuration(entry.duration)
      if (duration === 'invalid') invalid.push(slot)
      return {
        slot,
        label: findBinding(config, slot)?.label ?? DEFAULT_CAMERA_LABELS[slot],
        sceneName: entry.sceneName.length === 0 ? null : entry.sceneName,
        transition: entry.transition.length === 0 ? null : entry.transition,
        transitionDurationMs: duration === 'invalid' ? null : duration,
      }
    })

    setInvalidSlots(invalid)
    if (invalid.length > 0) return

    const next: CameraConfig = { bindings }
    // Belt and braces: the same schema the main process validates with runs here first, so a bad
    // mapping is refused with a readable message instead of bouncing off an IPC handler.
    if (!cameraConfigSchema.safeParse(next).success) {
      setInvalidSlots([...CAMERA_SLOTS])
      return
    }

    void setConfig(next).then((result) => {
      setSaved(result.ok)
    })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('camera.settings.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('camera.settings.subtitle')}</p>
      </header>

      {scenesUnavailable ? (
        <section
          aria-label={t('camera.settings.noScenes.title')}
          className="rounded-glass-lg border border-panic/50 bg-surface p-5"
        >
          <h2 className="font-semibold text-panic">{t('camera.settings.noScenes.title')}</h2>
          <p className="mt-2 max-w-3xl text-sm text-text-muted">
            {t('camera.settings.noScenes.body')}
          </p>
        </section>
      ) : null}

      <form
        aria-label={t('camera.settings.formLabel')}
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
      >
        {CAMERA_SLOTS.map((slot) => {
          const entry = draft[slot]
          const configured = findBinding(config, slot)?.label ?? ''
          const camera =
            configured.length > 0 && configured !== DEFAULT_CAMERA_LABELS[slot]
              ? configured
              : t(`camera.slot.${slot}`)
          const invalid = invalidSlots.includes(slot)

          const sceneId = `camera-scene-${slot}`
          const transitionId = `camera-transition-${slot}`
          const durationId = `camera-duration-${slot}`

          const sceneOptions = options(...scenes, entry.sceneName)
          const transitionOptions = options(...state.availableTransitions, entry.transition)

          return (
            <fieldset
              key={slot}
              data-slot={slot}
              className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-5"
            >
              <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-text">
                {camera}
              </legend>

              <Field id={sceneId} label={t('camera.settings.sceneLabel', { camera })}>
                <select
                  id={sceneId}
                  value={entry.sceneName}
                  aria-describedby={`${sceneId}-hint`}
                  onChange={(event) => {
                    update(slot, { sceneName: event.target.value })
                  }}
                  className={selectClass}
                >
                  <option value="">{t('camera.settings.sceneNone')}</option>
                  {sceneOptions.map((scene) => (
                    <option key={scene} value={scene}>
                      {scene}
                    </option>
                  ))}
                </select>
                <p id={`${sceneId}-hint`} className="text-xs text-text-muted">
                  {t('camera.settings.sceneHint')}
                </p>
              </Field>

              <Field id={transitionId} label={t('camera.settings.transitionLabel', { camera })}>
                <select
                  id={transitionId}
                  value={entry.transition}
                  aria-describedby={`${transitionId}-hint`}
                  onChange={(event) => {
                    update(slot, { transition: event.target.value })
                  }}
                  className={selectClass}
                >
                  <option value="">{t('camera.settings.transitionDefault')}</option>
                  {transitionOptions.map((transition) => (
                    <option key={transition} value={transition}>
                      {transition}
                    </option>
                  ))}
                </select>
                <p id={`${transitionId}-hint`} className="text-xs text-text-muted">
                  {transitionOptions.length === 0
                    ? t('camera.settings.noTransitions')
                    : t('camera.settings.transitionHint')}
                </p>
              </Field>

              <Field id={durationId} label={t('camera.settings.durationLabel', { camera })}>
                <input
                  id={durationId}
                  // Deliberately `text` + `inputMode="numeric"` rather than `type="number"`: a
                  // number input silently swallows what the operator typed when it is not a valid
                  // number, so "2 seconds" would vanish with no explanation. Here it stays on
                  // screen next to a message saying what to write instead.
                  type="text"
                  inputMode="numeric"
                  value={entry.duration}
                  aria-invalid={invalid}
                  aria-describedby={
                    invalid ? `${durationId}-error` : `${durationId}-hint`
                  }
                  onChange={(event) => {
                    update(slot, { duration: event.target.value })
                  }}
                  className={clsx(
                    'min-h-touch w-full select-text rounded-glass border bg-surface-2 px-3',
                    'text-base text-text',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    invalid ? 'border-panic' : 'border-border',
                  )}
                />
                {invalid ? (
                  <p
                    id={`${durationId}-error`}
                    role="alert"
                    className="text-xs font-medium text-panic"
                  >
                    {t('camera.settings.durationInvalid')}
                  </p>
                ) : (
                  <p id={`${durationId}-hint`} className="text-xs text-text-muted">
                    {t('camera.settings.durationHint')}
                  </p>
                )}
              </Field>
            </fieldset>
          )
        })}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="lg" icon={Save} disabled={saving}>
            {t('camera.settings.save')}
          </Button>
          <p role="status" className="text-sm text-text-muted">
            {saved ? t('camera.settings.saved') : ''}
          </p>
        </div>
      </form>

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

const selectClass = clsx(
  'min-h-touch w-full rounded-glass border border-border bg-surface-2 px-3',
  'text-base text-text',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
)

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
    </div>
  )
}

export default CameraSettings
