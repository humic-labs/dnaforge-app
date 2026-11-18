import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  InventoryRunValueAttributionEntry,
  InventoryRunValuePhysicalSelection,
  InventoryPlatePlanObservation,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import {
  inventoryRunValueAttributionReadSchema,
  inventoryRunValueCandidatesReadSchema,
  type InventoryRunValueCandidatesRead,
} from '../../shared/inventory-run-value-attributions';
import {
  inventoryPlatePlanObservationsReadSchema,
  inventoryPlatePlanObservationReadSchema,
} from '../../shared/inventory-plate-plan-observations';
import { InventoryRunValueAttributionReadSession } from './inventory-run-value-attribution-read-session';
import {
  InventoryRunValueAttributionSession,
  type RunValueAttributionAction,
} from './inventory-run-value-attribution-session';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
export type RunValueAssociationResource = {
  projectId: string;
  workspaceScope: string;
  entityId: string;
  fileObjectUuid: string;
};
type Selection = { key: string; action: RunValueAttributionAction; resume?: InventoryAttempt };
type Candidates = Extract<InventoryRunValueCandidatesRead, { kind: 'ready' }>;
function valueLabel(row: Record<string, unknown>) {
  const value = row.value as Record<string, unknown> | undefined;
  if (!value) return 'Unavailable value';
  switch (value.type) {
    case 'boolean':
      return value.value === false ? 'No' : value.value === true ? 'Yes' : 'Unsupported boolean';
    case 'text':
      return value.value === '' ? 'Recorded empty text' : String(value.value);
    case 'number':
    case 'date':
      return String(value.value);
    default:
      return `Unsupported ${String(value.type)} value`;
  }
}
function physicalLabel(
  observation: InventoryPlatePlanObservation,
  physical: InventoryRunValuePhysicalSelection
) {
  const subject = physical.subject;
  if (subject.kind === 'source-stock') {
    const stock = observation.effects.sources.find((row) => row.before.id === subject.stockId);
    return stock
      ? `${stock.vessel.name} · ${inventoryAmountLabel(stock.before.quantity)} → ${inventoryAmountLabel(stock.after.quantity)}`
      : 'Recorded source stock';
  }
  const output = observation.effects.destinations.find(
    (row) => row.actionId === subject.actionId && row.after.id === subject.stockId
  );
  return output
    ? `${output.vessel.name} · ${inventoryAmountLabel(output.after.quantity)}`
    : 'Recorded output aliquot';
}
export function InventoryRunValueAttributions({
  scope,
  resource,
  canCreate = false,
}: {
  scope: PlatePlanScope;
  resource?: RunValueAssociationResource;
  canCreate?: boolean;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    key = JSON.stringify([scope, resource?.entityId, resource?.fileObjectUuid]);
  const reader = useMemo(
    () =>
      new InventoryRunValueAttributionReadSession(
        scope,
        resource?.entityId,
        client,
        platform().protocols,
        openProjectResourceReference
      ),
    [client, key]
  );
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot),
    pendingState = useSyncExternalStore(pending.subscribe, pending.getSnapshot),
    [selection, setSelection] = useState<Selection | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelection(null);
    void reader.open();
    pending.refresh();
    const focus = () => reader.invalidateCurrent();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      reader.dispose();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [reader, pending]);
  const { list, detail } = snapshot,
    pendingAttempt = pendingState.attempts.find(
      (row) =>
        row.request.project === scope.project &&
        row.request.inventoryId === scope.inventoryId &&
        'kind' in row.request &&
        ['record-run-value-attribution', 'withdraw-run-value-attribution'].includes(
          row.request.kind
        )
    );
  function choose(action: RunValueAttributionAction) {
    setSelection({ key: crypto.randomUUID(), action });
  }
  async function resume() {
    if (!pendingAttempt || !('kind' in pendingAttempt.request)) return;
    try {
      const request = pendingAttempt.request;
      if (request.kind === 'withdraw-run-value-attribution') {
        const detail = inventoryRunValueAttributionReadSchema.parse(
          await client.runValueAttribution({
            ...scope,
            attributionId: request.choices.attributionId,
            intentSha256: request.choices.attributionIntentSha256,
          })
        );
        if (detail.kind !== 'available') throw Error(detail.message);
        setSelection({
          key: request.operationId,
          action: {
            kind: 'withdraw',
            entry: { attribution: detail.attribution, withdrawal: detail.withdrawal },
          },
          resume: pendingAttempt,
        });
      } else if (request.kind === 'record-run-value-attribution') {
        if (resource && request.choices.runValue.entityId !== resource.entityId)
          throw Error(
            'Use Inventory Saved value associations to confirm the original change for its Run.'
          );
        const predecessor = request.choices.predecessor;
        if (predecessor) {
          const detail = inventoryRunValueAttributionReadSchema.parse(
            await client.runValueAttribution({
              ...scope,
              attributionId: predecessor.attributionId,
              intentSha256: predecessor.attributionIntentSha256,
            })
          );
          if (detail.kind !== 'available') throw Error(detail.message);
          setSelection({
            key: request.operationId,
            action: {
              kind: 'correct',
              entry: { attribution: detail.attribution, withdrawal: detail.withdrawal },
            },
            resume: pendingAttempt,
          });
        } else
          setSelection({
            key: request.operationId,
            action: { kind: 'add', runId: request.choices.runValue.entityId },
            resume: pendingAttempt,
          });
      }
    } catch (cause) {
      setError(message(cause));
    }
  }
  const entry =
    detail.kind === 'available'
      ? { attribution: detail.attribution, withdrawal: detail.withdrawal }
      : null;
  const localEntry =
    entry &&
    resource &&
    entry.attribution.source.projectId === scope.project &&
    entry.attribution.source.workspaceScope === scope.project &&
    entry.attribution.runValue.entityId === resource.entityId &&
    entry.attribution.source.fileObjectUuid === resource.fileObjectUuid;
  return (
    <section
      className="space-y-3 rounded border border-border p-4"
      data-testid="run-value-associations"
      data-run-id={resource?.entityId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {resource ? 'Saved values and recorded subjects' : 'Saved value associations'}
        </h3>
        <Button onClick={() => void reader.refresh()}>Refresh associations</Button>
        {resource ? (
          <Button
            disabled={!canCreate}
            onClick={() => choose({ kind: 'add', runId: resource.entityId })}
          >
            Associate saved value
          </Button>
        ) : null}
      </div>
      <p>An association says that a saved Run value describes a recorded physical subject.</p>
      {resource && !canCreate ? (
        <p>Save or confirm existing Run changes before creating or correcting an association.</p>
      ) : null}
      {pendingAttempt ? (
        <Notice>
          A saved association change needs confirmation.{' '}
          <Button onClick={() => void resume()}>Resume saved association change</Button>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.kind === 'loading' ? (
        <p role="status">Loading saved value associations…</p>
      ) : list.kind === 'unavailable' ? (
        <Notice tone="error">{list.message}</Notice>
      ) : list.kind === 'inventory-absent' ? (
        <p>This project has no inventory yet.</p>
      ) : (
        <>
          {!list.entries.length ? <p>No saved value associations.</p> : null}
          {list.entries.map((row) => (
            <article
              className="space-y-2 rounded border border-border p-3"
              key={row.attribution.id}
              data-attribution-id={row.attribution.id}
              data-attribution-status={row.withdrawal ? 'withdrawn' : 'active'}
            >
              <h4 className="font-semibold">
                {row.attribution.source.title} · {row.attribution.slotLabel}
              </h4>
              <p>
                Association: {row.withdrawal ? 'Withdrawn' : 'Active'} ·{' '}
                {row.attribution.runValue.collection}
              </p>
              <p>{row.attribution.reason}</p>
              {row.withdrawal ? <p>Withdrawal: {row.withdrawal.reason}</p> : null}
              <Button
                onClick={() =>
                  void reader.detail({
                    attributionId: row.attribution.id,
                    intentSha256: row.attribution.intentSha256,
                  })
                }
              >
                View association
              </Button>
            </article>
          ))}
          <div className="flex gap-2">
            <Button disabled={!snapshot.cursor} onClick={() => void reader.refresh()}>
              First associations page
            </Button>
            <Button disabled={!list.nextCursor} onClick={() => void reader.next()}>
              Next associations page
            </Button>
          </div>
        </>
      )}
      {detail.kind === 'loading' ? (
        <p role="status">Loading exact association…</p>
      ) : detail.kind === 'unavailable' ? (
        <Notice tone="error">{detail.message}</Notice>
      ) : detail.kind === 'available' ? (
        <section
          className="space-y-3 border-t border-border pt-3"
          data-testid="run-value-association-detail"
          data-attribution-id={detail.attribution.id}
          data-attribution-status={detail.withdrawal ? 'withdrawn' : 'active'}
        >
          <h4 className="font-semibold">
            Original saved value: {detail.attribution.valueSnapshot.label}
          </h4>
          <p className="whitespace-pre-wrap" data-testid="attribution-original-value">
            {valueLabel(detail.attribution.valueSnapshot)}
          </p>
          <p>Recorded subject: {physicalLabel(detail.observation, detail.attribution.physical)}</p>
          <p>Association: {detail.withdrawal ? 'Withdrawn' : 'Active'}</p>
          <p>{detail.attribution.reason}</p>
          <p>
            {inventoryPrincipalLabel(detail.attribution.by)} ·{' '}
            {new Date(detail.attribution.at).toISOString()}
          </p>
          {detail.withdrawal ? <p>Withdrawal: {detail.withdrawal.reason}</p> : null}
          <p>
            This value describes the recorded subject; it does not establish consumption or
            production by this Run.
          </p>
          <section
            data-testid="attribution-current-comparison"
            data-current-comparison={
              snapshot.comparisonLoading ? 'loading' : detail.currentComparison.kind
            }
          >
            <h5 className="font-semibold">Current saved value</h5>
            {snapshot.comparisonLoading ? (
              <p role="status">Checking current saved content…</p>
            ) : (
              <>
                <p>{comparisonLabel(detail.currentComparison.kind)}</p>
                {'row' in detail.currentComparison ? (
                  <p className="whitespace-pre-wrap" data-testid="attribution-current-value">
                    {valueLabel(detail.currentComparison.row.row)}
                  </p>
                ) : null}
                {detail.currentComparison.kind === 'unavailable' ? (
                  <Notice tone="warning">{detail.currentComparison.message}</Notice>
                ) : null}
                <p className="text-xs">Compared at {new Date(detail.asOf).toISOString()}</p>
              </>
            )}
            <Button
              onClick={() =>
                void reader.detail(
                  {
                    attributionId: detail.attribution.id,
                    intentSha256: detail.attribution.intentSha256,
                  },
                  true
                )
              }
            >
              Compare current saved value
            </Button>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void reader.original()}>View original saved value</Button>
            <Button disabled={!localEntry} onClick={() => void reader.openCurrent()}>
              Open current Run
            </Button>
            {detail.withdrawal ? (
              <Button
                disabled={!localEntry || !canCreate}
                onClick={() => choose({ kind: 'correct', entry: entry! })}
              >
                Associate again or correct
              </Button>
            ) : (
              <Button onClick={() => choose({ kind: 'withdraw', entry: entry! })}>
                Withdraw association
              </Button>
            )}
          </div>
          <details>
            <summary>Original identities, raw value and correction pins</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(
                {
                  attribution: detail.attribution,
                  withdrawal: detail.withdrawal,
                  physicalObservation: detail.observation,
                },
                null,
                2
              )}
            </pre>
          </details>
          {snapshot.source.kind === 'loading' ? (
            <p role="status">Loading original retained Run…</p>
          ) : snapshot.source.kind === 'unavailable' ? (
            <Notice tone="error">{snapshot.source.message}</Notice>
          ) : snapshot.source.kind === 'available' ? (
            <section data-testid="attribution-retained-source">
              <h5 className="font-semibold">Original saved Run: {snapshot.source.source.title}</h5>
              <TextArea
                readOnly
                aria-label="Original attributed Run source"
                rows={9}
                value={snapshot.source.source.originalText}
              />
            </section>
          ) : null}
        </section>
      ) : null}
      {snapshot.navigationError ? <Notice tone="error">{snapshot.navigationError}</Notice> : null}
      {selection ? (
        <RunValueAttributionForm
          key={selection.key}
          scope={scope}
          selection={selection}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </section>
  );
}
function comparisonLabel(kind: string) {
  return (
    (
      {
        'same-source': 'Exact saved source matches',
        'changed-source-same-row': 'Run source changed; selected saved row matches',
        'changed-row': 'Saved row changed',
        'missing-row': 'Saved row is missing',
        'replaced-binding': 'Current Run file binding differs',
        unavailable: 'Current saved content is unavailable',
      } as Record<string, string>
    )[kind] ?? kind
  );
}
function RunValueAttributionForm({
  scope,
  selection,
  onClose,
}: {
  scope: PlatePlanScope;
  selection: Selection;
  onClose(): void;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    overlay = usePresentationOverlay('modal'),
    action = selection.action,
    session = useMemo(
      () =>
        new InventoryRunValueAttributionSession(scope, action, client, pending, {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
        }),
      [client, pending, scope.project, scope.inventoryId, selection.key]
    ),
    snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { draft, phase } = snapshot;
  const runId = action.kind === 'add' ? action.runId : action.entry.attribution.runValue.entityId;
  const [candidates, setCandidates] = useState<InventoryRunValueCandidatesRead | null>(null),
    [candidateLoading, setCandidateLoading] = useState(false),
    [candidateCursor, setCandidateCursor] = useState<Candidates['nextCursor']>(null),
    [candidateReload, setCandidateReload] = useState(0),
    [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState<string | null>(null);
  const [observations, setObservations] = useState<Extract<
      Awaited<ReturnType<typeof client.platePlanObservations>>,
      { kind: 'ready' }
    > | null>(null),
    [observationCursor, setObservationCursor] =
      useState<NonNullable<typeof observations>['nextCursor']>(null),
    [observationId, setObservationId] = useState(draft.physical?.observationId ?? ''),
    [observation, setObservation] = useState<InventoryPlatePlanObservation | null>(null),
    [loadingPhysical, setLoadingPhysical] = useState(false);
  useEffect(() => {
    session.activate();
    if (selection.resume) session.resume(selection.resume);
    const inventory = client.onChanged((event) => {
      if (event.projectId === scope.project && event.inventoryId === scope.inventoryId)
        session.invalidate();
    });
    const protocol = platform().protocols.onChanged((event) => {
      if (event.projectId === scope.project && event.entityId === runId) {
        session.invalidate();
        setCandidateCursor(null);
        setCandidateReload((value) => value + 1);
      }
    });
    const focus = () => session.invalidate();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      session.detach();
      inventory();
      protocol();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [session, client, scope.project, scope.inventoryId, runId]);
  useEffect(() => {
    if (action.kind === 'withdraw') return;
    let cancelled = false;
    setCandidateLoading(true);
    setError(null);
    void client
      .runValueCandidates({
        ...scope,
        runId,
        limit: 20,
        ...(candidateCursor ? { cursor: candidateCursor } : {}),
      })
      .then((raw) => {
        if (cancelled) return;
        const result = inventoryRunValueCandidatesReadSchema.parse(raw);
        if (
          result.kind !== 'unavailable' &&
          (result.projectId !== scope.project ||
            result.inventoryId !== scope.inventoryId ||
            (result.kind === 'ready' &&
              (result.run.entityId !== runId ||
                result.run.projectId !== scope.project ||
                result.run.workspaceScope !== scope.project)))
        )
          throw Error('Saved values belong to another Run.');
        setCandidates(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setCandidateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    scope.project,
    scope.inventoryId,
    runId,
    JSON.stringify(candidateCursor),
    candidateReload,
    action.kind,
  ]);
  useEffect(() => {
    if (action.kind === 'withdraw') return;
    let cancelled = false;
    void client
      .platePlanObservations({
        ...scope,
        limit: 20,
        ...(observationCursor ? { cursor: observationCursor } : {}),
      })
      .then((raw) => {
        if (cancelled) return;
        const result = inventoryPlatePlanObservationsReadSchema.parse(raw);
        if (result.kind !== 'ready')
          throw Error(
            result.kind === 'unavailable'
              ? result.message
              : 'There are no recorded plate-plan uses in this inventory.'
          );
        if (
          result.projectId !== scope.project ||
          result.inventoryId !== scope.inventoryId ||
          result.filters.version !== null ||
          result.filters.context !== null
        )
          throw Error('Recorded physical uses belong to another inventory.');
        setObservations(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, scope.project, scope.inventoryId, JSON.stringify(observationCursor), action.kind]);
  useEffect(() => {
    if (action.kind === 'withdraw' || !observationId || !observations) return;
    const summary = observations.observations.find((item) => item.id === observationId);
    if (!summary) return;
    let cancelled = false;
    setLoadingPhysical(true);
    setObservation(null);
    void client
      .platePlanObservation({
        ...scope,
        observationId: summary.id,
        intentSha256: summary.intentSha256,
      })
      .then((raw) => {
        if (cancelled) return;
        const result = inventoryPlatePlanObservationReadSchema.parse(raw);
        if (
          result.kind !== 'available' ||
          result.projectId !== scope.project ||
          result.inventoryId !== scope.inventoryId ||
          result.observation.id !== summary.id ||
          result.observation.intentSha256 !== summary.intentSha256
        )
          throw Error('The recorded physical subject could not be verified.');
        setObservation(result.observation);
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingPhysical(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, scope.project, scope.inventoryId, observationId, observations, action.kind]);
  const locked = ['sending', 'unknown', 'saved-refresh-failed', 'complete', 'previewing'].includes(
      phase.kind
    ),
    preview = phase.kind === 'previewed' ? phase.preview : null;
  const candidateRows = candidates?.kind === 'ready' ? candidates.rows : [],
    candidateRun = candidates?.kind === 'ready' ? candidates.run : null,
    original = action.kind === 'add' ? null : action.entry.attribution;
  const sameBinding =
    !original ||
    !candidateRun ||
    (original.source.projectId === candidateRun.projectId &&
      original.source.workspaceScope === candidateRun.workspaceScope &&
      original.source.fileObjectUuid === candidateRun.fileObjectUuid);
  const pinnedRow =
    selectedRow ??
    candidateRows.find(
      (row) =>
        candidateRun?.sourceSha256 === draft.runValue?.sourceSha256 &&
        row.collection === draft.runValue?.collection &&
        row.key === draft.runValue?.key &&
        row.rowSha256 === draft.runValue?.rowSha256
    )?.row ??
    original?.valueSnapshot;
  const subjects = observation
    ? [
        ...observation.effects.sources.map((row) => ({
          value: JSON.stringify({ kind: 'source-stock', stockId: row.before.id }),
          label: `Source stock · ${row.vessel.name} · ${inventoryAmountLabel(row.before.quantity)} → ${inventoryAmountLabel(row.after.quantity)}`,
        })),
        ...observation.effects.destinations.map((row) => ({
          value: JSON.stringify({
            kind: 'output-action',
            actionId: row.actionId,
            stockId: row.after.id,
          }),
          label: `Resulting aliquot · ${row.vessel.name} · ${inventoryAmountLabel(row.after.quantity)}`,
        })),
      ]
    : [];
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/50 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label={
            action.kind === 'withdraw'
              ? 'Withdraw saved value association'
              : action.kind === 'correct'
                ? 'Associate again or correct'
                : 'Associate saved value'
          }
          className="flex max-h-[calc(100vh-40px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid="run-value-attribution-form"
          data-attribution-phase={phase.kind}
          data-preview-kind={preview?.kind ?? phase.kind}
          data-attribution-draft-id={draft.identityId}
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h3 className="font-semibold">
              {action.kind === 'withdraw'
                ? 'Withdraw saved value association'
                : action.kind === 'correct'
                  ? 'Associate again or correct'
                  : 'Associate saved value'}
            </h3>
            <Button disabled={phase.kind === 'sending'} onClick={onClose}>
              Close association editor
            </Button>
          </header>
          <main className="min-h-0 space-y-4 overflow-auto p-4">
            <p>
              {action.kind === 'withdraw'
                ? 'Withdrawal preserves the original value, subject and reasons. It does not change the Run or inventory stock.'
                : 'This saved value describes the selected recorded physical subject. It does not establish consumption or production by this Run.'}
            </p>
            {original ? (
              <p>
                Original association: {original.valueSnapshot.label} ·{' '}
                {valueLabel(original.valueSnapshot)}
              </p>
            ) : null}
            <fieldset disabled={locked} className="space-y-4">
              {action.kind !== 'withdraw' ? (
                <>
                  <section className="space-y-2" data-testid="attribution-candidates">
                    <h4 className="font-semibold">Saved value</h4>
                    {candidateLoading ? (
                      <p role="status">Loading native saved values…</p>
                    ) : candidates?.kind === 'unavailable' ? (
                      <Notice tone="error">{candidates.message}</Notice>
                    ) : candidates?.kind === 'inventory-absent' ? (
                      <p>This project has no inventory.</p>
                    ) : null}
                    {!sameBinding ? (
                      <Notice tone="warning">
                        The current file binding differs. This correction cannot continue the old
                        association chain.
                      </Notice>
                    ) : null}
                    {candidateRows.map((row) => {
                      const sameSlot =
                        action.kind !== 'correct' ||
                        (row.collection === original!.runValue.collection &&
                          row.key === original!.runValue.key);
                      return (
                        <article
                          className="space-y-2 rounded border border-border p-3"
                          key={`${row.collection}:${row.key}`}
                          data-candidate-collection={row.collection}
                          data-candidate-key={row.key}
                          data-candidate-row-sha256={row.rowSha256}
                        >
                          <p>
                            {String(row.row.label)} · {row.collection} · {valueLabel(row.row)}
                          </p>
                          <p>
                            {row.origin?.kind === 'frozen-declaration'
                              ? 'From frozen Protocol'
                              : 'Added for this Run'}
                          </p>
                          {row.eligibility.kind === 'eligible' ? (
                            <Button
                              disabled={!sameSlot || !sameBinding || !candidateRun}
                              onClick={() => {
                                if (!candidateRun) return;
                                setSelectedRow(row.row);
                                session.edit({
                                  ...draft,
                                  runValue: {
                                    entityId: candidateRun.entityId,
                                    sourceSha256: candidateRun.sourceSha256,
                                    collection: row.collection,
                                    key: row.key,
                                    rowSha256: row.rowSha256,
                                  },
                                });
                              }}
                            >
                              Use saved value
                            </Button>
                          ) : (
                            <p>{row.eligibility.message}</p>
                          )}
                        </article>
                      );
                    })}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => {
                          session.invalidate();
                          setCandidateCursor(null);
                          setCandidateReload((value) => value + 1);
                        }}
                      >
                        Refresh saved values
                      </Button>
                      <Button disabled={!candidateCursor} onClick={() => setCandidateCursor(null)}>
                        First saved values page
                      </Button>
                      <Button
                        disabled={candidates?.kind !== 'ready' || !candidates.nextCursor}
                        onClick={() =>
                          candidates?.kind === 'ready' && setCandidateCursor(candidates.nextCursor)
                        }
                      >
                        Next saved values page
                      </Button>
                    </div>
                    {draft.runValue ? (
                      <p data-testid="attribution-pinned-value">
                        Pinned saved value:{' '}
                        {pinnedRow
                          ? valueLabel(pinnedRow)
                          : 'Earlier saved selection; choose a current value to change its pin.'}
                      </p>
                    ) : null}
                  </section>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span>Recorded plate-plan use</span>
                    <Select
                      ariaLabel="Recorded plate-plan use"
                      value={observationId}
                      options={[
                        { value: '', label: 'Choose a recorded physical use' },
                        ...(observations?.observations ?? []).map((row) => ({
                          value: row.id,
                          label: `${row.planTitle} · ${row.plate.name} · ${new Date(row.at).toISOString()}`,
                          description: row.id,
                        })),
                      ]}
                      onValueChange={(value) => {
                        session.edit({ ...draft, physical: null });
                        setObservationId(value);
                      }}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      disabled={!observationCursor}
                      onClick={() => setObservationCursor(null)}
                    >
                      First physical uses page
                    </Button>
                    <Button
                      disabled={!observations?.nextCursor}
                      onClick={() => observations && setObservationCursor(observations.nextCursor)}
                    >
                      Next physical uses page
                    </Button>
                  </div>
                  {loadingPhysical ? <p role="status">Loading exact recorded subject…</p> : null}
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span>Physical subject</span>
                    <Select
                      ariaLabel="Physical subject"
                      value={
                        draft.physical?.observationId === observation?.id
                          ? JSON.stringify(draft.physical?.subject)
                          : ''
                      }
                      options={[
                        { value: '', label: 'Choose a recorded source or aliquot' },
                        ...subjects,
                      ]}
                      onValueChange={(value) => {
                        const selected = subjects.find((item) => item.value === value);
                        if (!selected || !observation) return;
                        session.edit({
                          ...draft,
                          physical: {
                            observationId: observation.id,
                            observationIntentSha256: observation.intentSha256,
                            subject: JSON.parse(selected.value),
                          },
                        });
                      }}
                    />
                  </label>
                  {observation && draft.physical ? (
                    <p data-testid="attribution-pinned-subject">
                      Recorded subject: {physicalLabel(observation, draft.physical)}
                    </p>
                  ) : null}
                </>
              ) : null}
              <label className="flex flex-col gap-1.5 text-sm">
                <span>
                  {action.kind === 'withdraw' ? 'Reason for withdrawal' : 'Reason for association'}
                </span>
                <TextArea
                  aria-label={
                    action.kind === 'withdraw' ? 'Reason for withdrawal' : 'Reason for association'
                  }
                  value={draft.reason}
                  rows={3}
                  onChange={(event) => session.edit({ ...draft, reason: event.target.value })}
                />
              </label>
              <Button onClick={() => void session.preview()}>
                {action.kind === 'withdraw' ? 'Preview withdrawal' : 'Preview association'}
              </Button>
            </fieldset>
            <section className="space-y-3" data-testid="run-value-attribution-preview">
              {preview?.kind === 'blocked' ? (
                <Notice tone="warning">
                  {preview.issues.map((issue) => issue.message).join(' ')}
                </Notice>
              ) : preview?.kind === 'unavailable' ? (
                <Notice tone="error">{preview.message}</Notice>
              ) : preview?.kind === 'no-change' ? (
                <Notice>
                  <p>
                    Already recorded · {preview.entry.withdrawal ? 'Withdrawn' : 'Active'}. No new
                    association or restoration will be saved.
                  </p>
                  <p>{preview.entry.attribution.reason}</p>
                  {preview.entry.withdrawal ? (
                    <p>Withdrawal: {preview.entry.withdrawal.reason}</p>
                  ) : null}
                </Notice>
              ) : preview?.kind === 'ready' ? (
                <>
                  <Notice>
                    {action.kind === 'withdraw'
                      ? 'Ready to withdraw this association.'
                      : 'Ready to associate this exact saved value and recorded subject.'}
                  </Notice>
                  <p data-testid="attribution-preview-value">
                    Saved value: {valueLabel(preview.attribution.valueSnapshot)}
                  </p>
                  {observation ? (
                    <p>
                      Recorded subject: {physicalLabel(observation, preview.attribution.physical)}
                    </p>
                  ) : null}
                  <p>{preview.attribution.reason}</p>
                  <Button variant="primary" onClick={() => void session.submit()}>
                    {action.kind === 'withdraw' ? 'Withdraw association' : 'Add association'}
                  </Button>
                </>
              ) : null}
            </section>
            {phase.kind === 'previewed' && phase.request ? (
              <details>
                <summary>Prepared association request</summary>
                <TextArea
                  readOnly
                  aria-label="Prepared value association request"
                  rows={8}
                  value={JSON.stringify(phase.request, null, 2)}
                />
              </details>
            ) : null}
            {phase.kind === 'sending' || phase.kind === 'previewing' ? (
              <p role="status">
                {phase.kind === 'sending'
                  ? 'Saving the original association change…'
                  : 'Checking the association…'}
              </p>
            ) : phase.kind === 'failed' ? (
              <Notice tone="error">{phase.message}</Notice>
            ) : phase.kind === 'unknown' ? (
              <Notice tone="warning">
                <p>{phase.message}</p>
                <Button onClick={() => void session.checkStatus()}>Check association status</Button>
                <Button onClick={() => void session.retry()}>Retry same association change</Button>
              </Notice>
            ) : phase.kind === 'saved-refresh-failed' ? (
              <Notice>
                <p>{phase.message}</p>
                <Button onClick={() => void session.reloadSaved()}>Reload saved association</Button>
              </Notice>
            ) : phase.kind === 'complete' ? (
              <Notice>
                Association change saved. Historical status:{' '}
                {phase.entry.withdrawal ? 'Withdrawn' : 'Active'}.
              </Notice>
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <details>
              <summary>Pinned value and recorded subject identities</summary>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(
                  {
                    runValue: draft.runValue,
                    physical: draft.physical,
                    predecessor: action.kind === 'correct' ? action.entry : null,
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
export function RunSavedValueAssociations({
  resource,
  canCreate,
}: {
  resource: RunValueAssociationResource | null;
  canCreate: boolean;
}) {
  const client = platform().inventory,
    [scope, setScope] = useState<PlatePlanScope | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setScope(null);
    setError(null);
    if (!resource || resource.projectId !== resource.workspaceScope) {
      setError('The Run project identity is unavailable.');
      return;
    }
    void client
      .projects()
      .then((projects) => {
        if (cancelled) return;
        const project = projects.find((row) => row.projectId === resource.projectId);
        if (!project) throw Error('This Run’s inventory project is unavailable.');
        setScope({ project: project.projectId, inventoryId: project.defaultInventoryId });
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    resource?.projectId,
    resource?.workspaceScope,
    resource?.entityId,
    resource?.fileObjectUuid,
  ]);
  return scope && resource ? (
    <InventoryRunValueAttributions scope={scope} resource={resource} canCreate={canCreate} />
  ) : (
    <section className="space-y-2 rounded border border-border p-4">
      <h3>Saved values and recorded subjects</h3>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p role="status">Loading Run inventory scope…</p>
      )}
    </section>
  );
}
export function InventorySavedValueAssociations({
  scope,
  onClose,
}: {
  scope: PlatePlanScope;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/40 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Saved value associations"
          className="flex max-h-[calc(100vh-40px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid="inventory-saved-value-associations"
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Saved value associations</h2>
            <Button onClick={onClose}>Close saved value associations</Button>
          </header>
          <main className="min-h-0 overflow-auto p-4">
            <InventoryRunValueAttributions scope={scope} />
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Saved value associations are unavailable.';
}
