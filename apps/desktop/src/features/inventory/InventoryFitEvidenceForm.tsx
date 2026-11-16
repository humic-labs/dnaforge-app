import { useState, type FormEvent } from 'react';
import { inventoryStoragePositions, type InventoryFitSubject } from '@waypoint/domain-services';
import { Notice, Select, TextArea } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import type { InventoryItem } from './inventory-view';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventoryPhysicalSubjectFields } from './InventoryPhysicalSubjectFields';
import {
  PhysicalField,
  InventorySourceFields,
  inventorySourceDraft,
} from './InventoryPhysicalControls';

export function InventoryFitEvidenceForm({
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
  const parentRecord =
    record.placement.kind === 'located'
      ? data.state.storage[record.placement.storageId]
      : undefined;
  const [parent, setParent] = useState<InventoryFitSubject | null>(
    parentRecord
      ? {
          kind: 'installed',
          item: { kind: 'storage', id: parentRecord.id },
          configurationRevision: parentRecord.configuration.revision,
        }
      : null
  );
  const [child, setChild] = useState<InventoryFitSubject | null>({
    kind: 'installed',
    item,
    configurationRevision: record.configuration.revision,
  });
  const [positionId, setPositionId] = useState(
    record.placement.kind === 'located' ? record.placement.slotId : '__choose__'
  );
  const [orientations, setOrientations] = useState<readonly (0 | 1 | 2 | 3)[]>(
    record.configuration.orientation.kind === 'known'
      ? [record.configuration.orientation.quarterTurns]
      : []
  );
  const [result, setResult] = useState<'compatible' | 'incompatible'>('compatible');
  const [basis, setBasis] = useState<'manufacturer-supported' | 'locally-verified'>(
    'locally-verified'
  );
  const [source, setSource] = useState(() => inventorySourceDraft(data.availability?.asOf));
  const [localSource, setLocalSource] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parentType =
    parent?.kind === 'type-version' ? data.state.typeVersions[parent.versionId] : null;
  const positions =
    parent?.kind === 'installed' && parent.item.kind === 'storage'
      ? inventoryStoragePositions(data.state.storage[parent.item.id])
      : parentType?.definition.kind === 'storage'
        ? inventoryStoragePositions(parentType.definition)
        : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (!parent || !child) throw new Error('Choose the parent and child for this evidence.');
      if (positionId === '__choose__')
        throw new Error('Choose the position scope for this evidence.');
      if (
        await controller.submit(
          [
            {
              kind: 'record-fit-evidence',
              id: crypto.randomUUID(),
              parent,
              child,
              positionId: positionId || null,
              orientations,
              result,
              basis,
              source: basis === 'manufacturer-supported' || localSource ? source : null,
              reason: reason.trim(),
            },
          ],
          'Record fit evidence'
        )
      )
        onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the fit evidence.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title="Record fit evidence"
      subtitle={record.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice>
        Evidence applies to the selected item configurations or type versions and orientations. It
        does not change physical placement.
      </Notice>
      <InventoryPhysicalSubjectFields
        data={data}
        label="Parent"
        value={parent}
        parent
        onChange={(next) => {
          setParent(next);
          setPositionId('__choose__');
        }}
      />
      <InventoryPhysicalSubjectFields
        data={data}
        label="Child"
        value={child}
        onChange={(next) => {
          setChild(next);
          setPositionId('__choose__');
          setOrientations([]);
        }}
      />
      <PhysicalField label="Evidence position">
        <Select
          ariaLabel="Evidence position"
          value={positionId}
          options={[
            { value: '__choose__', label: 'Choose a position scope' },
            { value: '', label: 'All positions' },
            ...positions.map((position) => ({ value: position, label: position })),
          ]}
          onValueChange={setPositionId}
        />
      </PhysicalField>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium text-fg-muted">
          Supported mounting orientations
        </legend>
        {([0, 1, 2, 3] as const).map((turn) => (
          <label key={turn} className="mr-4 inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={`Evidence orientation ${turn * 90}°`}
              checked={orientations.includes(turn)}
              onChange={(event) =>
                setOrientations((current) =>
                  event.target.checked
                    ? [...current, turn]
                    : current.filter((value) => value !== turn)
                )
              }
            />
            {turn * 90}°
          </label>
        ))}
      </fieldset>
      <PhysicalField label="Fit result">
        <Select
          ariaLabel="Fit result"
          value={result}
          options={[
            { value: 'compatible', label: 'Compatible' },
            { value: 'incompatible', label: 'Incompatible' },
          ]}
          onValueChange={(next) => setResult(next as 'compatible' | 'incompatible')}
        />
      </PhysicalField>
      <PhysicalField label="Evidence basis">
        <Select
          ariaLabel="Evidence basis"
          value={basis}
          options={[
            { value: 'locally-verified', label: 'Local observation' },
            { value: 'manufacturer-supported', label: 'Manufacturer source' },
          ]}
          onValueChange={(next) => setBasis(next as 'locally-verified' | 'manufacturer-supported')}
        />
      </PhysicalField>
      {basis === 'locally-verified' ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={localSource}
            onChange={(event) => setLocalSource(event.target.checked)}
          />
          Add a source reference
        </label>
      ) : null}
      {basis === 'manufacturer-supported' || localSource ? (
        <InventorySourceFields value={source} onChange={setSource} />
      ) : null}
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
