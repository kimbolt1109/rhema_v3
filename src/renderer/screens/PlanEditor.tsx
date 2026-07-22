/**
 * The service plan editor — Phase 6's whole surface.
 *
 * This screen has to be **completely useful with no AI at all**. Author cues, reorder them, save
 * them, open them again, and drive them into the overlay by hand. Phases 7-8 add a transcript and
 * a cue engine on top; when either of those is unavailable — no microphone, no model, no network,
 * or simply an operator who does not trust it this week — everything degrades to exactly what is
 * on this screen. So this is built first, and built to stand alone.
 *
 * Four decisions worth stating:
 *
 * - **Reordering is keyboard-accessible, not pointer-only.** `KeyboardSensor` +
 *   `sortableKeyboardCoordinates` sit alongside `PointerSensor`, and the handle in `CueRow` is a
 *   real button. Reordering a service must not require a mouse.
 * - **Import is disabled, and explains itself, when no converter exists.** This machine has no
 *   LibreOffice and cannot get one (`HUMAN_TASKS.md`), so the unavailable path is the *ordinary*
 *   path here. It gets real words — the backend's own `detail`, plus what to install — rather than
 *   a greyed-out button that looks broken. Standing Rule 5: degrade, never crash.
 * - **Edits are debounced, not fired per keystroke.** Every edit goes through `plan.set`, which
 *   replaces the whole plan; doing that on every character would make the round trip race the
 *   typing and drop letters. {@link COMMIT_DEBOUNCE_MS} is the settle time, and switching cues
 *   flushes immediately so nothing is lost by clicking away.
 * - **Deleting a cue is a hold.** Standing Rule 6, via `HoldButton` in the editor panel.
 */

import { FileUp, FolderOpen, Plus, Save, SkipBack, SkipForward } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'

import type { Cue, CueType } from '@shared/plan'
import { CUE_TYPES } from '@shared/plan'

import { Button } from '../components/Button'
import { CueEditorPanel } from '../components/CueEditorPanel'
import type { CuePosition } from '../components/CueRow'
import { CueRow } from '../components/CueRow'
import { createCue, usePlanStore } from '../store/planStore'

/**
 * How long an edit rests before it is pushed to the main process.
 *
 * Long enough that ordinary typing produces one write rather than thirty; short enough that
 * clicking Save immediately after typing catches the edit. A flush also happens when the operator
 * selects a different cue, so nothing depends on this timer being generous.
 */
export const COMMIT_DEBOUNCE_MS = 250

/** Stage labels for the import progress readout, so a slow conversion never looks frozen. */
const IMPORT_STAGE_KEYS = {
  reading: 'plan.importer.progress.reading',
  converting: 'plan.importer.progress.converting',
  writing: 'plan.importer.progress.writing',
  done: 'plan.importer.progress.done',
  failed: 'plan.importer.progress.failed',
} as const

