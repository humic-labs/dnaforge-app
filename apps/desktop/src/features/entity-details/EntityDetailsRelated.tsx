import { toUserMessage } from '@waypoint/user-messages';
import {
  formatLimsRelationshipType,
  type LimsRegistryPreview,
  type LimsRegistrySummary,
  type LimsEntityHistoryEntry,
  type LimsPendingRef,
} from '../../shared/lims';
import type { ExternalProviderSourceRequest } from '../../shared/benchling-migration-raw-source';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import { sourceFieldIsUnconnected } from '../lims/public/unconnected-registry';
import {
  RegistryFailedTag,
  RegistryHistoryTimeline,
  RegistryLinkedRecordRow,
  RegistryClassificationReview,
  RegistryGenomeEvidence,
} from '../lims/public/details-presenters';
import { primerBindingToViewState } from '../sequence/public/primer-binding-viewstate';
import type { TabViewState } from '../canvas/public/types';

function focusFromLinkPayload(payload: Record<string, unknown>): TabViewState | undefined {
  const start = payload?.bindingStart;
  const end = payload?.bindingEnd;
  return typeof start === 'number' && typeof end === 'number'
    ? primerBindingToViewState(start, end)
    : undefined;
}

export interface EntityDetailsRelatedProps {
  host?: 'metadata' | 'registry';
  registryPreview: LimsRegistryPreview;
  registryHistory: LimsEntityHistoryEntry[] | null;
  registryHistoryLoading: boolean;
  registryHistoryError: boolean;
  registryActionBusy: boolean;
  registryActionDisabledReason?: string;
  registryActionNote: string | null;
  openRegistrySummary: (summary: LimsRegistrySummary, focus?: TabViewState) => void;
  handleRestoreEntity: (summary: LimsRegistrySummary) => void;
  handleRevertEntity: (summary: LimsRegistrySummary) => void;
  handleArchiveEntity: (summary: LimsRegistrySummary) => void;
  selectRegistrySummary: (summary: LimsRegistrySummary) => void;
  onViewOriginalSource: (dialog: { request: ExternalProviderSourceRequest; label: string }) => void;
  onClassificationApplied: () => Promise<void>;
  unconnectedRefs: readonly LimsPendingRef[];
  pendingActionBusy: boolean;
  onConfirmPendingRef: (ref: LimsPendingRef, targetEntityId: string) => void;
  onRejectPendingRef: (ref: LimsPendingRef, rejectedEntityId: string) => void;
  onDismissPendingRef: (ref: LimsPendingRef) => void;
}

