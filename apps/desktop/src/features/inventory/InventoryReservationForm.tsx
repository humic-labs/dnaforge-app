import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  normalizeInventoryAmount,
  type InventoryAmountUnit,
  type InventoryCommand,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  PresentationScopeContext,
  usePresentationListener,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryStatusNotice } from './InventoryStatusNotice';
import {
  inventoryAmountLabel,
  inventoryReservationOwner,
  type InventoryReservationDialog,
} from './InventoryReservations';
import { inventoryAmountUnitLabel, inventoryAmountUnitOptions } from './inventory-view';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function InventoryReservationForm({
  dialog,
  data,
  controller,
  status,
  onClose,
}: {
  dialog: InventoryReservationDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const [amount, setAmount] = useState('');
  const stockId = 'stockId' in dialog ? dialog.stockId : undefined;
  const stock = stockId ? data.state.stocks[stockId] : undefined;
  const [unit, setUnit] = useState<InventoryAmountUnit>(stock?.quantity.unit ?? 'uL');
  const [purpose, setPurpose] = useState('');
  const [expiry, setExpiry] = useState<'none' | 'deadline'>('none');
  const [deadline, setDeadline] = useState('');
  const [reason, setReason] = useState('');
  const [reservationId, setReservationId] = useState(
    dialog.kind === 'fulfill-reservation' ? (dialog.reservationId ?? '') : ''
  );
  const [validation, setValidation] = useState<string | null>(null);
  const busy = status.kind === 'submitting';
  const unknownWithdrawal = Boolean(stock && stock.quantity.kind === 'unknown');
  const editable = inventoryCanEdit(status) && !unknownWithdrawal;
  const action =
    dialog.kind === 'reservation-action'
      ? data.availability?.reservations[dialog.reservationId]
      : undefined;
  const title =
    dialog.kind === 'reserve-quantity'
      ? 'Reserve quantity'
      : dialog.kind === 'reserve-item'
        ? dialog.item.kind === 'storage'
          ? 'Reserve location'
          : 'Reserve item'
        : dialog.kind === 'fulfill-reservation'
          ? 'Use reserved stock'
          : dialog.action === 'release'
            ? 'Release reservation'
            : dialog.action === 'cancel'
              ? 'Cancel reservation'
              : 'Record expiry';
  const eligible = stockId
    ? (data.availability?.stocks[stockId]?.reservationIds ?? []).flatMap((id) => {
        const view = data.availability?.reservations[id];
        return view?.actions.fulfill ? [view] : [];
      })
    : [];

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    events.add(document, 'keydown', key);
    return () => events.remove(document, 'keydown', key);
  }, [events, busy, onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (!editable) return;
    try {
      if (dialog.kind === 'reserve-quantity' || dialog.kind === 'fulfill-reservation')
        normalizeInventoryAmount({ value: amount, unit });
      let command: InventoryCommand;
      if (dialog.kind === 'reserve-quantity' || dialog.kind === 'reserve-item') {
        const expiresAt = expiry === 'none' ? null : new Date(deadline).getTime();
        if (expiresAt !== null && !Number.isFinite(expiresAt))
          throw new Error('Enter a valid deadline.');
        const common = { id: crypto.randomUUID(), deadline: expiresAt, purpose: purpose.trim() };
        command =
          dialog.kind === 'reserve-quantity'
            ? {
                kind: 'reserve-quantity',
                ...common,
                stockId: dialog.stockId,
                quantity: { value: amount, unit },
              }
            : { kind: 'reserve-item', ...common, item: dialog.item };
      } else if (dialog.kind === 'fulfill-reservation') {
        command = {
          kind: 'fulfill-reservations',
          claims: [{ reservationId, quantity: { value: amount, unit } }],
          withdrawal: {
            kind: 'consume',
            stockId: dialog.stockId,
            quantity: { value: amount, unit },
            reason: reason.trim(),
          },
        };
      } else if (dialog.action === 'expire') {
        command = { kind: 'expire-reservations', ids: [dialog.reservationId] };
      } else {
        command = {
          kind: dialog.action === 'release' ? 'release-reservation' : 'cancel-reservation',
          reservationId: dialog.reservationId,
          reason: reason.trim(),
        };
      }
      if (await controller.submit([command], title)) onClose();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Check the reservation values.');
    }
  }

  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-reservation-form-title"
          className="flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="inventory-reservation-form-title" className="text-lg font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              {stockId
                ? data.state.vessels[data.state.stocks[stockId].vesselId].name
                : (action?.reservation.purpose ?? data.project.name)}
            </p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {validation ? <Notice tone="error">{validation}</Notice> : null}
              {dialog.kind === 'fulfill-reservation' ? (
                <>
                  <Field label="Reservation">
                    <Select
                      ariaLabel="Reservation"
                      value={reservationId}
                      options={[
                        { value: '', label: 'Choose a reservation to fulfill' },
                        ...eligible.map((view) => ({
                          value: view.reservation.id,
                          label: view.reservation.purpose,
                          description: `${inventoryReservationOwner(view)}${view.reservation.kind === 'quantity' ? ` · ${inventoryAmountLabel(view.reservation.remaining)} remaining` : ''}`,
                        })),
                      ]}
                      onValueChange={setReservationId}
                    />
                  </Field>
                  <Notice>
                    This use explicitly fulfills the selected reservation and withdraws the entered
                    amount.
                  </Notice>
                </>
              ) : null}
              {dialog.kind === 'reserve-quantity' || dialog.kind === 'fulfill-reservation' ? (
                <>
                  <Field label={`Quantity (${inventoryAmountUnitLabel(unit)})`}>
                    <TextField
                      aria-label={`Quantity (${inventoryAmountUnitLabel(unit)})`}
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Unit">
                    <Select
                      ariaLabel="Unit"
                      value={unit}
                      options={inventoryAmountUnitOptions(stock?.quantity.unit)}
                      onValueChange={(value) => setUnit(value as InventoryAmountUnit)}
                    />
                  </Field>
                  {unknownWithdrawal ? (
                    <Notice>
                      Record a measured quantity before allocating or using this stock.
                    </Notice>
                  ) : null}
                </>
              ) : null}
              {dialog.kind === 'reserve-quantity' || dialog.kind === 'reserve-item' ? (
                <>
                  <Field label="Purpose">
                    <TextArea
                      aria-label="Purpose"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Reservation expiry">
                    <Select
                      ariaLabel="Reservation expiry"
                      value={expiry}
                      options={[
                        { value: 'none', label: 'No expiry' },
                        { value: 'deadline', label: 'Set deadline' },
                      ]}
                      onValueChange={(value) => setExpiry(value as 'none' | 'deadline')}
                    />
                  </Field>
                  {expiry === 'deadline' ? (
                    <Field label="Deadline">
                      <TextField
                        aria-label="Deadline"
                        type="datetime-local"
                        value={deadline}
                        onChange={(event) => setDeadline(event.target.value)}
                        required
                      />
                    </Field>
                  ) : null}
                  <Notice>This reservation allocates inventory for planned work.</Notice>
                </>
              ) : dialog.kind === 'reservation-action' && dialog.action === 'expire' ? (
                <Notice>
                  Mark this past-deadline reservation as expired. Its allocation is released when
                  expiry is recorded.
                </Notice>
              ) : (
                <Field label="Reason">
                  <TextArea
                    aria-label="Reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                </Field>
              )}
              {dialog.kind === 'reservation-action' && dialog.action === 'cancel' ? (
                <Notice>
                  Cancellation is an explicit override by this desktop profile. Its reason is
                  retained in history.
                </Notice>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!editable}>
                {busy ? 'Saving…' : title}
              </Button>
            </div>
          </form>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
