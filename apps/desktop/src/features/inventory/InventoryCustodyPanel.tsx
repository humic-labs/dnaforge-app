import type { InventoryCustodyDestination } from '@waypoint/domain-services';
import { Button, Notice } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import type { InventoryCustodyDialog } from './InventoryCustodyForm';
import {
  inventoryBlockerLabel,
  inventoryCustodyLabel,
  inventoryLocationPathLabel,
  inventoryPrincipalLabel,
  locationPath,
  vesselLocation,
  type InventoryItem,
} from './inventory-view';

export function inventoryDestinationLabel(
  data: InventoryData,
  destination: InventoryCustodyDestination
): string {
  if (destination.kind === 'root') return 'Top level';
  if (destination.kind === 'unplaced') return 'Unplaced';
  if (destination.kind === 'stack-top')
    return `${locationPath(data.state, destination.stackId)} / Top of stack`;
  return `${locationPath(data.state, destination.storageId)} / ${destination.slotId}`;
}

export function InventoryCustodyPanel({
  data,
  item,
  editable,
  onDialog,
  onOpenItem,
}: {
  data: InventoryData;
  item: InventoryItem;
  editable: boolean;
  onDialog(dialog: InventoryCustodyDialog): void;
  onOpenItem(item: InventoryItem): void;
}) {
  const view = data.availability?.items[item.id];
  const record =
    item.kind === 'storage' ? data.state.storage[item.id] : data.state.vessels[item.id];
  if (!view || !record)
    return <Notice>Custody is unavailable. Refresh inventory to load its current state.</Notice>;
  const fixedWell = item.kind === 'vessel' && data.state.vessels[item.id].kind === 'fixed-well';
  const governor =
    view.root && view.root.id !== item.id
      ? view.root
      : fixedWell && record.placement.kind === 'located'
        ? { kind: 'storage' as const, id: record.placement.storageId }
        : null;
  const governorRecord = governor
    ? governor.kind === 'storage'
      ? data.state.storage[governor.id]
      : data.state.vessels[governor.id]
    : undefined;
  const currentLocation =
    record.lifecycle === 'disposed'
      ? 'Disposed'
      : view.state.kind === 'missing'
        ? 'Location unknown'
        : view.state.kind !== 'available'
          ? inventoryCustodyLabel(view)
          : item.kind === 'vessel'
            ? vesselLocation(data.state, data.state.vessels[item.id], view)
            : inventoryDestinationLabel(data, view.placement);
  const actions: readonly {
    allowed: boolean;
    label: string;
    action: InventoryCustodyDialog['action'];
  }[] = [
    { allowed: view.actions.checkout, label: 'Check out', action: 'checkout' },
    { allowed: view.actions.startTransit, label: 'Start transfer', action: 'transit' },
    {
      allowed: view.actions.return,
      label: view.state.kind === 'in-transit' ? 'Record arrival' : 'Return',
      action: 'return',
    },
    { allowed: view.actions.reportMissing, label: 'Report missing', action: 'missing' },
    { allowed: view.actions.locate, label: 'Record location', action: 'locate' },
  ];
  const blockers = [...new Map(view.blockers.map((blocker) => [blocker.code, blocker])).values()];
  return (
    <section
      data-testid="inventory-custody"
      data-item-id={item.id}
      data-custody-state={view.state.kind}
      data-effective-state={view.state.kind}
      data-governing-item-id={governor?.id ?? view.root?.id}
      className="space-y-3 rounded border border-border p-3 text-sm"
    >
      <div>
        <h3 className="text-xs font-medium text-fg-muted">Custody</h3>
        <p className="mt-1 font-medium">
          {record.lifecycle === 'disposed' ? 'Disposed' : inventoryCustodyLabel(view)}
          {view.inherited && governorRecord ? ` with ${governorRecord.name}` : ''}
        </p>
      </div>
      <dl className="space-y-3 text-xs">
        <div>
          <dt className="text-fg-muted">Current location</dt>
          <dd data-testid="inventory-current-location" className="mt-1 break-words">
            {currentLocation}
          </dd>
        </div>
        {view.state.kind !== 'available' && view.state.holder ? (
          <div>
            <dt className="text-fg-muted">Recorded holder</dt>
            <dd className="mt-1 break-words">
              {inventoryPrincipalLabel(view.state.holder, data.availability?.principal)}
            </dd>
          </div>
        ) : null}
        {view.state.kind === 'checked-out' && view.state.dueAt !== null ? (
          <div>
            <dt className="text-fg-muted">Expected return</dt>
            <dd className="mt-1">
              {new Date(view.state.dueAt).toLocaleString()}
              {view.overdue ? ' · Past expected return' : ''}
            </dd>
          </div>
        ) : null}
        {view.state.kind === 'in-transit' ? (
          <div>
            <dt className="text-fg-muted">Intended destination</dt>
            <dd className="mt-1 break-words">
              {inventoryDestinationLabel(data, view.state.destination)}
            </dd>
          </div>
        ) : null}
        {view.lastKnown ? (
          <div>
            <dt className="text-fg-muted">Last recorded location</dt>
            <dd data-testid="inventory-last-known-location" className="mt-1 space-y-1 break-words">
              <p>
                {inventoryLocationPathLabel(view.lastKnown.path) ||
                  (view.lastKnown.placement.kind === 'root'
                    ? 'Top level'
                    : view.lastKnown.placement.kind === 'unplaced'
                      ? 'Unplaced'
                      : 'Recorded position unavailable')}
              </p>
              <p className="text-fg-muted">
                Recorded {new Date(view.lastKnown.observedAt).toLocaleString()}
              </p>
              {view.lastKnown.relativePath.length ? (
                <p className="text-fg-muted">
                  Recorded relative position:{' '}
                  {inventoryLocationPathLabel(view.lastKnown.relativePath)}
                  {view.lastKnown.relativeAt !== null
                    ? ` · ${new Date(view.lastKnown.relativeAt).toLocaleString()}`
                    : ''}
                </p>
              ) : null}
            </dd>
          </div>
        ) : null}
        {view.state.kind !== 'available' ? (
          <div>
            <dt className="text-fg-muted">Reason</dt>
            <dd className="mt-1 break-words">{view.state.reason}</dd>
          </div>
        ) : null}
      </dl>
      {blockers.map((blocker) => (
        <p
          key={`${blocker.code}:${'lotId' in blocker ? blocker.lotId : ''}`}
          data-blocker-code={blocker.code}
          className="text-xs text-fg-muted"
        >
          {inventoryBlockerLabel(blocker, data.state)}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {governor && governorRecord ? (
          <Button onClick={() => onOpenItem(governor)}>
            {governor.kind === 'storage' &&
            data.state.storage[governor.id].layout.kind === 'fixed-well'
              ? 'Open plate'
              : `Open ${governorRecord.name}`}
          </Button>
        ) : null}
        {!fixedWell
          ? actions
              .filter((action) => action.allowed)
              .map((action) => (
                <Button
                  key={action.action}
                  disabled={!editable}
                  onClick={() => onDialog({ kind: 'custody', item, action: action.action })}
                >
                  {action.label}
                </Button>
              ))
          : null}
      </div>
    </section>
  );
}
