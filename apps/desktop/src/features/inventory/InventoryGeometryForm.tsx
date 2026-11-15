import { useState, type FormEvent } from 'react';
import { Notice, TextArea } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import type { InventoryItem } from './inventory-view';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  InventoryGeometryFields,
  inventoryGeometryDraft,
  inventoryGeometryFromDraft,
} from './InventoryGeometryFields';
import {
  InventorySourceFields,
  inventorySourceDraft,
  PhysicalField,
} from './InventoryPhysicalControls';

export function InventoryGeometryForm({
  data,
  item,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  item: InventoryItem;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const record =
    item.kind === 'storage' ? data.state.storage[item.id] : data.state.vessels[item.id];
  const existing = record.configuration.geometryOverride;
  const [geometry, setGeometry] = useState(() => inventoryGeometryDraft(existing?.geometry));
  const [hasSource, setHasSource] = useState(Boolean(existing?.source));
  const [source, setSource] = useState(
    existing?.source ?? inventorySourceDraft(data.availability?.asOf)
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (
        await controller.submit(
          [
            {
              kind: 'record-item-geometry',
              item,
              geometry: inventoryGeometryFromDraft(geometry),
              source: hasSource ? source : null,
              reason: reason.trim(),
            },
          ],
          'Record dimensions'
        )
      )
        onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the dimensions.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title="Record dimensions"
      subtitle={record.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice>
        These dimensions apply to this installed item. Type defaults and manufacturer assertions
        remain unchanged. Blank dimensions are recorded as unknown.
      </Notice>
      <InventoryGeometryFields
        value={geometry}
        onChange={setGeometry}
        label="Installed dimensions"
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={hasSource}
          onChange={(event) => setHasSource(event.target.checked)}
        />
        Add a source reference
      </label>
      {hasSource ? <InventorySourceFields value={source} onChange={setSource} /> : null}
      <PhysicalField label="Reason">
        <TextArea
          aria-label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </PhysicalField>
    </InventoryPhysicalDialog>
  );
}
