import type { InventoryQuantity, InventoryVolume } from '@waypoint/domain-services';
import { Button, Notice } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import type { InventoryItem } from './inventory-view';
import { inventoryBlockerLabel } from './inventory-view';

export type InventoryReservationDialog =
  | { kind: 'reserve-quantity'; stockId: string }
  | { kind: 'reserve-item'; item: InventoryItem }
  | { kind: 'reservation-action'; reservationId: string; action: 'release' | 'cancel' | 'expire' }
  | { kind: 'fulfill-reservation'; stockId: string; reservationId?: string };

export function isInventoryReservationDialog(dialog: {
  kind: string;
}): dialog is InventoryReservationDialog {
  return ['reserve-quantity', 'reserve-item', 'reservation-action', 'fulfill-reservation'].includes(
    dialog.kind
  );
}

type Availability = NonNullable<InventoryData['availability']>;
export type InventoryReservationView = Availability['reservations'][string];

export function inventoryAmountLabel(amount: InventoryQuantity | InventoryVolume): string {
  return 'kind' in amount && amount.kind === 'unknown'
    ? 'Unknown'
    : `${amount.value} ${amount.unit === 'uL' ? 'µL' : amount.unit}`;
}

export function inventoryReservationOwner(view: InventoryReservationView): string {
  const holder = view.reservation.holder;
  return holder.kind === 'agent'
    ? `Agent ${holder.identityId}`
    : view.mine
      ? 'This desktop profile'
      : 'Another desktop profile';
}

export function InventoryStockAvailability({
  data,
  stockId,
}: {
  data: InventoryData;
  stockId: string;
}) {
  const snapshot = data.availability;
  const availability = snapshot?.stocks[stockId];
  if (!snapshot || !availability)
    return <Notice>Availability is unavailable. Refresh inventory before allocating stock.</Notice>;
  const facts: readonly (readonly [string, InventoryQuantity | InventoryVolume])[] = [
    ['On hand', availability.onHand],
    ['Held', availability.held],
    ['Unreserved', availability.unreserved],
    ['Reserved by you', availability.mine],
  ];
  return (
    <section
      data-testid="inventory-stock-availability"
      data-inventory-revision={snapshot.revision}
      className="space-y-3"
    >
      <dl className="grid grid-cols-2 gap-3">
        {facts.map(([label, amount]) => (
          <div key={label}>
            <dt className="text-xs text-fg-muted">{label}</dt>
            <dd data-availability={label} className="mt-1 text-lg font-semibold tabular-nums">
              {inventoryAmountLabel(amount)}
            </dd>
          </div>
        ))}
      </dl>
      {availability.blockers.map((blocker) => (
        <Notice key={blocker.code}>
          <span data-blocker-code={blocker.code}>{inventoryBlockerLabel(blocker)}</span>
        </Notice>
      ))}
      <p className="text-xs text-fg-muted">
        Availability as of {new Date(snapshot.asOf).toLocaleString()}
      </p>
    </section>
  );
}

export function InventoryReservationList({
  data,
  editable,
  reservationIds,
  stockId,
  onDialog,
  onRefresh,
}: {
  data: InventoryData;
  editable: boolean;
  reservationIds?: readonly string[];
  stockId?: string;
  onDialog(dialog: InventoryReservationDialog): void;
  onRefresh(): void;
}) {
  const snapshot = data.availability;
  const reservations = snapshot
    ? (reservationIds ?? Object.keys(snapshot.reservations)).flatMap((id) =>
        snapshot.reservations[id] ? [snapshot.reservations[id]] : []
      )
    : [];
  return (
    <div data-testid="inventory-reservations" className="divide-y divide-border">
      <div className="p-4">
        <Button onClick={onRefresh}>Refresh reservations</Button>
      </div>
      {reservations.length ? (
        reservations.map((view) => {
          const reservation = view.reservation;
          const blockers = [
            ...new Map(view.blockers.map((blocker) => [blocker.code, blocker])).values(),
          ];
          const targetStockId =
            stockId ?? (reservation.kind === 'quantity' ? reservation.stockId : undefined);
          return (
            <article
              key={reservation.id}
              data-reservation-id={reservation.id}
              className="space-y-2 p-4 text-sm"
            >
              <p className="break-words font-medium">{reservation.purpose}</p>
              <p className="text-xs text-fg-muted">{inventoryReservationOwner(view)}</p>
              <p
                data-reservation-state={
                  view.overdue ? 'EXPIRY_PENDING' : reservation.lifecycle.kind
                }
                className="text-xs font-medium"
              >
                {view.overdue
                  ? 'Past deadline'
                  : {
                      active: 'Active',
                      fulfilled: 'Fulfilled',
                      released: 'Released',
                      cancelled: 'Cancelled',
                      expired: 'Expired',
                    }[reservation.lifecycle.kind]}
              </p>
              {reservation.kind === 'quantity' ? (
                <p className="tabular-nums">
                  {inventoryAmountLabel(reservation.remaining)} remaining
                </p>
              ) : (
                <p>
                  {reservation.item.kind === 'storage'
                    ? (data.state.storage[reservation.item.id]?.name ?? reservation.item.id)
                    : (data.state.vessels[reservation.item.id]?.name ?? reservation.item.id)}
                </p>
              )}
              <p className="text-xs text-fg-muted">
                {reservation.deadline === null
                  ? 'No expiry'
                  : `Deadline ${new Date(reservation.deadline).toLocaleString()}`}
              </p>
              {'reason' in reservation.lifecycle ? (
                <p className="break-words text-xs text-fg-muted">{reservation.lifecycle.reason}</p>
              ) : null}
              {blockers.map((blocker) => (
                <p
                  key={blocker.code}
                  data-blocker-code={blocker.code}
                  className="text-xs text-fg-muted"
                >
                  {inventoryBlockerLabel(blocker)}
                </p>
              ))}
              {view.overdue ? (
                <Notice>Past deadline; still allocated until released or expired.</Notice>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {view.actions.fulfill && targetStockId ? (
                  <Button
                    disabled={!editable}
                    onClick={() =>
                      onDialog({
                        kind: 'fulfill-reservation',
                        stockId: targetStockId,
                        reservationId: reservation.id,
                      })
                    }
                  >
                    Use reserved stock
                  </Button>
                ) : null}
                {view.actions.release ? (
                  <Button
                    disabled={!editable}
                    onClick={() =>
                      onDialog({
                        kind: 'reservation-action',
                        reservationId: reservation.id,
                        action: 'release',
                      })
                    }
                  >
                    Release reservation
                  </Button>
                ) : null}
                {view.actions.cancel ? (
                  <Button
                    disabled={!editable}
                    onClick={() =>
                      onDialog({
                        kind: 'reservation-action',
                        reservationId: reservation.id,
                        action: 'cancel',
                      })
                    }
                  >
                    Cancel reservation
                  </Button>
                ) : null}
                {view.actions.expire ? (
                  <Button
                    disabled={!editable}
                    onClick={() =>
                      onDialog({
                        kind: 'reservation-action',
                        reservationId: reservation.id,
                        action: 'expire',
                      })
                    }
                  >
                    Record expiry
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })
      ) : (
        <p className="p-4 text-sm text-fg-muted">No reservations recorded.</p>
      )}
    </div>
  );
}
