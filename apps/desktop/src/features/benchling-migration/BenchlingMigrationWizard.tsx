import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  userEntityLabel,
  type UserMessage,
  renderUserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, SpinnerIcon } from '../../components/icons/glyphs';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import {
  isProtectedImportReplacementPath,
  type ImportDecision,
  type PendingImportDecision,
} from '../../shared/benchling-import-decision';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useToastStore } from '../../stores/toast-store';
import { LocalExportIntakeStep } from './LocalExportIntakeStep';
import { ImportDestinationStep } from './ImportDestinationStep';
import { ActionRequiredStep, ImportFailureStep, ProgressStep } from './MigrationRunSteps';
import { TerminalFailureStep, ValidationStep } from './MigrationValidationStep';
import { PrimaryButton, SecondaryButton, StatusCard } from './WizardPrimitives';
import {
  isCoordinatorDrivenLocalImport,
  isFinalizingNativeZipImport,
  isLocalBundleRunView,
} from './migration-progress';
import type { MigrationInitialView } from './migration-session-selection';
import type { BenchlingMigrationWizardBridge } from './types';
import { useBenchlingMigrationWizard } from './useBenchlingMigrationWizard';

const ACTIVE_PROGRESS_STATES = new Set<BenchlingMigrationRunView['state']>([
  'export_pending',
  'downloading',
  'parsing',
  'offline_resolution',
  'targeted_reads',
  'projecting',
  'validating',
]);

const ACTIVE_LINKED_ITEM_RECOVERY_STATES = new Set<
  NonNullable<BenchlingMigrationRunView['linkedItemRecovery']>['state']
>(['copying', 'parsing', 'awaiting_conflict_resolution', 'reconciling', 'validating']);

const BACKGROUND_MIGRATION_NOTICE =
  'Migration continues in the background and resumes automatically after DNAForge restarts. Track it in Settings → Migrations.';

function isLocalImportFailure(run: BenchlingMigrationRunView | null): boolean {
  return (
    run?.scope.acquisition === 'local_bundle' &&
    (run.state === 'failed' ||
      (run.state === 'action_required' && run.lastError?.blocking === true))
  );
}

