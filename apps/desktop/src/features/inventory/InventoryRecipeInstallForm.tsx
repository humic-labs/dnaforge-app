import { useState, type FormEvent } from 'react';
import {
  inventoryCatalogRecipeEligibility,
  inventoryEquipmentCatalogMissingDefinitions,
  inventoryEquipmentCatalogUpdatePreview,
  inventoryStoragePositions,
  type InventoryConfigurationCommand,
  type InventoryEquipmentCatalogEntry,
  type InventoryEquipmentRecipeVersion,
} from '@waypoint/domain-services';
import { Button, Notice, TextArea, TextField } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  InventoryDestinationFields,
  inventoryDestinationFromDraft,
  InventoryMetadataFields,
  inventoryMetadata,
  InventorySourceDetails,
  PhysicalField,
} from './InventoryPhysicalControls';
import {
  inventoryCatalogBlockerText,
  InventoryCatalogEligibilityNotice,
} from './InventoryCatalogSelection';

export function InventoryRecipeInstallForm({
  data,
  recipeVersionId,
  entry,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  recipeVersionId?: string;
  entry?: InventoryEquipmentCatalogEntry;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const recipe:
    | Pick<InventoryEquipmentRecipeVersion, 'name' | 'components' | 'sources'>
    | undefined = entry
    ? entry.definitions.find(
        (
          definition
        ): definition is Extract<
          InventoryConfigurationCommand,
          { kind: 'define-equipment-recipe' }
        > =>
          definition.kind === 'define-equipment-recipe' && definition.id === entry.recipeVersionId
      )
    : recipeVersionId
      ? data.state.recipeVersions[recipeVersionId]
      : undefined;
  const root = recipe?.components.find((component) => component.parentKey === null);
  const catalogTypes =
    entry?.definitions.filter((definition) => definition.kind === 'define-physical-type') ?? [];
  const typeAt = (id: string) =>
    data.state.typeVersions[id] ?? catalogTypes.find((type) => type.id === id);
  const rootType = root ? typeAt(root.typeVersionId) : undefined;
  const [name, setName] = useState(recipe?.name ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(root ? [root.key] : [])
  );
  const [metadata, setMetadata] = useState<
    Readonly<Record<string, Readonly<Record<string, unknown>>>>
  >({});
  const [invalid, setInvalid] = useState<Readonly<Record<string, ReadonlySet<string>>>>({});
  const [destination, setDestination] = useState({ storageId: '__choose__', position: '' });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const invalidSelection = [...selected].some((key) => invalid[key]?.size);
  const versionId = entry?.recipeVersionId ?? recipeVersionId;
  const preview = entry ? inventoryEquipmentCatalogUpdatePreview(data.state, entry) : null;
  const eligibility =
    recipe && versionId
      ? inventoryCatalogRecipeEligibility(data.state, versionId, recipe.components, [...selected])
      : null;
  const fullEligibility =
    recipe && versionId
      ? inventoryCatalogRecipeEligibility(data.state, versionId, recipe.components)
      : null;
  const blocked = eligibility?.kind !== 'selectable' || preview?.canApply === false;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (!recipe || !root || !rootType) throw new Error('The recipe definition is unavailable.');
      if (!versionId) throw new Error('Choose a recipe version.');
      if (eligibility?.kind !== 'selectable')
        throw new Error('The selected recipe components are unavailable for new installation.');
      if (invalidSelection) throw new Error('Correct the invalid additional fields.');
      const bindings = recipe.components
        .filter((component) => selected.has(component.key))
        .map((component) => ({
          key: component.key,
          id: crypto.randomUUID(),
          metadata: inventoryMetadata(
            typeAt(component.typeVersionId)?.fields ?? [],
            metadata[component.key] ?? {}
          ),
        }));
      const commands = entry ? inventoryEquipmentCatalogMissingDefinitions(data.state, entry) : [];
      if (
        await controller.submit(
          [
            ...commands,
            {
              kind: 'instantiate-equipment-recipe',
              recipeVersionId: versionId,
              name: name.trim(),
              components: bindings,
              destination: inventoryDestinationFromDraft(
                data,
                destination,
                rootType.definition.kind
              ),
              reason: reason.trim(),
            },
          ],
          'Add equipment'
        )
      )
        onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the installation.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title="Add equipment"
      subtitle={recipe?.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      disabled={invalidSelection || blocked}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <InventoryCatalogEligibilityNotice data={data} eligibility={eligibility} />
      {preview?.canApply === false ? (
        <Notice tone="warning">
          This source pack conflicts with saved definitions. Open its catalog update preview to
          inspect the differences before adding equipment.
        </Notice>
      ) : null}
      <Notice>
        Record only the components actually installed. Empty positions do not create physical boxes
        or stock. Unknown fit remains usable.
      </Notice>
      {entry ? (
        <p className="text-xs text-fg-muted">
          Catalog configuration: {entry.boxPositions} box positions · {entry.nominalBoxClass}. This
          is separate from installed components and occupied positions.
        </p>
      ) : null}
      <PhysicalField label="Equipment name">
        <TextField
          aria-label="Equipment name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </PhysicalField>
      {rootType ? (
        <InventoryDestinationFields
          data={data}
          value={destination}
          onChange={setDestination}
          kind={rootType.definition.kind}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={fullEligibility?.kind !== 'selectable'}
          onClick={() =>
            setSelected(new Set(recipe?.components.map((component) => component.key) ?? []))
          }
        >
          Use full recipe arrangement
        </Button>
        <Button onClick={() => setSelected(new Set(root ? [root.key] : []))}>
          Use empty equipment shell
        </Button>
      </div>
      {fullEligibility?.kind === 'blocked' && eligibility?.kind === 'selectable' ? (
        <div className="space-y-1 text-xs text-fg-muted">
          <p>The full arrangement is unavailable. Select only the components being installed.</p>
          {fullEligibility.blockers.map((blocker, index) => (
            <p key={index} data-catalog-blocker={blocker.code}>
              {inventoryCatalogBlockerText(data, blocker)}
            </p>
          ))}
        </div>
      ) : null}
      <div data-testid="inventory-install-components" className="space-y-3">
        {recipe?.components.map((component) => {
          const type = typeAt(component.typeVersionId);
          const active = selected.has(component.key);
          const componentEligibility = versionId
            ? inventoryCatalogRecipeEligibility(data.state, versionId, recipe.components, [
                component.key,
              ])
            : null;
          return (
            <section
              key={component.key}
              data-component-key={component.key}
              className="space-y-3 rounded border border-border p-3"
            >
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  aria-label={`Install ${component.name}`}
                  checked={active}
                  disabled={
                    component.parentKey === null ||
                    (!active && componentEligibility?.kind !== 'selectable')
                  }
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(component.key);
                      else next.delete(component.key);
                      return next;
                    })
                  }
                />
                {component.name}
              </label>
              <p className="text-xs text-fg-muted">
                {type?.name ?? 'Unavailable type'}
                {component.parentKey ? ` · Position ${component.positionId}` : ' · Equipment root'}
                {type?.definition.kind === 'storage'
                  ? ` · ${inventoryStoragePositions(type.definition).length} configured positions`
                  : ''}
              </p>
              {componentEligibility?.kind === 'blocked' ? (
                <div className="space-y-1 text-xs text-fg-muted">
                  {componentEligibility.blockers.map((blocker, index) => (
                    <p key={index} data-catalog-blocker={blocker.code}>
                      {inventoryCatalogBlockerText(data, blocker)}
                    </p>
                  ))}
                </div>
              ) : null}
              {active ? (
                <InventoryMetadataFields
                  prefix={`inventory-component-${component.key}`}
                  fields={type?.fields ?? []}
                  values={metadata[component.key] ?? {}}
                  onChange={(values) =>
                    setMetadata((current) => ({ ...current, [component.key]: values }))
                  }
                  onValidityChange={(key, valid) =>
                    setInvalid((current) => {
                      const next = new Set(current[component.key] ?? []);
                      if (valid) next.delete(key);
                      else next.add(key);
                      return { ...current, [component.key]: next };
                    })
                  }
                />
              ) : null}
            </section>
          );
        })}
      </div>
      {recipe?.sources.map((source, index) => (
        <InventorySourceDetails key={index} source={source} />
      ))}
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
