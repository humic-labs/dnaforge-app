import { useState, type FormEvent } from 'react';
import {
  METADATA_FIELD_TYPES,
  type InventoryChildPolicy,
  type InventoryPhysicalDefinition,
  type InventoryPhysicalTypeVersion,
  type InventoryPositionRule,
  type MetadataFieldDefinition,
} from '@waypoint/domain-services';
import { Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  FieldDefinitionTable,
  type FieldDefinitionDraft,
} from '../../shared/components/entity-metadata/FieldDefinitionTable';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField, InventorySourceDetails } from './InventoryPhysicalControls';
import {
  InventoryGeometryFields,
  inventoryGeometryDraft,
  inventoryGeometryFromDraft,
} from './InventoryGeometryFields';
import {
  InventoryLayoutFields,
  inventoryLayoutDraft,
  inventoryLayoutFromDraft,
} from './InventoryLayoutFields';
import { InventoryChildPolicyFields } from './InventoryChildPolicyFields';
import { InventoryPositionRulesFields } from './InventoryPositionRulesFields';

const FIELD_LABELS = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  enum: 'Choice',
  date: 'Date',
  string_array: 'Text list',
};

export function InventoryPhysicalTypeForm({
  data,
  source,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  source?: InventoryPhysicalTypeVersion;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const [name, setName] = useState(source?.name ?? '');
  const [description, setDescription] = useState(source?.description ?? '');
  const [kind, setKind] = useState<'storage' | 'vessel'>(source?.definition.kind ?? 'storage');
  const [mobility, setMobility] = useState<'movable' | 'fixed-well'>(
    source?.definition.kind === 'vessel' ? source.definition.mobility : 'movable'
  );
  const [layout, setLayout] = useState(() =>
    inventoryLayoutDraft(
      source?.definition.kind === 'storage' ? source.definition.layout : undefined
    )
  );
  const [childPolicy, setChildPolicy] = useState<InventoryChildPolicy>(
    source?.definition.kind === 'storage' ? source.definition.childPolicy : { kind: 'any-legal' }
  );
  const [positionRules, setPositionRules] = useState<
    Readonly<Record<string, InventoryPositionRule>>
  >(source?.definition.kind === 'storage' ? source.definition.positionRules : {});
  const [geometry, setGeometry] = useState(() =>
    inventoryGeometryDraft(source?.definition.geometry)
  );
  const [capacity, setCapacity] = useState(
    source?.definition.kind === 'vessel' && source.definition.limits.capacity.kind === 'known'
      ? source.definition.limits.capacity.value
      : ''
  );
  const [deadVolume, setDeadVolume] = useState(
    source?.definition.kind === 'vessel' && source.definition.limits.deadVolume.kind === 'known'
      ? source.definition.limits.deadVolume.value
      : ''
  );
  const [fields, setFields] = useState<FieldDefinitionDraft<MetadataFieldDefinition>[]>(() =>
    (source?.fields ?? []).map((definition) => ({
      id: definition.key,
      definition: { ...definition },
      autoKey: false,
    }))
  );
  const [error, setError] = useState<string | null>(null);
  const title = source ? 'Publish type version' : 'New type';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (!name.trim()) throw new Error('Enter a type name.');
      const measured = (value: string) =>
        value.trim()
          ? { kind: 'known' as const, value: value.trim(), unit: 'uL' as const }
          : { kind: 'unknown' as const };
      const definition: InventoryPhysicalDefinition =
        kind === 'storage'
          ? {
              kind,
              layout: inventoryLayoutFromDraft(layout),
              childPolicy,
              positionRules,
              geometry: inventoryGeometryFromDraft(geometry),
            }
          : {
              kind,
              mobility,
              limits: { capacity: measured(capacity), deadVolume: measured(deadVolume) },
              geometry: inventoryGeometryFromDraft(geometry),
            };
      if (
        await controller.submit(
          [
            {
              kind: 'define-physical-type',
              id: crypto.randomUUID(),
              typeId: source?.typeId ?? crypto.randomUUID(),
              name: name.trim(),
              description: description.trim(),
              fields: fields.map((field) => field.definition),
              sources: source?.sources ?? [],
              definition,
            },
          ],
          title
        )
      )
        onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the type definition.');
    }
  }

  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={source ? `${source.name} · based on version ${source.version}` : data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      submitLabel="Publish type"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice>
        Publishing creates a new definition version. Installed items and recipes retain their pinned
        versions.
      </Notice>
      <PhysicalField label="Type name">
        <TextField
          aria-label="Type name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </PhysicalField>
      <PhysicalField label="Description">
        <TextArea
          aria-label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </PhysicalField>
      <PhysicalField label="Item kind">
        <Select
          ariaLabel="Item kind"
          value={kind}
          options={[
            { value: 'storage', label: 'Location or storage' },
            { value: 'vessel', label: 'Container' },
          ]}
          onValueChange={(value) => setKind(value as 'storage' | 'vessel')}
        />
      </PhysicalField>
      {kind === 'storage' ? (
        <>
          <InventoryLayoutFields value={layout} onChange={setLayout} />
          <InventoryChildPolicyFields
            value={childPolicy}
            onChange={setChildPolicy}
            types={data.availability?.physical.typeVersions ?? []}
          />
          <InventoryPositionRulesFields
            layout={layout}
            value={positionRules}
            onChange={setPositionRules}
            types={data.availability?.physical.typeVersions ?? []}
          />
        </>
      ) : (
        <>
          <PhysicalField label="Container mobility">
            <Select
              ariaLabel="Container mobility"
              value={mobility}
              options={[
                { value: 'movable', label: 'Movable container' },
                { value: 'fixed-well', label: 'Permanent well' },
              ]}
              onValueChange={(value) => setMobility(value as 'movable' | 'fixed-well')}
            />
          </PhysicalField>
          <p className="text-xs text-fg-muted">
            Permanent wells are created by their plate. Blank limits remain unknown.
          </p>
          <PhysicalField label="Default capacity (µL)">
            <TextField
              aria-label="Default capacity (µL)"
              inputMode="decimal"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </PhysicalField>
          <PhysicalField label="Default dead volume (µL)">
            <TextField
              aria-label="Default dead volume (µL)"
              inputMode="decimal"
              value={deadVolume}
              onChange={(event) => setDeadVolume(event.target.value)}
            />
          </PhysicalField>
        </>
      )}
      <InventoryGeometryFields value={geometry} onChange={setGeometry} />
      {source?.sources.map((reference, index) => (
        <InventorySourceDetails key={index} source={reference} />
      ))}
      <FieldDefinitionTable
        title="Additional fields"
        testId="inventory-type-fields"
        fields={source?.fields ?? []}
        draftFields={fields}
        onFieldsChange={setFields}
        editableTypes={METADATA_FIELD_TYPES.map((value) => ({ value, label: FIELD_LABELS[value] }))}
        typeLabels={FIELD_LABELS}
        createField={() => ({
          id: crypto.randomUUID(),
          definition: { key: '', label: '', type: 'text' },
          autoKey: true,
        })}
      />
    </InventoryPhysicalDialog>
  );
}
