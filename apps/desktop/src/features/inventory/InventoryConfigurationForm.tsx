import { useState, type FormEvent } from 'react';
import {
  inventoryStoragePositions,
  type InventoryCommand,
  type InventoryOrientation,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import type { InventoryItem } from './inventory-view';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  InventoryMetadataFields,
  inventoryMetadata,
  PhysicalField,
} from './InventoryPhysicalControls';
import {
  InventoryLayoutFields,
  inventoryLayoutDraft,
  inventoryLayoutFromDraft,
  inventoryLayoutPositions,
} from './InventoryLayoutFields';

export function InventoryConfigurationForm({
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
  const configuration = record.configuration;
  const types =
    data.availability?.physical.typeVersions.filter((type) => type.definition.kind === item.kind) ??
    [];
  const [typeId, setTypeId] = useState(configuration.typeVersionId ?? '');
  const [metadata, setMetadata] = useState<Readonly<Record<string, unknown>>>(
    configuration.metadata
  );
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const [orientation, setOrientation] = useState(
    configuration.orientation.kind === 'known'
      ? String(configuration.orientation.quarterTurns)
      : 'unknown'
  );
  const [positions, setPositions] = useState(() =>
    Object.entries(configuration.unavailablePositions).map(([position, reason]) => ({
      id: crypto.randomUUID(),
      position,
      reason,
    }))
  );
  const [editLayout, setEditLayout] = useState(false);
  const [layout, setLayout] = useState(() =>
    inventoryLayoutDraft(item.kind === 'storage' ? data.state.storage[item.id].layout : undefined)
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const type = types.find((type) => type.id === typeId);
  const availablePositions =
    item.kind === 'storage'
      ? editLayout
        ? inventoryLayoutPositions(layout)
        : inventoryStoragePositions(data.state.storage[item.id])
      : [];
  const unselected = availablePositions.filter(
    (position) => !positions.some((row) => row.position === position)
  );
  function validity(key: string, valid: boolean) {
    setInvalidFields((current) => {
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (invalidFields.size)
        throw new Error('Correct the invalid additional fields before saving.');
      const mounting: InventoryOrientation =
        orientation === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'known', quarterTurns: Number(orientation) as 0 | 1 | 2 | 3 };
      const commands: InventoryCommand[] = [
        {
          kind: 'configure-item',
          item,
          typeVersionId: typeId || null,
          metadata: inventoryMetadata(type?.fields ?? [], metadata),
          orientation: mounting,
          unavailablePositions: Object.fromEntries(
            positions.map((row) => [row.position, row.reason.trim()])
          ),
          reason: reason.trim(),
        },
      ];
      if (item.kind === 'storage' && editLayout)
        commands.push({
          kind: 'reconfigure-storage',
          storageId: item.id,
          layout: inventoryLayoutFromDraft(layout),
          reason: reason.trim(),
        });
      if (await controller.submit(commands, 'Edit installed arrangement')) onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the installed arrangement.');
    }
  }

  return (
    <InventoryPhysicalDialog
      title="Edit installed arrangement"
      subtitle={record.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      submitLabel="Save this arrangement"
      disabled={invalidFields.size > 0}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice>
        This changes this installed item. Type definitions, recipes and other instances retain their
        existing versions and arrangements.
      </Notice>
      <PhysicalField label="Type version">
        <Select
          ariaLabel="Type version"
          value={typeId}
          options={[
            { value: '', label: 'Unspecified' },
            ...types.map((type) => ({ value: type.id, label: `${type.name} · v${type.version}` })),
          ]}
          onValueChange={(id) => {
            setTypeId(id);
            const fields = types.find((type) => type.id === id)?.fields ?? [];
            setMetadata(
              Object.fromEntries(
                fields.flatMap((field) =>
                  Object.hasOwn(metadata, field.key) ? [[field.key, metadata[field.key]]] : []
                )
              )
            );
            setInvalidFields(new Set());
          }}
        />
      </PhysicalField>
      <InventoryMetadataFields
        fields={type?.fields ?? []}
        values={metadata}
        onChange={setMetadata}
        onValidityChange={validity}
      />
      <PhysicalField label="Mounting orientation">
        <Select
          ariaLabel="Mounting orientation"
          value={orientation}
          options={[
            { value: 'unknown', label: 'Unknown' },
            ...[0, 1, 2, 3].map((turns) => ({ value: String(turns), label: `${turns * 90}°` })),
          ]}
          onValueChange={setOrientation}
        />
      </PhysicalField>
      <p className="text-xs text-fg-muted">
        Mounting orientation does not rename logical positions or wells.
      </p>
      {item.kind === 'storage' ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editLayout}
              onChange={(event) => setEditLayout(event.target.checked)}
            />
            Edit this item's layout
          </label>
          {editLayout ? (
            <>
              <InventoryLayoutFields value={layout} onChange={setLayout} />
              <Notice>
                Occupied positions and permanent well identities must remain valid when the layout
                is saved.
              </Notice>
            </>
          ) : null}
          <fieldset className="space-y-3 rounded border border-border p-3">
            <legend className="px-1 text-sm font-semibold">Unavailable positions</legend>
            {positions.map((row, index) => (
              <div key={row.id} className="space-y-2">
                <PhysicalField label={`Unavailable position ${index + 1}`}>
                  <Select
                    ariaLabel={`Unavailable position ${index + 1}`}
                    value={row.position}
                    options={[
                      { value: row.position, label: row.position },
                      ...unselected.map((position) => ({ value: position, label: position })),
                    ]}
                    onValueChange={(position) =>
                      setPositions((current) =>
                        current.map((entry) =>
                          entry.id === row.id ? { ...entry, position } : entry
                        )
                      )
                    }
                  />
                </PhysicalField>
                <PhysicalField label={`Unavailable reason ${index + 1}`}>
                  <TextArea
                    aria-label={`Unavailable reason ${index + 1}`}
                    value={row.reason}
                    required
                    onChange={(event) =>
                      setPositions((current) =>
                        current.map((entry) =>
                          entry.id === row.id ? { ...entry, reason: event.target.value } : entry
                        )
                      )
                    }
                  />
                </PhysicalField>
                <Button
                  onClick={() =>
                    setPositions((current) => current.filter((entry) => entry.id !== row.id))
                  }
                >
                  Remove unavailable position {index + 1}
                </Button>
              </div>
            ))}
            <Button
              disabled={!unselected.length}
              onClick={() =>
                setPositions((current) => [
                  ...current,
                  { id: crypto.randomUUID(), position: unselected[0], reason: '' },
                ])
              }
            >
              Mark a position unavailable
            </Button>
          </fieldset>
        </>
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
