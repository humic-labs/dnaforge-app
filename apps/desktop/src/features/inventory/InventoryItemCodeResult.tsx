import { inventoryVesselContents } from '@waypoint/domain-services';
import { inventoryContentsLabel } from './inventory-contents-view';
import { Button, Notice } from '../../components/ui';
import type { InventoryItemCodeLookupSnapshot } from '../../shared/inventory-client';
import { inventoryExpectedItemCode } from './inventory-item-code-view';
import { inventoryAmountLabel } from './InventoryReservations';
import {
  inventoryBlockerLabel,
  inventoryCustodyLabel,
  inventoryLocationPathLabel,
  type InventoryItem,
} from './inventory-view';

export function InventoryItemCodeResult({
  lookup,
  materialNames,
  expected,
  onInspect,
}: {
  lookup: InventoryItemCodeLookupSnapshot;
  materialNames: Readonly<Record<string, string>>;
  expected?: { projectId: string; inventoryId: string; item: InventoryItem };
  onInspect(item: InventoryItem): void;
}) {
  const result = lookup.resolution;
  const matches =
    result.kind === 'resolved' || result.kind === 'retired'
      ? [result.match]
      : result.kind === 'ambiguous'
        ? result.matches
        : [];
  const expectedMatch = expected ? inventoryExpectedItemCode(lookup, expected) : null;
  return (
    <section
      data-testid="inventory-code-result"
      data-resolution={result.kind}
      data-inventory-revision={lookup.revision}
      className="space-y-3"
    >
      <h3 className="text-sm font-semibold">
        {result.kind === 'invalid'
          ? 'Invalid code'
          : result.kind === 'not-found'
            ? 'No exact code found'
            : result.kind === 'ambiguous'
              ? 'Ambiguous code'
              : result.kind === 'retired'
                ? 'Retired code'
                : 'Code found'}
      </h3>
      {result.kind === 'invalid' ? <Notice tone="error">{result.message}</Notice> : null}
      {result.kind === 'not-found' ? (
        <p className="text-sm">No exact binding exists in this project and inventory.</p>
      ) : null}
      {result.kind === 'ambiguous' ? (
        <Notice>
          Multiple namespaces contain this exact code. Choose a namespace to check one binding.
        </Notice>
      ) : null}
      {expectedMatch !== null ? (
        <Notice tone={expectedMatch ? 'neutral' : 'warning'}>
          <span data-testid="inventory-code-expected-match" data-matches={String(expectedMatch)}>
            {expectedMatch
              ? result.kind === 'retired'
                ? 'This retired code identifies the selected item.'
                : 'Code matches the selected item.'
              : 'Wrong item: this code identifies a different physical item.'}
          </span>
        </Notice>
      ) : null}
      {matches.map((match) => {
        const target = lookup.targets.find(
          (candidate) =>
            candidate.item.kind === match.item.kind && candidate.item.id === match.item.id
        );
        const custody = target?.custody;
        const contents =
          target && 'limits' in target.record
            ? inventoryVesselContents(
                {
                  vessels: { [target.record.id]: target.record },
                  stocks: Object.fromEntries(target.stocks.map(({ stock }) => [stock.id, stock])),
                },
                target.record.id
              )
            : null;
        const current = !target
          ? 'Unavailable'
          : target.record.lifecycle === 'disposed'
            ? 'Disposed'
            : custody?.state.kind === 'missing'
              ? 'Location unknown'
              : custody && custody.state.kind !== 'available'
                ? inventoryCustodyLabel(custody)
                : target.currentLocationPath?.length
                  ? inventoryLocationPathLabel(target.currentLocationPath)
                  : target.record.placement.kind === 'root'
                    ? 'Top level'
                    : target.record.placement.kind === 'unplaced'
                      ? 'Unplaced'
                      : 'Unavailable';
        return (
          <article
            key={match.id}
            data-code-id={match.id}
            data-code-state={match.lifecycle.kind}
            data-item-id={match.item.id}
            data-item-kind={match.item.kind}
            className="space-y-3 rounded border border-border p-3 text-xs"
          >
            <h4 className="text-sm font-semibold">{target?.record.name ?? match.item.id}</h4>
            <p className="break-all">
              {match.item.kind}:{match.item.id}
            </p>
            <p>
              Namespace: <code>{JSON.stringify(match.namespace)}</code>
            </p>
            <p>
              Exact code:{' '}
              <code className="whitespace-pre-wrap break-all">{JSON.stringify(match.value)}</code>
            </p>
            <p className="font-medium">
              {match.lifecycle.kind === 'active' ? 'Active' : 'Retired'}
            </p>
            {match.lifecycle.kind === 'retired' ? (
              <p>Retirement reason: {match.lifecycle.reason}</p>
            ) : null}
            {target ? (
              <>
                <p>
                  Item state:{' '}
                  {target.record.lifecycle === 'disposed'
                    ? 'Disposed'
                    : inventoryCustodyLabel(target.custody)}
                </p>
                <div>
                  <p className="text-fg-muted">Current location</p>
                  <p data-testid="inventory-code-current-location">{current}</p>
                </div>
                {custody?.lastKnown ? (
                  <div className="space-y-1">
                    <p className="text-fg-muted">Last known location</p>
                    <p data-testid="inventory-code-last-known-location">
                      {inventoryLocationPathLabel(custody.lastKnown.path) ||
                        (custody.lastKnown.placement.kind === 'root' ? 'Top level' : 'Unplaced')}
                    </p>
                    <p className="text-fg-muted">
                      Recorded {new Date(custody.lastKnown.observedAt).toLocaleString()}
                    </p>
                    {custody.lastKnown.relativePath.length ? (
                      <p>
                        Relative position:{' '}
                        {inventoryLocationPathLabel(custody.lastKnown.relativePath)}
                        {custody.lastKnown.relativeAt === null
                          ? ''
                          : ` · ${new Date(custody.lastKnown.relativeAt).toLocaleString()}`}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {target.stocks.length ? (
                  target.stocks.map(({ stock, availability }) => (
                    <div key={stock.id} data-stock-id={stock.id} className="space-y-1">
                      <p>Stock: {stock.id}</p>
                      <p title={stock.materialId}>
                        Material: {materialNames[stock.materialId] ?? stock.materialId}
                      </p>
                      <p>
                        On hand: {inventoryAmountLabel(availability.onHand)} · Held:{' '}
                        {inventoryAmountLabel(availability.held)} · Unreserved:{' '}
                        {inventoryAmountLabel(availability.unreserved)}
                      </p>
                      {availability.blockers.map((blocker) => (
                        <p
                          key={`${blocker.code}:${'lotId' in blocker ? blocker.lotId : ''}`}
                          data-blocker-code={blocker.code}
                        >
                          {inventoryBlockerLabel(blocker)}
                        </p>
                      ))}
                    </div>
                  ))
                ) : (
                  <p>
                    {contents
                      ? inventoryContentsLabel(contents)
                      : 'No stock is recorded in this item.'}
                  </p>
                )}
                <Button onClick={() => onInspect(match.item)}>Inspect item</Button>
              </>
            ) : (
              <Notice>Current target facts are unavailable.</Notice>
            )}
          </article>
        );
      })}
      <p className="break-all text-xs text-fg-muted">
        Project {lookup.projectId} · Inventory {lookup.inventoryId} · Revision {lookup.revision}
      </p>
    </section>
  );
}
