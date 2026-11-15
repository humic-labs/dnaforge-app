import { useState, type FormEvent } from 'react';
import {
  inventoryStoragePositions,
  type InventoryEquipmentRecipeVersion,
  type InventoryRecipeComponent,
  type InventorySourceReference,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  PhysicalField,
  InventorySourceFields,
  inventorySourceDraft,
} from './InventoryPhysicalControls';
import {
  inventoryCatalogStatusAt,
  inventoryCatalogVersionLabel,
} from './InventoryCatalogSelection';

export function InventoryEquipmentRecipeForm({
  data,
  source,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  source?: InventoryEquipmentRecipeVersion;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const [name, setName] = useState(source?.name ?? '');
  const [description, setDescription] = useState(source?.description ?? '');
  const [model, setModel] = useState(
    source?.model ?? { manufacturer: '', model: '', partNumber: null, region: null, revision: null }
  );
  const [components, setComponents] = useState<readonly InventoryRecipeComponent[]>(
    source?.components ?? [
      { key: crypto.randomUUID(), parentKey: null, positionId: null, name: '', typeVersionId: '' },
    ]
  );
  const [sources, setSources] = useState<readonly InventorySourceReference[]>(
    source?.sources ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const types =
    data.availability?.physical.typeVersions.filter(
      (type) => type.definition.kind === 'storage' || type.definition.mobility === 'movable'
    ) ?? [];
  function updateComponent(key: string, update: Partial<InventoryRecipeComponent>) {
    setComponents((current) =>
      current.map((component) => (component.key === key ? { ...component, ...update } : component))
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (
        await controller.submit(
          [
            {
              kind: 'define-equipment-recipe',
              id: crypto.randomUUID(),
              recipeId: source?.recipeId ?? crypto.randomUUID(),
              name: name.trim(),
              description: description.trim(),
              model,
              components,
              sources,
            },
          ],
          'Publish equipment recipe'
        )
      )
        onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the recipe.');
    }
  }

  return (
    <InventoryPhysicalDialog
      title={source ? 'Publish recipe version' : 'New equipment recipe'}
      subtitle={source ? `${source.name} · based on version ${source.version}` : data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      submitLabel="Publish recipe"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice>
        A recipe describes one arrangement. Publishing does not add hardware, boxes or stock, and
        does not change installed instances.
      </Notice>
      <PhysicalField label="Recipe name">
        <TextField
          aria-label="Recipe name"
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
      {(['manufacturer', 'model', 'partNumber', 'region', 'revision'] as const).map((key) => {
        const label = {
          manufacturer: 'Manufacturer',
          model: 'Model',
          partNumber: 'Part number',
          region: 'Region',
          revision: 'Model revision',
        }[key];
        return (
          <PhysicalField key={key} label={label}>
            <TextField
              aria-label={label}
              value={model[key] ?? ''}
              onChange={(event) =>
                setModel({
                  ...model,
                  [key]:
                    key === 'manufacturer' || key === 'model'
                      ? event.target.value
                      : event.target.value || null,
                })
              }
            />
          </PhysicalField>
        );
      })}
      <section className="space-y-3" data-testid="inventory-recipe-components">
        <h3 className="text-sm font-semibold">Arrangement</h3>
        {components.map((component, index) => {
          const parent = components.find((entry) => entry.key === component.parentKey);
          const parentType = types.find((type) => type.id === parent?.typeVersionId);
          const positions =
            parentType?.definition.kind === 'storage'
              ? inventoryStoragePositions(parentType.definition)
              : [];
          return (
            <div key={component.key} className="space-y-3 rounded border border-border p-3">
              <PhysicalField label={`Component ${index + 1} name`}>
                <TextField
                  aria-label={`Component ${index + 1} name`}
                  value={component.name}
                  onChange={(event) => updateComponent(component.key, { name: event.target.value })}
                  required
                />
              </PhysicalField>
              <PhysicalField label={`Component ${index + 1} type`}>
                <Select
                  ariaLabel={`Component ${index + 1} type`}
                  value={component.typeVersionId}
                  options={[
                    { value: '', label: 'Choose a type version' },
                    ...types.map((type) => ({
                      value: type.id,
                      label: `${type.name} · v${type.version}`,
                      description: inventoryCatalogVersionLabel(
                        type.name,
                        type.version,
                        inventoryCatalogStatusAt(data, { kind: 'type-version', versionId: type.id })
                      ),
                    })),
                  ]}
                  onValueChange={(typeVersionId) =>
                    updateComponent(component.key, { typeVersionId })
                  }
                />
              </PhysicalField>
              <PhysicalField label={`Component ${index + 1} parent`}>
                <Select
                  ariaLabel={`Component ${index + 1} parent`}
                  value={component.parentKey ?? ''}
                  options={[
                    { value: '', label: 'Recipe root' },
                    ...components
                      .filter(
                        (entry) =>
                          entry.key !== component.key &&
                          types.find((type) => type.id === entry.typeVersionId)?.definition.kind ===
                            'storage'
                      )
                      .map((entry) => ({
                        value: entry.key,
                        label: entry.name || 'Unnamed component',
                      })),
                  ]}
                  onValueChange={(parentKey) =>
                    updateComponent(component.key, {
                      parentKey: parentKey || null,
                      positionId: null,
                    })
                  }
                />
              </PhysicalField>
              {component.parentKey ? (
                <PhysicalField label={`Component ${index + 1} position`}>
                  <Select
                    ariaLabel={`Component ${index + 1} position`}
                    value={component.positionId ?? ''}
                    options={[
                      { value: '', label: 'Choose a position' },
                      ...positions.map((position) => ({ value: position, label: position })),
                    ]}
                    onValueChange={(positionId) => updateComponent(component.key, { positionId })}
                  />
                </PhysicalField>
              ) : null}
              <Button
                onClick={() =>
                  setComponents((current) => current.filter((entry) => entry.key !== component.key))
                }
              >
                Remove component {index + 1}
              </Button>
            </div>
          );
        })}
        <Button
          onClick={() =>
            setComponents((current) => [
              ...current,
              {
                key: crypto.randomUUID(),
                parentKey: current[0]?.key ?? null,
                positionId: null,
                name: '',
                typeVersionId: '',
              },
            ])
          }
        >
          Add component
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Sources</h3>
        {sources.map((reference, index) => (
          <div key={index} className="space-y-2">
            <InventorySourceFields
              prefix={`Source ${index + 1}`}
              value={reference}
              onChange={(next) =>
                setSources((current) =>
                  current.map((entry, candidate) => (candidate === index ? next : entry))
                )
              }
            />
            <Button
              onClick={() =>
                setSources((current) => current.filter((_, candidate) => candidate !== index))
              }
            >
              Remove source {index + 1}
            </Button>
          </div>
        ))}
        <Button
          onClick={() =>
            setSources((current) => [...current, inventorySourceDraft(data.availability?.asOf)])
          }
        >
          Add source
        </Button>
      </section>
    </InventoryPhysicalDialog>
  );
}
