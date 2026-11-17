import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  inventoryVesselContentsProjection,
  inventoryAmountUnitDefinition,
  inventoryStockEligibility,
  normalizeInventoryAmount,
  type InventoryAmountUnit,
  type InventoryCommand,
  type InventoryVolumeQuantity,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  PresentationScopeContext,
  usePresentationListener,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryClient, InventoryMaterial } from '../../shared/inventory-client';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryStatusNotice } from './InventoryStatusNotice';
import {
  inventoryAmountLabel,
  inventoryAmountUnitLabel,
  inventoryAmountUnitOptions,
} from './inventory-view';
import {
  InventoryReservationClaims,
  type InventoryReservationClaimRow,
} from './InventoryReservationClaims';

export type InventoryMaterialDialog =
  | { kind: 'lot'; sourceStockId?: string }
  | { kind: 'transfer'; stockId: string }
  | { kind: 'attribute'; stockId: string }
  | { kind: 'pool' | 'dilute'; stockId: string }
  | { kind: 'limits'; vesselId: string };

export function isInventoryMaterialDialog(dialog: {
  kind: string;
}): dialog is InventoryMaterialDialog {
  return ['lot', 'transfer', 'pool', 'dilute', 'limits', 'attribute'].includes(dialog.kind);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function InventoryMaterialForm({
  dialog,
  data,
  controller,
  status,
  client,
  onClose,
}: {
  dialog: InventoryMaterialDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  client: InventoryClient;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const state = data.state;
  const contentsByVessel = useMemo(() => inventoryVesselContentsProjection(state), [state]);
  const source = 'stockId' in dialog ? state.stocks[dialog.stockId] : undefined;
  const title =
    dialog.kind === 'attribute'
      ? 'Assign lot'
      : dialog.kind === 'lot'
        ? 'Add lot or preparation'
        : dialog.kind === 'transfer'
          ? 'Transfer or aliquot'
          : dialog.kind === 'pool'
            ? 'Pool stocks'
            : dialog.kind === 'dilute'
              ? 'Dilute stock'
              : 'Container limits';
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState<'received' | 'prepared'>('received');
  const [attributedLotId, setAttributedLotId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [method, setMethod] = useState('');
  const [query, setQuery] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialsError, setMaterialsError] = useState(false);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<InventoryAmountUnit>(source?.quantity.unit ?? 'uL');
  const [secondAmount, setSecondAmount] = useState('');
  const [secondId, setSecondId] = useState('');
  const [extraInputs, setExtraInputs] = useState<
    readonly { id: string; stockId: string; amount: string }[]
  >([]);
  const [destinationKind, setDestinationKind] = useState<'empty' | 'existing'>('empty');
  const [mixing, setMixing] = useState<'unknown' | 'homogeneous'>('unknown');
  const [destinationId, setDestinationId] = useState('new');
  const [containerName, setContainerName] = useState('');
  const [reason, setReason] = useState('');
  const [claims, setClaims] = useState<readonly InventoryReservationClaimRow[]>([]);
  const vessel = dialog.kind === 'limits' ? state.vessels[dialog.vesselId] : undefined;
  const [capacity, setCapacity] = useState(
    vessel?.limits.capacity.kind === 'known' ? vessel.limits.capacity.value : ''
  );
  const [deadVolume, setDeadVolume] = useState(
    vessel?.limits.deadVolume.kind === 'known' ? vessel.limits.deadVolume.value : ''
  );
  const [validation, setValidation] = useState<string | null>(null);
  const busy = status.kind === 'submitting';
  const volumeSource =
    source && inventoryAmountUnitDefinition(source.quantity.unit).dimension === 'volume';
  const lotBlockers = source
    ? (inventoryStockEligibility(state, source.id)?.blockers.filter(
        (blocker) => blocker.code !== 'STOCK_QUARANTINED'
      ) ?? [])
    : [];
  const withdrawalBlocked =
    (dialog.kind === 'transfer' || dialog.kind === 'pool' || dialog.kind === 'dilute') &&
    (source?.quantity.kind !== 'known' ||
      lotBlockers.length > 0 ||
      (dialog.kind !== 'transfer' && !volumeSource));
  const editable =
    !withdrawalBlocked &&
    !data.project.pinned &&
    (status.kind === 'ready' || (status.kind === 'refused' && !status.recoveryError));
  const emptyVessels = Object.values(state.vessels).filter(
    (item) => item.lifecycle === 'active' && contentsByVessel[item.id]?.kind === 'declared-empty'
  );
  const candidates = Object.values(state.stocks).filter(
    (stock) =>
      stock.id !== source?.id &&
      state.vessels[stock.vesselId].lifecycle === 'active' &&
      stock.quantity.kind === 'known' &&
      !inventoryStockEligibility(state, stock.id)?.blockers.length &&
      inventoryAmountUnitDefinition(stock.quantity.unit).dimension ===
        (dialog.kind === 'transfer' && source
          ? inventoryAmountUnitDefinition(source.quantity.unit).dimension
          : 'volume')
  );
  const stockOptions = candidates.map((stock) => ({
    value: stock.id,
    label: state.vessels[stock.vesselId].name,
    description: `${inventoryAmountLabel(stock.quantity)} · ${stock.source.kind === 'lot' ? state.lots[stock.source.lotId].name : 'Unattributed'}`,
  }));

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
    if (dialog.kind !== 'lot' && dialog.kind !== 'pool' && dialog.kind !== 'dilute') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setMaterialsError(false);
          }
        })
        .catch(() => {
          if (!cancelled) setMaterialsError(true);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, dialog.kind, query]);

  function destination(commands: InventoryCommand[]): string {
    if (destinationId !== 'new') return destinationId;
    if (!containerName.trim()) throw new Error('Enter a destination container name.');
    const id = crypto.randomUUID();
    commands.push({
      kind: 'create-vessel',
      id,
      name: containerName.trim(),
      placement: { kind: 'unplaced' },
    });
    return id;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (!editable) return;
    try {
      const commands: InventoryCommand[] = [];
      if (dialog.kind === 'lot') {
        if (!materialId || !name.trim())
          throw new Error('Choose the material and enter a batch name.');
        if (!reason.trim()) throw new Error('Enter a reason to start managing this lot.');
        const lotId = crypto.randomUUID();
        commands.push({
          kind: 'create-lot',
          id: lotId,
          materialId,
          name: name.trim(),
          origin:
            origin === 'received'
              ? { kind: 'received', supplier: supplier.trim(), lotNumber: lotNumber.trim() }
              : {
                  kind: 'prepared',
                  sourceStockIds: dialog.sourceStockId ? [dialog.sourceStockId] : [],
                  method: method.trim(),
                },
        });
        commands.push({ kind: 'manage-lot', lotId, reason: reason.trim() });
      } else if (dialog.kind === 'attribute') {
        commands.push({
          kind: 'associate-stock-lot',
          stockId: dialog.stockId,
          lotId: attributedLotId,
          reason: reason.trim(),
        });
      } else if (dialog.kind === 'limits') {
        const measured = (value: string): InventoryVolumeQuantity =>
          value.trim() ? { kind: 'known', value: value.trim(), unit: 'uL' } : { kind: 'unknown' };
        commands.push({
          kind: 'set-vessel-limits',
          vesselId: dialog.vesselId,
          limits: { capacity: measured(capacity), deadVolume: measured(deadVolume) },
          reason: reason.trim(),
        });
      } else if (dialog.kind === 'transfer') {
        normalizeInventoryAmount({ value: amount, unit });
        const target =
          destinationKind === 'existing'
            ? { kind: 'existing-stock' as const, stockId: destinationId }
            : {
                kind: 'new-stock' as const,
                stockId: crypto.randomUUID(),
                vesselId: destination(commands),
              };
        commands.push({
          kind: 'transfer',
          sourceStockId: dialog.stockId,
          quantity: { value: amount, unit },
          destination: target,
          ...(destinationKind === 'existing' && volumeSource ? { mixing } : {}),
          reason: reason.trim(),
        });
      } else {
        if (!secondId || !materialId || !name.trim())
          throw new Error('Choose the second stock, output material and output batch name.');
        const output = {
          lotId: crypto.randomUUID(),
          stockId: crypto.randomUUID(),
          vesselId: destination(commands),
          materialId,
          name: name.trim(),
          reason: reason.trim(),
          mixing,
        };
        const first = { stockId: dialog.stockId, quantity: { value: amount, unit: 'uL' as const } };
        const second = {
          stockId: secondId,
          quantity: { value: secondAmount, unit: 'uL' as const },
        };
        commands.push(
          dialog.kind === 'pool'
            ? {
                kind: 'pool',
                ...output,
                inputs: [
                  first,
                  second,
                  ...extraInputs.map((input) => ({
                    stockId: input.stockId,
                    quantity: { value: input.amount, unit: 'uL' as const },
                  })),
                ],
              }
            : { kind: 'dilute', ...output, sample: first, diluent: second }
        );
        commands.push({ kind: 'manage-lot', lotId: output.lotId, reason: reason.trim() });
      }
      const submitted: InventoryCommand[] = claims.length
        ? commands.map<InventoryCommand>((command) =>
            command.kind === 'transfer' || command.kind === 'pool' || command.kind === 'dilute'
              ? {
                  kind: 'fulfill-reservations',
                  claims: claims.map((claim) => {
                    const reservation =
                      data.availability?.reservations[claim.reservationId]?.reservation;
                    const claimUnit =
                      reservation?.kind === 'quantity'
                        ? reservation.remaining.unit
                        : dialog.kind === 'transfer'
                          ? (source?.quantity.unit ?? unit)
                          : 'uL';
                    normalizeInventoryAmount({ value: claim.quantity, unit: claimUnit });
                    return {
                      reservationId: claim.reservationId,
                      quantity: { value: claim.quantity, unit: claimUnit },
                    };
                  }),
                  withdrawal: command,
                }
              : command
          )
        : commands;
      if (await controller.submit(submitted, title)) onClose();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Check the form values.');
    }
  }

  const outputMaterial = (
    <>
      <Field label="Find output material">
        <TextField
          aria-label="Find output material"
          value={query}
          onChange={(event) => {
            setMaterialId('');
            setQuery(event.target.value);
          }}
        />
      </Field>
      <Field label="Output material">
        <Select
          ariaLabel="Output material"
          value={materialId}
          options={[
            { value: '', label: 'Choose a registered material' },
            ...materials.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.registryId ?? item.kind,
            })),
          ]}
          onValueChange={setMaterialId}
        />
      </Field>
      {materialsError ? (
        <Notice tone="error">Materials could not be loaded. Change the search to try again.</Notice>
      ) : null}
    </>
  );
  const emptyDestination = (
    <>
      <Field label="Destination container">
        <Select
          ariaLabel="Destination container"
          value={destinationId}
          options={[
            { value: 'new', label: 'New unplaced container' },
            ...emptyVessels.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={setDestinationId}
        />
      </Field>
      {destinationId === 'new' ? (
        <Field label="Destination container name">
          <TextField
            aria-label="Destination container name"
            value={containerName}
            onChange={(event) => setContainerName(event.target.value)}
            required
          />
        </Field>
      ) : null}
    </>
  );

  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-material-form-title"
          className="flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="inventory-material-form-title" className="text-lg font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              {source ? state.vessels[source.vesselId].name : data.project.name}
            </p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {validation ? <Notice tone="error">{validation}</Notice> : null}
              {dialog.kind === 'attribute' ? (
                <>
                  <Field label="Lot or preparation">
                    <Select
                      ariaLabel="Lot or preparation"
                      value={attributedLotId}
                      options={[
                        { value: '', label: 'Choose a batch of this material' },
                        ...Object.values(state.lots)
                          .filter((lot) => lot.materialId === source?.materialId)
                          .map((lot) => ({ value: lot.id, label: lot.name })),
                      ]}
                      onValueChange={setAttributedLotId}
                    />
                  </Field>
                  <Notice>
                    This changes the selected stock’s attribution. Earlier aliquots and recorded
                    contributions retain their original provenance.
                  </Notice>
                </>
              ) : dialog.kind === 'lot' ? (
                <>
                  <Notice>
                    The new lot starts Unassessed. Record an explicit release decision before its
                    stock can be reserved or used.
                  </Notice>
                  <Field label="Batch name">
                    <TextField
                      aria-label="Batch name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </Field>
                  {outputMaterial}
                  <Field label="Batch origin">
                    <Select
                      ariaLabel="Batch origin"
                      value={origin}
                      options={[
                        { value: 'received', label: 'Supplier lot' },
                        { value: 'prepared', label: 'Internal preparation' },
                      ]}
                      onValueChange={(value) => setOrigin(value as 'received' | 'prepared')}
                    />
                  </Field>
                  {origin === 'received' ? (
                    <>
                      <Field label="Supplier">
                        <TextField
                          aria-label="Supplier"
                          value={supplier}
                          onChange={(event) => setSupplier(event.target.value)}
                          required
                        />
                      </Field>
                      <Field label="Supplier lot number">
                        <TextField
                          aria-label="Supplier lot number"
                          value={lotNumber}
                          onChange={(event) => setLotNumber(event.target.value)}
                          required
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="Preparation method">
                        <TextArea
                          aria-label="Preparation method"
                          value={method}
                          onChange={(event) => setMethod(event.target.value)}
                          required
                        />
                      </Field>
                      <Notice>
                        {dialog.sourceStockId
                          ? 'The selected stock’s identity and provenance will be recorded as an input.'
                          : 'No tracked source stock is selected.'}{' '}
                        Creating a preparation records provenance. Record any material use
                        separately.
                      </Notice>
                    </>
                  )}
                </>
              ) : dialog.kind === 'limits' ? (
                <>
                  <Notice>
                    Leave a limit blank when unknown. Capacity limits additions; dead volume limits
                    withdrawals.
                  </Notice>
                  <Field label="Capacity (µL)">
                    <TextField
                      aria-label="Capacity (µL)"
                      inputMode="decimal"
                      value={capacity}
                      onChange={(event) => setCapacity(event.target.value)}
                    />
                  </Field>
                  <Field label="Dead volume (µL)">
                    <TextField
                      aria-label="Dead volume (µL)"
                      inputMode="decimal"
                      value={deadVolume}
                      onChange={(event) => setDeadVolume(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label={
                      dialog.kind === 'transfer'
                        ? `Source amount (${inventoryAmountUnitLabel(unit)})`
                        : dialog.kind === 'dilute'
                          ? 'Sample amount (µL)'
                          : 'Source amount (µL)'
                    }
                  >
                    <TextField
                      aria-label={
                        dialog.kind === 'transfer'
                          ? `Source amount (${inventoryAmountUnitLabel(unit)})`
                          : dialog.kind === 'dilute'
                            ? 'Sample amount (µL)'
                            : 'Source amount (µL)'
                      }
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      required
                    />
                  </Field>
                  {dialog.kind === 'transfer' ? (
                    <>
                      <Field label="Unit">
                        <Select
                          ariaLabel="Unit"
                          value={unit}
                          options={inventoryAmountUnitOptions(source?.quantity.unit)}
                          onValueChange={(value) => setUnit(value as InventoryAmountUnit)}
                        />
                      </Field>
                      <Field label="Transfer destination">
                        <Select
                          ariaLabel="Transfer destination"
                          value={destinationKind}
                          options={[
                            { value: 'empty', label: 'Empty container or new aliquot' },
                            { value: 'existing', label: 'Existing compatible stock' },
                          ]}
                          onValueChange={(value) => {
                            setDestinationKind(value as 'empty' | 'existing');
                            setDestinationId(value === 'empty' ? 'new' : '');
                          }}
                        />
                      </Field>
                      {destinationKind === 'empty' ? (
                        emptyDestination
                      ) : (
                        <>
                          <Field label="Existing stock">
                            <Select
                              ariaLabel="Existing stock"
                              value={destinationId}
                              options={[
                                { value: '', label: 'Choose a destination stock' },
                                ...stockOptions,
                              ]}
                              onValueChange={setDestinationId}
                            />
                          </Field>
                          <Notice>
                            The destination must share the same material and lot or original
                            unattributed stock.
                          </Notice>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <Field label={dialog.kind === 'dilute' ? 'Tracked diluent' : 'Second stock'}>
                        <Select
                          ariaLabel={dialog.kind === 'dilute' ? 'Tracked diluent' : 'Second stock'}
                          value={secondId}
                          options={[
                            { value: '', label: 'Choose a tracked stock' },
                            ...stockOptions,
                          ]}
                          onValueChange={setSecondId}
                        />
                      </Field>
                      <Field
                        label={
                          dialog.kind === 'dilute' ? 'Diluent amount (µL)' : 'Second amount (µL)'
                        }
                      >
                        <TextField
                          aria-label={
                            dialog.kind === 'dilute' ? 'Diluent amount (µL)' : 'Second amount (µL)'
                          }
                          inputMode="decimal"
                          value={secondAmount}
                          onChange={(event) => setSecondAmount(event.target.value)}
                          required
                        />
                      </Field>
                      {dialog.kind === 'pool' ? (
                        <>
                          {extraInputs.map((input, index) => (
                            <div
                              key={input.id}
                              className="space-y-3 rounded border border-border p-3"
                            >
                              <Field label={`Source ${index + 3}`}>
                                <Select
                                  ariaLabel={`Source ${index + 3}`}
                                  value={input.stockId}
                                  options={[
                                    { value: '', label: 'Choose a tracked stock' },
                                    ...stockOptions,
                                  ]}
                                  onValueChange={(stockId) =>
                                    setExtraInputs((current) =>
                                      current.map((item) =>
                                        item.id === input.id ? { ...item, stockId } : item
                                      )
                                    )
                                  }
                                />
                              </Field>
                              <Field label={`Source ${index + 3} amount (µL)`}>
                                <TextField
                                  aria-label={`Source ${index + 3} amount (µL)`}
                                  inputMode="decimal"
                                  value={input.amount}
                                  onChange={(event) =>
                                    setExtraInputs((current) =>
                                      current.map((item) =>
                                        item.id === input.id
                                          ? { ...item, amount: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Button
                                onClick={() =>
                                  setExtraInputs((current) =>
                                    current.filter((item) => item.id !== input.id)
                                  )
                                }
                              >
                                Remove source {index + 3}
                              </Button>
                            </div>
                          ))}
                          <Button
                            disabled={extraInputs.length >= 254}
                            onClick={() =>
                              setExtraInputs((current) => [
                                ...current,
                                { id: crypto.randomUUID(), stockId: '', amount: '' },
                              ])
                            }
                          >
                            Add another source
                          </Button>
                        </>
                      ) : null}
                      <Field label="Output batch name">
                        <TextField
                          aria-label="Output batch name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          required
                        />
                      </Field>
                      {outputMaterial}
                      {emptyDestination}
                      <Notice>
                        All contributions are withdrawn together. Their identities and exact volumes
                        are retained with their measured composition in the output batch. The output
                        lot starts Unassessed and requires its own release decision.
                      </Notice>
                    </>
                  )}
                  {(dialog.kind !== 'transfer' || destinationKind === 'existing') &&
                  volumeSource ? (
                    <>
                      <Field label="Result mixing">
                        <Select
                          ariaLabel="Result mixing"
                          value={mixing}
                          options={[
                            { value: 'unknown', label: 'Unknown' },
                            { value: 'homogeneous', label: 'Homogeneous' },
                          ]}
                          onValueChange={(value) => setMixing(value as 'unknown' | 'homogeneous')}
                        />
                      </Field>
                      <Notice>
                        {mixing === 'homogeneous'
                          ? 'Record homogeneous only when the contents are evenly mixed. An analyte needs a measurement in every input to calculate its concentration. Record an explicit zero when it is absent.'
                          : 'The resulting composition will remain unknown. Choose homogeneous only when the contents are evenly mixed.'}
                      </Notice>
                    </>
                  ) : destinationKind === 'empty' ? (
                    <Notice>The new aliquot inherits the source’s recorded composition.</Notice>
                  ) : null}
                  {withdrawalBlocked ? (
                    <Notice>
                      {source?.quantity.kind === 'unknown'
                        ? 'Record a measured quantity before withdrawing this stock.'
                        : lotBlockers.length
                          ? 'Lot assessment or recall prevents withdrawing this stock. Inspect its lot controls.'
                          : 'Pooling and dilution require stock measured by volume.'}
                    </Notice>
                  ) : null}
                  <InventoryReservationClaims
                    data={data}
                    stockIds={[
                      dialog.stockId,
                      ...(dialog.kind === 'transfer'
                        ? []
                        : [secondId, ...extraInputs.map((input) => input.stockId)]),
                    ]}
                    claims={claims}
                    onChange={setClaims}
                  />
                </>
              )}
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
