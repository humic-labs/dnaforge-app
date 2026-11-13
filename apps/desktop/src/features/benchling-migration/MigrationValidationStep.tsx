import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { CheckIcon, SpinnerIcon } from '../../components/icons/glyphs';
import type {
  BenchlingMigrationCreatedObjectView,
  BenchlingMigrationLinkedItemRecoveryLocationKind,
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
import { MigrationTechnicalDetails } from './MigrationTechnicalDetails';
import { LinkedItemRecoveryPanel } from './LinkedItemRecoveryPanel';

export function ValidationStep({
  run,
  report,
  pending,
  recoveryPending = false,
  openPending = false,
  createdObjects = [],
  onUnlock,
  onOpenWorkspace,
  onViewMigrationDetails,
  onAddLinkedItemExports,
  onOpenLinkedItemRecoveryLocation,
  initialLinkedItemRecoveryOpen = false,
}: {
  run: BenchlingMigrationRunView;
  report: BenchlingMigrationReportView | null;
  pending: boolean;
  recoveryPending?: boolean;
  createdObjects?: readonly BenchlingMigrationCreatedObjectView[];
  onUnlock: AsyncAction;
  onOpenWorkspace?: AsyncAction;
  onViewMigrationDetails?: AsyncAction;
  onAddLinkedItemExports?: (sourcePaths?: string[]) => Promise<unknown> | void;
  openPending?: boolean;
  initialLinkedItemRecoveryOpen?: boolean;
  onOpenLinkedItemRecoveryLocation?: (
    kind: BenchlingMigrationLinkedItemRecoveryLocationKind,
    sourceId: string
  ) => Promise<unknown> | void;
}) {
  const linkedItemRecoveryState = run.linkedItemRecovery?.state;
  const recoveryBlocksUnlock =
    linkedItemRecoveryState === 'copying' ||
    linkedItemRecoveryState === 'parsing' ||
    linkedItemRecoveryState === 'reconciling' ||
    linkedItemRecoveryState === 'validating' ||
    linkedItemRecoveryState === 'failed';
  const initialLinkedItemAttemptCount =
    report?.version === 2 ? (report.linkedItemRecovery?.evidence.attempts.length ?? 0) : 0;
  const [showLinkedItemRecovery, setShowLinkedItemRecovery] = useState(
    initialLinkedItemRecoveryOpen
  );
  const [linkedItemAttemptBaseline, setLinkedItemAttemptBaseline] = useState<number | null>(
    initialLinkedItemRecoveryOpen ? initialLinkedItemAttemptCount : null
  );
  const previousRunId = useRef(run.id);

  useEffect(() => {
    const runChanged = previousRunId.current !== run.id;
    previousRunId.current = run.id;
    if (runChanged) {
      setShowLinkedItemRecovery(initialLinkedItemRecoveryOpen);
      setLinkedItemAttemptBaseline(
        initialLinkedItemRecoveryOpen ? initialLinkedItemAttemptCount : null
      );
    }
  }, [initialLinkedItemAttemptCount, initialLinkedItemRecoveryOpen, run.id]);

  if (!report) {
    return (
      <StatusCard tone="warning" title="Validation report unavailable">
        Refresh this run before unlocking.
      </StatusCard>
    );
  }
  const directFolderImportScope =
    report.version === 2 && report.scope.kind === 'folder'
      ? report.directFolderImportScope
      : undefined;
  const isLocalExportRun = run.scope.acquisition === 'local_bundle';
  const localExportArtifact =
    isLocalExportRun &&
    run.binding === null &&
    run.sourceArtifact?.kind === 'local_bundle' &&
    run.scope.acquisition === 'local_bundle'
      ? run.sourceArtifact
      : null;
  const localExportSection = report.version === 2 ? report.localExport : undefined;
  const nativeImport = report.version === 2 ? report.nativeImport : undefined;
  const nativeSourceVerified =
    report.runId === run.id &&
    nativeImport !== undefined &&
    nativeImport.externalSources.length > 0 &&
    nativeImport.externalSources.every((source) => source.state === 'verified_at_import');
  const localExportVerified =
    !isLocalExportRun ||
    ((run.linkedItemRecovery && nativeImport !== undefined) ||
    run.workspaceOrigin === 'adopted_existing'
      ? nativeSourceVerified &&
        run.linkedItemRecovery?.state === 'completed' &&
        nativeImport?.actionId === run.linkedItemRecovery.attemptId
      : nativeImport
        ? nativeSourceVerified &&
          nativeImport.history === 'new_workspace' &&
          nativeImport.actionId === run.id
        : localExportArtifact !== null &&
          localExportEvidenceMatchesArtifact(localExportArtifact, localExportSection));
  const usesLocalFolderExport =
    isLocalExportRun && (run.scope.kind === 'folder' || run.scope.kind === 'folder_tree');
  const localFolderExport = usesLocalFolderExport ? localExportSection : undefined;
  const nativeFolderZipInventory = localFolderExport?.evidence.nativeFolderZipInventory;
  const linkedItemRecoveryEvidence =
    report.version === 2 ? report.linkedItemRecovery?.evidence : undefined;
  const offlinePlaceholderCount = report.issues.filter(
    (issue) => issue.code === 'required_target_missing' && !issue.blocking
  ).length;
  const visibleIssues = report.issues.filter(
    (issue) =>
      !(issue.code === 'required_target_missing' && !issue.blocking) &&
      !(
        issue.code === 'projection_failed' &&
        issue.message.startsWith('Native conversion exception:')
      ) &&
      !isProviderActivityIssue(issue.message)
  );
  const linkedItemRecoveryAvailable =
    isLocalExportRun &&
    linkedItemRecoveryEvidence !== undefined &&
    onAddLinkedItemExports !== undefined &&
    onOpenLinkedItemRecoveryLocation !== undefined;
  const missingLinkedItemCount =
    linkedItemRecoveryEvidence?.remainingUniqueObjectCount ?? offlinePlaceholderCount;
  const compactLocalSuccess =
    report.passed &&
    localExportVerified &&
    ((usesLocalFolderExport && nativeFolderZipInventory !== undefined) ||
      (isLocalExportRun && nativeImport !== undefined));
  const latestLinkedItemAttempt =
    linkedItemRecoveryEvidence?.attempts[(linkedItemRecoveryEvidence?.attempts.length ?? 0) - 1];
  const completedLinkedItemAttempt =
    showLinkedItemRecovery &&
    linkedItemAttemptBaseline !== null &&
    linkedItemRecoveryEvidence !== undefined &&
    linkedItemRecoveryEvidence.attempts.length > linkedItemAttemptBaseline &&
    latestLinkedItemAttempt !== undefined &&
    latestLinkedItemAttempt.attemptId === run.linkedItemRecovery?.attemptId &&
    latestLinkedItemAttempt.outcome !== 'failed' &&
    latestLinkedItemAttempt.recoveredTargetCount > 0 &&
    run.linkedItemRecovery?.state === 'completed' &&
    run.linkedItemRecovery.mode !== 'workspace_append'
      ? latestLinkedItemAttempt
      : null;
  const linkedItemImportIsActive =
    run.linkedItemRecovery !== null &&
    run.linkedItemRecovery !== undefined &&
    run.linkedItemRecovery.mode !== 'workspace_append' &&
    run.linkedItemRecovery.state !== 'completed' &&
    run.linkedItemRecovery.state !== 'failed';

  if (completedLinkedItemAttempt) {
    return (
      <LinkedItemRecoverySuccess
        recoveredTargetCount={completedLinkedItemAttempt.recoveredTargetCount}
        repairedRelationshipCount={completedLinkedItemAttempt.repairedRelationshipCount}
        remainingTargetCount={missingLinkedItemCount}
        pending={pending || openPending}
        onOpenWorkspace={onOpenWorkspace ?? onUnlock}
        onImportAnother={
          missingLinkedItemCount > 0
            ? () => {
                setLinkedItemAttemptBaseline(linkedItemRecoveryEvidence?.attempts.length ?? 0);
                setShowLinkedItemRecovery(true);
              }
            : undefined
        }
      />
    );
  }

  if (
    (showLinkedItemRecovery || linkedItemImportIsActive) &&
    linkedItemRecoveryAvailable &&
    missingLinkedItemCount > 0
  ) {
    return (
      <section className="space-y-3" data-testid="benchling-migration-validation-report">
        <button
          type="button"
          onClick={onViewMigrationDetails}
          className="rounded px-1 py-1 text-xs font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Back to migration history
        </button>
        <LinkedItemRecoveryPanel
          run={run}
          evidence={linkedItemRecoveryEvidence}
          pending={recoveryPending}
          onAddExports={onAddLinkedItemExports}
          onOpenLocation={onOpenLinkedItemRecoveryLocation}
        />
      </section>
    );
  }

  if (compactLocalSuccess) {
    const selectedObjectCount =
      nativeFolderZipInventory?.canonicalObjects.selectedTotal ?? report.sourceObjects.actual;
    const workspaceAppend = run.linkedItemRecovery?.mode === 'workspace_append';
    const completedWorkspaceAppend =
      workspaceAppend && run.linkedItemRecovery?.state === 'completed'
        ? run.linkedItemRecovery
        : null;
    const localPreservedWarnings = report.issues
      .filter(
        (issue) =>
          issue.code === 'local_export_warning' && /preserv.*(?:file|raw)/iu.test(issue.message)
      )
      .map((issue) => issue.message);
    const preservedFiles = nativeImport?.fileOutcomes?.preserved ?? [];
    const preservedWarnings =
      preservedFiles.length > 0
        ? preservedFiles.map((file) => `${file.fileName}: ${file.reason}`)
        : localPreservedWarnings;
    const failedFiles = [
      ...(nativeImport?.fileOutcomes?.failed ?? []),
      ...(nativeFolderZipInventory?.canonicalObjects.skipped ?? []).map((item) => ({
        fileName: '',
        reason: item.reason,
      })),
    ];
    const importedCount = nativeImport?.destinationChanges
      ? nativeImport.destinationChanges.added +
        nativeImport.destinationChanges.updated +
        nativeImport.destinationChanges.retained
      : completedWorkspaceAppend
        ? completedWorkspaceAppend.recoveredUniqueObjectCount +
          completedWorkspaceAppend.corroboratedExistingObjectCount +
          (completedWorkspaceAppend.versionConflictResolution?.kind === 'resolved'
            ? completedWorkspaceAppend.versionConflictResolution.conflictCount
            : completedWorkspaceAppend.retainedExistingObjectCount)
        : (nativeFolderZipInventory?.canonicalObjects.importedTotal ?? selectedObjectCount);
    const preservedCount = Math.max(
      preservedFiles.length,
      report.projections.fallback ?? 0,
      preservedWarnings.length
    );
    const hasExceptions = preservedWarnings.length > 0 || failedFiles.length > 0;
    if (!hasExceptions) {
      const checkedObjectCount = completedWorkspaceAppend
        ? completedWorkspaceAppend.recoveredUniqueObjectCount +
          completedWorkspaceAppend.corroboratedExistingObjectCount +
          (completedWorkspaceAppend.versionConflictResolution?.kind === 'resolved'
            ? completedWorkspaceAppend.versionConflictResolution.conflictCount
            : completedWorkspaceAppend.retainedExistingObjectCount)
        : 0;
      return (
        <section className="space-y-4" data-testid="benchling-migration-validation-report">
          <div
            className="rounded-xl border border-success/35 bg-success/[0.045] px-4 py-5 sm:px-5"
            data-testid="benchling-migration-import-complete"
          >
            <div className="flex items-start gap-3">
              <span
                className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-success/10 text-success"
                aria-hidden="true"
              >
                <CheckIcon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-fg">Import complete</h3>
                <p className="mt-1 text-xs text-fg-muted">
                  {completedWorkspaceAppend ? (
                    <>
                      {checkedObjectCount} {checkedObjectCount === 1 ? 'entity' : 'entities'} in
                      this export {checkedObjectCount === 1 ? 'was' : 'were'} checked.
                    </>
                  ) : workspaceAppend ? (
                    'Checking what this export changed…'
                  ) : (
                    <>
                      {selectedObjectCount} {selectedObjectCount === 1 ? 'entity' : 'entities'} in
                      this export {selectedObjectCount === 1 ? 'was' : 'were'} checked.
                    </>
                  )}
                </p>
                <ImportReceiptCard
                  run={run}
                  inventory={nativeFolderZipInventory}
                  nativeImport={report.version === 2 ? report.nativeImport : undefined}
                  compact
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {run.state === 'ready_to_unlock' ? (
                    <PrimaryButton
                      dataTestId="benchling-migration-unlock"
                      onClick={onOpenWorkspace ?? onUnlock}
                      disabled={!report.passed || !localExportVerified || recoveryBlocksUnlock}
                      pending={pending || openPending}
                      label="Open project"
                      pendingLabel="Opening"
                    />
                  ) : run.state === 'unlocked' ? (
                    onOpenWorkspace ? (
                      <PrimaryButton
                        dataTestId="benchling-migration-open-workspace"
                        onClick={onOpenWorkspace}
                        pending={openPending}
                        label="Open project"
                        pendingLabel="Opening"
                      />
                    ) : null
                  ) : (
                    <span className="rounded bg-bg-muted px-2 py-1 text-xs font-medium text-fg-muted">
                      Project remains locked
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <NativeImportDetails report={report} />
          <IncompleteDnaWarning report={report} />

          <NativeExceptions issues={report.issues} />
          <ValidationIssueList issues={visibleIssues} />
        </section>
      );
    }
    return (
      <section className="space-y-4" data-testid="benchling-migration-validation-report">
        <div
          className={`rounded-xl border px-4 py-5 sm:px-5 ${hasExceptions ? 'border-warning/35 bg-warning/[0.035]' : 'border-success/35 bg-success/[0.045]'}`}
          data-testid="benchling-migration-import-complete"
        >
          <div className="flex items-start gap-3">
            <span
              className={`flex h-8 w-8 flex-none items-center justify-center rounded-full ${hasExceptions ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}
              aria-hidden="true"
            >
              <CheckIcon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-fg">
                {hasExceptions ? 'Imported with warnings' : 'Import complete'}
              </h3>
              <p
                className="mt-1 text-xs text-fg-muted"
                data-testid="benchling-migration-import-summary"
              >
                {workspaceAppend && !completedWorkspaceAppend
                  ? 'Checking what this export changed…'
                  : `${importedCount} imported · ${preservedCount} kept as files · ${failedFiles.length} failed`}
              </p>
              {hasExceptions ? (
                <ul
                  className="mt-3 space-y-1 text-xs text-fg-muted"
                  data-testid="benchling-migration-import-warnings"
                >
                  {preservedWarnings.map((message, index) => (
                    <li key={`preserved-${index}`}>{message}</li>
                  ))}
                  {failedFiles.map((item, index) => (
                    <li key={`failed-${index}`}>
                      {item.fileName ? `${item.fileName}: ` : ''}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {run.state === 'ready_to_unlock' ? (
                  <PrimaryButton
                    dataTestId="benchling-migration-unlock"
                    onClick={onOpenWorkspace ?? onUnlock}
                    disabled={!report.passed || !localExportVerified || recoveryBlocksUnlock}
                    pending={pending || openPending}
                    label="Open project"
                    pendingLabel="Opening"
                  />
                ) : run.state === 'unlocked' ? (
                  onOpenWorkspace ? (
                    <PrimaryButton
                      dataTestId="benchling-migration-open-workspace"
                      onClick={onOpenWorkspace}
                      pending={openPending}
                      label="Open project"
                      pendingLabel="Opening"
                    />
                  ) : null
                ) : (
                  <span className="rounded bg-bg-muted px-2 py-1 text-xs font-medium text-fg-muted">
                    Project remains locked
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4" data-testid="benchling-migration-validation-report">
      <StatusCard
        tone={report.passed ? 'success' : 'error'}
        title={
          report.passed
            ? 'Your notebook came across complete'
            : 'Some of your notebook did not come across'
        }
      >
        {report.passed
          ? 'Every item in this export was checked.'
          : 'The items below are missing or incomplete. Nothing from your export was deleted.'}
      </StatusCard>
      {isLocalExportRun && !localExportVerified ? (
        <StatusCard tone="error" title="ZIP verification failed">
          The stored report does not match the ZIP selected for this import. The notebook stays
          read-only.
        </StatusCard>
      ) : null}
      <ImportReceiptCard
        run={run}
        inventory={nativeFolderZipInventory}
        nativeImport={report.version === 2 ? report.nativeImport : undefined}
      />
      <NativeImportDetails report={report} />
      <IncompleteDnaWarning report={report} />
      {usesLocalFolderExport && nativeFolderZipInventory ? (
        <MigrationTechnicalDetails summary="What was imported">
          <NativeFolderZipInventory
            scopeKind={run.scope.kind as 'folder' | 'folder_tree'}
            inventory={nativeFolderZipInventory}
          />
          {report.scope.kind === 'folder' && directFolderImportScope ? (
            <DirectFolderImportScope section={directFolderImportScope} />
          ) : null}
        </MigrationTechnicalDetails>
      ) : null}
      <CreatedObjectList objects={createdObjects} />
      <NativeExceptions issues={report.issues} />
      {visibleIssues.length > 0 ? (
        <ul className="space-y-1.5 rounded border border-border p-3 text-xs text-fg-muted">
          {visibleIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <span
                className={issue.blocking ? 'font-medium text-error' : 'font-medium text-warning'}
              >
                {issue.code}:
              </span>{' '}
              {toUserMessage(issue.message, 'operation.failed')}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[11px] text-fg-subtle">
          {run.state === 'unlocked'
            ? 'Your notebook is ready to open and edit.'
            : recoveryBlocksUnlock
              ? linkedItemRecoveryState === 'failed'
                ? 'Choose the linked-item exports again before opening the notebook.'
                : 'Wait for the linked-item ZIP files to finish before opening the notebook.'
              : 'Your notebook is read-only until you open it for editing.'}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {run.state === 'ready_to_unlock' ? (
            <PrimaryButton
              dataTestId="benchling-migration-unlock"
              onClick={onOpenWorkspace ?? onUnlock}
              disabled={!report.passed || !localExportVerified || recoveryBlocksUnlock}
              pending={pending || openPending}
              label="Open my notebook"
              pendingLabel="Opening"
            />
          ) : run.state === 'unlocked' ? (
            onOpenWorkspace ? (
              <PrimaryButton
                dataTestId="benchling-migration-open-workspace"
                onClick={onOpenWorkspace}
                disabled={
                  (nativeImport !== undefined || run.workspaceOrigin === 'adopted_existing') &&
                  (!report.passed || !localExportVerified || recoveryBlocksUnlock)
                }
                pending={openPending}
                label="Open project"
                pendingLabel="Opening"
              />
            ) : null
          ) : (
            <span className="rounded bg-bg-muted px-2 py-1 text-xs font-medium text-fg-muted">
              Workspace remains locked
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function LinkedItemRecoverySuccess({
  recoveredTargetCount,
  repairedRelationshipCount,
  remainingTargetCount,
  pending,
  onOpenWorkspace,
  onImportAnother,
}: {
  recoveredTargetCount: number;
  repairedRelationshipCount: number;
  remainingTargetCount: number;
  pending: boolean;
  onOpenWorkspace: AsyncAction;
  onImportAnother?: () => void;
}) {
  return (
    <section
      data-testid="benchling-migration-linked-item-success"
      className="flex min-h-[28rem] items-center justify-center px-4 py-10 text-center"
    >
      <div className="max-w-md">
        <span
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success"
          aria-hidden="true"
        >
          <CheckIcon size={26} />
        </span>
        <h2 className="mt-5 text-xl font-semibold text-fg">Linked items imported</h2>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          {recoveredTargetCount} linked item{recoveredTargetCount === 1 ? ' was' : 's were'}{' '}
          imported and {repairedRelationshipCount} link
          {repairedRelationshipCount === 1 ? ' was' : 's were'} repaired.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
          {remainingTargetCount > 0
            ? `${remainingTargetCount} linked item${remainingTargetCount === 1 ? ' is' : 's are'} still missing. You can import ${remainingTargetCount === 1 ? 'it' : 'them'} later.`
            : 'All missing linked items are now connected.'}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          {onImportAnother ? (
            <SecondaryButton
              label="Import another export"
              pending={pending}
              onClick={onImportAnother}
            />
          ) : null}
          <PrimaryButton
            dataTestId="benchling-migration-open-workspace-after-linked-items"
            onClick={onOpenWorkspace}
            pending={pending}
            label="Open project"
            pendingLabel="Opening"
          />
        </div>
      </div>
    </section>
  );
}

type LocalExportSection = NonNullable<
  Extract<BenchlingMigrationReportView, { version: 2 }>['localExport']
>;

type NativeFolderInventory = NonNullable<
  LocalExportSection['evidence']['nativeFolderZipInventory']
>;

function NativeFolderZipInventory({
  scopeKind,
  inventory,
}: {
  scopeKind: 'folder' | 'folder_tree';
  inventory: NativeFolderInventory;
}) {
  const objects = inventory.canonicalObjects;
  const representations = inventory.archiveRepresentations;
  const folders = inventory.folders;
  const root = inventory.rootBinding;
  const selectedAttachmentClasses = formatInventoryCounts(inventory.selectedAttachments.byClass, {
    png: 'PNG',
    jpg: 'JPG',
    pdf: 'PDF',
    ab1: 'AB1',
    gbk: 'GBK',
    seq: 'SEQ',
    other: 'other',
  });

  return (
    <div
      className="mt-4 space-y-3 border-t border-border pt-3"
      data-testid="benchling-migration-native-folder-zip-inventory"
    >
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
          Native ZIP inventory
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          These counts come from the verified archive itself. Entity identity and folder membership
          are reported separately so duplicate representations are not imported as duplicate
          entities.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <VerificationValue
          label="Archive entries"
          value={`${inventory.catalog.uniqueEntryCount} unique · ${inventory.catalog.physicalEntryCount} physical`}
        />
        <VerificationValue
          label="Canonical entities"
          value={`${objects.archiveTotal} in archive`}
        />
        <VerificationValue
          label="Imported"
          value={`${objects.importedTotal} entities · ${objects.importedMembershipTotal} memberships`}
        />
        <VerificationValue
          label="Excluded by scope"
          value={`${objects.excludedByScopeTotal} entities`}
        />
      </div>

      <dl className="grid gap-2 text-[11px] leading-relaxed text-fg-muted sm:grid-cols-2">
        <InventoryLine
          label="Archive entity types"
          value={formatInventoryCounts(objects.archiveByClass, {
            notebook: 'notebooks',
            dna_rna: 'DNA/RNA',
            protein: 'proteins',
          })}
        />
        <InventoryLine
          label="Imported entity types"
          value={formatInventoryCounts(objects.importedByClass, {
            notebook: 'notebooks',
            dna_rna: 'DNA/RNA',
            protein: 'proteins',
          })}
        />
        <InventoryLine
          label="Selected attachments"
          value={`${inventory.selectedAttachments.total}${selectedAttachmentClasses === 'None' ? '' : ` · ${selectedAttachmentClasses}`}`}
        />
        <InventoryLine
          label="Alternate representations"
          value={`${representations.alternateTotal} · ${formatInventoryCounts(
            representations.alternateByClass,
            {
              sequence_txt: 'sequence TXT',
              sequence_html: 'sequence HTML',
              protein_txt: 'protein TXT',
              protein_gp: 'protein GP',
              protein_html: 'protein HTML',
            }
          )}`}
        />
        <InventoryLine
          label="Support files"
          value={`${representations.supportTotal} retained · ${representations.collapsedIdenticalSupportDuplicateCount} identical duplicate stylesheets collapsed`}
        />
        <InventoryLine
          label="Folder representation"
          value={`${folders.inferredCount} inferred · ${folders.explicitDirectoryEntryCount} explicit directory entries`}
        />
      </dl>

      {folders.emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries ? (
        <p className="rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
          Empty folders cannot be preserved from this ZIP because Benchling emitted no directory
          entries; DNAForge inferred only folders that contain canonical entities.
        </p>
      ) : null}

      <p className="rounded border border-border bg-bg px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
        <strong className="text-fg">Folder in this export:</strong> “{root.archiveDisplayRoot}”.{' '}
        DNAForge used the folder layout saved in the ZIP.{' '}
        {scopeKind === 'folder'
          ? 'It imported items from this folder and linked items that were also in the ZIP. Child folders were not included.'
          : 'It imported this folder and the subfolders included in the ZIP.'}
      </p>

      {objects.skipped.length > 0 ? (
        <div className="rounded border border-warning/30 bg-warning/5 px-2.5 py-2">
          <div className="text-[11px] font-medium text-fg">
            Skipped canonical entities ({objects.skipped.length})
          </div>
          <ul className="mt-1 space-y-1 text-[11px] text-fg-muted">
            {summarizeSkippedReasons(objects.skipped).map(({ reason, count }) => (
              <li key={reason}>
                {count} {count === 1 ? 'entity' : 'entities'} —{' '}
                {toUserMessage(reason, 'operation.failed')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function summarizeSkippedReasons(
  skipped: NativeFolderInventory['canonicalObjects']['skipped']
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const object of skipped) {
    counts.set(object.reason, (counts.get(object.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function isProviderActivityIssue(message: string): boolean {
  return /(?:provider activity|network requests?|cache hits?|provider request)/iu.test(message);
}

function ValidationIssueList({ issues }: { issues: BenchlingMigrationReportView['issues'] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1.5 rounded border border-border p-3 text-xs text-fg-muted">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`}>
          <span className={issue.blocking ? 'font-medium text-error' : 'font-medium text-warning'}>
            {issue.code}:
          </span>{' '}
          {toUserMessage(issue.message, 'operation.failed')}
        </li>
      ))}
    </ul>
  );
}

function InventoryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-bg px-2.5 py-2">
      <dt className="text-[10px] text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 font-medium text-fg">{value}</dd>
    </div>
  );
}

