import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { SpinnerIcon } from '../../components/icons/glyphs';
import type {
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import {
  NativeExceptions,
  PrimaryButton,
  SecondaryButton,
  StatusCard,
  type AsyncAction,
} from './WizardPrimitives';

export function ProgressStep({
  run,
  report,
  recovery,
  canClose = false,
}: {
  run?: Pick<BenchlingMigrationRunView, 'state' | 'localBundleState'>;
  report?: BenchlingMigrationReportView | null;
  recovery?: NonNullable<BenchlingMigrationRunView['linkedItemRecovery']>;
  canClose?: boolean;
}) {
  const writing =
    recovery?.state === 'reconciling' && recovery.work?.kind === 'write_objects'
      ? recovery.work
      : null;
  const finishing = recovery
    ? recovery.state === 'validating'
    : run?.state === 'validating' || run?.state === 'ready_to_unlock';
  const importing = recovery ? writing !== null : run?.state === 'projecting';
  const label = finishing
    ? 'Finishing up'
    : importing
      ? 'Importing your items'
      : 'Preparing your import';
  const measured = writing && writing.total > 0 ? writing : null;
  return (
    <section data-testid="benchling-migration-progress" aria-live="polite">
      <div className="flex min-h-64 flex-col items-center justify-center px-5 py-10 text-center">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent"
          aria-hidden="true"
        >
          <SpinnerIcon className="h-5 w-5" />
        </span>
        <h3 className="mt-4 text-sm font-semibold text-fg">{label}</h3>
        <p className="mt-1 text-xs text-fg-muted">Bringing your Benchling export into DNAForge.</p>
        <div
          className="mt-5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={measured?.total}
          aria-valuenow={measured?.completed}
        >
          <div
            className={
              measured
                ? 'h-full rounded-full bg-accent'
                : 'h-full w-full animate-pulse rounded-full bg-accent/40'
            }
            style={
              measured ? { width: `${(100 * measured.completed) / measured.total}%` } : undefined
            }
          />
        </div>
        <p className="mt-2 h-4 text-xs tabular-nums text-fg-muted">
          {measured
            ? `${measured.completed.toLocaleString()} of ${measured.total.toLocaleString()} items`
            : null}
        </p>
        <p className="mt-3 text-[11px] text-fg-subtle">
          {canClose
            ? 'You can close this window. Your import will continue in the background.'
            : 'Keep this window open.'}
        </p>
      </div>
      <NativeExceptions issues={report?.issues ?? []} />
    </section>
  );
}

export function ActionRequiredStep({
  run,
  pendingAction,
  onResume,
  onStartOverPreserved,
  onDiscard,
}: {
  run: BenchlingMigrationRunView;
  pendingAction: string | null;
  onResume: AsyncAction;
  onStartOverPreserved: AsyncAction;
  onDiscard: AsyncAction;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const projectionContractRestartRequired =
    run.recoveryAction === 'start_new_migration_select_original_export';
  return (
    <section className="space-y-4" data-testid={`benchling-migration-${run.state}`}>
      <StatusCard tone="error" title="Action required before migration can continue">
        {toUserMessage(
          run.lastError,
          'failure.resolve-the-blocking-condition-then-retry-this-step'
        )}
      </StatusCard>
      {run.lastError ? (
        <div className="rounded border border-error/30 bg-error/5 p-3 text-xs">
          <div className="font-mono text-[10px] uppercase tracking-wide text-error">
            {toUserMessage(run.lastError.code, 'operation.failed')}
          </div>
          <div className="mt-1 text-fg-muted">No captured local export was deleted.</div>
        </div>
      ) : null}
      {projectionContractRestartRequired ? (
        <p
          data-testid="benchling-migration-projection-contract-start-over"
          className="rounded border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-fg-muted"
        >
          DNAForge cannot safely reuse the captured bytes in this run. Start a new migration and
          select the same original Benchling export again. This locked run and its captured source
          will remain preserved as a failed migration; nothing is deleted.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {projectionContractRestartRequired ? (
          <PrimaryButton
            dataTestId="benchling-migration-start-over-preserved"
            onClick={onStartOverPreserved}
            pending={pendingAction === 'start_over'}
            disabled={pendingAction !== null && pendingAction !== 'start_over'}
            label="Start a new migration"
            pendingLabel="Preserving run"
          />
        ) : (
          <PrimaryButton
            dataTestId="benchling-migration-resume"
            onClick={onResume}
            pending={pendingAction === 'resume'}
            disabled={pendingAction !== null && pendingAction !== 'resume'}
            label="Retry blocked step"
            pendingLabel="Resuming"
          />
        )}
      </div>
      <div className="rounded border border-error/30 bg-error/5 p-3 text-xs">
        {confirmingDiscard ? (
          <div className="space-y-3">
            <p className="text-fg">
              This permanently removes the locked destination project, captured exports, and resume
              state. It cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <SecondaryButton
                onClick={() => setConfirmingDiscard(false)}
                pending={false}
                label="Keep preserved data"
              />
              <button
                type="button"
                data-testid="benchling-migration-confirm-discard"
                disabled={pendingAction === 'discard'}
                onClick={() => void onDiscard()}
                className="rounded border border-error bg-error px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {pendingAction === 'discard' ? 'Discarding…' : 'Permanently discard'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-muted">Cannot continue this import?</span>
            <button
              type="button"
              data-testid="benchling-migration-discard"
              onClick={() => setConfirmingDiscard(true)}
              className="rounded px-2 py-1 font-medium text-error hover:bg-error/10"
            >
              Discard blocked import…
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function ImportFailureStep({ run }: { run: BenchlingMigrationRunView }) {
  const validationFailed = run.lastError?.code === 'validation_failed';
  const fileName = run.lastError?.sourceFileName;
  return (
    <section
      data-testid={
        validationFailed
          ? 'benchling-migration-validation-failed'
          : 'benchling-migration-import-failed'
      }
      role="alert"
      className="text-fg"
    >
      <h2
        id="benchling-migration-import-failed-title"
        className="text-xl font-semibold leading-tight tracking-tight text-error"
      >
        Import failed
      </h2>
      {fileName ? (
        <div id="benchling-migration-import-failed-details" className="mt-4">
          <p className="text-xs leading-5 text-fg-muted">on</p>
          <p className="mt-1 break-words font-mono text-sm leading-6">{fileName}</p>
        </div>
      ) : null}
    </section>
  );
}