export function BenchlingMigrationWizard({
  bridge,
  onClose,
  onUnlocked,
  onImportedObjectsChanged,
  onOpenWorkspace,
  onViewMigrationDetails,
  onRunChange,
  selectedRunId,
  startFresh = false,
  initialView = 'summary',
}: {
  bridge: BenchlingMigrationWizardBridge;
  onClose(): void;
  onUnlocked?(workspaceId: string): void;
  onImportedObjectsChanged?(workspaceId: string): void | Promise<void>;
  onOpenWorkspace?(workspaceId: string, sourceIds?: readonly string[]): void | Promise<void>;
  onViewMigrationDetails?(): void | Promise<void>;
  onRunChange?(run: BenchlingMigrationRunView | null): void;
  selectedRunId?: string;
  startFresh?: boolean;
  initialView?: MigrationInitialView;
}) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const wizard = useBenchlingMigrationWizard(bridge, selectedRunId, startFresh);
  const { view, loading, pendingAction, error } = wizard;
  const run = view.run;
  const report = view.report;
  const localImportFailure = isLocalImportFailure(run);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const openingWorkspaceRef = useRef(false);
  const [openingError, setOpeningError] = useState<UserMessage | null>(null);
  const notifiedWorkspaceId = useRef<string | null>(null);
  const notifiedWorkspaceAppendAttemptId = useRef<string | null>(null);
  const importedObjectsRefreshPromise = useRef<Promise<void> | null>(null);
  const selectedRunInitialState = useRef<{
    runId: string;
    state: BenchlingMigrationRunView['state'];
  } | null>(null);
  if (selectedRunId === undefined) {
    selectedRunInitialState.current = null;
  } else if (
    run?.id === selectedRunId &&
    selectedRunInitialState.current?.runId !== selectedRunId
  ) {
    selectedRunInitialState.current = { runId: selectedRunId, state: run.state };
  }
  const dialogPanelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeRequestedRef = useRef(false);
  const addToast = useToastStore((state) => state.addToast);
  const linkedItemImportIsActive =
    run?.linkedItemRecovery !== null &&
    run?.linkedItemRecovery !== undefined &&
    run.linkedItemRecovery.state !== 'completed' &&
    run.linkedItemRecovery.state !== 'failed';
  const migrationWorkIsBlockingClose =
    pendingAction === 'create' ||
    pendingAction === 'retry_without_file' ||
    linkedItemImportIsActive;
  const useWideLayout = wizard.pendingImport !== null || (run !== null && !localImportFailure);
  const migrationContinuesInBackground =
    pendingAction === 'create' ||
    pendingAction === 'retry_without_file' ||
    (run !== null &&
      (ACTIVE_PROGRESS_STATES.has(run.state) ||
        isFinalizingNativeZipImport(run) ||
        (isLocalBundleRunView(run) && run.localBundleState === 'copying') ||
        (run.linkedItemRecovery !== null &&
          run.linkedItemRecovery !== undefined &&
          ACTIVE_LINKED_ITEM_RECOVERY_STATES.has(run.linkedItemRecovery.state))));
  const closeLabel = migrationContinuesInBackground
    ? `Close migration details. ${BACKGROUND_MIGRATION_NOTICE}`
    : 'Close Benchling migration';
  const closeWizard = useCallback(() => {
    if (migrationWorkIsBlockingClose) return;
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    if (migrationContinuesInBackground) {
      addToast(
        userMessage(
          'notice.migration-continues-in-the-background-and-resumes-automatically-after-'
        ),
        { definition: 'migration-background' }
      );
    }
    onClose();
  }, [addToast, migrationContinuesInBackground, migrationWorkIsBlockingClose, onClose]);
  const visibleError: UserMessage | null = openingError ?? error;
  const closeButton = !migrationWorkIsBlockingClose ? (
    <button
      ref={closeButtonRef}
      type="button"
      data-testid="benchling-migration-close"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={closeWizard}
      className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
    >
      <CloseIcon size={16} />
    </button>
  ) : null;
  const openWorkspace = useCallback(async () => {
    if (!run || !onOpenWorkspace || openingWorkspaceRef.current) return;
    openingWorkspaceRef.current = true;
    setOpeningWorkspace(true);
    setOpeningError(null);
    try {
      const completedRun = run.state === 'ready_to_unlock' ? (await wizard.unlock())?.run : run;
      if (completedRun?.state !== 'unlocked') return;
      await importedObjectsRefreshPromise.current;
      const sources =
        report?.version === 2
          ? report.nativeImport?.externalSources.map((source) => source.sourceId)
          : undefined;
      if (sources?.length) await onOpenWorkspace(completedRun.workspaceId, sources);
      else await onOpenWorkspace(completedRun.workspaceId);
    } catch (cause) {
      setOpeningError(toUserMessage(cause, 'benchling.openFailed'));
    } finally {
      openingWorkspaceRef.current = false;
      setOpeningWorkspace(false);
    }
  }, [onOpenWorkspace, run, report, wizard.unlock]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeWizard();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = dialogPanelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute('hidden'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        safeFocus(last);
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        safeFocus(first);
      }
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => presentationEvents.remove(window, 'keydown', onKeyDown);
  }, [closeWizard, presentationEvents]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    safeFocus(closeButtonRef.current);
    return () => {
      if (previouslyFocused?.isConnected) safeFocus(previouslyFocused);
    };
  }, []);

  useEffect(() => {
    const selectedRunWasAlreadyUnlocked =
      selectedRunId !== undefined &&
      selectedRunInitialState.current?.runId === selectedRunId &&
      selectedRunInitialState.current.state === 'unlocked';
    if (
      !selectedRunWasAlreadyUnlocked &&
      run?.state === 'unlocked' &&
      onUnlocked &&
      notifiedWorkspaceId.current !== run.workspaceId
    ) {
      notifiedWorkspaceId.current = run.workspaceId;
      onUnlocked(run.workspaceId);
    }
  }, [onUnlocked, run?.state, run?.workspaceId, selectedRunId]);

  useEffect(() => {
    const recovery = run?.linkedItemRecovery;
    if (
      !run ||
      recovery?.mode !== 'workspace_append' ||
      recovery.state !== 'completed' ||
      !onImportedObjectsChanged ||
      notifiedWorkspaceAppendAttemptId.current === recovery.attemptId
    ) {
      return;
    }
    notifiedWorkspaceAppendAttemptId.current = recovery.attemptId;
    const refresh = Promise.resolve(onImportedObjectsChanged(run.workspaceId)).catch((error) => {
      console.warn(
        '[benchling-migration] Imported-object refresh failed before workspace open:',
        error
      );
    });
    importedObjectsRefreshPromise.current = refresh;
    void refresh.finally(() => {
      if (importedObjectsRefreshPromise.current === refresh) {
        importedObjectsRefreshPromise.current = null;
      }
    });
  }, [onImportedObjectsChanged, run?.linkedItemRecovery, run?.workspaceId]);

  useEffect(() => {
    if (loading || error !== null) return;
    if (selectedRunId === undefined) onRunChange?.(run);
  }, [error, loading, onRunChange, run, selectedRunId]);

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        data-testid="benchling-migration-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby={
          localImportFailure
            ? 'benchling-migration-import-failed-title'
            : 'benchling-migration-title'
        }
        aria-describedby={
          localImportFailure && run?.lastError?.sourceFileName
            ? 'benchling-migration-import-failed-details'
            : undefined
        }
        className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div
          ref={dialogPanelRef}
          data-testid="benchling-migration-wizard"
          aria-busy={loading || pendingAction !== null}
          className={`relative flex max-h-[88vh] flex-col rounded-xl border border-border bg-bg shadow-xl ${
            useWideLayout ? 'w-[min(56rem,94vw)]' : 'w-[min(32rem,94vw)]'
          }`}
        >
          {localImportFailure ? (
            <div className="absolute right-4 top-4">{closeButton}</div>
          ) : (
            <header className="flex h-14 flex-none items-center justify-between border-b border-border px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="benchling-migration-title" className="text-base font-semibold text-fg">
                    Migrate from Benchling
                  </h2>
                  {}
                </div>
              </div>
              <div className="flex items-center gap-2">{closeButton}</div>
            </header>
          )}

          <div
            className={`min-h-0 flex-1 overflow-y-auto px-5 ${localImportFailure ? 'py-6 pr-12' : 'py-4'}`}
          >
            {visibleError && !localImportFailure ? (
              <div
                role="alert"
                data-testid="benchling-migration-error"
                className="mb-4 rounded border border-error/40 bg-error/5 px-3 py-2 text-xs text-error"
              >
                <p className="font-medium">{renderUserMessage(visibleError)}</p>
              </div>
            ) : null}
            {loading && !startFresh ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-fg-muted">
                <SpinnerIcon className="h-4 w-4" /> Loading migration state
              </div>
            ) : (
              <WizardBody
                wizard={wizard}
                openingWorkspace={openingWorkspace}
                onOpenWorkspace={onOpenWorkspace ? openWorkspace : undefined}
                onViewMigrationDetails={onViewMigrationDetails}
                initialView={initialView}
              />
            )}
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}

