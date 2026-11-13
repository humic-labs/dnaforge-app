import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sequenceRestoreItemCatalog } from '../../../db/sequence-package-restore';
import {
  readSequencePackageEvidenceRun,
  type SequencePackageEvidenceRead,
} from '../../../db/sequence-package-history-io';
import { platform } from '../../../platform';
import type {
  SequenceRestoreApplyRequest,
  SequenceRestorePreviewResult,
  SequenceRestoreSelection,
} from '../../../shared/sequence-package-revision';
import type { SequencePackageRevision } from '../../../db/sequence-package';
import type { ResolvedAcceptedAssemblyRecord } from '../../assembly/public/accepted-record-reader';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';
import { SequenceAssemblyHistory } from './SequenceAssemblyHistory';
import {
  HistoricalAssemblyCompositionPanel,
  type HistoricalAssemblyCompositionController,
} from './HistoricalAssemblyCompositionPanel';
import { SequencePackageAttachmentsPanel } from './SequencePackageAttachmentsPanel';
import { computeSequenceDiff, type DiffResult } from '../diff/sequence-diff';

const KIND_LABELS: Record<SequencePackageRevision['kind'], string> = {
  adopted: 'Earlier saved sequence',
  'sequence-save': 'Sequence saved',
  'metadata-update': 'Metadata updated',
  'assembly-finalization': 'Assembly finalized',
  'evidence-update': 'Evidence updated',
  'member-update': 'Attachment updated',
  'sequencing-apply': 'Sequencing applied',
  restore: 'Restored',
};

