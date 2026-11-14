import type { InventoryMaterialDialog } from './InventoryMaterialForm';
import type { InventoryCompositionDialog } from './InventoryCompositionForm';
import type { InventoryReservationDialog } from './InventoryReservations';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  inventoryStoragePositions,
  inventoryWellId,
  type InventoryCommand,
  type InventoryLocatedPlacement,
  type InventoryLayout,
  type InventoryVolumeUnit,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  PresentationScopeContext,
  usePresentationListener,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryClient, InventoryMaterialPage } from '../../shared/inventory-client';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { inventoryCanEdit } from './inventory-controller';
import { InventoryStatusNotice } from './InventoryStatusNotice';
import {
  destinationCommands,
  destinationPositions,
  locationPath,
  vesselLocation,
  type InventoryDialog,
} from './inventory-view';

type OpenDialog = Exclude<
  InventoryDialog,
  | InventoryMaterialDialog
  | InventoryCompositionDialog
  | InventoryReservationDialog
  | { kind: 'none' }
>;
type Materials =
  | { kind: 'loading' }
  | { kind: 'ready'; page: InventoryMaterialPage }
  | { kind: 'failed' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function InventoryForm({
  dialog,
  data,
  status,
  controller,
  client,
  onClose,
  onMaterial,
}: {
  dialog: OpenDialog;
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  client: InventoryClient;
  onClose: () => void;
  onMaterial: (id: string, name: string) => void;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const state = data.state;
  const stock = 'stockId' in dialog ? state.stocks[dialog.stockId] : undefined;
  const moving =
    dialog.kind === 'move'
      ? dialog.item.kind === 'storage'
        ? state.storage[dialog.item.id]
        : state.vessels[dialog.item.id]
      : undefined;
  const initialPlacement =
    dialog.kind === 'receive'
      ? dialog.placement
      : moving?.placement.kind === 'located'
        ? moving.placement
        : undefined;
  const [name, setName] = useState('');
  const [positions, setPositions] = useState('A1, A2, A3, A4');
  const [layoutKind, setLayoutKind] = useState<InventoryLayout['kind']>('named');
  const [rows, setRows] = useState('8');
  const [columns, setColumns] = useState('12');
  const [capacity, setCapacity] = useState('10');
  const [storageId, setStorageId] = useState(
    initialPlacement?.storageId ?? (dialog.kind === 'location' ? (dialog.parentId ?? '') : '')
  );
  const [position, setPosition] = useState(initialPlacement?.slotId ?? '');
  const [quantityKind, setQuantityKind] = useState<'known' | 'unknown'>(
    stock?.quantity.kind ?? 'known'
  );
  const [quantity, setQuantity] = useState(
    stock?.quantity.kind === 'known' && dialog.kind === 'reconcile' ? stock.quantity.value : ''
  );
  const [unit, setUnit] = useState<InventoryVolumeUnit>('uL');
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [lotId, setLotId] = useState('');
  const [containerId, setContainerId] = useState(
    dialog.kind === 'receive' ? (dialog.vesselId ?? '') : ''
  );
  const [materials, setMaterials] = useState<Materials>({ kind: 'loading' });
  const [validation, setValidation] = useState<string | null>(null);
  const canSubmit = inventoryCanEdit(status);
  const selectedStorage = state.storage[storageId];
  const fixedWell = dialog.kind === 'receive' && selectedStorage?.layout.kind === 'fixed-well';
  const selectedContainer = state.vessels[containerId];
  const busy = status.kind === 'submitting';
  const title =
    dialog.kind === 'location'
      ? 'Add location'
      : dialog.kind === 'receive'
        ? 'Receive stock'
        : dialog.kind === 'move'
          ? `Move ${dialog.item.kind === 'storage' ? 'location' : 'container'}`
          : dialog.kind === 'use'
            ? 'Use stock'
            : dialog.kind === 'reconcile'
              ? 'Record quantity'
              : dialog.kind === 'quality'
                ? dialog.quality === 'quarantined'
                  ? 'Quarantine stock'
                  : 'Release stock'
                : 'Dispose';

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    events.add(document, 'keydown', key);
    return () => events.remove(document, 'keydown', key);
  }, [events, busy, onClose]);

  useEffect(() => {
    if (dialog.kind !== 'receive') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setMaterials({ kind: 'loading' });
      void client
        .materials({ project: data.project.projectId, query, limit: 50 })
        .then((page) => {
          if (!cancelled) setMaterials({ kind: 'ready', page });
        })
        .catch(() => {
          if (!cancelled) setMaterials({ kind: 'failed' });
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, dialog.kind, query]);

  const available = useMemo(() => {
    if (!selectedStorage) return [];
    if (fixedWell)
      return inventoryStoragePositions(selectedStorage).filter((id) => {
        const vesselId = inventoryWellId(selectedStorage.id, id);
        return (
          state.vessels[vesselId]?.lifecycle === 'active' &&
          !Object.values(state.stocks).some((item) => item.vesselId === vesselId)
        );
      });
    return destinationPositions(state, selectedStorage, moving?.id);
  }, [selectedStorage, fixedWell, state, moving?.id]);
  const selectedPosition = available.includes(position) ? position : (available[0] ?? '');
  const destinations = Object.values(state.storage).filter(
    (item) =>
      item.lifecycle === 'active' &&
      item.id !== moving?.id &&
      (dialog.kind === 'receive' || item.layout.kind !== 'fixed-well')
  );
  const containers = Object.values(state.vessels).filter(
    (item) =>
      item.kind === 'movable' &&
      item.lifecycle === 'active' &&
      !Object.values(state.stocks).some((stock) => stock.vesselId === item.id)
  );

  function destination(): InventoryLocatedPlacement | null {
    return storageId ? { kind: 'located', storageId, slotId: selectedPosition } : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (!canSubmit) return;
    try {
      const commands: InventoryCommand[] = [];
      if (dialog.kind === 'location') {
        const layout: InventoryLayout =
          layoutKind === 'named'
            ? {
                kind: 'named',
                slots: positions
                  .split(/[,\n]/)
                  .map((slot) => slot.trim())
                  .filter(Boolean),
              }
            : layoutKind === 'stack'
              ? { kind: 'stack', capacity: Number(capacity), removal: 'top-only' }
              : { kind: layoutKind, rows: Number(rows), columns: Number(columns) };
        if (!name.trim()) throw new Error('Enter a location name.');
        if (layout.kind === 'named' && layout.slots.length === 0)
          throw new Error('Add at least one named position.');
        const id = crypto.randomUUID();
        const target = destination();
        commands.push({
          kind: 'create-layout-storage',
          id,
          name: name.trim(),
          layout,
          placement:
            selectedStorage?.layout.kind === 'stack'
              ? { kind: 'root' }
              : (target ?? { kind: 'root' }),
        });
        if (selectedStorage?.layout.kind === 'stack')
          commands.push({
            kind: 'push-stack',
            stackId: selectedStorage.id,
            item: { kind: 'storage', id },
          });
      } else if (dialog.kind === 'receive') {
        if (!materialId) throw new Error('Choose a material from this project.');
        let vesselId = containerId;
        if (!vesselId && fixedWell) {
          if (!selectedPosition) throw new Error('Choose an empty well.');
          vesselId = inventoryWellId(storageId, selectedPosition);
        } else if (!vesselId) {
          if (!name.trim()) throw new Error('Enter a container name.');
          vesselId = crypto.randomUUID();
          const target = destination();
          commands.push({
            kind: 'create-vessel',
            id: vesselId,
            name: name.trim(),
            placement:
              selectedStorage?.layout.kind === 'stack'
                ? { kind: 'unplaced' }
                : (target ?? { kind: 'unplaced' }),
          });
          if (selectedStorage?.layout.kind === 'stack')
            commands.push({
              kind: 'push-stack',
              stackId: selectedStorage.id,
              item: { kind: 'vessel', id: vesselId },
            });
        }
        commands.push(
          lotId
            ? {
                kind: 'receive-lot-stock',
                id: crypto.randomUUID(),
                vesselId,
                lotId,
                quantity:
                  quantityKind === 'unknown'
                    ? { kind: 'unknown' }
                    : { kind: 'known', value: quantity, unit },
                quality: 'usable',
              }
            : {
                kind: 'receive-stock',
                id: crypto.randomUUID(),
                vesselId,
                materialId,
                quantity:
                  quantityKind === 'unknown'
                    ? { kind: 'unknown' }
                    : { kind: 'known', value: quantity, unit },
                quality: 'usable',
              }
        );
      } else if (dialog.kind === 'move') {
        if (storageId && !selectedPosition) throw new Error('Choose an available position.');
        commands.push(...destinationCommands(state, dialog.item, destination()));
      } else if (dialog.kind === 'use') {
        commands.push({
          kind: 'consume',
          stockId: dialog.stockId,
          quantity: { value: quantity, unit },
          reason: reason.trim(),
        });
      } else if (dialog.kind === 'reconcile') {
        commands.push({
          kind: 'reconcile',
          stockId: dialog.stockId,
          quantity:
            quantityKind === 'unknown'
              ? { kind: 'unknown' }
              : { kind: 'known', value: quantity, unit },
          reason: reason.trim(),
        });
      } else if (dialog.kind === 'quality') {
        commands.push({
          kind: 'set-quality',
          stockId: dialog.stockId,
          quality: dialog.quality,
          reason: reason.trim(),
        });
      } else {
        commands.push(
          dialog.item.kind === 'storage'
            ? { kind: 'dispose-plate', id: dialog.item.id, reason: reason.trim() }
            : { kind: 'dispose-vessel', id: dialog.item.id, reason: reason.trim() }
        );
      }
      if (await controller.submit(commands, title)) onClose();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Check the entered values.');
    }
  }

  const placementFields =
    dialog.kind === 'location' ||
    dialog.kind === 'move' ||
    (dialog.kind === 'receive' && !containerId) ? (
      <>
        <Field label="Location">
          <Select
            ariaLabel="Location"
            testId="inventory-form-location"
            value={storageId}
            options={[
              {
                value: '',
                label:
                  dialog.kind === 'location' ||
                  (dialog.kind === 'move' && dialog.item.kind === 'storage')
                    ? 'Top level'
                    : 'Unplaced',
              },
              ...destinations.map((item) => ({
                value: item.id,
                label: locationPath(state, item.id),
              })),
            ]}
            onValueChange={(value) => {
              setStorageId(value);
              setPosition('');
            }}
          />
        </Field>
        {selectedStorage ? (
          <Field label={fixedWell ? 'Well' : 'Position'}>
            <Select
              ariaLabel={fixedWell ? 'Well' : 'Position'}
              testId="inventory-form-position"
              value={selectedPosition}
              disabled={available.length === 0}
              options={
                available.length
                  ? available.map((id) => ({
                      value: id,
                      label: id === 'top' ? 'Next position on top' : id,
                    }))
                  : [{ value: '', label: 'No available positions' }]
              }
              onValueChange={setPosition}
            />
          </Field>
        ) : null}
      </>
    ) : null;
  const quantityFields =
    dialog.kind === 'receive' || dialog.kind === 'reconcile' || dialog.kind === 'use' ? (
      <>
        {dialog.kind !== 'use' ? (
          <Field label="Quantity">
            <Select
              ariaLabel="Quantity measurement"
              value={quantityKind}
              options={[
                { value: 'known', label: 'Measured quantity' },
                { value: 'unknown', label: 'Unknown quantity' },
              ]}
              onValueChange={(value) => setQuantityKind(value as 'known' | 'unknown')}
            />
          </Field>
        ) : null}
        {dialog.kind === 'use' || quantityKind === 'known' ? (
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field label={dialog.kind === 'use' ? 'Amount to use' : 'Amount'}>
              <TextField
                aria-label="Quantity"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="0"
                required
              />
            </Field>
            <Field label="Unit">
              <Select
                ariaLabel="Unit"
                value={unit}
                options={['uL', 'mL', 'L', 'nL'].map((value) => ({
                  value,
                  label: value === 'uL' ? 'µL' : value,
                }))}
                onValueChange={(value) => setUnit(value as InventoryVolumeUnit)}
              />
            </Field>
          </div>
        ) : null}
      </>
    ) : null;

  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-form-title"
          data-testid={`inventory-${dialog.kind}-dialog`}
          className="flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="inventory-form-title" className="text-lg font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">{data.project.name}</p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {validation ? <Notice tone="error">{validation}</Notice> : null}
              {dialog.kind === 'location' ? (
                <>
                  <Field label="Location name">
                    <TextField
                      autoFocus
                      aria-label="Location name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Freezer 1, shelf, box, or plate"
                      required
                    />
                  </Field>
                  <Field label="Positions">
                    <Select
                      ariaLabel="Position layout"
                      value={layoutKind}
                      options={[
                        { value: 'named', label: 'Named positions' },
                        { value: 'grid', label: 'Grid' },
                        { value: 'removable-tube', label: 'Tube box' },
                        { value: 'fixed-well', label: 'Well plate' },
                        { value: 'stack', label: 'Ordered stack' },
                      ]}
                      onValueChange={(value) => setLayoutKind(value as InventoryLayout['kind'])}
                    />
                  </Field>
                  {layoutKind === 'named' ? (
                    <Field label="Position names, separated by commas">
                      <TextArea
                        aria-label="Position names"
                        value={positions}
                        onChange={(event) => setPositions(event.target.value)}
                        rows={3}
                        required
                      />
                    </Field>
                  ) : layoutKind === 'stack' ? (
                    <Field label="Stack capacity">
                      <TextField
                        aria-label="Stack capacity"
                        type="number"
                        min={1}
                        max={10000}
                        value={capacity}
                        onChange={(event) => setCapacity(event.target.value)}
                        required
                      />
                    </Field>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Rows">
                        <TextField
                          aria-label="Rows"
                          type="number"
                          min={1}
                          max={10000}
                          value={rows}
                          onChange={(event) => setRows(event.target.value)}
                          required
                        />
                      </Field>
                      <Field label="Columns">
                        <TextField
                          aria-label="Columns"
                          type="number"
                          min={1}
                          max={10000}
                          value={columns}
                          onChange={(event) => setColumns(event.target.value)}
                          required
                        />
                      </Field>
                    </div>
                  )}
                </>
              ) : null}
              {dialog.kind === 'receive' ? (
                <>
                  <Field label="Find material">
                    <TextField
                      autoFocus
                      aria-label="Find material"
                      value={query}
                      onChange={(event) => {
                        setMaterialId('');
                        setLotId('');
                        setQuery(event.target.value);
                      }}
                      placeholder="Search this project’s materials"
                    />
                  </Field>
                  <Field label="Material">
                    <Select
                      ariaLabel="Material"
                      testId="inventory-material-picker"
                      value={materialId}
                      loading={materials.kind === 'loading'}
                      options={[
                        { value: '', label: 'Choose a material' },
                        ...(materials.kind === 'ready'
                          ? materials.page.items.map((item) => ({
                              value: item.id,
                              label: item.name,
                              description: item.registryId ?? item.kind,
                            }))
                          : []),
                      ]}
                      onValueChange={(id) => {
                        setMaterialId(id);
                        setLotId('');
                        const item =
                          materials.kind === 'ready'
                            ? materials.page.items.find((item) => item.id === id)
                            : undefined;
                        if (item) onMaterial(id, item.name);
                      }}
                    />
                  </Field>
                  {materials.kind === 'failed' ? (
                    <Notice tone="error">
                      Materials could not be loaded. Change the search to try again.
                    </Notice>
                  ) : materials.kind === 'ready' && materials.page.items.length === 0 ? (
                    <Notice>
                      No matching materials in this project. Create or import a scientific record in
                      Registry first.
                    </Notice>
                  ) : materials.kind === 'ready' && materials.page.nextCursor ? (
                    <p className="text-xs text-fg-muted">
                      Showing the first matching materials. Refine the search to find another
                      record.
                    </p>
                  ) : null}
                  {materialId ? (
                    <Field label="Lot or preparation">
                      <Select
                        ariaLabel="Lot or preparation"
                        value={lotId}
                        options={[
                          { value: '', label: 'Unattributed stock' },
                          ...Object.values(state.lots)
                            .filter((lot) => lot.materialId === materialId)
                            .map((lot) => ({ value: lot.id, label: lot.name })),
                        ]}
                        onValueChange={setLotId}
                      />
                    </Field>
                  ) : null}
                  {containers.length > 0 ? (
                    <Field label="Container">
                      <Select
                        ariaLabel="Container"
                        value={containerId}
                        options={[
                          { value: '', label: 'New container or well' },
                          ...containers.map((item) => ({
                            value: item.id,
                            label: item.name,
                            description: vesselLocation(state, item),
                          })),
                        ]}
                        onValueChange={setContainerId}
                      />
                    </Field>
                  ) : null}
                  {selectedContainer ? (
                    <Notice>
                      Receive into {selectedContainer.name} at{' '}
                      {vesselLocation(state, selectedContainer)}.
                    </Notice>
                  ) : !fixedWell ? (
                    <Field label="Container name">
                      <TextField
                        aria-label="Container name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Tube 1"
                        required
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}
              {placementFields}
              {quantityFields}
              {dialog.kind === 'use' && stock ? (
                <Notice>
                  Recorded quantity:{' '}
                  {stock.quantity.kind === 'known'
                    ? `${stock.quantity.value} ${stock.quantity.unit === 'uL' ? 'µL' : stock.quantity.unit}`
                    : 'Unknown'}
                  .
                </Notice>
              ) : null}
              {dialog.kind === 'dispose' ? (
                <Notice tone="warning">
                  Disposal releases the occupied position and retains the recorded history.{' '}
                  {dialog.item.kind === 'storage'
                    ? 'Every well in this plate will be disposed.'
                    : 'This container cannot be used again.'}
                </Notice>
              ) : null}
              {['use', 'reconcile', 'quality', 'dispose'].includes(dialog.kind) ? (
                <Field label="Reason">
                  <TextArea
                    aria-label="Reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={2}
                    required
                  />
                </Field>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button disabled={busy} onClick={onClose}>
                {status.kind === 'outcome-unknown' ? 'Close' : 'Cancel'}
              </Button>
              <Button
                type="submit"
                variant={dialog.kind === 'dispose' ? 'danger' : 'primary'}
                disabled={
                  !canSubmit || Boolean(selectedStorage && !containerId && available.length === 0)
                }
              >
                {busy ? 'Saving…' : title}
              </Button>
            </div>
          </form>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
