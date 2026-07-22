/**
 * The last line of defence for the control surface.
 *
 * A React render error must not leave the operator staring at a blank black window mid-service.
 * It also must not imply the *service* is broken: OBS is a separate process that keeps streaming
 * and recording regardless (Standing Rule 2), and the fallback says so explicitly, because an
 * operator who thinks the stream just died will do something drastic.
 *
 * The error is forwarded to the main process's rolling log file via `window.verger?.log.write`,
 * optional-chained: if the preload never loaded, that is *plausibly the cause of the crash*, so
 * the reporting path must not itself throw.
 */

import { TriangleAlert, RotateCcw } from 'lucide-react'
import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'
import { useTranslation } from 'react-i18next'

import type { LogRecord } from '@shared/log'

import { Button } from './Button'

export interface ErrorBoundaryProps {
  readonly children: ReactNode
  /** Overrides the default reload behaviour. Injected by tests, which must not reload jsdom. */
  readonly onReload?: () => void
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

function reportToMain(error: Error, info: ErrorInfo): void {
  const record: LogRecord = {
    ts: Date.now(),
    level: 'error',
    scope: 'renderer:error-boundary',
    msg: error.message,
    data: {
      name: error.name,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
    },
  }

  if (typeof window === 'undefined') return
  // Two layers of optional-chaining on purpose: the bridge may be absent, and — although the IPC
  // contract says handlers never reject — a boundary is not the place to trust that.
  void window.verger?.log.write(record)?.catch(() => undefined)
}

/**
 * The visible fallback. Split out as a function component so it can use `useTranslation` — a
 * class component cannot, and hard-coding English here would violate the no-literal-copy rule
 * precisely where the operator is under the most stress.
 */
function ErrorFallback({ error, onReload }: { error: Error; onReload: () => void }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      role="alert"
      className="flex h-full w-full items-center justify-center bg-background p-8 text-text"
    >
      <div className="w-full max-w-2xl rounded-glass-lg border border-panic/50 bg-surface p-6">
        <div className="flex items-start gap-3">
          <TriangleAlert aria-hidden="true" className="mt-1 h-7 w-7 shrink-0 text-panic" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t('errors.boundary.title')}</h1>
            <p className="mt-2 text-sm text-text-muted">{t('errors.boundary.body')}</p>
          </div>
        </div>

        <div className="mt-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('errors.boundary.detailsLabel')}
          </h2>
          <pre className="mt-2 max-h-48 select-text overflow-auto rounded-glass bg-surface-2 p-3 font-mono text-xs text-text">
            {error.message}
          </pre>
        </div>

        <p className="mt-5 text-xs text-text-muted">{t('errors.boundary.reloadHint')}</p>

        <div className="mt-4">
          <Button variant="primary" size="lg" icon={RotateCcw} onClick={onReload}>
            {t('actions.reload')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportToMain(error, info)
  }

  private readonly handleReload = (): void => {
    const { onReload } = this.props
    if (onReload !== undefined) {
      onReload()
      return
    }
    if (typeof window !== 'undefined') window.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error !== null) {
      return <ErrorFallback error={error} onReload={this.handleReload} />
    }
    return this.props.children
  }
}
