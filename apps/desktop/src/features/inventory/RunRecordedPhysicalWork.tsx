import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { InventoryScientificWork } from '@waypoint/domain-services';
import { parseProtocolPackage } from '@waypoint/domain-services/protocol-package';
import { Button, Notice } from '../../components/ui';
import { platform } from '../../platform';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import type { ProtocolRunSavedSource } from '../../shared/protocol-packages';
import { FrozenProtocolDefinition } from '../scientific-document/FrozenProtocolDefinition';
import {
  InventoryScientificWorkReadSession,
  type InventoryRunResource,
} from './inventory-scientific-work-read-session';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
import {
  InventoryScientificCitations,
  InventoryCitationHost,
  type CitationSelection,
} from './InventoryScientificCitations';

export function RunRecordedPhysicalWork({ resource }: { resource: InventoryRunResource | null }) {
  const client = platform().inventory;
  const session = useMemo(
    () => new InventoryScientificWorkReadSession(client, resource, openProjectResourceReference),
    [client, resource?.projectId, resource?.workspaceScope, resource?.entityId]
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [citationSelection, setCitationSelection] = useState<CitationSelection | null>(null);
  useEffect(() => {
    setCitationSelection(null);
  }, [resource?.projectId, resource?.workspaceScope, resource?.entityId]);
  useEffect(() => {
    void session.open();
    return () => session.dispose();
  }, [session]);
  const status = snapshot.status;
  return (
    <section
      className="space-y-3 rounded border border-border p-4"
      data-testid="run-recorded-physical-work"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Recorded physical work</h2>
        <Button
          disabled={status.kind === 'loading' || status.kind === 'resolving'}
          onClick={() => void session.refresh()}
        >
          Refresh
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        Completed manual transfers recorded with this Run. Balances and locations show what was
        recorded at the time.
      </p>
      {status.kind === 'loading' || status.kind === 'resolving' ? (
        <p role="status" className="text-sm">
          Loading recorded physical work…
        </p>
      ) : status.kind === 'unavailable' ? (
        <Notice tone="error">
          <p>Recorded physical work could not be loaded.</p>
          <p>{status.message}</p>
          <Button onClick={() => void session.refresh()}>Retry</Button>
        </Notice>
      ) : status.kind === 'inventory-absent' ? (
        <Notice>
          <p>This project has no inventory yet.</p>
          <Button onClick={() => void session.refresh()}>Retry</Button>
        </Notice>
      ) : (
        <>
          {status.read.works.length === 0 ? (
            <p className="text-sm">No recorded physical work for this Run.</p>
          ) : null}
          {status.read.works.map((work) => (
            <article
              key={work.id}
              className="space-y-3 rounded border border-border p-3 text-sm"
              data-scientific-work-id={work.id}
            >
              <WorkFacts work={work} />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    snapshot.source.kind === 'loading' && snapshot.source.workId === work.id
                  }
                  onClick={() => void session.viewSavedContext(work.id)}
                >
                  View saved context
                </Button>
                <Button onClick={() => void session.openCurrent(work.id)}>Open current Run</Button>
              </div>
              {snapshot.source.kind !== 'idle' && snapshot.source.workId === work.id ? (
                snapshot.source.kind === 'loading' ? (
                  <p role="status">Loading saved context…</p>
                ) : snapshot.source.kind === 'unavailable' ? (
                  <Notice tone="error">{snapshot.source.message}</Notice>
                ) : snapshot.source.read.source.schema ===
                  'dnaforge.protocol-run-saved-source.v1' ? (
                  <SavedRunContext source={snapshot.source.read.source} />
                ) : null
              ) : null}
              <InventoryScientificCitations
                target={{
                  project: status.scope.projectId,
                  inventoryId: status.scope.inventoryId,
                  workId: work.id,
                  workIntentSha256: work.intentSha256,
                }}
                onSelect={setCitationSelection}
              />
            </article>
          ))}
          <div className="flex gap-2">
            <Button disabled={!status.cursor} onClick={() => void session.refresh()}>
              First page
            </Button>
            <Button disabled={!status.read.nextCursor} onClick={() => void session.next()}>
              Next page
            </Button>
          </div>
        </>
      )}
      {snapshot.navigationError ? <Notice tone="error">{snapshot.navigationError}</Notice> : null}
      <InventoryCitationHost
        projectId={resource?.projectId ?? null}
        selection={citationSelection}
        onSelect={setCitationSelection}
      />
    </section>
  );
}

function WorkFacts({ work }: { work: InventoryScientificWork }) {
  const source = work.effects.source,
    destination = work.effects.destination;
  return (
    <>
      <h3 className="font-semibold">
        Manual transfer · {inventoryAmountLabel(work.transfer.quantity)}
      </h3>
      <p>
        From {source.vessel.name} to {destination.vessel.name}
      </p>
      <p>
        Source balance at recording: {inventoryAmountLabel(source.before.quantity)} →{' '}
        {inventoryAmountLabel(source.after.quantity)}
      </p>
      <p>Destination aliquot at recording: {inventoryAmountLabel(destination.after.quantity)}</p>
      <p>
        {inventoryPrincipalLabel(work.by)} ·{' '}
        <time dateTime={new Date(work.at).toISOString()}>{new Date(work.at).toISOString()}</time>
      </p>
      <p>{work.reason}</p>
      <details>
        <summary>Recorded identities and locations</summary>
        <dl className="mt-2 space-y-1 break-all text-xs">
          <dt>Source stock</dt>
          <dd>{source.before.id}</dd>
          <dt>Source vessel</dt>
          <dd>{source.vessel.id}</dd>
          <dt>Source location at recording</dt>
          <dd>{placementLabel(source.vessel.placement)}</dd>
          <dt>Destination stock</dt>
          <dd>{destination.after.id}</dd>
          <dt>Destination vessel</dt>
          <dd>{destination.vessel.id}</dd>
          <dt>Destination location at recording</dt>
          <dd>{placementLabel(destination.vessel.placement)}</dd>
          <dt>Work identity</dt>
          <dd>
            {work.identity.namespace} / {work.identity.workId}
          </dd>
          <dt>Saved source</dt>
          <dd>{work.context.source.sha256}</dd>
        </dl>
      </details>
    </>
  );
}
function placementLabel(
  placement: InventoryScientificWork['effects']['source']['vessel']['placement']
) {
  return placement.kind === 'located'
    ? `${placement.storageId} / ${placement.slotId}`
    : 'Unlocated';
}
function SavedRunContext({ source }: { source: ProtocolRunSavedSource }) {
  try {
    const saved = parseProtocolPackage(source.originalText);
    return (
      <section
        className="space-y-3 border-t border-border pt-3"
        data-testid="run-retained-scientific-source"
      >
        <h4 className="font-semibold">Saved Run context: {source.title}</h4>
        <p>This copy preserves the Run context from when the transfer was recorded.</p>
        <p>Run status at recording: {String(saved.raw.status).replace('_', ' ')}</p>
        <FrozenProtocolDefinition raw={saved.raw} />
        <details>
          <summary>Complete saved Run record</summary>
          <textarea
            aria-label="Saved Run source"
            readOnly
            value={source.originalText}
            rows={10}
            className="mt-2 w-full rounded border border-border bg-bg p-2 font-mono text-xs"
          />
        </details>
      </section>
    );
  } catch {
    return <Notice tone="error">The saved Run context could not be displayed.</Notice>;
  }
}