export function EntityDetailsRelated({
  host = 'registry',
  registryPreview,
  registryHistory,
  registryHistoryLoading,
  registryHistoryError,
  registryActionBusy,
  registryActionDisabledReason,
  registryActionNote,
  openRegistrySummary,
  handleRestoreEntity,
  handleRevertEntity,
  handleArchiveEntity,
  selectRegistrySummary,
  onViewOriginalSource,
  onClassificationApplied,
  unconnectedRefs,
  pendingActionBusy,
  onConfirmPendingRef,
  onRejectPendingRef,
  onDismissPendingRef,
}: EntityDetailsRelatedProps) {
  const actionId = host === 'registry' ? 'lims-registry-preview' : 'entity-metadata';
  const importedSourceFields = sourceMetadataEntries(registryPreview.entity.fields.sourceMetadata);
  const originalSourceRecordId = benchlingSourceRecordId(
    registryPreview.entity.fields.sourceMetadata
  );
  const originalSourceRequest =
    registryPreview.originalSource ??
    (registryPreview.entity.workspaceId && originalSourceRecordId
      ? {
          workspaceId: registryPreview.entity.workspaceId,
          entityId: registryPreview.entity.id,
          sourceRecordId: originalSourceRecordId,
        }
      : null);
  const fileAuthoritativeTrackView = ['track-view', 'molecular-document'].includes(
    registryPreview.entity.kind
  );
  const packageAuthoritativeRecord =
    registryPreview.summary.representation.openTarget?.kind === 'managed_sequence' ||
    registryPreview.savedLifecycleAuthority === 'sequence_package';
  const registryRevertSupported =
    !packageAuthoritativeRecord || registryPreview.acceptedScientificOwner === true;
  const canRevert =
    registryRevertSupported &&
    registryPreview.summary.representation.openTarget?.kind !== 'notebook';
  const canMutateLifecycle =
    registryRevertSupported || registryPreview.savedLifecycleAuthority === 'sequence_package';
  const showActionBar =
    !fileAuthoritativeTrackView && (Boolean(originalSourceRequest) || canMutateLifecycle);
  return (
    <>
      {showActionBar ? (
        <div
          data-testid={`${actionId}-actions`}
          className="flex flex-wrap items-center gap-2 border-y border-border py-2"
        >
          <>
            {originalSourceRequest ? (
              <button
                type="button"
                data-testid="lims-registry-view-original-source"
                className="h-7 rounded border border-border px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle"
                onClick={() =>
                  onViewOriginalSource({
                    request: originalSourceRequest,
                    label: registryPreview.summary.name,
                  })
                }
              >
                View original source
              </button>
            ) : null}
            {canMutateLifecycle && registryPreview.summary.archived ? (
              <>
                <span className="rounded bg-warning/15 px-2 py-0.5 text-[11px] font-semibold uppercase text-warning">
                  Archived
                </span>
                <button
                  type="button"
                  data-testid={`${actionId}-restore`}
                  disabled={registryActionBusy}
                  title={
                    registryActionBusy
                      ? toUserMessage(registryActionDisabledReason, 'operation.failed')
                      : undefined
                  }
                  className="h-7 rounded border border-border px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle disabled:opacity-50"
                  onClick={() => void handleRestoreEntity(registryPreview.summary)}
                >
                  Restore
                </button>
              </>
            ) : canMutateLifecycle ? (
              <>
                {canRevert ? (
                  <button
                    type="button"
                    data-testid={`${actionId}-undo`}
                    disabled={registryActionBusy}
                    title={
                      registryActionBusy
                        ? toUserMessage(registryActionDisabledReason, 'operation.failed')
                        : undefined
                    }
                    className="h-7 rounded border border-border px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle disabled:opacity-50"
                    onClick={() => void handleRevertEntity(registryPreview.summary)}
                  >
                    Undo last change
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid={`${actionId}-archive`}
                  disabled={registryActionBusy}
                  title={
                    registryActionBusy
                      ? toUserMessage(registryActionDisabledReason, 'operation.failed')
                      : undefined
                  }
                  className="h-7 rounded border border-border px-2.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
                  onClick={() => void handleArchiveEntity(registryPreview.summary)}
                >
                  Archive
                </button>
              </>
            ) : null}
          </>
        </div>
      ) : null}
      {registryActionNote && (
        <div
          data-testid={
            host === 'registry' ? 'lims-registry-action-note' : 'entity-metadata-action-note'
          }
          className="rounded border border-border bg-bg-subtle px-3 py-2 text-xs text-fg-muted"
        >
          {registryActionNote}
        </div>
      )}
      {onClassificationApplied &&
        registryPreview.classificationEligible !== false &&
        !registryPreview.summary.archived &&
        ['dna_sequence', 'rna_sequence', 'oligo', 'rna_oligo'].includes(
          registryPreview.entity.kind
        ) && (
          <RegistryClassificationReview
            key={`classification-${registryPreview.entity.id}`}
            entityId={registryPreview.entity.id}
            eligible={['dna_sequence', 'rna_sequence'].includes(registryPreview.entity.kind)}
            disabled={registryActionBusy}
            onApplied={onClassificationApplied}
          />
        )}
      {importedSourceFields.length > 0 ? (
        <details
          data-testid="lims-registry-imported-source-fields"
          className="group rounded border border-border bg-bg-subtle"
          {...(importedSourceFields.some((entry) =>
            sourceFieldIsUnconnected(entry.value, unconnectedRefs)
          )
            ? { open: true }
            : {})}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-fg marker:content-none">
            <span>Imported source details ({importedSourceFields.length})</span>
            <span className="text-[11px] text-fg-subtle group-open:hidden">Show</span>
            <span className="hidden text-[11px] text-fg-subtle group-open:inline">Hide</span>
          </summary>
          <dl className="divide-y divide-border border-t border-border px-3">
            {importedSourceFields.map((entry, index) => (
              <div
                key={`${entry.position}-${index}`}
                className="grid grid-cols-[minmax(6rem,0.75fr)_minmax(0,1.25fr)] gap-3 py-2 text-xs"
              >
                <dt className="break-words font-medium text-fg-muted">
                  <span className="inline-flex items-center gap-1.5">
                    {entry.label}
                    {sourceFieldIsUnconnected(entry.value, unconnectedRefs) ? (
                      <RegistryFailedTag
                        testId={`lims-registry-source-field-failed-${entry.position}`}
                      />
                    ) : null}
                  </span>
                </dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-fg">
                  {entry.value.length > 0 ? entry.value : <span>-</span>}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <RegistryGenomeEvidence preview={registryPreview} />
      {registryPreview.incomingLinks.length +
        registryPreview.outgoingLinks.length +
        unconnectedRefs.length >
      0 ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase text-fg-subtle">Links</div>
          <div className="space-y-1">
            {[...registryPreview.incomingLinks, ...registryPreview.outgoingLinks].map((entry) => (
              <RegistryLinkedRecordRow
                key={`${entry.link.id}-${entry.entity.id}`}
                entry={entry}
                onPreview={() => void selectRegistrySummary(entry.summary)}
                onOpen={() =>
                  void openRegistrySummary(entry.summary, focusFromLinkPayload(entry.link.payload))
                }
              />
            ))}
            {unconnectedRefs.map((ref) => (
              <div
                key={ref.key}
                data-testid="lims-registry-unconnected-link"
                className="rounded border border-error/30 bg-error/5 px-2 py-1.5"
              >
                <div className="flex items-center gap-2 text-xs text-fg">
                  <RegistryFailedTag testId={`lims-registry-unconnected-failed-${ref.key}`} />
                  <span className="min-w-0">
                    {formatLimsRelationshipType(ref.type)} “{ref.targetName}”
                  </span>
                </div>
                {ref.candidates.length === 0 ? (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-fg-muted">
                      Not in the registry yet — it will connect if it arrives.
                    </span>
                    <button
                      type="button"
                      disabled={pendingActionBusy}
                      data-testid="pending-ref-dismiss"
                      className="rounded px-2 py-0.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                      onClick={() => onDismissPendingRef?.(ref)}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 flex flex-col gap-1">
                    {ref.candidates.map((candidate) => (
                      <div key={candidate.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-fg">
                          {candidate.name}{' '}
                          <span className="text-fg-subtle">· {candidate.kind}</span>
                        </span>
                        <span className="flex flex-shrink-0 gap-1">
                          <button
                            type="button"
                            disabled={pendingActionBusy}
                            data-testid="pending-ref-confirm"
                            className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                            onClick={() => onConfirmPendingRef?.(ref, candidate.id)}
                          >
                            Connect
                          </button>
                          <button
                            type="button"
                            disabled={pendingActionBusy}
                            data-testid="pending-ref-reject"
                            className="rounded px-2 py-0.5 text-xs text-fg-muted hover:text-error disabled:opacity-50"
                            onClick={() => onRejectPendingRef?.(ref, candidate.id)}
                          >
                            Not this
                          </button>
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={pendingActionBusy}
                        data-testid="pending-ref-dismiss"
                        className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
                        onClick={() => onDismissPendingRef?.(ref)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <RegistryHistoryTimeline
        entries={registryHistory}
        schema={registryPreview.schemaSnapshot}
        loading={registryHistoryLoading}
        error={registryHistoryError}
      />
    </>
  );
}

function benchlingSourceRecordId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const origin = (value as Record<string, unknown>).origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const record = origin as Record<string, unknown>;
  if (record.connectorType !== 'benchling' || typeof record.sourceId !== 'string') return null;
  return isExactProviderStableId(record.sourceId) ? record.sourceId : null;
}

type ImportedSourceField = Readonly<{ label: string; value: string; position: number }>;

function sourceMetadataEntries(value: unknown): ImportedSourceField[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  return value.entries.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.label === 'string' &&
    typeof entry.value === 'string' &&
    Number.isSafeInteger(entry.position) &&
    (entry.position as number) >= 0
      ? [
          {
            label: entry.label,
            value: entry.value,
            position: entry.position as number,
          },
        ]
      : []
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