export function PlanEditor(): React.JSX.Element {
  const { t } = useTranslation()

  const plan = usePlanStore((state) => state.plan)
  const position = usePlanStore((state) => state.position)
  const path = usePlanStore((state) => state.path)
  const dirty = usePlanStore((state) => state.dirty)
  const lastFired = usePlanStore((state) => state.lastFired)
  const importer = usePlanStore((state) => state.importer)
  const importProgress = usePlanStore((state) => state.importProgress)
  const importing = usePlanStore((state) => state.importing)
  const bridgeAvailable = usePlanStore((state) => state.bridgeAvailable)
  const hydrated = usePlanStore((state) => state.hydrated)
  const lastError = usePlanStore((state) => state.lastError)

  const hydrate = usePlanStore((state) => state.hydrate)
  const subscribe = usePlanStore((state) => state.subscribe)
  const open = usePlanStore((state) => state.open)
  const save = usePlanStore((state) => state.save)
  const importDeck = usePlanStore((state) => state.importDeck)
  const fireCue = usePlanStore((state) => state.fireCue)
  const advance = usePlanStore((state) => state.advance)
  const back = usePlanStore((state) => state.back)
  const addCue = usePlanStore((state) => state.addCue)
  const updateCue = usePlanStore((state) => state.updateCue)
  const removeCue = usePlanStore((state) => state.removeCue)
  const reorderCues = usePlanStore((state) => state.reorderCues)

  useEffect(() => {
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [hydrate, subscribe])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newCueType, setNewCueType] = useState<CueType>('slide')

  const cues = plan.cues
  const selectedCue = cues.find((cue) => cue.id === selectedId) ?? null

  /* -------------------------- the debounced edit buffer -------------------------- */

  const [draft, setDraft] = useState<Cue | null>(null)
  /** True while the draft holds edits the main process has not been told about yet. */
  const pendingRef = useRef(false)
  /** The latest draft, readable from an unmount cleanup that must not close over stale state. */
  const draftRef = useRef<Cue | null>(null)
  draftRef.current = draft

  useEffect(() => {
    // Only adopt the store's copy when there is nothing local in flight — otherwise the answer to
    // an earlier keystroke would overwrite the characters typed since.
    if (pendingRef.current) return
    setDraft(selectedCue)
  }, [selectedCue])

  useEffect(() => {
    if (!pendingRef.current || draft === null) return undefined
    const timer = window.setTimeout(() => {
      // Re-checked, because something may have flushed this edit already — a debounce that fires
      // after an explicit flush would push the same plan twice.
      if (!pendingRef.current) return
      pendingRef.current = false
      void updateCue(draft.id, draft)
    }, COMMIT_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [draft, updateCue])

  // Switching tabs unmounts this screen. An edit typed in the last quarter-second must not be the
  // thing that vanishes, so it is committed on the way out.
  useEffect(
    () => () => {
      const pending = draftRef.current
      if (!pendingRef.current || pending === null) return
      pendingRef.current = false
      void usePlanStore.getState().updateCue(pending.id, pending)
    },
    [],
  )

  /** Push whatever is buffered right now. Used before anything that changes what is on screen. */
  const flush = useCallback((): void => {
    if (!pendingRef.current || draft === null) return
    pendingRef.current = false
    void updateCue(draft.id, draft)
  }, [draft, updateCue])

  const select = (cueId: string): void => {
    flush()
    setSelectedId(cueId)
  }

  /* ---------------------------------- drag and drop ---------------------------------- */

  const sensors = useSensors(
    // A 4px threshold so a plain click on the handle is still a click, not a one-pixel drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // The half that makes this usable without a pointer at all.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null || active.id === over.id) return
    const from = cues.findIndex((cue) => cue.id === active.id)
    const to = cues.findIndex((cue) => cue.id === over.id)
    if (from === -1 || to === -1) return
    // `reorderCues` moves the local copy first and then persists; a refusal puts the old order
    // back rather than leaving the list half-moved.
    void reorderCues(from, to)
  }

  /* ------------------------------------- readouts ------------------------------------- */

  const current = cues[position.index] ?? null
  const upcoming = cues[position.index + 1] ?? null

  const positionOf = (index: number): CuePosition => {
    if (index === position.index) return 'current'
    if (index === position.index + 1) return 'next'
    return 'other'
  }

  const progressStage = importProgress === null ? null : IMPORT_STAGE_KEYS[importProgress.stage]

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('plan.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('plan.subtitle')}</p>
      </header>

      {/* ------------------------------- file + toolbar ------------------------------- */}

      <section
        aria-label={t('plan.file.label')}
        className="flex flex-wrap items-center gap-3 rounded-glass-lg border border-border bg-surface p-4"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span data-testid="plan-service" className="truncate text-sm font-medium text-text">
            {plan.service.length > 0 ? plan.service : t('plan.file.untitled')}
          </span>
          <span data-testid="plan-path" className="truncate font-mono text-xs text-text-muted">
            {path ?? t('plan.file.neverSaved')}
          </span>
        </div>

        {/* The dirty indicator says which state it is in, in words — colour is never the only
            channel, and "did I save that?" is the question this answers at a glance. */}
        <span
          data-testid="plan-dirty"
          data-dirty={dirty ? 'true' : 'false'}
          className={
            dirty
              ? 'rounded-glass border border-accent px-3 py-1 text-xs font-medium text-accent'
              : 'rounded-glass border border-border px-3 py-1 text-xs text-text-muted'
          }
        >
          {dirty ? t('plan.unsaved') : t('plan.saved')}
        </span>

        <Button
          variant="secondary"
          icon={FolderOpen}
          data-testid="plan-open"
          disabled={!bridgeAvailable}
          onClick={() => {
            flush()
            void open()
          }}
        >
          {t('plan.actions.open')}
        </Button>
        <Button
          variant="primary"
          icon={Save}
          data-testid="plan-save"
          disabled={!bridgeAvailable}
          onClick={() => {
            flush()
            void save()
          }}
        >
          {t('plan.actions.save')}
        </Button>
      </section>

      {/* ------------------------------- the deck importer ------------------------------- */}

      <section
        aria-label={t('plan.importer.title')}
        data-testid="deck-importer"
        data-importer-available={importer.available ? 'true' : 'false'}
        className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex-1 text-sm font-semibold uppercase tracking-wide text-text">
            {t('plan.importer.title')}
          </h2>
          <Button
            variant="secondary"
            icon={FileUp}
            data-testid="plan-import"
            disabled={!importer.available || importing || !bridgeAvailable}
            aria-describedby={importer.available ? undefined : 'deck-importer-unavailable'}
            onClick={() => {
              flush()
              void importDeck()
            }}
          >
            {t('plan.actions.import')}
          </Button>
        </div>

        {importer.available ? (
          <p className="font-mono text-xs text-text-muted">
            {t('plan.importer.backend', {
              backend: importer.backend ?? '—',
              path: importer.executablePath ?? '—',
            })}
          </p>
        ) : (
          <div
            id="deck-importer-unavailable"
            data-testid="importer-unavailable"
            className="flex flex-col gap-2 rounded-glass border border-accent-2/50 bg-surface-2 p-3"
          >
            <p className="text-sm font-semibold text-text">
              {t('plan.importer.unavailable.title')}
            </p>
            {/* The backend's own words, printed verbatim. A generic "unavailable" would send the
                operator hunting for a setting that does not exist. */}
            <p className="select-text text-sm text-text-muted">
              {importer.detail ?? t('plan.importer.unavailable.noDetail')}
            </p>
            <p className="text-sm text-text-muted">{t('plan.importer.unavailable.install')}</p>
            <p className="text-sm text-text-muted">{t('plan.importer.unavailable.meanwhile')}</p>
          </div>
        )}

        {importProgress === null || progressStage === null ? null : (
          <div
            role="status"
            aria-live="polite"
            data-testid="import-progress"
            data-stage={importProgress.stage}
            className="flex flex-col gap-1 rounded-glass border border-border bg-surface-2 p-3"
          >
            <p className="text-sm text-text">{t(progressStage)}</p>
            <p data-testid="import-progress-count" className="font-mono text-xs text-text-muted">
              {importProgress.slidesTotal === null
                ? t('plan.importer.progress.countedUnknown', { done: importProgress.slidesDone })
                : t('plan.importer.progress.counted', {
                    done: importProgress.slidesDone,
                    total: importProgress.slidesTotal,
                  })}
            </p>
            {importProgress.slidesTotal === null ? null : (
              <progress
                aria-label={t('plan.importer.progress.label')}
                value={importProgress.slidesDone}
                max={importProgress.slidesTotal}
                className="h-2 w-full"
              />
            )}
            {importProgress.message === null ? null : (
              <p className="select-text text-xs text-text-muted">{importProgress.message}</p>
            )}
          </div>
        )}
      </section>

      {/* -------------------------------- the manual driver -------------------------------- */}

      <section
        aria-label={t('plan.driver.title')}
        className="flex flex-wrap items-center gap-3 rounded-glass-lg border border-border bg-surface p-4"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-testid="driver-current" className="truncate text-sm text-text">
            {t('plan.driver.nowShowing')}:{' '}
            <strong className="font-semibold">
              {(lastFired ?? current)?.label ?? t('plan.driver.nothingFired')}
            </strong>
          </span>
          <span data-testid="driver-next" className="truncate text-xs text-text-muted">
            {t('plan.driver.upNext')}: {upcoming?.label ?? t('plan.driver.endOfPlan')}
          </span>
        </div>
        <Button
          variant="secondary"
          icon={SkipBack}
          data-testid="plan-back"
          disabled={!bridgeAvailable}
          onClick={() => {
            void back()
          }}
        >
          {t('plan.actions.back')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          icon={SkipForward}
          data-testid="plan-advance"
          disabled={!bridgeAvailable}
          onClick={() => {
            void advance()
          }}
        >
          {t('plan.actions.advance')}
        </Button>
      </section>

      {bridgeAvailable ? null : (
        <p role="alert" className="rounded-glass-lg border border-panic/60 bg-surface p-4 text-sm text-panic">
          {t('plan.bridgeUnavailable.body')}
        </p>
      )}

      {lastError === null ? null : (
        <p
          role="alert"
          data-testid="plan-error"
          className="rounded-glass-lg border border-panic/60 bg-surface p-4 text-sm text-panic"
        >
          {t('plan.error.title')}: <span className="select-text">{lastError.message}</span>
        </p>
      )}

      {/* ------------------------------- the list and editor ------------------------------- */}

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <section
          aria-label={t('plan.list.label')}
          className="flex flex-col gap-3 rounded-glass-lg border border-border bg-surface p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-sm font-semibold uppercase tracking-wide text-text">
              {t('plan.list.heading', { total: cues.length })}
            </h2>
            <label htmlFor="new-cue-type" className="sr-only">
              {t('plan.list.newCueType')}
            </label>
            <select
              id="new-cue-type"
              value={newCueType}
              onChange={(event) => {
                setNewCueType(event.target.value as CueType)
              }}
              className="min-h-touch rounded-glass border border-border bg-surface-2 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`plan.cueType.${type}`)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              icon={Plus}
              data-testid="plan-add-cue"
              disabled={!bridgeAvailable}
              onClick={() => {
                flush()
                const cue = createCue(newCueType, t(`plan.cueType.${newCueType}`))
                setSelectedId(cue.id)
                void addCue(cue)
              }}
            >
              {t('plan.actions.addCue')}
            </Button>
          </div>

          <p className="text-xs text-text-muted">{t('plan.list.reorderHint')}</p>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={cues.map((cue) => cue.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul data-testid="cue-list" className="flex flex-col gap-2">
                {cues.map((cue, index) => (
                  <CueRow
                    key={cue.id}
                    cue={cue}
                    ordinal={index + 1}
                    position={positionOf(index)}
                    selected={cue.id === selectedId}
                    onSelect={select}
                    onFire={(cueId) => {
                      flush()
                      void fireCue(cueId)
                    }}
                    fireDisabled={!bridgeAvailable}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          {cues.length > 0 || !hydrated ? null : (
            <p data-testid="plan-empty" className="text-sm text-text-muted">
              {t('plan.list.empty')}
            </p>
          )}
        </section>

        {draft === null ? (
          <section
            aria-label={t('plan.editor.title')}
            className="rounded-glass-lg border border-border bg-surface p-5 text-sm text-text-muted"
          >
            {t('plan.editor.none')}
          </section>
        ) : (
          <CueEditorPanel
            cue={draft}
            disabled={!bridgeAvailable}
            onChange={(next) => {
              pendingRef.current = true
              setDraft(next)
            }}
            onDelete={() => {
              pendingRef.current = false
              setSelectedId(null)
              setDraft(null)
              void removeCue(draft.id)
            }}
          />
        )}
      </div>
    </div>
  )
}

export default PlanEditor
