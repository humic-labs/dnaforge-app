import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  parseProtocolPackage,
  type InventoryPlatePlanObservation,
} from '@waypoint/domain-services';
import { Button, Notice, TextArea } from '../../components/ui';
import { platform } from '../../platform';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import type { InventoryPlatePlanObservationsRequest } from '../../shared/inventory-plate-plan-observations';
import { FrozenProtocolDefinition } from '../scientific-document/FrozenProtocolDefinition';
import type { InventoryRunResource } from './inventory-scientific-work-read-session';
import { InventoryPlatePlanObservationReadSession } from './inventory-plate-plan-observation-read-session';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
export function PlatePlanObservationFacts({
  observation,
  proposed = false,
}: {
  observation: InventoryPlatePlanObservation;
  proposed?: boolean;
}) {
  return (
    <article
      className="space-y-3 rounded border border-border p-3"
      data-testid="plate-plan-observation-facts"
      data-observation-id={observation.id}
    >
      <h4 className="font-semibold">
        {proposed ? 'Proposed whole manual use record' : 'Reported completed manual plate-plan use'}
      </h4>
      <p>
        {observation.plate.name} · {observation.plate.layout.rows} ×{' '}
        {observation.plate.layout.columns} · {observation.actions.length} ordered transfers
      </p>
      <p>
        {inventoryPrincipalLabel(observation.by)} · {new Date(observation.at).toISOString()}
      </p>
      <p>{observation.reason}</p>
      {observation.effects.sources.map((source) => (
        <div data-source-stock-id={source.before.id} key={source.before.id}>
          <p>
            {source.vessel.name}: {inventoryAmountLabel(source.before.quantity)} →{' '}
            {inventoryAmountLabel(source.after.quantity)}
          </p>
        </div>
      ))}
      <ol className="space-y-2">
        {observation.actions.map((action) => {
          const destination = observation.effects.destinations.find(
            (item) => item.actionId === action.actionId
          );
          return (
            <li key={action.actionId} data-action-id={action.actionId}>
              <p>
                Step {action.ordinal}: {inventoryAmountLabel(action.transfer.quantity)} →{' '}
                {destination?.vessel.name ?? action.transfer.destination.vesselId}
              </p>
            </li>
          );
        })}
      </ol>
      <p>
        This record preserves the manual report and saved context from the time it was recorded.
      </p>
      <details>
        <summary>Recorded identities, plate geometry and exact stock facts</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(observation, null, 2)}
        </pre>
      </details>
    </article>
  );
}
export function InventoryPlatePlanObservations({
  scope,
  filters,
}: {
  scope: PlatePlanScope;
  filters: Pick<InventoryPlatePlanObservationsRequest, 'version' | 'context'>;
}) {
  const key = JSON.stringify([scope, filters]),
    client = platform().inventory,
    session = useMemo(
      () =>
        new InventoryPlatePlanObservationReadSession(
          client,
          scope,
          filters,
          openProjectResourceReference
        ),
      [client, key]
    ),
    snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    void session.open();
    return () => session.dispose();
  }, [session]);
  const { list, detail, source } = snapshot;
  return (
    <section
      className="space-y-3 rounded border border-border p-4"
      data-testid="recorded-plate-plan-uses"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Recorded plate-plan uses</h3>
        <Button disabled={list.kind === 'loading'} onClick={() => void session.refresh()}>
          Refresh plate-plan uses
        </Button>
      </div>
      <p>
        Operator-reported whole manual uses, preserved separately from individual transfer records.
      </p>
      {list.kind === 'loading' ? (
        <p role="status">Loading recorded plate-plan uses…</p>
      ) : list.kind === 'unavailable' ? (
        <Notice tone="error">{list.message}</Notice>
      ) : list.kind === 'inventory-absent' ? (
        <p>This project has no inventory yet.</p>
      ) : (
        <>
          {!list.observations.length ? <p>No recorded plate-plan uses.</p> : null}
          {list.observations.map((row) => (
            <article
              key={row.id}
              data-plate-plan-observation-id={row.id}
              className="space-y-2 rounded border border-border p-3"
            >
              <p className="font-semibold">
                {row.planTitle} · {row.actionCount} transfers · {row.plate.name}
              </p>
              <p>
                {inventoryPrincipalLabel(row.by)} · {new Date(row.at).toISOString()}
              </p>
              <p>{row.reason}</p>
              <Button
                onClick={() =>
                  void session.detail({ observationId: row.id, intentSha256: row.intentSha256 })
                }
              >
                View recorded use
              </Button>
            </article>
          ))}
          <div className="flex gap-2">
            <Button disabled={!snapshot.cursor} onClick={() => void session.refresh()}>
              First uses page
            </Button>
            <Button disabled={!list.nextCursor} onClick={() => void session.next()}>
              Next uses page
            </Button>
          </div>
        </>
      )}
      {detail.kind === 'loading' ? (
        <p role="status">Loading the exact recorded use…</p>
      ) : detail.kind === 'unavailable' ? (
        <Notice tone="error">{detail.message}</Notice>
      ) : detail.kind === 'available' ? (
        <section data-testid="plate-plan-observation-detail">
          <PlatePlanObservationFacts observation={detail.observation} />
          <div className="flex gap-2">
            <Button disabled={source.kind === 'loading'} onClick={() => void session.source()}>
              View saved plan-use context
            </Button>
            <Button onClick={() => void session.openCurrent()}>
              Open current plan-use context
            </Button>
          </div>
          {source.kind === 'loading' ? (
            <p role="status">Loading saved context…</p>
          ) : source.kind === 'unavailable' ? (
            <Notice tone="error">{source.message}</Notice>
          ) : source.kind === 'available' ? (
            <section className="space-y-3" data-testid="plate-plan-observation-source">
              <h4 className="font-semibold">Saved context: {source.source.title}</h4>
              {source.source.schema === 'dnaforge.protocol-run-saved-source.v1' ? (
                <FrozenProtocolDefinition
                  raw={parseProtocolPackage(source.source.originalText).raw}
                />
              ) : null}
              <TextArea
                readOnly
                aria-label="Saved plate-plan use context"
                value={JSON.stringify(source.source, null, 2)}
                rows={10}
              />
            </section>
          ) : null}
        </section>
      ) : null}
      {snapshot.navigationError ? <Notice tone="error">{snapshot.navigationError}</Notice> : null}
    </section>
  );
}
export function RunRecordedPlatePlanUses({ resource }: { resource: InventoryRunResource | null }) {
  const client = platform().inventory,
    [scope, setScope] = useState<PlatePlanScope | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setScope(null);
    setError(null);
    if (!resource || resource.workspaceScope !== resource.projectId) {
      setError('This Run’s project identity is unavailable.');
      return;
    }
    void client
      .projects()
      .then((projects) => {
        if (cancelled) return;
        const project = projects.find((item) => item.projectId === resource.projectId);
        if (!project) throw Error('This Run’s inventory project is unavailable.');
        setScope({ project: project.projectId, inventoryId: project.defaultInventoryId });
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : 'The inventory project is unavailable.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [client, resource?.projectId, resource?.workspaceScope, resource?.entityId]);
  return scope && resource ? (
    <InventoryPlatePlanObservations
      scope={scope}
      filters={{ context: { kind: 'protocol-run', entityId: resource.entityId } }}
    />
  ) : (
    <section className="space-y-2 rounded border border-border p-4">
      <h3>Recorded plate-plan uses</h3>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p role="status">Loading inventory project…</p>
      )}
    </section>
  );
}