async function computeHistoricalSequenceDiff(
  oldBases: string,
  newBases: string
): Promise<DiffResult | null> {
  if (oldBases === newBases) return computeSequenceDiff(oldBases, newBases);
  const commonLimit = Math.min(oldBases.length, newBases.length);
  let prefix = 0;
  while (prefix < commonLimit && oldBases[prefix] === newBases[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < commonLimit - prefix &&
    oldBases[oldBases.length - suffix - 1] === newBases[newBases.length - suffix - 1]
  )
    suffix += 1;
  const oldWindow = oldBases.slice(prefix, oldBases.length - suffix);
  const newWindow = newBases.slice(prefix, newBases.length - suffix);
  if (Math.max(oldWindow.length, newWindow.length) > 6_000) return null;
  const diff = await computeSequenceDiff(oldWindow, newWindow);
  return {
    ...diff,
    changes: diff.changes.map((change) => ({
      ...change,
      position: change.position + prefix,
      ...(change.oldPosition !== undefined ? { oldPosition: change.oldPosition + prefix } : {}),
    })),
    oldGapped: undefined,
    newGapped: undefined,
  };
}

export function SequencePackageHistoryPanel({
  history,
  restore,
  composition,
  assemblyRecord,
  onHoverPart,
}: {
  history: SequencePackageHistoryView;
  assemblyRecord?: ResolvedAcceptedAssemblyRecord | null;
  onHoverPart?: (index: number | null) => void;
  restore?: {
    workspaceRoot: string;
    isDirty: boolean;
    savePending(): Promise<boolean>;
    discardPending(): boolean;
    apply(request: SequenceRestoreApplyRequest): Promise<void>;
  };
  composition?: HistoricalAssemblyCompositionController;
}) {
  const revisions = history.index?.document.versionHistory.revisions ?? [];
  const evidenceRuns = history.index?.document.evidenceRuns ?? [];
  const attachmentOwner = useRef<string | null>(null);
  if (history.index)
    attachmentOwner.current = JSON.stringify([
      history.index.document.id,
      history.index.packageRoot,
    ]);
  const timeline = useMemo(
    () =>
      [
        ...revisions.map((revision) => ({
          kind: 'revision' as const,
          id: revision.id,
          at: revision.createdAt,
          revision,
        })),
        ...evidenceRuns.map((run) => ({
          kind: 'evidence' as const,
          id: run.id,
          at: run.createdAt,
          run,
        })),
        ...evidenceRuns.flatMap((run) =>
          (run.states ?? []).map((state) => ({
            kind: 'review' as const,
            id: state.id,
            at: state.createdAt,
            run,
          }))
        ),
      ].sort((left, right) => right.at.localeCompare(left.at)),
    [revisions, evidenceRuns]
  );
  const [requestedEvidenceRunId, setRequestedEvidenceRunId] = useState<string | null>(null);
  const [requestedEvidenceStateId, setRequestedEvidenceStateId] = useState<string | null>(null);
  const [evidenceRead, setEvidenceRead] = useState<SequencePackageEvidenceRead | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const evidenceSerial = useRef(0);
  const evidenceRunId = requestedEvidenceRunId ?? evidenceRuns[evidenceRuns.length - 1]?.id ?? null;
  useEffect(() => {
    const serial = ++evidenceSerial.current;
    setEvidenceRead(null);
    setEvidenceLoading(false);
    if (!history.index || !history.workspaceRoot || !evidenceRunId) return;
    setEvidenceLoading(true);
    void readSequencePackageEvidenceRun({
      index: history.index,
      runId: evidenceRunId,
      workspaceRoot: history.workspaceRoot,
      fs: history.readFs ?? platform().fs,
    })
      .then((value) => {
        if (serial === evidenceSerial.current) setEvidenceRead(value);
      })
      .catch(() => {
        if (serial === evidenceSerial.current) {
          const run = history.index?.document.evidenceRuns?.find(
            (candidate) => candidate.id === evidenceRunId
          );
          if (run)
            setEvidenceRead({ status: 'unavailable', run, reason: 'Evidence could not be read.' });
        }
      })
      .finally(() => {
        if (serial === evidenceSerial.current) setEvidenceLoading(false);
      });
    return () => {
      evidenceSerial.current += 1;
    };
  }, [evidenceRunId, history.index, history.workspaceRoot]);
  const selected = revisions.find((revision) => revision.id === history.selectedRevisionId);
  const [sequenceDiff, setSequenceDiff] = useState<DiffResult | null>(null);
  const [diffStatus, setDiffStatus] = useState<
    'none' | 'loading' | 'ready' | 'too-large' | 'unavailable'
  >('none');
  useEffect(() => {
    let active = true;
    setSequenceDiff(null);
    if (!selected?.parentId) {
      setDiffStatus('none');
      return () => {
        active = false;
      };
    }
    if (history.selectedParentStatus === 'loading') {
      setDiffStatus('loading');
      return () => {
        active = false;
      };
    }
    if (!history.selectedParentSequence || !history.selectedSequence) {
      setDiffStatus('unavailable');
      return () => {
        active = false;
      };
    }
    const oldBases = history.selectedParentSequence.sequence;
    const newBases = history.selectedSequence.sequence;
    setDiffStatus('loading');
    void computeHistoricalSequenceDiff(oldBases, newBases)
      .then((diff) => {
        if (!active) return;
        if (!diff) {
          setDiffStatus('too-large');
          return;
        }
        setSequenceDiff(diff);
        setDiffStatus('ready');
      })
      .catch(() => {
        if (active) setDiffStatus('unavailable');
      });
    return () => {
      active = false;
    };
  }, [
    selected?.id,
    selected?.parentId,
    history.selectedParentSequence,
    history.selectedParentStatus,
    history.selectedSequence,
  ]);
  const selectedEvidenceStateIndex =
    evidenceRead?.status === 'available' && requestedEvidenceStateId
      ? (evidenceRead.run.states?.findIndex((state) => state.id === requestedEvidenceStateId) ?? -1)
      : -1;
  const selectedEvidenceState =
    evidenceRead?.status === 'available'
      ? evidenceRead.states[
          selectedEvidenceStateIndex >= 0
            ? selectedEvidenceStateIndex
            : evidenceRead.states.length - 1
        ]
      : null;
  const items = useMemo(
    () => (history.index ? sequenceRestoreItemCatalog(history.index.document) : []),
    [history.index]
  );
  const [sourceChoices, setSourceChoices] = useState<Record<string, string>>({});
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SequenceRestorePreviewResult | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDirtyDecision, setShowDirtyDecision] = useState(false);
  const previewSerial = useRef(0);
  const previewContext = useRef({ index: history.index, dirty: restore?.isDirty });
  useEffect(() => {
    const previous = previewContext.current;
    const dirty = restore?.isDirty;
    previewContext.current = { index: history.index, dirty };
    if (previous.index === history.index && previous.dirty === dirty) return;

    previewSerial.current += 1;
    setPreview(null);
    setOperationId(null);
    setBusy(false);
    setShowDirtyDecision(false);
  }, [history.index, restore?.isDirty]);
  const selections = useMemo<SequenceRestoreSelection[]>(
    () =>
      Object.entries(sourceChoices)
        .filter(([, revisionId]) => revisionId.length > 0)
        .map(([itemId, revisionId]) => ({ itemId, revisionId })),
    [sourceChoices]
  );
  const chooseSource = (itemId: string, revisionId: string) => {
    previewSerial.current += 1;
    setSourceChoices((current) => ({ ...current, [itemId]: revisionId }));
    setOpenItemId(null);
    setPreview(null);
    setOperationId(null);
    setRestoreError(null);
    setBusy(false);
    setShowDirtyDecision(false);
  };
  const previewRestore = async () => {
    if (!restore || !history.index || selections.length === 0) return;
    const serial = ++previewSerial.current;
    setBusy(true);
    setRestoreError(null);
    try {
      const result = await platform().fs.previewSequenceRestore({
        workspaceRoot: restore.workspaceRoot,
        packageRoot: history.index.packageRoot,
        packageId: history.index.document.id,
        selections,
      });
      if (serial !== previewSerial.current) return;
      setPreview(result);
      setOperationId(globalThis.crypto.randomUUID());
    } catch (error) {
      if (serial === previewSerial.current) {
        setRestoreError(toUserMessage(error, 'tracks.loadFailed'));
      }
    } finally {
      if (serial === previewSerial.current) setBusy(false);
    }
  };
  const applyRestore = async () => {
    if (!restore || !history.index || !preview || !operationId) return;
    if (restore.isDirty) {
      setShowDirtyDecision(true);
      return;
    }
    setBusy(true);
    setRestoreError(null);
    try {
      await restore.apply({
        workspaceRoot: restore.workspaceRoot,
        packageRoot: history.index.packageRoot,
        packageId: history.index.document.id,
        selections,
        operationId,
        previewFingerprint: preview.previewFingerprint,
      });
      previewSerial.current += 1;
      setPreview(null);
      setOperationId(null);
      setSourceChoices({});
      history.selectRevision(null);
      history.refresh();
    } catch (error) {
      setRestoreError(toUserMessage(error, 'tracks.loadFailed'));
    } finally {
      setBusy(false);
    }
  };
  const resolveDirty = async (choice: 'save' | 'discard' | 'cancel') => {
    setShowDirtyDecision(false);
    if (choice === 'cancel' || !restore) return;
    if (choice === 'save') {
      setBusy(true);
      let saveError: string | null = null;
      const saved = await restore.savePending().catch((error: unknown) => {
        saveError = error instanceof Error ? error.message : String(error);
        return false;
      });
      setBusy(false);
      if (!saved) {
        setRestoreError(
          saveError != null
            ? toUserMessage(
                saveError,
                'failure.the-current-sequence-could-not-be-saved-restore-was-not-applied'
              )
            : userMessage('failure.the-current-sequence-could-not-be-saved-restore-was-not-applied')
        );
        return;
      }
    } else if (!restore.discardPending()) {
      setRestoreError(
        userMessage(
          'failure.finish-or-cancel-the-unfinished-metadata-edits-before-discarding-seque'
        )
      );
      return;
    }
    setPreview(null);
    setOperationId(null);
    history.refresh();
    setRestoreError(
      userMessage('failure.current-edits-were-resolved-preview-restore-again-against-the-new-curr')
    );
  };
  return (
    <div data-testid="sequence-package-history" className="flex h-full flex-col bg-bg text-sm">
      <div className="border-b border-border px-4 py-3 font-semibold text-fg">History</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.error && (
          <p role="alert" className="border-b border-border px-4 py-3 text-xs text-error">
            {toUserMessage(history.error, 'tracks.loadFailed')}
          </p>
        )}
        {history.index?.currentProductStatus === 'drifted' && (
          <p role="alert" className="border-b border-border px-4 py-3 text-xs text-fg-muted">
            The current sequence file differs from its recorded package version.
          </p>
        )}
        {history.index?.currentProductStatus === 'unavailable' && (
          <p role="alert" className="border-b border-border px-4 py-3 text-xs text-fg-muted">
            The current sequence file is unavailable.
          </p>
        )}
        {history.isLoading && <p className="px-4 py-2 text-xs text-fg-muted">Loading history…</p>}
        <div className="p-2 space-y-1">
          <button
            type="button"
            data-testid="history-current"
            disabled={busy}
            className={`w-full rounded-md border px-3 py-2 text-left ${
              history.selectedRevisionId === null
                ? 'border-accent bg-accent/10 text-fg'
                : 'border-transparent text-fg hover:bg-bg-elevated'
            }`}
            onClick={() => history.selectRevision(null)}
          >
            Current sequence
          </button>
          {timeline.map((event) =>
            event.kind === 'revision' ? (
              <button
                type="button"
                key={`revision:${event.id}`}
                data-testid={`history-revision-${event.id}`}
                disabled={busy}
                className={`w-full rounded-md border px-3 py-2 text-left ${
                  history.selectedRevisionId === event.id
                    ? 'border-accent bg-accent/10 text-fg'
                    : 'border-transparent text-fg hover:bg-bg-elevated'
                }`}
                onClick={() => {
                  setRequestedEvidenceRunId(null);
                  setRequestedEvidenceStateId(null);
                  history.selectRevision(event.id);
                }}
              >
                <span className="block font-medium">{KIND_LABELS[event.revision.kind]}</span>
                <span className="block text-xs text-fg-muted">
                  {new Date(event.at).toLocaleString()}
                </span>
              </button>
            ) : (
              <button
                type="button"
                key={`${event.kind}:${event.id}`}
                data-testid={`history-${event.kind}-${event.id}`}
                disabled={busy}
                className={`w-full rounded-md border px-3 py-2 text-left ${
                  requestedEvidenceRunId === event.run.id &&
                  (event.kind === 'evidence'
                    ? !requestedEvidenceStateId
                    : requestedEvidenceStateId === event.id)
                    ? 'border-accent bg-accent/10 text-fg'
                    : 'border-transparent text-fg hover:bg-bg-elevated'
                }`}
                onClick={() => {
                  history.selectRevision(null);
                  setRequestedEvidenceRunId(event.run.id);
                  setRequestedEvidenceStateId(event.kind === 'review' ? event.id : null);
                }}
              >
                <span className="block font-medium">
                  {event.kind === 'review' ? 'Sequencing review updated' : 'Sequencing evidence'}
                </span>
                <span className="block text-xs text-fg-muted">
                  {new Date(event.at).toLocaleString()} · {event.run.queries.length} read
                  {event.run.queries.length === 1 ? '' : 's'}
                </span>
              </button>
            )
          )}
          {history.index?.legacyCurrentHasNoSnapshot && (
            <p className="px-3 py-2 text-xs text-fg-muted">
              Earlier versions of this package have no archived sequence snapshot.
            </p>
          )}
        </div>
        {selected && (
          <div className="border-t border-border px-4 py-3" data-testid="history-selected-details">
            <div className="font-semibold text-fg">{selected.state.name}</div>
            <div className="mt-1 text-xs text-fg-muted">
              {selected.state.entity.schema.displayName}
              {history.selectedSequence
                ? ` · ${history.selectedSequence.length.toLocaleString()} bp`
                : ''}
            </div>
            {Object.keys(selected.state.entity.fields).length > 0 && (
              <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 text-xs">
                {selected.state.entity.schema.fields.map((field) => {
                  const value = selected.state.entity.fields[field.key];
                  if (value === undefined) return null;
                  return (
                    <div key={field.key} className="contents">
                      <dt className="text-fg-muted">{field.label}</dt>
                      <dd className="break-words text-fg">
                        {Array.isArray(value) ? value.join(', ') : String(value ?? '–')}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {selected.state.acceptedAssembly && (
              <p className="mt-3 text-xs text-fg-muted">
                A saved assembly is associated with this version.
              </p>
            )}
            {selected.parentId && (
              <div className="mt-3 text-xs text-fg-muted" data-testid="history-sequence-diff">
                {diffStatus === 'ready' && sequenceDiff
                  ? `DNA versus previous version: ${sequenceDiff.insertedBp} bp inserted, ${sequenceDiff.deletedBp} bp deleted, ${sequenceDiff.changes.filter((change) => change.type === 'mutation').reduce((sum, change) => sum + change.length, 0)} bp substituted.`
                  : diffStatus === 'loading'
                    ? 'Comparing DNA with previous version…'
                    : diffStatus === 'too-large'
                      ? 'DNA changes span too much sequence for this view to compare.'
                      : 'Previous DNA snapshot is unavailable for comparison.'}
                {diffStatus === 'ready' && sequenceDiff && sequenceDiff.changes.length > 0 && (
                  <div className="mt-2 space-y-1 text-fg">
                    {sequenceDiff.changes.slice(0, 20).map((change, index) => (
                      <div key={index} data-testid={`history-diff-change-${index}`}>
                        {change.type === 'insertion'
                          ? 'Insertion'
                          : change.type === 'deletion'
                            ? 'Deletion'
                            : 'Substitution'}{' '}
                        at {change.position + 1}: {compactDiffBases(change.oldBases)} →{' '}
                        {compactDiffBases(change.newBases)}
                      </div>
                    ))}
                    {sequenceDiff.changes.length > 20 && (
                      <div className="text-fg-muted">
                        {sequenceDiff.changes.length - 20} more changes
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {assemblyRecord && onHoverPart && (
              <div className="mt-3">
                <SequenceAssemblyHistory
                  entries={[assemblyRecord.accepted]}
                  productSequence={assemblyRecord.accepted.projectionInput.productSequence}
                  assemblyReopenStatus="missing"
                  currentEntry={assemblyRecord.recordIsCurrent}
                  onPartHoverChange={onHoverPart}
                />
              </div>
            )}
            <div className="mt-3 break-all text-[10px] text-fg-muted" title={selected.id}>
              {selected.id}
            </div>
          </div>
        )}
        {evidenceRuns.length > 0 && (
          <div className="border-t border-border px-4 py-3" data-testid="sequence-history-evidence">
            <div className="font-semibold text-fg">Sequencing evidence</div>
            <p className="mt-1 text-xs text-fg-muted">
              Select an evidence or review event above to inspect it.
            </p>
            {evidenceRunId && evidenceLoading && (
              <p className="mt-2 text-xs text-fg-muted">Loading evidence…</p>
            )}
            {evidenceRead?.status === 'unavailable' && (
              <p role="alert" className="mt-2 text-xs text-fg-muted">
                {evidenceRead.reason}
              </p>
            )}
            {evidenceRead?.status === 'available' && (
              <div className="mt-2 text-xs text-fg-muted" data-testid="sequence-evidence-details">
                <div>
                  Tested version:{' '}
                  {evidenceRead.run.reference.checkpointId ?? 'Unpublished reference'}
                </div>
                <div>Reads: {evidenceRead.run.queries.map((query) => query.label).join(', ')}</div>
                <div>Review states: {evidenceRead.states.length}</div>
                {selectedEvidenceState !== null && selectedEvidenceState !== undefined && (
                  <div className="mt-1 text-fg">{reviewSummary(selectedEvidenceState)}</div>
                )}
              </div>
            )}
          </div>
        )}
        {composition && history.index && (
          <HistoricalAssemblyCompositionPanel index={history.index} controller={composition} />
        )}
        <SequencePackageAttachmentsPanel
          key={attachmentOwner.current}
          history={history}
          isDirty={restore?.isDirty ?? true}
          onRefresh={history.refresh}
        />
        {restore && revisions.length > 0 && (
          <div className="border-t border-border px-4 py-3" data-testid="sequence-restore-controls">
            <div className="font-semibold text-fg">Restore items</div>
            <p className="mt-1 text-xs text-fg-muted">
              Choose the saved version of each item. Unselected items stay as they are.
            </p>
            {selected && (
              <button
                type="button"
                disabled={busy}
                className="mt-2 rounded border border-border px-2 py-1 text-xs hover:bg-bg-elevated"
                onClick={() => {
                  previewSerial.current += 1;
                  setSourceChoices(
                    Object.fromEntries(
                      items
                        .filter((item) => item.sourceRevisionIds.includes(selected.id))
                        .map((item) => [item.id, selected.id])
                    )
                  );
                  setPreview(null);
                  setOperationId(null);
                  setRestoreError(null);
                }}
              >
                Select all from this version
              </button>
            )}
            <div className="mt-3 space-y-2">
              {items.map((item) => {
                const choice = sourceChoices[item.id] ?? '';
                const revision = revisions.find((entry) => entry.id === choice);
                return (
                  <div
                    key={item.id}
                    className="relative flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate" title={item.label}>
                      {item.label}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Choose source for ${item.label}`}
                      aria-expanded={openItemId === item.id}
                      className="max-w-[11rem] truncate rounded border border-border bg-bg-muted px-2 py-1 text-left hover:bg-bg-elevated"
                      onClick={() => setOpenItemId(openItemId === item.id ? null : item.id)}
                    >
                      {revision
                        ? `${KIND_LABELS[revision.kind]} · ${new Date(revision.createdAt).toLocaleString()}`
                        : 'Keep current'}
                    </button>
                    {openItemId === item.id && (
                      <div
                        data-testid={`restore-source-options-${item.id}`}
                        className="absolute right-0 top-full z-20 mt-1 max-h-48 w-60 overflow-y-auto rounded border border-border bg-bg shadow-lg"
                      >
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left hover:bg-bg-elevated"
                          onClick={() => chooseSource(item.id, '')}
                        >
                          Keep current
                        </button>
                        {[...revisions]
                          .reverse()
                          .filter((entry) => item.sourceRevisionIds.includes(entry.id))
                          .map((entry) => (
                            <button
                              type="button"
                              key={entry.id}
                              className="block w-full px-2 py-1 text-left hover:bg-bg-elevated"
                              onClick={() => chooseSource(item.id, entry.id)}
                            >
                              {KIND_LABELS[entry.kind]} ·{' '}
                              {new Date(entry.createdAt).toLocaleString()}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {restoreError && (
              <p role="alert" className="mt-3 text-xs text-error">
                {toUserMessage(restoreError, 'tracks.loadFailed')}
              </p>
            )}
            {preview && (
              <div
                className="mt-3 rounded border border-border bg-bg-muted p-2 text-xs"
                data-testid="restore-preview"
              >
                <div>
                  {preview.changedItems.length} item{preview.changedItems.length === 1 ? '' : 's'}{' '}
                  will change. A new version will be created; earlier versions remain.
                </div>
                {preview.changedItems.length > 0 && (
                  <div className="mt-1 text-fg-muted">{preview.changedItems.join(', ')}</div>
                )}
                {preview.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-fg-muted">
                    {warning}
                  </p>
                ))}
                {preview.blockers.map((blocker) => (
                  <p key={blocker} role="alert" className="mt-2 text-error">
                    {blocker}
                  </p>
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy || selections.length === 0}
                className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                onClick={() => void previewRestore()}
              >
                {busy ? 'Working…' : 'Preview Restore'}
              </button>
              {preview && (
                <button
                  type="button"
                  disabled={busy || preview.blockers.length > 0}
                  className="rounded border border-accent bg-accent px-2 py-1 text-xs text-accent-fg disabled:opacity-50"
                  onClick={() => void applyRestore()}
                >
                  Restore as new version
                </button>
              )}
            </div>
            {showDirtyDecision && (
              <div
                role="dialog"
                aria-label="Unsaved sequence changes"
                className="mt-3 rounded border border-accent bg-bg p-3 text-xs shadow-lg"
              >
                <p>Save or discard the current sequence edits before Restore?</p>
                <p className="mt-1 text-fg-muted">
                  Either choice requires a fresh Restore preview.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1"
                    onClick={() => void resolveDirty('cancel')}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1"
                    onClick={() => void resolveDirty('save')}
                  >
                    Save changes
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1"
                    onClick={() => void resolveDirty('discard')}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function compactDiffBases(value: string | undefined): string {
  if (!value) return '–';
  return value.length <= 24
    ? value
    : `${value.slice(0, 12)}…${value.slice(-8)} (${value.length} bp)`;
}

function reviewSummary(value: unknown): string {
  if (!value || typeof value !== 'object' || !('tracks' in value) || !Array.isArray(value.tracks)) {
    return 'Review unavailable';
  }
  const tracks = value.tracks as Array<{
    label?: unknown;
    status?: unknown;
    userStatus?: unknown;
    mutations?: unknown[];
  }>;
  return tracks
    .map((track) => {
      const label = typeof track.label === 'string' ? track.label : 'Read';
      const status = typeof track.userStatus === 'string' ? track.userStatus : track.status;
      const count = Array.isArray(track.mutations) ? track.mutations.length : 0;
      return `${label}: ${String(status ?? 'unreviewed')} · ${count} difference${count === 1 ? '' : 's'}`;
    })
    .join('; ');
}
