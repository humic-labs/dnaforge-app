import { Button, Notice, Select, TextField } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import { inventoryAmountLabel, inventoryReservationOwner } from './InventoryReservations';
import { inventoryAmountUnitLabel } from './inventory-view';

export interface InventoryReservationClaimRow {
  id: string;
  reservationId: string;
  quantity: string;
}

export function InventoryReservationClaims({
  data,
  stockIds,
  claims,
  onChange,
}: {
  data: InventoryData;
  stockIds: readonly string[];
  claims: readonly InventoryReservationClaimRow[];
  onChange(claims: readonly InventoryReservationClaimRow[]): void;
}) {
  const ids = [
    ...new Set(
      stockIds.flatMap((stockId) => data.availability?.stocks[stockId]?.reservationIds ?? [])
    ),
  ];
  const eligible = ids.flatMap((id) => {
    const view = data.availability?.reservations[id];
    return view?.actions.fulfill ? [view] : [];
  });
  return (
    <div
      className="space-y-3 rounded border border-border p-3"
      data-testid="inventory-reservation-claims"
    >
      <p className="text-xs font-medium text-fg-muted">Reservation claims</p>
      <Notice>
        {claims.length
          ? 'Each claim explicitly spends the entered amount from its reservation. Any remaining withdrawal must be unreserved.'
          : 'This operation uses unreserved quantity. Add a claim to deliberately fulfill a reservation.'}
      </Notice>
      {claims.map((claim, index) => {
        const reservation = data.availability?.reservations[claim.reservationId]?.reservation;
        const stock = stockIds.length === 1 ? data.state.stocks[stockIds[0]] : undefined;
        const unit = inventoryAmountUnitLabel(
          reservation?.kind === 'quantity'
            ? reservation.remaining.unit
            : (stock?.quantity.unit ?? 'uL')
        );
        return (
          <div key={claim.id} className="space-y-2">
            <Select
              ariaLabel={`Reservation claim ${index + 1}`}
              value={claim.reservationId}
              options={[
                { value: '', label: 'Choose a reservation' },
                ...eligible.map((view) => ({
                  value: view.reservation.id,
                  label: view.reservation.purpose,
                  description: `${inventoryReservationOwner(view)}${view.reservation.kind === 'quantity' ? ` · ${inventoryAmountLabel(view.reservation.remaining)} remaining` : ''}`,
                })),
              ]}
              onValueChange={(reservationId) =>
                onChange(
                  claims.map((row) => (row.id === claim.id ? { ...row, reservationId } : row))
                )
              }
            />
            <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
              <span>{`Reservation claim ${index + 1} quantity (${unit})`}</span>
              <TextField
                aria-label={`Reservation claim ${index + 1} quantity (${unit})`}
                inputMode="decimal"
                value={claim.quantity}
                onChange={(event) =>
                  onChange(
                    claims.map((row) =>
                      row.id === claim.id ? { ...row, quantity: event.target.value } : row
                    )
                  )
                }
                required
              />
            </label>
            <Button
              onClick={() => onChange(claims.filter((row) => row.id !== claim.id))}
            >{`Remove reservation claim ${index + 1}`}</Button>
          </div>
        );
      })}
      <Button
        disabled={!eligible.length || claims.length >= 256}
        onClick={() =>
          onChange([...claims, { id: crypto.randomUUID(), reservationId: '', quantity: '' }])
        }
      >
        Add reservation claim
      </Button>
    </div>
  );
}
