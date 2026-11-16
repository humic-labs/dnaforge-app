import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  inventoryVesselContents,
  type InventoryCommand,
  type InventoryQuality,
  type InventoryVolumeUnit,
} from '@waypoint/domain-services';
import { Notice, Select, TextArea, TextField } from '../../components/ui';
import type { InventoryClient, InventoryMaterialPage } from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { inventoryContentsLabel } from './inventory-contents-view';

export interface InventoryContentsDialog {
  kind: 'contents';
  action: 'record' | 'identify' | 'empty';
  vesselId: string;
}

type Materials =
  | { kind: 'loading' }
  | { kind: 'ready'; page: InventoryMaterialPage }
  | { kind: 'failed' };

export function InventoryContentsForm({
  dialog,
  data,
  controller,
  status,
  client,
  onClose,
}: {
  dialog: InventoryContentsDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  client: InventoryClient;
  onClose(): void;
}) {
  const vessel = data.state.vessels[dialog.vesselId];
  const contents = inventoryVesselContents(data.state, dialog.vesselId);
  const scope = JSON.stringify([
    data.project.projectId,
    data.project.defaultInventoryId,
    dialog.vesselId,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  const [knowledge, setKnowledge] = useState<'unobserved' | 'unidentified'>(
    contents?.kind === 'unidentified' ? 'unidentified' : 'unobserved'
  );
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [materials, setMaterials] = useState<Materials>({ kind: 'loading' });
  const [quantityKind, setQuantityKind] = useState<'known' | 'unknown'>('known');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<InventoryVolumeUnit>('uL');
  const [quality, setQuality] = useState<InventoryQuality | ''>('');
  const [validation, setValidation] = useState<string | null>(null);
  const title =
    dialog.action === 'identify'
      ? 'Identify contents'
      : dialog.action === 'empty'
        ? 'Declare empty'
        : 'Record contents status';
  const available = Boolean(
    vessel?.lifecycle === 'active' &&
    contents &&
    contents.kind !== 'identified' &&
    (dialog.action === 'record' || contents.kind !== 'declared-empty')
  );

  useEffect(() => {
    ++generation.current;
    setMaterialId('');
    setQuery('');
    setReason('');
    setQuantityKind('known');
    setQuantity('');
    setUnit('uL');
    setQuality('');
    setValidation(null);
    return () => {
      ++generation.current;
    };
  }, [scope]);
  useEffect(() => {
    if (dialog.action !== 'identify') return;
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
  }, [client, data.project.projectId, dialog.action, query]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!inventoryCanEdit(status) || !available) return;
    setValidation(null);
    try {
      if (!reason.trim()) throw new Error('Enter a reason for this contents declaration.');
      let command: InventoryCommand;
      if (dialog.action === 'record')
        command = {
          kind: 'record-vessel-contents',
          vesselId: dialog.vesselId,
          knowledge,
          reason: reason.trim(),
        };
      else if (dialog.action === 'empty')
        command = {
          kind: 'declare-vessel-empty',
          vesselId: dialog.vesselId,
          reason: reason.trim(),
        };
      else {
        if (!materialId) throw new Error('Choose a scientific material from this project.');
        if (!quality) throw new Error('Choose the stock quality explicitly.');
        command = {
          kind: 'identify-vessel-stock',
          id: crypto.randomUUID(),
          vesselId: dialog.vesselId,
          materialId,
          quantity:
            quantityKind === 'unknown'
              ? { kind: 'unknown' }
              : { kind: 'known', value: quantity, unit },
          quality,
          reason: reason.trim(),
        };
      }
      const current = generation.current;
      const submittedScope = scope;
      if (await controller.submit([command], title))
        if (current === generation.current && scopeRef.current === submittedScope) onClose();
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={vessel?.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      submitLabel={title}
      disabled={!available}
    >
      <section
        className="space-y-4"
        data-testid="inventory-contents-form"
        data-contents-action={dialog.action}
      >
        <p className="text-sm">Current declaration: {inventoryContentsLabel(contents)}</p>
        {!available ? (
          <Notice>
            This container is no longer eligible for this action. Close and inspect its current
            contents.
          </Notice>
        ) : null}
        {validation ? <Notice tone="error">{validation}</Notice> : null}
        {dialog.action === 'record' ? (
          <Select
            ariaLabel="Contents status"
            value={knowledge}
            options={[
              { value: 'unobserved', label: 'Contents have not been observed' },
              { value: 'unidentified', label: 'Material is present but unidentified' },
            ]}
            onValueChange={(value) => setKnowledge(value as typeof knowledge)}
          />
        ) : dialog.action === 'empty' ? (
          <Notice>
            This explicitly declares that no material is present. It cannot erase an existing stock
            record.
          </Notice>
        ) : (
          <>
            <Notice>
              Identify material already in this container. This does not record a physical receipt.
            </Notice>
            <TextField
              aria-label="Find material"
              placeholder="Search this project’s materials"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMaterialId('');
              }}
            />
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
              onValueChange={setMaterialId}
            />
            {materials.kind === 'failed' ? (
              <Notice tone="error">
                Materials could not be loaded. Change the search to retry.
              </Notice>
            ) : null}
            <Select
              ariaLabel="Quantity measurement"
              value={quantityKind}
              options={[
                { value: 'known', label: 'Recorded quantity' },
                { value: 'unknown', label: 'Unknown quantity' },
              ]}
              onValueChange={(value) => setQuantityKind(value as typeof quantityKind)}
            />
            {quantityKind === 'known' ? (
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
                <TextField
                  aria-label="Quantity"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  required
                />
                <Select
                  ariaLabel="Unit"
                  value={unit}
                  options={['uL', 'mL', 'L', 'nL'].map((value) => ({
                    value,
                    label: value === 'uL' ? 'µL' : value,
                  }))}
                  onValueChange={(value) => setUnit(value as InventoryVolumeUnit)}
                />
              </div>
            ) : null}
            <Select
              ariaLabel="Stock quality"
              value={quality}
              options={[
                { value: '', label: 'Choose stock quality' },
                { value: 'usable', label: 'Usable' },
                { value: 'quarantined', label: 'Quarantined' },
              ]}
              onValueChange={(value) => setQuality(value as typeof quality)}
            />
          </>
        )}
        <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
          Reason
          <TextArea
            aria-label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
      </section>
    </InventoryPhysicalDialog>
  );
}