function WizardBody({
  wizard,
  openingWorkspace,
  onOpenWorkspace,
  onViewMigrationDetails,
  initialView,
}: {
  wizard: ReturnType<typeof useBenchlingMigrationWizard>;
  openingWorkspace: boolean;
  onOpenWorkspace?(): void | Promise<void>;
  onViewMigrationDetails?(): void | Promise<void>;
  initialView: MigrationInitialView;
}) {
  const { view, pendingAction, pendingImport } = wizard;
  const run = view.run;
  const createdObjects = view.createdObjects;
  if (!run) {
    if (pendingImport) {
      if (pendingAction === 'create') return <ProgressStep />;
      return (
        <ImportDestinationStep
          selection={pendingImport}
          pending={false}
          onBack={wizard.cancelPreparedLocalBundle}
          onImport={wizard.importPreparedLocalBundle}
        />
      );
    }
    return (
      <LocalExportIntakeStep
        pendingState={
          wizard.loading
            ? 'loading'
            : pendingAction === 'choose_export'
              ? 'opening_picker'
              : pendingAction === 'survey'
                ? 'reading_export'
                : null
        }
        onChooseExport={wizard.chooseLocalBundle}
        onDropExport={wizard.prepareLocalBundle}
      />
    );
  }
  if (isLocalImportFailure(run)) {
    if (run.bestEffortRecoveryPending) return <ProgressStep run={run} canClose />;
    return <ImportFailureStep run={run} />;
  }
  const workspaceAppend =
    run.linkedItemRecovery?.mode === 'workspace_append' ? run.linkedItemRecovery : null;
  const pendingImportDecision =
    run.linkedItemRecovery?.pendingImportDecision ??
    (run.linkedItemRecovery?.versionConflictResolution?.kind === 'awaiting_choice'
      ? {
          kind: 'provider_version_conflict' as const,
          conflicts: [
            {
              sourceObjectId:
                run.linkedItemRecovery.versionConflictResolution.firstConflict.stableId,
              stableId: run.linkedItemRecovery.versionConflictResolution.firstConflict.stableId,
              displayName: run.linkedItemRecovery.versionConflictResolution.firstConflict.name,
            },
          ],
        }
      : null);
  if (run.linkedItemRecovery?.state === 'awaiting_conflict_resolution' && pendingImportDecision) {
    return (
      <ImportDecisionChoiceStep
        decision={pendingImportDecision}
        pending={pendingAction === 'resolve_import_decision'}
        onChoose={(decision) =>
          wizard.resolveImportDecision(run.linkedItemRecovery!.attemptId, decision)
        }
      />
    );
  }
  if (workspaceAppend && workspaceAppend.state !== 'completed') {
    return workspaceAppend.state === 'failed' ? (
      <StatusCard tone="error" title="This export could not be checked">
        {workspaceAppend.errorMessage != null
          ? toUserMessage(
              workspaceAppend.errorMessage,
              'failure.dnaforge-could-not-finish-checking-every-entity-in-this-export-your-ex'
            )
          : userMessage(
              'failure.dnaforge-could-not-finish-checking-every-entity-in-this-export-your-ex'
            )}
      </StatusCard>
    ) : (
      <ProgressStep recovery={workspaceAppend} />
    );
  }
  const canRetryLocalBundleIntake =
    isLocalBundleRunView(run) &&
    run.localBundleState === 'waiting_for_selection' &&
    run.scope.kind !== 'file' &&
    run.binding === null &&
    (run.state === 'scope_planning' ||
      (run.state === 'action_required' && run.resumeState === 'scope_planning'));
  if (canRetryLocalBundleIntake) {
    return (
      <div className="space-y-4">
        {run.lastError ? (
          <p
            role="alert"
            data-testid="benchling-migration-intake-retry-error"
            className="rounded border border-error/40 bg-error/5 px-3 py-2 text-xs text-error"
          >
            {toUserMessage(run.lastError, 'operation.failed')}
          </p>
        ) : null}
        <LocalExportIntakeStep
          pendingState={pendingAction === 'create' ? 'reading_export' : null}
          onChooseExport={() => wizard.importLocalBundle(run.id)}
          onDropExport={(sourcePath) => wizard.importDroppedLocalBundle(sourcePath, run.id)}
        />
      </div>
    );
  }
  if (isLocalBundleRunView(run) && run.localBundleState === 'copying') {
    return <ProgressStep run={run} canClose />;
  }
  if (run.state === 'scope_planning') {
    const drivenByCoordinator = isCoordinatorDrivenLocalImport(run);
    if (drivenByCoordinator && run.localBundleState === 'ready') {
      return <ProgressStep run={run} canClose />;
    }
    if (isLocalBundleRunView(run) && run.localBundleState === 'ready') {
      return (
        <section className="space-y-4" data-testid="benchling-migration-legacy-local-ready">
          <StatusCard tone="neutral" title="Local export is ready">
            This preserved migration was created by an older DNAForge version. Continue to import
            its verified local export without reconnecting to Benchling.
          </StatusCard>
          <PrimaryButton
            dataTestId="benchling-migration-continue-local"
            label="Continue import"
            pendingLabel="Starting import"
            pending={pendingAction === 'start'}
            onClick={wizard.start}
          />
        </section>
      );
    }
    return (
      <TerminalFailureStep
        run={run}
        pending={pendingAction === 'discard'}
        onDiscard={wizard.discard}
      />
    );
  }
  if (ACTIVE_PROGRESS_STATES.has(run.state) || isFinalizingNativeZipImport(run)) {
    return <ProgressStep run={run} report={view.report} canClose />;
  }
  if (run.state === 'action_required') {
    return (
      <div className="space-y-5">
        <ActionRequiredStep
          run={run}
          pendingAction={pendingAction}
          onResume={wizard.resume}
          onStartOverPreserved={wizard.startOverPreserved}
          onDiscard={wizard.discard}
        />
        {view.report && !view.report.passed ? (
          <ValidationStep
            run={run}
            report={view.report}
            createdObjects={createdObjects}
            pending={false}
            onUnlock={() => undefined}
          />
        ) : null}
      </div>
    );
  }
  if (run.state === 'ready_to_unlock' || run.state === 'unlocked') {
    return (
      <ValidationStep
        run={run}
        report={view.report}
        createdObjects={createdObjects}
        pending={pendingAction === 'unlock'}
        openPending={openingWorkspace}
        recoveryPending={pendingAction === 'recover_linked_items'}
        onUnlock={wizard.unlock}
        onOpenWorkspace={onOpenWorkspace}
        onViewMigrationDetails={onViewMigrationDetails}
        onAddLinkedItemExports={wizard.addLinkedItemExports}
        onOpenLinkedItemRecoveryLocation={wizard.openLinkedItemRecoveryLocation}
        initialLinkedItemRecoveryOpen={initialView === 'missing_dependencies'}
      />
    );
  }
  return (
    <div className="space-y-5">
      <TerminalFailureStep
        run={run}
        pending={pendingAction === 'discard'}
        retryPending={pendingAction === 'resume'}
        onRetry={
          run.state === 'failed' &&
          run.lastError?.code === 'internal_invariant' &&
          (run.sourceArtifact?.format === 'zip' || run.localBundleMode === 'external_zip')
            ? wizard.resume
            : undefined
        }
        onDiscard={wizard.discard}
      />
      {view.report && !view.report.passed ? (
        <ValidationStep
          run={run}
          report={view.report}
          createdObjects={createdObjects}
          pending={false}
          onUnlock={() => undefined}
        />
      ) : null}
    </div>
  );
}

