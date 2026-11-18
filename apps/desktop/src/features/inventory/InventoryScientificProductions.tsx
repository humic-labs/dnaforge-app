import { ScientificProductionFacts } from './ScientificProductionFacts';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { parseProtocolPackage } from '@waypoint/domain-services';
import { Button, Notice, TextArea } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import { FrozenProtocolDefinition } from '../scientific-document/FrozenProtocolDefinition';
import { InventoryScientificProductionReadSession } from './inventory-scientific-production-read-session';
import { InventoryScientificProductionForm } from './InventoryScientificProductionForm';
import type {
  ScientificProductionResource,
  ScientificProductionScope,
} from './inventory-scientific-production-session';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
export function InventoryScientificProductions({
  scope,
  resource,
  canCreate = false,
}: {
  scope: ScientificProductionScope;
  resource?: ScientificProductionResource;
  canCreate?: boolean;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator();
  const key = JSON.stringify([
    scope,
    resource?.projectId,
    resource?.workspaceScope,
    resource?.entityId,
    resource?.fileObjectUuid,
  ]);
  const reader = useMemo(
    () =>
      new InventoryScientificProductionReadSession(
        client,
        scope,
        resource ? { context: { kind: 'protocol-run', entityId: resource.entityId } } : {},
        openProjectResourceReference
      ),
    [client, key]
  );
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot),
    pendingSnapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot);
  const [selection, setSelection] = useState<{
      resource: ScientificProductionResource;
      resume?: InventoryAttempt;
    } | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelection(null);
    setError(null);
    void reader.open();
    try {
      pending.refresh();
    } catch (cause) {
      setError(message(cause));
    }
    return () => reader.dispose();
  }, [reader, pending]);
  const pendingAttempt = pendingSnapshot.attempts.find(
    (row) =>
      row.request.project === scope.project &&
      row.request.inventoryId === scope.inventoryId &&
      'kind' in row.request &&
      row.request.kind === 'record-scientific-production'
  );
  function resumeOriginal() {
    if (
      !pendingAttempt ||
      !('kind' in pendingAttempt.request) ||
      pendingAttempt.request.kind !== 'record-scientific-production'
    )
      return;
    if (resource && resource.entityId !== pendingAttempt.request.choices.context.entityId) {
      setError('Use Inventory Saved productions to confirm the original report for its Run.');
      return;
    }
    setSelection({
      resource: resource ?? {
        projectId: scope.project,
        workspaceScope: scope.project,
        entityId: pendingAttempt.request.choices.context.entityId,
        fileObjectUuid: null,
      },
      resume: pendingAttempt,
    });
  }
  const { list, detail, source } = snapshot;
  return (
    <>
      <section
        className="space-y-3 rounded border border-border p-4"
        data-testid="recorded-scientific-productions"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Recorded productions</h3>
          <Button onClick={() => void reader.refresh()}>Refresh recorded productions</Button>
          {resource ? (
            <Button
              disabled={!canCreate || Boolean(pendingAttempt)}
              onClick={() => setSelection({ resource })}
            >
              Record completed production
            </Button>
          ) : null}
        </div>
        <p>
          Manual production reports preserve the DNA design, inputs, measured product and saved Run
          context.
        </p>
        {resource && !canCreate ? (
          <p>Save or confirm existing Run changes before recording a new production.</p>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {pendingAttempt ? (
          <Notice>
            An original production request needs confirmation.{' '}
            <Button onClick={resumeOriginal}>Resume original production report</Button>
          </Notice>
        ) : null}
        {list.kind === 'loading' ? (
          <p role="status">Loading recorded productions…</p>
        ) : list.kind === 'unavailable' ? (
          <Notice tone="error">{list.message}</Notice>
        ) : list.kind === 'inventory-absent' ? (
          <p>This project has no inventory yet.</p>
        ) : (
          <>
            {!list.productions.length ? <p>No recorded productions.</p> : null}
            {list.productions.map((row) => (
              <article
                key={row.id}
                className="space-y-2 rounded border border-border p-3"
                data-production-id={row.id}
              >
                <p className="font-semibold">
                  {row.output.lotName} · {inventoryAmountLabel(row.output.quantity)}
                </p>
                <p>
                  {row.design.document.name} · {row.context.source.title}
                </p>
                <p>
                  {inventoryPrincipalLabel(row.by)} · {new Date(row.at).toISOString()}
                </p>
                <Button
                  onClick={() =>
                    void reader.detail({ productionId: row.id, intentSha256: row.intentSha256 })
                  }
                >
                  View recorded production
                </Button>
              </article>
            ))}
            <div className="flex gap-2">
              <Button disabled={!snapshot.cursor} onClick={() => void reader.refresh()}>
                First productions page
              </Button>
              <Button disabled={!list.nextCursor} onClick={() => void reader.next()}>
                Next productions page
              </Button>
            </div>
          </>
        )}
        {detail.kind === 'loading' ? (
          <p role="status">Loading the exact recorded production…</p>
        ) : detail.kind === 'unavailable' ? (
          <Notice tone="error">{detail.message}</Notice>
        ) : detail.kind === 'available' ? (
          <section className="space-y-3" data-testid="scientific-production-detail">
            <ScientificProductionFacts production={detail.production} />
            <div className="flex flex-wrap gap-2">
              <Button disabled={source.kind === 'loading'} onClick={() => void reader.source()}>
                View saved production sources
              </Button>
              <Button onClick={() => void reader.openCurrent('run')}>
                Open current production Run
              </Button>
              <Button onClick={() => void reader.openCurrent('design')}>
                Open current DNA design
              </Button>
            </div>
            {snapshot.navigationError ? (
              <Notice tone="error">{snapshot.navigationError}</Notice>
            ) : null}
            {source.kind === 'loading' ? (
              <p role="status">Verifying the original saved sources…</p>
            ) : source.kind === 'unavailable' ? (
              <Notice tone="error">{source.message}</Notice>
            ) : source.kind === 'available' ? (
              <section className="space-y-3" data-testid="scientific-production-source">
                <h4 className="font-semibold">
                  DNA design used: {source.design.binding.document.name}
                </h4>
                <p>
                  {source.design.binding.document.length} bases ·{' '}
                  {source.design.binding.document.topology} · original accepted design
                </p>
                <TextArea
                  aria-label="Original accepted DNA design"
                  readOnly
                  value={source.design.representation.text}
                />
                <h4 className="font-semibold">Saved Run: {source.source.title}</h4>
                <FrozenProtocolDefinition
                  raw={parseProtocolPackage(source.source.originalText).raw}
                />
                <details>
                  <summary>Original saved Run and source identities</summary>
                  <TextArea
                    aria-label="Original production Run source"
                    readOnly
                    value={source.source.originalText}
                  />
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(
                      {
                        design: source.design.binding,
                        proofSha256: source.design.proofSha256,
                        sourceSha256: source.sourceSha256,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </section>
            ) : null}
          </section>
        ) : null}
      </section>
      {selection ? (
        <InventoryScientificProductionForm
          key={`${key}:${selection.resume?.request.operationId ?? 'draft'}`}
          scope={scope}
          resource={selection.resource}
          canCreate={Boolean(resource && canCreate)}
          resume={selection.resume}
          onClose={() => {
            setSelection(null);
            void reader.refresh();
          }}
        />
      ) : null}
    </>
  );
}
export function RunScientificProductions({
  resource,
  canCreate,
}: {
  resource: ScientificProductionResource | null;
  canCreate: boolean;
}) {
  const client = platform().inventory;
  const [scope, setScope] = useState<ScientificProductionScope | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setScope(null);
    setError(null);
    if (!resource || resource.projectId !== resource.workspaceScope) {
      setError('The saved Run project identity is unavailable.');
      return;
    }
    void client
      .projects()
      .then((projects) => {
        if (cancelled) return;
        const project = projects.find((row) => row.projectId === resource.projectId);
        if (!project) throw Error('The Run inventory project is unavailable.');
        setScope({ project: project.projectId, inventoryId: project.defaultInventoryId });
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, resource?.projectId, resource?.workspaceScope, resource?.entityId]);
  return scope && resource ? (
    <InventoryScientificProductions scope={scope} resource={resource} canCreate={canCreate} />
  ) : (
    <section className="space-y-2 rounded border border-border p-4">
      <h3>Recorded productions</h3>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p role="status">Loading production inventory project…</p>
      )}
    </section>
  );
}
export function InventorySavedProductions({
  scope,
  onClose,
}: {
  scope: ScientificProductionScope;
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
          aria-label="Saved productions"
          data-testid="inventory-saved-productions"
          className="flex max-h-[calc(100vh-40px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Saved productions</h2>
            <Button onClick={onClose}>Close saved productions</Button>
          </header>
          <main className="min-h-0 overflow-auto p-4">
            <InventoryScientificProductions scope={scope} />
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Recorded productions are unavailable.';
}
