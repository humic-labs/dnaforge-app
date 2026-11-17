import { useEffect } from 'react';
import { Button, Notice } from '../../components/ui';
import type { InventoryController, InventoryData } from './inventory-controller';
import {
  InventoryValidityFactDetails,
  type InventoryValidityDialog,
} from './InventoryValidityForms';
import { inventoryValidityRuleLabel } from './inventory-validity-view';
import { inventoryPrincipalLabel, inventoryStockAction } from './inventory-view';

export function useInventoryValidityRefresh(
  data: InventoryData | null,
  controller: InventoryController
) {
  useEffect(() => {
    const snapshot = data?.availability;
    if (
      !snapshot ||
      snapshot.revision !== data.state.revision ||
      snapshot.projectId !== data.project.projectId ||
      snapshot.inventoryId !== data.project.defaultInventoryId
    )
      return;
    const boundaries = Object.values(snapshot.stocks).flatMap((stock) =>
      typeof stock.validity?.nextBoundaryAt === 'number' ? [stock.validity.nextBoundaryAt] : []
    );
    const stockroom = data?.stockroom;
    const reportBoundaries =
      stockroom &&
      stockroom.projectId === data.project.projectId &&
      stockroom.inventoryId === data.project.defaultInventoryId &&
      stockroom.revision === data.state.revision
        ? Object.values(stockroom.reorderRules).flatMap((result) =>
            result.kind === 'ready' && result.assessment.nextBoundaryAt !== null
              ? [result.assessment.nextBoundaryAt - stockroom.asOf]
              : []
          )
        : [];
    const delays = [...boundaries.map((boundary) => boundary - snapshot.asOf), ...reportBoundaries];
    if (!delays.length) return;
    const delay = Math.max(
      1,
      delays.reduce((first, next) => Math.min(first, next), 2147483647)
    );
    const timer = setTimeout(() => {
      void controller.refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [data?.availability, data?.stockroom, data?.state.revision, controller]);
}

export function InventoryValidityPanel({
  data,
  stockId,
  editable,
  controller,
  onDialog,
}: {
  data: InventoryData;
  stockId: string;
  editable: boolean;
  controller: InventoryController;
  onDialog(dialog: InventoryValidityDialog): void;
}) {
  const stock = data.state.stocks[stockId];
  if (!stock) return null;
  const observation = stock.opening.observationId
    ? data.state.openingObservations[stock.opening.observationId]
    : null;
  const facts = inventoryStockAction(data, stockId, 'withdraw')
    ? data.availability?.stocks[stockId]
    : undefined;
  const validity = facts?.validity;
  const opening =
    stock.opening.kind === 'unobserved'
      ? observation
        ? 'Opening status unknown after correction'
        : 'Opening status unobserved'
      : stock.opening.kind === 'sealed-observed'
        ? 'Observed sealed'
        : observation?.observedAt === null
          ? 'Observed opened; opening time unknown'
          : 'Observed opened';
  return (
    <section
      className="space-y-3 rounded border border-border p-3"
      data-testid="inventory-stock-validity"
      data-validity-state={validity?.state ?? 'unavailable'}
    >
      <h3 className="text-sm font-semibold">Opening and validity</h3>
      <p data-opening-state={stock.opening.kind}>{opening}</p>
      {observation ? (
        <div className="space-y-1 text-xs">
          <p>
            Observed time:{' '}
            {observation.observedAt === null
              ? 'Unknown'
              : new Date(observation.observedAt).toISOString()}
          </p>
          <p className="break-all">Opening observation: {observation.id}</p>
          <p className="break-words">{observation.reason}</p>
          <p>
            {inventoryPrincipalLabel(
              observation.by,
              data.availability?.principal ?? data.storageConditions.principal
            )}{' '}
            · Recorded {new Date(observation.at).toISOString()}
          </p>
          <details>
            <summary>Retained opening observations</summary>
            {Object.values(data.state.openingObservations)
              .filter((fact) => fact.stockId === stockId)
              .map((fact) => (
                <p key={fact.id} className="break-all">
                  {fact.id} · {fact.kind} · {fact.value} · Observed{' '}
                  {fact.observedAt === null ? 'Unknown' : new Date(fact.observedAt).toISOString()} ·{' '}
                  {fact.reason}
                </p>
              ))}
          </details>
        </div>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {stock.opening.kind !== 'opened-observed' ? (
            <Button onClick={() => onDialog({ kind: 'opening', stockId })}>Record opening</Button>
          ) : null}
          {stock.opening.observationId ? (
            <Button
              onClick={() =>
                onDialog({ kind: 'opening', stockId, supersedesId: stock.opening.observationId! })
              }
            >
              Correct opening
            </Button>
          ) : null}
          <Button onClick={() => onDialog({ kind: 'validity', owner: { kind: 'stock', stockId } })}>
            Add validity rule
          </Button>
        </div>
      ) : null}
      {validity ? (
        <>
          <p className="text-xs" data-validity-as-of={validity.asOf}>
            Native observation time: {new Date(validity.asOf).toISOString()}
          </p>
          <p>
            Recorded rules: {validity.state === 'legacy-untracked' ? 'Not managed' : validity.state}
          </p>
          <p>
            Earliest cutoff:{' '}
            {validity.effectiveDeadlineAt === null
              ? 'No established cutoff'
              : new Date(validity.effectiveDeadlineAt).toISOString()}
          </p>
          <p className="text-xs">
            Next native refresh boundary:{' '}
            {validity.nextBoundaryAt === null
              ? 'None'
              : new Date(validity.nextBoundaryAt).toISOString()}
          </p>
          <p data-validity-action="reserve">Reserve: {facts.actions.reserve.kind}</p>
          <p data-validity-action="withdraw">Withdraw: {facts.actions.withdraw.kind}</p>
          {validity.coverage !== 'managed' ? (
            <Notice>
              Expiry not fully tracked ({validity.coverage}). Current recorded rules do not
              establish that all material is unexpired.
            </Notice>
          ) : null}
          {validity.families.map((family) => (
            <article
              key={family.rootId}
              className="space-y-2 border-t border-border pt-3"
              data-validity-family={family.rootId}
            >
              <p className="text-xs font-semibold">
                {family.owner.kind === 'lot'
                  ? `Lot: ${data.state.lots[family.owner.lotId]?.name ?? family.owner.lotId}`
                  : `Stock: ${data.state.vessels[data.state.stocks[family.owner.stockId]?.vesselId]?.name ?? family.owner.stockId}`}{' '}
                · {family.state}
              </p>
              <p className="text-xs">{inventoryValidityRuleLabel(family.rule)}</p>
              {family.deadlineAt !== null ? (
                <p className="text-xs">
                  Effective family cutoff: {new Date(family.deadlineAt).toISOString()}
                </p>
              ) : null}
              {family.opening ? (
                <p className="break-all text-xs">
                  Original opening owner: {family.opening.stockId} · {family.opening.state.kind} ·
                  Opening time{' '}
                  {family.opening.observation?.observedAt == null
                    ? 'Unknown'
                    : new Date(family.opening.observation.observedAt).toISOString()}
                </p>
              ) : null}
              {family.openingNoLaterThan !== null ? (
                <p className="text-xs">
                  Opening must be no later than the recorded derivation:{' '}
                  {new Date(family.openingNoLaterThan).toISOString()}
                </p>
              ) : null}
              <InventoryValidityFactDetails
                fact={data.state.validityFacts[family.headId]}
                data={data}
              />
              <details>
                <summary className="text-xs">Retained family decisions</summary>
                {Object.values(data.state.validityFacts)
                  .filter((fact) => fact.rootId === family.rootId)
                  .map((fact) => (
                    <InventoryValidityFactDetails key={fact.id} fact={fact} data={data} />
                  ))}
              </details>
              {editable ? (
                <Button
                  aria-label={`Correct validity rule ${family.rootId}`}
                  onClick={() =>
                    onDialog({ kind: 'validity', owner: family.owner, headId: family.headId })
                  }
                >
                  Correct this rule
                </Button>
              ) : null}
            </article>
          ))}
        </>
      ) : (
        <Notice>
          Native availability is unavailable or stale. Refresh before reserving or withdrawing
          material.
        </Notice>
      )}
      <Button onClick={() => void controller.refresh()}>Refresh validity</Button>
    </section>
  );
}