export function ImportDecisionChoiceStep({
  decision,
  pending,
  onChoose,
}: {
  decision: PendingImportDecision;
  pending: boolean;
  onChoose(decision: ImportDecision): Promise<unknown>;
}) {
  if (decision.kind === 'unbound_exact_match') {
    return (
      <section className="space-y-5 py-2" data-testid="benchling-exact-match-choice">
        <div>
          <h3 className="text-base font-semibold text-fg">An identical item already exists</h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            <span className="font-medium text-fg">{decision.candidateDisplayName}</span> has the
            same scientific content as{' '}
            <span className="font-medium text-fg">{decision.sourceDisplayName}</span>, but their
            identities are not linked yet.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <SecondaryButton
            label="Import separate copy"
            pending={pending}
            onClick={() =>
              onChoose({
                kind: 'unbound_exact_match',
                sourceObjectId: decision.sourceObjectId,
                candidateEntityId: decision.candidateEntityId,
                expectedCandidateScientificSha256: decision.expectedCandidateScientificSha256,
                expectedBindingState: 'unbound',
                policy: 'import_separate',
              })
            }
          />
          <PrimaryButton
            label="Link existing item"
            pendingLabel="Linking item…"
            pending={pending}
            onClick={() =>
              onChoose({
                kind: 'unbound_exact_match',
                sourceObjectId: decision.sourceObjectId,
                candidateEntityId: decision.candidateEntityId,
                expectedCandidateScientificSha256: decision.expectedCandidateScientificSha256,
                expectedBindingState: 'unbound',
                policy: 'link_existing',
              })
            }
          />
        </div>
      </section>
    );
  }
  if (decision.kind === 'structural_path_conflict') {
    const replaceAllowed =
      decision.replaceAllowed && !isProtectedImportReplacementPath(decision.relativePath);
    return (
      <section className="space-y-5 py-2" data-testid="benchling-structural-conflict-choice">
        <div>
          <h3 className="text-base font-semibold text-fg">Choose how to handle this path</h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Incoming {decision.incomingKind} conflicts with an existing{' '}
            {decision.expectedExistingState.kind} at{' '}
            <code className="rounded bg-bg-muted px-1.5 py-0.5 text-xs text-fg">
              {decision.relativePath}
            </code>
            .
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <SecondaryButton
            label="Cancel import"
            pending={pending}
            onClick={() =>
              onChoose({
                kind: 'structural_path_conflict',
                relativePath: decision.relativePath,
                expectedExistingState: decision.expectedExistingState,
                policy: 'cancel_import',
              })
            }
          />
          <SecondaryButton
            label="Rename incoming"
            pending={pending}
            onClick={() =>
              onChoose({
                kind: 'structural_path_conflict',
                relativePath: decision.relativePath,
                expectedExistingState: decision.expectedExistingState,
                policy: 'rename_incoming',
              })
            }
          />
          {replaceAllowed ? (
            <PrimaryButton
              label="Replace existing"
              pendingLabel="Replacing item…"
              pending={pending}
              onClick={() =>
                onChoose({
                  kind: 'structural_path_conflict',
                  relativePath: decision.relativePath,
                  expectedExistingState: decision.expectedExistingState,
                  policy: 'replace_existing',
                })
              }
            />
          ) : null}
        </div>
      </section>
    );
  }
  const firstConflict = decision.conflicts[0];
  return (
    <section className="space-y-5 py-2" data-testid="benchling-version-conflict-choice">
      <div>
        <h3 className="text-base font-semibold text-fg">Choose which versions to use</h3>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          This export has a different version of{' '}
          <span className="font-medium text-fg">{userEntityLabel(firstConflict?.displayName)}</span>
          .
        </p>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          DNAForge will apply your choice to every different version in this import.
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <SecondaryButton
          label="Keep existing versions"
          pending={pending}
          onClick={() => onChoose({ kind: 'provider_version_conflict', policy: 'keep_existing' })}
        />
        <PrimaryButton
          label="Use incoming versions"
          pendingLabel="Applying choice…"
          pending={pending}
          onClick={() => onChoose({ kind: 'provider_version_conflict', policy: 'use_incoming' })}
        />
      </div>
    </section>
  );
}
