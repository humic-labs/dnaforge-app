import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { inventoryVesselContentsProjection, type InventoryState } from '@waypoint/domain-services';
import { Button, Notice, TextField, TextArea, UI_FIELD_CLASS } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import { inventoryRunValueCandidatesReadSchema } from '../../shared/inventory-run-value-attributions';
import {
  inventoryScientificProductionDesignsReadSchema,
  type InventoryScientificProductionDesignsRead,
  type InventoryScientificProductionDesignCandidate,
} from '../../shared/inventory-scientific-productions';
import type { InventoryAvailabilitySnapshot } from '../../shared/inventory-client';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import {
  InventoryScientificProductionSession,
  type ScientificProductionScope,
  type ScientificProductionResource,
} from './inventory-scientific-production-session';
import { ScientificProductionFacts } from './ScientificProductionFacts';
import { inventoryAmountLabel } from './inventory-view';
type Designs = Exclude<InventoryScientificProductionDesignsRead, { kind: 'unavailable' }>;
export function InventoryScientificProductionForm({
  scope,
  resource,
  canCreate,
  resume,
  onClose,
}: {
  scope: ScientificProductionScope;
  resource: ScientificProductionResource;
  canCreate: boolean;
  resume?: InventoryAttempt;
  onClose(): void;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    overlay = usePresentationOverlay('modal');
  const session = useMemo(
    () =>
      new InventoryScientificProductionSession(scope, resource, client, pending, {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      }),
    [client, pending, scope.project, scope.inventoryId, resource.entityId, resource.fileObjectUuid]
  );
  const { draft, phase } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [reload, setReload] = useState(0),
    [data, setData] = useState<{
      state: InventoryState;
      availability: InventoryAvailabilitySnapshot;
      sourceSha256: string;
      title: string;
    } | null>(null),
    [dataError, setDataError] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [designs, setDesigns] = useState<Designs | null>(null),
    [designError, setDesignError] = useState<string | null>(null),
    [designLoading, setDesignLoading] = useState(false),
    [cursor, setCursor] = useState<Designs['nextCursor']>(null),
    [selectedLabel, setSelectedLabel] =
      useState<InventoryScientificProductionDesignCandidate | null>(null);
  useEffect(() => {
    session.activate();
    if (resume) session.resume(resume);
    const changed = () => {
      session.invalidate();
      setReload((value) => value + 1);
    };
    const inventory = client.onChanged((event) => {
      if (event.projectId === scope.project && event.inventoryId === scope.inventoryId) changed();
    });
    const protocol = platform().protocols.onChanged((event) => {
      if (event.projectId === scope.project && event.entityId === resource.entityId) changed();
    });
    window.addEventListener('focus', changed);
    document.addEventListener('visibilitychange', changed);
    return () => {
      session.detach();
      inventory();
      protocol();
      window.removeEventListener('focus', changed);
      document.removeEventListener('visibilitychange', changed);
    };
  }, [session, client, scope.project, scope.inventoryId, resource.entityId]);
  useEffect(() => session.setWritable(canCreate), [session, canCreate]);
  useEffect(() => {
    let cancelled = false;
    if (resume) return;
    setData(null);
    setDataError(null);
    void Promise.all([
      client.inspect(scope),
      client.availability(scope),
      client.runValueCandidates({ ...scope, runId: resource.entityId, limit: 1 }),
    ])
      .then(([state, availability, raw]) => {
        if (cancelled) return;
        const result = inventoryRunValueCandidatesReadSchema.parse(raw);
        if (result.kind !== 'ready')
          throw Error(
            result.kind === 'unavailable' ? result.message : 'This Run has no inventory yet.'
          );
        if (
          !state ||
          !availability ||
          availability.projectId !== scope.project ||
          availability.inventoryId !== scope.inventoryId ||
          availability.revision !== state.revision ||
          result.projectId !== scope.project ||
          result.inventoryId !== scope.inventoryId ||
          result.revision !== state.revision ||
          result.run.entityId !== resource.entityId ||
          result.run.fileObjectUuid !== resource.fileObjectUuid ||
          result.run.projectId !== resource.projectId ||
          result.run.workspaceScope !== resource.workspaceScope
        )
          throw Error('The saved Run and inventory changed while being read. Refresh the report.');
        session.setPrincipal(availability.principal);
        setData({
          state,
          availability,
          sourceSha256: result.run.sourceSha256,
          title: result.run.title,
        });
        if (!session.getSnapshot().draft.sourceSha256)
          session.edit({ ...session.getSnapshot().draft, sourceSha256: result.run.sourceSha256 });
      })
      .catch((cause) => {
        if (!cancelled) setDataError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    session,
    client,
    scope.project,
    scope.inventoryId,
    resource.entityId,
    resource.fileObjectUuid,
    reload,
  ]);
  useEffect(() => {
    let cancelled = false;
    setDesignLoading(true);
    setDesignError(null);
    void client
      .scientificProductionDesigns({ ...scope, query, limit: 20, ...(cursor ? { cursor } : {}) })
      .then((raw) => {
        if (cancelled) return;
        const result = inventoryScientificProductionDesignsReadSchema.parse(raw);
        if (result.kind === 'unavailable') {
          if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
            setCursor(null);
            return;
          }
          throw Error(result.message);
        }
        if (
          result.projectId !== scope.project ||
          result.inventoryId !== scope.inventoryId ||
          result.query !== query
        )
          throw Error('The design choices belong to another project or search.');
        setDesigns(result);
      })
      .catch((cause) => {
        if (!cancelled) setDesignError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setDesignLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, scope.project, scope.inventoryId, query, cursor, reload]);
  const edit = (change: Partial<typeof draft>) => session.edit({ ...draft, ...change });
  const locked = ['sending', 'unknown', 'accepted-read-pending', 'recorded'].includes(phase.kind);
  const contents = data ? inventoryVesselContentsProjection(data.state) : {};
  const stocks = data
    ? Object.values(data.state.stocks).filter(
        (stock) => stock.quantity.kind === 'known' && stock.quantity.unit === 'uL'
      )
    : [];
  const vessels = data
    ? Object.values(data.state.vessels).filter(
        (vessel) => vessel.lifecycle === 'active' && contents[vessel.id]?.kind === 'declared-empty'
      )
    : [];
  const sourceCurrent = Boolean(data && data.sourceSha256 === draft.sourceSha256);
  const preview = phase.kind === 'previewed' ? phase.preview : null;
  const prepared = phase.kind === 'previewed' ? phase.request : undefined;
  const selected =
    selectedLabel ??
    (designs?.kind === 'ready'
      ? designs.designs.find(
          (row) =>
            row.selection.revision.resourceId === draft.design?.revision.resourceId &&
            row.selection.revision.resourceRevisionId ===
              draft.design?.revision.resourceRevisionId &&
            row.selection.revision.contentSha256 === draft.design?.revision.contentSha256
        )
      : undefined);
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/40 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Record completed production"
          data-testid="scientific-production-form"
          className="flex max-h-[calc(100vh-40px)] w-full max-w-4xl flex-col rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Record completed production</h2>
            <Button onClick={onClose}>Close production report</Button>
          </header>
          <main className="min-h-0 space-y-4 overflow-auto p-4">
            <p>
              Record an already completed manual preparation against a saved DNA design and Run.
            </p>
            {!canCreate ? (
              <Notice>
                Save or confirm existing Run changes before recording a new production.
              </Notice>
            ) : null}
            {phase.kind === 'unknown' || phase.kind === 'accepted-read-pending' ? (
              <Notice>
                <p>{phase.message}</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => void session.checkStatus()}>
                    Confirm original production report
                  </Button>
                  <Button onClick={() => void session.retry()}>
                    {phase.kind === 'unknown'
                      ? 'Retry original production request'
                      : 'Reload recorded production'}
                  </Button>
                </div>
                <details>
                  <summary>Original production request</summary>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(phase.attempt.request, null, 2)}
                  </pre>
                </details>
              </Notice>
            ) : null}
            {phase.kind === 'sending' ? (
              <p role="status">Recording the original production report…</p>
            ) : null}
            {phase.kind === 'failed' ? <Notice tone="error">{phase.message}</Notice> : null}
            {phase.kind === 'recorded' ? (
              <>
                <Notice>
                  {phase.outcome === 'existing'
                    ? 'This production was already recorded. No new inventory change was made.'
                    : 'The completed production was recorded.'}
                </Notice>
                <ScientificProductionFacts production={phase.production} />
                <Button onClick={() => void session.preview(phase.production)}>
                  Preview original production again
                </Button>
                <Button disabled={!canCreate} onClick={() => session.newReport()}>
                  New production report
                </Button>
              </>
            ) : null}
            {!locked ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">Saved Run</h3>
                  <Button
                    onClick={() => {
                      session.invalidate();
                      setReload((value) => value + 1);
                    }}
                  >
                    Refresh production choices
                  </Button>
                </div>
                {dataError ? (
                  <Notice tone="error">{dataError}</Notice>
                ) : !data ? (
                  <p role="status">Loading current saved Run and inventory…</p>
                ) : (
                  <p>{data.title}</p>
                )}
                {data && !sourceCurrent ? (
                  <Notice>
                    The saved Run has changed.{' '}
                    <Button onClick={() => edit({ sourceSha256: data.sourceSha256 })}>
                      Use current saved Run
                    </Button>
                  </Notice>
                ) : null}
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Find accepted DNA design</span>
                  <TextField
                    aria-label="Find accepted DNA design"
                    value={query}
                    onChange={(event) => {
                      setCursor(null);
                      setQuery(event.target.value);
                      session.invalidate();
                    }}
                  />
                </label>
                <h3 className="font-semibold">Accepted DNA design</h3>
                {designLoading ? (
                  <p role="status">Loading accepted designs…</p>
                ) : designError ? (
                  <Notice tone="error">{designError}</Notice>
                ) : designs?.kind === 'setup-required' ? (
                  <Notice>
                    Set up versioned designs using the Run’s Versioned designs panel before choosing
                    a production design.
                  </Notice>
                ) : designs?.kind === 'ready' ? (
                  <>
                    <div className="space-y-2">
                      {!designs.designs.length ? (
                        <p>No accepted nonempty DNA designs match this search.</p>
                      ) : null}
                      {designs.designs.map((row) => (
                        <div
                          key={row.selection.revision.resourceId}
                          className="rounded border border-border p-2"
                          data-design-resource-id={row.selection.revision.resourceId}
                          data-design-revision-id={row.selection.revision.resourceRevisionId}
                        >
                          <Button
                            disabled={row.materialAdmission.kind !== 'admitted'}
                            onClick={() => {
                              setSelectedLabel(row);
                              edit({ design: row.selection });
                            }}
                          >
                            Use {row.document.name} · {row.document.length} bases ·{' '}
                            {row.document.topology}
                          </Button>
                          {row.materialAdmission.kind === 'unavailable' ? (
                            <p>{row.materialAdmission.message}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button disabled={!cursor} onClick={() => setCursor(null)}>
                        First designs page
                      </Button>
                      <Button
                        disabled={!designs.nextCursor}
                        onClick={() => setCursor(designs.nextCursor)}
                      >
                        Next designs page
                      </Button>
                    </div>
                  </>
                ) : null}
                {draft.design ? (
                  <div data-testid="scientific-production-selected-design">
                    <p>
                      Selected saved design:{' '}
                      {selected?.document.name ?? 'Previously selected accepted DNA design'}
                      {selected
                        ? ` · ${selected.document.length} bases · ${selected.document.topology}`
                        : ''}
                    </p>
                    <details>
                      <summary>Selected design and Run identities</summary>
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {JSON.stringify(
                          {
                            design: draft.design,
                            run: { ...resource, sourceSha256: draft.sourceSha256 },
                          },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  </div>
                ) : null}
                <h3 className="font-semibold">Inputs used</h3>
                {draft.inputs.map((row, index) => (
                  <fieldset
                    key={row.key}
                    className="space-y-2 rounded border border-border p-3"
                    data-testid="scientific-production-input"
                    data-row-key={row.key}
                    data-stock-id={row.stockId}
                  >
                    <legend>Input {index + 1}</legend>
                    <label className="block space-y-1">
                      <span>Input {index + 1} stock</span>
                      <select
                        aria-label={`Input ${index + 1} stock`}
                        className={UI_FIELD_CLASS}
                        value={row.stockId}
                        onChange={(event) =>
                          edit({
                            inputs: draft.inputs.map((item) =>
                              item.key === row.key ? { ...item, stockId: event.target.value } : item
                            ),
                          })
                        }
                      >
                        <option value="">Choose an existing stock</option>
                        {stocks.map((stock) => {
                          const facts = data!.availability.stocks[stock.id];
                          return (
                            <option key={stock.id} value={stock.id}>
                              {data!.state.vessels[stock.vesselId].name} ·{' '}
                              {inventoryAmountLabel(stock.quantity)} · unreserved{' '}
                              {facts ? inventoryAmountLabel(facts.unreserved) : 'unavailable'}
                              {facts?.actions.withdraw.kind === 'blocked'
                                ? ' · withdrawal blocked'
                                : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span>Input {index + 1} amount (µL)</span>
                      <TextField
                        aria-label={`Input ${index + 1} amount (µL)`}
                        value={row.amount}
                        onChange={(event) =>
                          edit({
                            inputs: draft.inputs.map((item) =>
                              item.key === row.key ? { ...item, amount: event.target.value } : item
                            ),
                          })
                        }
                      />
                    </label>
                    {draft.inputs.length > 1 ? (
                      <Button
                        onClick={() =>
                          edit({ inputs: draft.inputs.filter((item) => item.key !== row.key) })
                        }
                      >
                        Remove input {index + 1}
                      </Button>
                    ) : null}
                  </fieldset>
                ))}
                <Button
                  disabled={draft.inputs.length >= 253}
                  onClick={() =>
                    edit({
                      inputs: [
                        ...draft.inputs,
                        { key: crypto.randomUUID(), stockId: '', amount: '' },
                      ],
                    })
                  }
                >
                  Add production input
                </Button>
                <label className="block space-y-1">
                  <span className="font-medium">Output vessel</span>
                  <select
                    aria-label="Output vessel"
                    className={UI_FIELD_CLASS}
                    value={draft.outputVesselId}
                    onChange={(event) => edit({ outputVesselId: event.target.value })}
                  >
                    <option value="">Choose an existing empty vessel</option>
                    {vessels.map((vessel) => (
                      <option key={vessel.id} value={vessel.id}>
                        {vessel.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span>Measured output amount (µL)</span>
                  <TextField
                    aria-label="Measured output amount (µL)"
                    value={draft.outputAmount}
                    onChange={(event) => edit({ outputAmount: event.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <span>Batch name</span>
                  <TextField
                    aria-label="Batch name"
                    value={draft.lotName}
                    onChange={(event) => edit({ lotName: event.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <span>Preparation method</span>
                  <TextArea
                    aria-label="Preparation method"
                    value={draft.method}
                    onChange={(event) => edit({ method: event.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <span>Reason for production report</span>
                  <TextArea
                    aria-label="Reason for production report"
                    value={draft.reason}
                    onChange={(event) => edit({ reason: event.target.value })}
                  />
                </label>
                <Notice>
                  The new batch starts unassessed and its stock starts quarantined. Quality
                  decisions remain separate.
                </Notice>
                <label className="block space-y-1">
                  <span>Manual production status</span>
                  <select
                    aria-label="Manual production status"
                    className={UI_FIELD_CLASS}
                    value={draft.declaration}
                    onChange={(event) =>
                      edit({ declaration: event.target.value as typeof draft.declaration })
                    }
                  >
                    <option value="">Choose the observed outcome</option>
                    <option value="completed">
                      This production was completed manually as reported
                    </option>
                    <option value="uncertain">
                      Production was partial or its outcome is uncertain
                    </option>
                  </select>
                </label>
                {draft.declaration === 'uncertain' ? (
                  <Notice>
                    This form supports a completed manual production report. Keep a partial or
                    uncertain report for separate reconciliation.
                  </Notice>
                ) : null}
                <Button
                  disabled={
                    !canCreate ||
                    !data ||
                    !sourceCurrent ||
                    phase.kind === 'previewing' ||
                    draft.declaration !== 'completed'
                  }
                  onClick={() => void session.preview()}
                >
                  Preview completed production
                </Button>
              </>
            ) : null}
            {phase.kind === 'previewing' ? (
              <p role="status">Previewing the complete production without changing inventory…</p>
            ) : null}
            {preview ? (
              <section className="space-y-3" data-testid="scientific-production-preview">
                {preview.kind === 'unavailable' ? (
                  <Notice tone="error">{preview.message}</Notice>
                ) : preview.kind === 'blocked' ? (
                  <Notice tone="error">
                    <ul>
                      {preview.issues.map((issue, index) => (
                        <li key={index}>{issue.message}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : (
                  <>
                    <Notice>
                      {preview.kind === 'no-change'
                        ? 'This exact production was already recorded. There is no new change to save.'
                        : 'Ready to record this completed report. Preview has not changed inventory.'}
                    </Notice>
                    <ScientificProductionFacts
                      production={preview.production}
                      proposed={preview.kind === 'ready'}
                    />
                    {prepared ? (
                      <>
                        <details>
                          <summary>Prepared production request</summary>
                          <TextArea
                            aria-label="Prepared production request"
                            readOnly
                            value={JSON.stringify(prepared, null, 2)}
                          />
                        </details>
                        <Button
                          disabled={!canCreate || !sourceCurrent}
                          onClick={() => void session.submit()}
                        >
                          Record completed production
                        </Button>
                      </>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Production choices are unavailable.';
}
