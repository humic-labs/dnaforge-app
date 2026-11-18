import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  inventoryAmountUnitDefinition,
  type InventoryPlatePlanVersion,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryData } from './inventory-controller';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
import {
  InventoryPlatePlanObservationSession,
  type PlatePlanObservationDraft,
} from './inventory-plate-plan-observation-session';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import {
  PlatePlanObservationFacts,
  InventoryPlatePlanObservations,
} from './InventoryPlatePlanObservations';
import { inventoryAmountLabel } from './inventory-view';
export type PlatePlanReportSelection = {
  version: InventoryPlatePlanVersion;
  initial?: { destinationPlateId: string; sources: Record<string, string> };
  resume?: InventoryAttempt;
};
export function InventoryPlatePlanObservationForm({
  scope,
  selection,
  data,
  onClose,
}: {
  scope: PlatePlanScope;
  selection: PlatePlanReportSelection;
  data?: InventoryData;
  onClose(): void;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    overlay = usePresentationOverlay('modal'),
    version = selection.version;
  const session = useMemo(
    () =>
      new InventoryPlatePlanObservationSession(
        scope,
        version,
        client,
        pending,
        {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
        },
        selection.initial
      ),
    [client, pending, scope.project, scope.inventoryId, version.id, version.definitionSha256]
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { draft, phase } = snapshot;
  const [contexts, setContexts] = useState<
      Awaited<ReturnType<typeof client.scientificContextsV2>>['contexts']
    >([]),
    [query, setQuery] = useState(''),
    [refresh, setRefresh] = useState(0),
    [contextState, setContextState] = useState<'loading' | 'ready' | 'failed'>('loading'),
    [contextError, setContextError] = useState<string | null>(null);
  useEffect(() => {
    session.activate();
    if (selection.resume) session.resume(selection.resume);
    const unsubscribe = client.onChanged((event) => {
      if (event.projectId === scope.project && event.inventoryId === scope.inventoryId)
        session.invalidate();
    });
    const invalidate = () => session.invalidate();
    window.addEventListener('focus', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      session.detach();
      unsubscribe();
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, [session, client, scope.project, scope.inventoryId]);
  useEffect(
    () => session.setPrincipal(data?.availability?.principal),
    [session, data?.availability?.principal]
  );
  useEffect(() => {
    const changed = () => {
      session.invalidate();
      setRefresh((value) => value + 1);
    };
    const unsubscribe =
      draft.contextKind === 'protocol-run'
        ? platform().protocols.onChanged((event) => {
            if (
              event.projectId === scope.project &&
              (!draft.entityId || event.entityId === draft.entityId)
            )
              changed();
          })
        : platform().notebook.onChanged(() => changed());
    return unsubscribe;
  }, [session, scope.project, draft.contextKind, draft.entityId]);
  useEffect(() => {
    let cancelled = false;
    setContexts([]);
    setContextError(null);
    setContextState('loading');
    void client
      .scientificContextsV2({ ...scope, kind: draft.contextKind, query, limit: 50 })
      .then((result) => {
        if (cancelled) return;
        if (result.projectId !== scope.project || result.inventoryId !== scope.inventoryId)
          throw Error('Saved contexts belong to another inventory project.');
        setContexts(result.contexts);
        setContextState('ready');
      })
      .catch((cause) => {
        if (!cancelled) {
          setContextError(
            cause instanceof Error ? cause.message : 'Saved contexts could not be loaded.'
          );
          setContextState('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, scope.project, scope.inventoryId, draft.contextKind, query, refresh]);
  const edit = (change: Partial<PlatePlanObservationDraft>) =>
      session.edit({ ...draft, ...change }),
    locked = ['sending', 'unknown', 'saved-refresh-failed', 'complete', 'previewing'].includes(
      phase.kind
    ),
    preview = phase.kind === 'previewed' ? phase.preview : null,
    physical = data?.project.projectId === scope.project ? data.state : null,
    plates = physical
      ? Object.values(physical.storage).filter((item) => item.layout.kind === 'fixed-well')
      : [],
    stocks = physical
      ? Object.values(physical.stocks).filter(
          (stock) => inventoryAmountUnitDefinition(stock.quantity.unit).dimension === 'volume'
        )
      : [];
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-3"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Record completed plate-plan transfers"
          className="flex max-h-[calc(100vh-32px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid="plate-plan-observation-form"
          data-report-phase={phase.kind}
          data-report-preview-state={preview?.kind ?? phase.kind}
          data-observation-draft-id={draft.observationId}
          data-plan-version-id={version.id}
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Record completed plate-plan transfers</h2>
            <Button disabled={phase.kind === 'sending'} onClick={onClose}>
              Close manual report
            </Button>
          </header>
          <main className="min-h-0 space-y-4 overflow-auto p-4">
            <p>
              Report a whole manual use that was physically completed exactly as listed. Previewing
              and recording do not start equipment or perform transfers.
            </p>
            <p className="font-semibold">
              {version.definition.title} · {version.definition.layout.rows} ×{' '}
              {version.definition.layout.columns}
            </p>
            <p className="break-all text-xs">
              Saved version: {version.id} · {version.definitionSha256}
            </p>
            <ol>
              {version.definition.transfers.map((step, index) => (
                <li key={step.actionId}>
                  Step {index + 1}: {step.label} · {step.destinationPosition} ·{' '}
                  {step.quantity.value} µL
                </li>
              ))}
            </ol>
            <fieldset disabled={locked || data?.project.pinned} className="space-y-3">
              <Field label="Occurrence">
                <TextField readOnly aria-label="Occurrence" value={draft.observationId} />
              </Field>
              <Field label="Physical plate">
                <Select
                  ariaLabel="Physical plate"
                  value={draft.destinationPlateId}
                  options={[
                    { value: '', label: 'Choose an existing plate' },
                    ...plates.map((plate) => ({
                      value: plate.id,
                      label: `${plate.name} · ${plate.layout.kind === 'fixed-well' ? `${plate.layout.rows} × ${plate.layout.columns}` : ''}`,
                      description: plate.id,
                    })),
                  ]}
                  onValueChange={(value) => edit({ destinationPlateId: value })}
                />
              </Field>
              {version.definition.sourceSlots.map((slot, index) => (
                <Field label={`Report source ${index + 1}: ${slot.label}`} key={slot.key}>
                  <Select
                    ariaLabel={`Report source ${index + 1}: ${slot.label}`}
                    value={draft.sources[slot.key] ?? ''}
                    options={[
                      { value: '', label: 'Choose an existing volume stock' },
                      ...stocks.map((stock) => ({
                        value: stock.id,
                        label: `${physical?.vessels[stock.vesselId]?.name ?? stock.vesselId} · ${inventoryAmountLabel(stock.quantity)}`,
                        description: stock.id,
                      })),
                    ]}
                    onValueChange={(value) =>
                      edit({ sources: { ...draft.sources, [slot.key]: value } })
                    }
                  />
                </Field>
              ))}
              <Field label="Scientific context kind">
                <Select
                  ariaLabel="Scientific context kind"
                  value={draft.contextKind}
                  options={[
                    { value: 'notebook-page', label: 'Notebook page' },
                    { value: 'protocol-run', label: 'Protocol run' },
                  ]}
                  onValueChange={(value) =>
                    edit({
                      contextKind: value as typeof draft.contextKind,
                      entityId: '',
                      sourceSha256: '',
                    })
                  }
                />
              </Field>
              <Field label="Find saved context">
                <TextField
                  aria-label="Find saved context"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    session.invalidate();
                  }}
                />
              </Field>
              <Button
                onClick={() => {
                  session.invalidate();
                  setRefresh((value) => value + 1);
                }}
              >
                Refresh saved contexts
              </Button>
              {contextState === 'loading' ? (
                <p role="status">Loading saved contexts…</p>
              ) : contextState === 'failed' ? (
                <Notice tone="error">{contextError}</Notice>
              ) : null}
              <Field label="Saved context">
                <Select
                  ariaLabel="Saved context"
                  value={draft.entityId}
                  options={[
                    { value: '', label: 'Choose a saved context' },
                    ...contexts.map((context) => ({
                      value: context.entityId,
                      label: context.title,
                      description: context.entityId,
                    })),
                  ]}
                  onValueChange={(value) => {
                    const context = contexts.find((item) => item.entityId === value);
                    edit({ entityId: value, sourceSha256: context?.sourceSha256 ?? '' });
                  }}
                />
              </Field>
              {draft.sourceSha256 ? (
                <p className="break-all text-xs">Pinned saved context: {draft.sourceSha256}</p>
              ) : null}
              <Field label="Reason for this manual report">
                <TextArea
                  aria-label="Reason for this manual report"
                  value={draft.reason}
                  rows={3}
                  onChange={(event) => edit({ reason: event.target.value })}
                />
              </Field>
              <Field label="Were all listed transfers completed exactly as shown?">
                <Select
                  ariaLabel="Were all listed transfers completed exactly as shown?"
                  value={draft.declaration}
                  options={[
                    { value: '', label: 'Choose the physical outcome' },
                    { value: 'whole', label: 'Yes, all transfers' },
                    { value: 'uncertain', label: 'Some transfers or unsure' },
                  ]}
                  onValueChange={(value) =>
                    edit({ declaration: value as typeof draft.declaration })
                  }
                />
              </Field>
              {draft.declaration === 'uncertain' ? (
                <Notice>
                  This form can record only the complete list. No inventory change has been saved.
                </Notice>
              ) : null}
              <Button
                disabled={draft.declaration !== 'whole'}
                onClick={() => void session.preview()}
              >
                Preview completed transfers
              </Button>
            </fieldset>
            <section data-testid="plate-plan-report-result">
              {preview?.kind === 'blocked' ? (
                <Notice tone="warning">
                  {preview.issues.map((issue) => issue.message).join(' ')}
                </Notice>
              ) : preview?.kind === 'unavailable' ? (
                <Notice tone="error">{preview.message}</Notice>
              ) : preview?.kind === 'ready' || preview?.kind === 'no-change' ? (
                <>
                  <Notice>
                    {preview.kind === 'ready'
                      ? 'Ready to record this whole completed manual use.'
                      : 'This occurrence was already recorded. No additional transfer will be recorded.'}
                  </Notice>
                  <PlatePlanObservationFacts
                    observation={preview.observation}
                    proposed={preview.kind === 'ready'}
                  />
                  {preview.kind === 'ready' ? (
                    <Button variant="primary" onClick={() => void session.submit()}>
                      Record completed transfers
                    </Button>
                  ) : (
                    <Button onClick={() => session.newOccurrence()}>
                      Start a separate occurrence
                    </Button>
                  )}
                </>
              ) : null}
            </section>
            {phase.kind === 'previewed' && phase.request ? (
              <details>
                <summary>Prepared manual report details</summary>
                <TextArea
                  readOnly
                  aria-label="Prepared manual report request"
                  value={JSON.stringify(phase.request, null, 2)}
                  rows={8}
                />
              </details>
            ) : null}
            {phase.kind === 'sending' || phase.kind === 'previewing' ? (
              <p role="status">
                {phase.kind === 'sending'
                  ? 'Recording the whole manual use…'
                  : 'Checking the complete report…'}
              </p>
            ) : phase.kind === 'failed' ? (
              <Notice tone="error">{phase.message}</Notice>
            ) : phase.kind === 'unknown' ? (
              <Notice tone="warning">
                <p>{phase.message}</p>
                <Button onClick={() => void session.checkStatus()}>Check report status</Button>
                <Button onClick={() => void session.retry()}>Retry same manual report</Button>
              </Notice>
            ) : phase.kind === 'saved-refresh-failed' ? (
              <Notice>
                <p>{phase.message}</p>
                <Button onClick={() => void session.reloadSaved()}>Reload recorded use</Button>
              </Notice>
            ) : phase.kind === 'complete' ? (
              <Notice>
                <p>Completed manual plate-plan use recorded.</p>
                <Button onClick={() => void session.previewSameOccurrence()}>
                  Preview same occurrence again
                </Button>
                <Button onClick={() => session.newOccurrence()}>Start a separate occurrence</Button>
              </Notice>
            ) : null}
            {phase.kind === 'complete' ? (
              <InventoryPlatePlanObservations
                scope={scope}
                filters={{
                  version: { versionId: version.id, definitionSha256: version.definitionSha256 },
                }}
              />
            ) : null}
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