function formatInventoryCounts(
  counts: Readonly<Record<string, number>>,
  labels: Readonly<Record<string, string>>
): string {
  const populated = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${labels[key] ?? key}`);
  return populated.length > 0 ? populated.join(' · ') : 'None';
}

function localExportEvidenceMatchesArtifact(
  artifact: NonNullable<BenchlingMigrationRunView['sourceArtifact']>,
  section: LocalExportSection | undefined
): boolean {
  const evidence = section?.evidence;
  return (
    artifact.kind === 'local_bundle' &&
    section?.passed === true &&
    evidence !== undefined &&
    evidence.networkRequests === 0 &&
    evidence.format === artifact.format &&
    evidence.logicalFilename === artifact.fileName &&
    evidence.sha256 === artifact.sha256 &&
    evidence.sizeBytes === artifact.sizeBytes
  );
}

function VerificationValue({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="rounded border border-border bg-bg p-2">
      <div className="text-[10px] text-fg-subtle">{label}</div>
      <div className="mt-1 font-medium text-fg" title={title}>
        {value}
      </div>
    </div>
  );
}

type DirectFolderImportScopeSection = NonNullable<
  Extract<BenchlingMigrationReportView, { version: 2 }>['directFolderImportScope']
>;

function DirectFolderImportScope({ section }: { section: DirectFolderImportScopeSection }) {
  const evidence = section.evidence;
  const verified = section.passed && evidence !== null;
  const selectedCount = evidence?.selectedSourceObjectIds.length ?? 0;
  const plannedLinkedCount = evidence?.approvedOneHopDependencySourceObjectIds.length ?? 0;
  const importedLinkedCount = evidence?.importedOneHopDependencySourceObjectIds.length ?? 0;

  return (
    <div data-testid="benchling-migration-direct-folder-import-scope">
      <StatusCard
        tone={verified ? 'success' : 'error'}
        title={
          verified
            ? 'All expected folder and linked items were imported'
            : 'The imported items did not match the expected folder'
        }
      >
        <p className="max-w-2xl">
          {verified
            ? 'DNAForge imported the items from this folder and the directly linked items that were also in the ZIP. It left out child folders and unrelated items.'
            : 'Some expected folder or linked items are missing, or the import includes items outside this folder. The notebook stays read-only.'}
        </p>
        {evidence ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            <VerificationValue label="Folder items" value={String(selectedCount)} />
            <VerificationValue label="Linked items in the ZIP" value={String(plannedLinkedCount)} />
            <VerificationValue label="Linked items imported" value={String(importedLinkedCount)} />
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-error">No Direct Folder scope evidence is stored.</p>
        )}
      </StatusCard>
    </div>
  );
}

function CreatedObjectList({
  objects,
}: {
  objects: readonly BenchlingMigrationCreatedObjectView[];
}) {
  if (objects.length === 0) return null;
  return (
    <MigrationTechnicalDetails summary={`Created in DNAForge (${objects.length})`}>
      <ul
        data-testid="benchling-migration-created-objects"
        className="max-h-72 divide-y divide-border overflow-y-auto rounded border border-border bg-bg"
      >
        {objects.map((object) => (
          <li key={object.id} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-fg">{object.name}</p>
              <p className="mt-0.5 truncate text-[10px] text-fg-subtle">{object.path}</p>
            </div>
            <span className="flex-none rounded bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
              {humanObjectType(object.type)}
            </span>
          </li>
        ))}
      </ul>
    </MigrationTechnicalDetails>
  );
}

function humanObjectType(type: BenchlingMigrationCreatedObjectView['type']): string {
  return type.replace(/_/gu, ' ');
}

export function TerminalFailureStep({
  run,
  pending,
  retryPending = false,
  onRetry,
  onDiscard,
}: {
  run: BenchlingMigrationRunView;
  pending: boolean;
  retryPending?: boolean;
  onRetry?: AsyncAction;
  onDiscard: AsyncAction;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  return (
    <div className="space-y-3">
      <StatusCard tone="error" title={`Migration ${run.state}`}>
        {toUserMessage(
          run.lastError,
          'failure.the-migration-stopped-because-an-internal-invariant-failed-preserved-s'
        )}
      </StatusCard>
      {onRetry ? (
        <div className="rounded border border-border bg-bg-muted/40 p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-muted">
              The verified ZIP and captured evidence are preserved. Retry without selecting the
              export again.
            </span>
            <PrimaryButton
              dataTestId="benchling-migration-retry-failed"
              label="Retry migration"
              pendingLabel="Retrying migration"
              pending={retryPending}
              onClick={onRetry}
            />
          </div>
        </div>
      ) : null}
      <div className="rounded border border-error/30 bg-error/5 p-3 text-xs">
        {confirmingDiscard ? (
          <div className="space-y-3">
            <p className="text-fg">
              This permanently removes the failed staging workspace and its preserved evidence. It
              cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <SecondaryButton
                onClick={() => setConfirmingDiscard(false)}
                pending={false}
                label="Keep preserved data"
              />
              <button
                type="button"
                data-testid="benchling-migration-confirm-failed-discard"
                disabled={pending || retryPending}
                onClick={() => void onDiscard()}
                className="rounded border border-error bg-error px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {pending ? 'Discarding…' : 'Permanently discard'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-muted">
              Review the failure, then keep or remove its preserved staging data.
            </span>
            <button
              type="button"
              data-testid="benchling-migration-discard-failed"
              disabled={retryPending}
              onClick={() => setConfirmingDiscard(true)}
              className="rounded px-2 py-1 font-medium text-error hover:bg-error/10 disabled:opacity-50"
            >
              Discard failed workspace…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportReceiptCard({
  run,
  inventory,
  nativeImport,
  compact = false,
}: {
  run: BenchlingMigrationRunView;
  inventory?: NativeFolderInventory;
  nativeImport?: import('../../shared/benchling-migration').NativeImportReceipt;
  compact?: boolean;
}) {
  const progress = run.linkedItemRecovery;
  const receiptClass = compact
    ? 'mt-3'
    : 'rounded-xl border border-border bg-bg-muted/40 px-4 py-4 sm:px-5';
  if (nativeImport?.destinationChanges && (!progress || progress.state === 'completed')) {
    const changes = nativeImport.destinationChanges;
    return (
      <div data-testid="benchling-migration-import-receipt" className={receiptClass}>
        {!compact ? (
          <h3 className="text-sm font-semibold text-fg">What this import changed</h3>
        ) : null}
        <dl className="mt-2 space-y-1 text-xs">
          <ReceiptRow
            testId="import-receipt-added"
            count={changes.added}
            label={run.state === 'unlocked' ? 'new entities added' : 'new entities prepared'}
          />
          <ReceiptRow
            testId="import-receipt-updated"
            count={changes.updated}
            label="existing entities updated"
          />
          <ReceiptRow
            testId="import-receipt-reused"
            count={changes.retained}
            label="existing entities kept unchanged"
          />
        </dl>
      </div>
    );
  }
  if (!progress || progress.state === 'failed') {
    if (!inventory) return null;
    const imported = inventory.canonicalObjects.importedTotal;
    const skipped = inventory.canonicalObjects.skipped.length;
    if (imported === 0 && skipped === 0) return null;
    return (
      <div data-testid="benchling-migration-import-receipt" className={receiptClass}>
        {!compact ? (
          <h3 className="text-sm font-semibold text-fg">What this import changed</h3>
        ) : null}
        <dl className="mt-2 space-y-1 text-xs">
          <ReceiptRow
            testId="import-receipt-imported"
            count={imported}
            label={imported === 1 ? 'entity imported' : 'entities imported'}
          />
          <ReceiptRow
            testId="import-receipt-skipped"
            count={skipped}
            label={skipped === 1 ? 'entity skipped' : 'entities skipped'}
          />
        </dl>
      </div>
    );
  }
  const workspaceAppend = progress.mode === 'workspace_append';
  if (progress.state !== 'completed') {
    return (
      <div
        data-testid="benchling-migration-import-receipt"
        className="rounded-xl border border-border bg-bg-muted/40 px-4 py-4 sm:px-5"
      >
        <h3 className="text-sm font-semibold text-fg">
          {workspaceAppend ? 'What this export changed' : 'What this import changed'}
        </h3>
        <div
          data-testid="benchling-migration-import-receipt-checking"
          className="mt-2 flex items-center gap-2 text-xs text-fg-muted"
        >
          <SpinnerIcon className="h-3.5 w-3.5" />
          Checking what changed…
        </div>
      </div>
    );
  }
  const added = progress.recoveredUniqueObjectCount;
  const reused = progress.corroboratedExistingObjectCount;
  const retained = progress.retainedExistingObjectCount;
  const conflictResolution =
    progress.versionConflictResolution?.kind === 'resolved'
      ? progress.versionConflictResolution
      : null;
  const differentVersions = conflictResolution?.conflictCount ?? retained;
  if (added === 0 && reused === 0 && differentVersions === 0) return null;
  return (
    <div data-testid="benchling-migration-import-receipt" className={receiptClass}>
      {!compact ? (
        <h3 className="text-sm font-semibold text-fg">
          {workspaceAppend ? 'What this export changed' : 'What this import changed'}
        </h3>
      ) : null}
      <dl className="mt-2 space-y-1 text-xs">
        <ReceiptRow
          testId="import-receipt-added"
          count={added}
          label={workspaceAppend ? 'new entities added' : 'added'}
        />
        <ReceiptRow
          testId="import-receipt-reused"
          count={reused}
          label="identical entities already here"
        />
        <ReceiptRow
          testId="import-receipt-retained"
          count={differentVersions}
          label={
            conflictResolution?.policy === 'use_incoming'
              ? 'different versions; incoming versions used'
              : 'different versions; existing versions kept'
          }
        />
      </dl>
      {retained > 0 && conflictResolution?.policy !== 'use_incoming' ? (
        <details className="mt-3" data-testid="benchling-migration-import-receipt-retained">
          <summary className="cursor-pointer text-xs font-medium text-fg-muted hover:text-fg">
            Which existing versions were kept
          </summary>
          <ul className="mt-2 space-y-1">
            {progress.retainedExistingObjects.map((entry) => (
              <li key={entry.stableId} className="text-xs text-fg">
                <span className="font-medium">{entry.name}</span>{' '}
                <span className="text-fg-subtle tabular-nums">{entry.stableId}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function NativeImportDetails({ report }: { report: BenchlingMigrationReportView }) {
  const receipt = report.version === 2 ? report.nativeImport : undefined;
  if (!receipt) return null;
  const linked = receipt.exactNativeMatches.filter(
    (entry) => entry.choice === 'link_existing'
  ).length;
  const separate = receipt.exactNativeMatches.filter(
    (entry) => entry.choice === 'import_separate'
  ).length;
  const renamed = receipt.structuralDecisions.filter(
    (entry) => entry.choice === 'rename_incoming'
  ).length;
  const replaced = receipt.structuralDecisions.filter(
    (entry) => entry.choice === 'replace_existing'
  ).length;
  return (
    <div
      data-testid="benchling-native-import-decisions"
      className="space-y-1 text-xs text-fg-muted"
    >
      {receipt.history === 'adopted_history_created' ? (
        <p>Migration history was added to this existing project.</p>
      ) : null}
      {receipt.providerVersions ? (
        <p>
          {receipt.providerVersions.affectedCount} different{' '}
          {receipt.providerVersions.affectedCount === 1 ? 'version' : 'versions'};{' '}
          {receipt.providerVersions.policy === 'use_incoming'
            ? 'incoming versions used'
            : 'existing versions kept'}
          .
        </p>
      ) : null}
      {linked ? (
        <p>
          {linked} existing {linked === 1 ? 'item linked' : 'items linked'} without changing their
          content.
        </p>
      ) : null}
      {separate ? (
        <p>
          {separate} exact {separate === 1 ? 'match imported' : 'matches imported'} as separate
          copies.
        </p>
      ) : null}
      {renamed ? (
        <p>
          {renamed} incoming {renamed === 1 ? 'path renamed' : 'paths renamed'} to avoid a
          file/folder conflict.
        </p>
      ) : null}
      {replaced ? (
        <p>
          {replaced} conflicting {replaced === 1 ? 'path replaced' : 'paths replaced'} with your
          approval.
        </p>
      ) : null}
      {receipt.externalSources.some((source) => source.state !== 'verified_at_import') ? (
        <p>Original ZIP verification failed.</p>
      ) : null}
    </div>
  );
}

function IncompleteDnaWarning({ report }: { report: BenchlingMigrationReportView }) {
  if (report.version !== 2) return null;
  const nativeRepresentations = report.projections.nativeRepresentations;
  if (!nativeRepresentations) return null;
  const { needsSequence } = nativeRepresentations;
  if (needsSequence === 0) return null;

  return (
    <div
      data-testid="benchling-migration-incomplete-dna"
      className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-xs text-fg-muted sm:px-5"
    >
      <span className="font-semibold text-fg tabular-nums">{needsSequence}</span>{' '}
      {needsSequence === 1
        ? 'DNA record was imported without sequence data.'
        : 'DNA records were imported without sequence data.'}
    </div>
  );
}

function ReceiptRow({ count, label, testId }: { count: number; label: string; testId: string }) {
  if (count === 0) return null;
  return (
    <div className="flex items-baseline gap-2" data-testid={testId}>
      <dt className="w-10 shrink-0 text-right font-semibold tabular-nums text-fg">{count}</dt>
      <dd className="text-fg-muted">{label}</dd>
    </div>
  );
}
