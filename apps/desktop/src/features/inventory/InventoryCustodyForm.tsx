import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { InventoryCommand, InventoryCustodyDestination } from '@waypoint/domain-services';
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
import { destinationPositions, locationPath, type InventoryItem } from './inventory-view';
import { InventoryStatusNotice } from './InventoryStatusNotice';

export type InventoryCustodyDialog = {
  kind: 'custody';
  item: InventoryItem;
  action: 'checkout' | 'transit' | 'return' | 'missing' | 'locate';
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function InventoryCustodyForm({
  dialog,
  data,
  controller,
  status,
  onClose,
}: {
  dialog: InventoryCustodyDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const [storageId, setStorageId] = useState('__choose__');
  const [position, setPosition] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const view = data.availability?.items[dialog.item.id];
  const record =
    dialog.item.kind === 'storage'
      ? data.state.storage[dialog.item.id]
      : data.state.vessels[dialog.item.id];
  const busy = status.kind === 'submitting';
  const editable = inventoryCanEdit(status);
  const title =
    dialog.action === 'checkout'
      ? 'Check out'
      : dialog.action === 'transit'
        ? 'Start transfer'
        : dialog.action === 'return'
          ? view?.state.kind === 'in-transit'
            ? 'Record arrival'
            : 'Return'
          : dialog.action === 'missing'
            ? 'Report missing'
            : 'Record location';
  const selectedStorage = data.state.storage[storageId];
  const destinations = Object.values(data.state.storage).filter(
    (storage) =>
      storage.lifecycle === 'active' &&
      storage.id !== dialog.item.id &&
      storage.layout.kind !== 'fixed-well'
  );
  const positions = selectedStorage
    ? destinationPositions(data.state, selectedStorage, dialog.item.id)
    : [];
  const needsDestination =
    dialog.action === 'transit' || dialog.action === 'return' || dialog.action === 'locate';

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

  function destination(): InventoryCustodyDestination {
    if (storageId === '__choose__') throw new Error('Choose the actual destination.');
    if (!storageId) return dialog.item.kind === 'storage' ? { kind: 'root' } : { kind: 'unplaced' };
    if (!selectedStorage || !position) throw new Error('Choose an available position.');
    return selectedStorage.layout.kind === 'stack'
      ? { kind: 'stack-top', stackId: storageId }
      : { kind: 'located', storageId, slotId: position };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (!editable) return;
    try {
      let command: InventoryCommand;
      const common = { item: dialog.item, reason: reason.trim() };
      if (dialog.action === 'checkout') {
        const deadline = dueAt ? new Date(dueAt).getTime() : null;
        if (deadline !== null && !Number.isFinite(deadline))
          throw new Error('Enter a valid expected return time.');
        command = { kind: 'checkout-item', ...common, dueAt: deadline };
      } else if (dialog.action === 'missing') {
        command = { kind: 'report-item-missing', ...common };
      } else {
        command = {
          kind:
            dialog.action === 'transit'
              ? 'start-item-transit'
              : dialog.action === 'return'
                ? 'return-item'
                : 'locate-item',
          ...common,
          destination: destination(),
        };
      }
      if (await controller.submit([command], title)) onClose();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Check the custody values.');
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
          aria-labelledby="inventory-custody-form-title"
          data-testid="inventory-custody-dialog"
          className="flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="inventory-custody-form-title" className="text-lg font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">{record.name}</p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {validation ? <Notice tone="error">{validation}</Notice> : null}
              {dialog.action === 'checkout' ? (
                <Field label="Expected return (optional)">
                  <TextField
                    aria-label="Expected return (optional)"
                    type="datetime-local"
                    value={dueAt}
                    onChange={(event) => setDueAt(event.target.value)}
                  />
                </Field>
              ) : null}
              {needsDestination ? (
                <>
                  <Field label="Location">
                    <Select
                      ariaLabel="Location"
                      testId="inventory-custody-location"
                      value={storageId}
                      options={[
                        { value: '__choose__', label: 'Choose a destination' },
                        {
                          value: '',
                          label: dialog.item.kind === 'storage' ? 'Top level' : 'Unplaced',
                        },
                        ...destinations.map((storage) => ({
                          value: storage.id,
                          label: locationPath(data.state, storage.id),
                        })),
                      ]}
                      onValueChange={(id) => {
                        setStorageId(id);
                        setPosition('');
                      }}
                    />
                  </Field>
                  {selectedStorage ? (
                    <Field label="Position">
                      <Select
                        ariaLabel="Position"
                        testId="inventory-custody-position"
                        value={position}
                        options={[
                          { value: '', label: 'Choose a position' },
                          ...positions.map((id) => ({
                            value: id,
                            label: id === 'top' ? 'Top of stack' : id,
                          })),
                        ]}
                        onValueChange={setPosition}
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}
              {dialog.action === 'missing' ? (
                <Notice>
                  The current location becomes unknown. The last recorded location and inventory
                  amounts remain in history.
                </Notice>
              ) : dialog.action === 'transit' ? (
                <Notice>
                  This records an intended destination. Record arrival when the item reaches its
                  actual destination.
                </Notice>
              ) : dialog.action === 'checkout' ? (
                <Notice>
                  This records handling of the whole item and its contents. Quantity and
                  reservations remain separate.
                </Notice>
              ) : null}
              <Field label="Reason">
                <TextArea
                  aria-label="Reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button disabled={busy} onClick={onClose}>
                {status.kind === 'outcome-unknown' ? 'Close' : 'Cancel'}
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
