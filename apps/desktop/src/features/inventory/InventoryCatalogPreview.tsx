import { useState, type FormEvent } from 'react';
import {
  inventoryEquipmentCatalogMissingDefinitions,
  inventoryEquipmentCatalogUpdatePreview,
  type InventoryCatalogDefinition,
  type InventoryEquipmentCatalogEntry,
} from '@waypoint/domain-services';
import { Notice } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventorySourceDetails } from './InventoryPhysicalControls';
import { inventoryTemperatureRangeLabel } from './inventory-temperature-view';
import {
  inventoryCatalogStatusAt,
  InventoryCatalogVersionState,
} from './InventoryCatalogSelection';

function savedDefinition(data: InventoryData, definition: InventoryCatalogDefinition) {
  const saved =
    definition.kind === 'define-physical-type'
      ? data.state.typeVersions[definition.id]
      : definition.kind === 'define-equipment-recipe'
        ? data.state.recipeVersions[definition.id]
        : definition.kind === 'record-temperature-claim'
          ? data.state.temperatureClaims[definition.id]
          : data.state.fitEvidence[definition.id];
  if (!saved)
    return (
      data.state.typeVersions[definition.id] ??
      data.state.recipeVersions[definition.id] ??
      data.state.fitEvidence[definition.id] ??
      data.state.temperatureClaims[definition.id] ??
      null
    );
  return Object.fromEntries(
    Object.keys(definition).map((key) => [
      key,
      key === 'kind' ? definition.kind : Reflect.get(saved, key),
    ])
  );
}

export function InventoryCatalogPreview({
  data,
  entry,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  entry: InventoryEquipmentCatalogEntry;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const preview = inventoryEquipmentCatalogUpdatePreview(data.state, entry);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const selectedCount = preview.definitions.filter(
    (row) => row.status === 'new' && selected.has(row.definition.id)
  ).length;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const commands = inventoryEquipmentCatalogMissingDefinitions(data.state, entry).filter(
        (definition) => selected.has(definition.id)
      );
      if (!commands.length) throw new Error('Select at least one new definition.');
      if (await controller.submit(commands, 'Apply catalog definitions')) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the catalog definitions.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title="Catalog update preview"
      subtitle={preview.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      submitLabel="Apply selected definitions"
      disabled={!preview.canApply || selectedCount === 0}
    >
      <div
        data-testid="inventory-catalog-preview"
        data-catalog-id={preview.entryId}
        data-preview-revision={preview.revision}
        className="space-y-4"
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Notice>
          Previewing makes no inventory changes. Apply publishes only the selected new definitions.
          Existing versions, availability and installed items stay unchanged.
        </Notice>
        {!preview.canApply ? (
          <Notice tone="warning">
            This pack contains {preview.conflictCount} conflicting definition
            {preview.conflictCount === 1 ? '' : 's'} and cannot be applied. Use a new version with a
            distinct identifier to record different definitions.
          </Notice>
        ) : null}
        <p className="text-sm">{preview.description}</p>
        <div className="space-y-1 text-xs">
          <p>Manufacturer: {preview.model.manufacturer}</p>
          <p>Model: {preview.model.model}</p>
          <p>Part number: {preview.model.partNumber ?? 'Unspecified'}</p>
          <p>Region: {preview.model.region ?? 'Unspecified'}</p>
          <p>Model revision: {preview.model.revision ?? 'Unspecified'}</p>
        </div>
        {preview.sources.map((source, index) => (
          <InventorySourceDetails key={index} source={source} />
        ))}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Installed references</h3>
          {preview.installedReferences.length ? (
            <ul className="space-y-1 text-xs">
              {preview.installedReferences.map((reference) => (
                <li key={reference.item.id} data-installed-item-id={reference.item.id}>
                  {reference.name} · {reference.item.id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">No installed items reference these definitions.</p>
          )}
        </section>
        <div className="space-y-3">
          {preview.definitions.map((row) => {
            const definition = row.definition;
            const target =
              definition.kind === 'define-physical-type'
                ? ({ kind: 'type-version', versionId: definition.id } as const)
                : definition.kind === 'define-equipment-recipe'
                  ? ({ kind: 'recipe-version', versionId: definition.id } as const)
                  : null;
            return (
              <article
                key={definition.id}
                data-definition-id={definition.id}
                data-definition-status={row.status}
                className="space-y-2 rounded border border-border p-3"
              >
                <h3 className="text-sm font-semibold">
                  {'name' in definition
                    ? definition.name
                    : definition.kind === 'record-temperature-claim'
                      ? 'Specified operating range'
                      : 'Fit evidence'}
                </h3>
                <p className="text-xs font-medium">
                  {row.status === 'new'
                    ? 'New'
                    : row.status === 'identical'
                      ? 'Identical'
                      : 'Conflicting'}
                </p>
                <p className="break-all text-xs text-fg-muted">{definition.id}</p>
                {definition.kind === 'record-temperature-claim' ? (
                  <>
                    <p className="text-sm">
                      {inventoryTemperatureRangeLabel(definition.assertion.range)}
                    </p>
                    <p className="text-xs text-fg-muted">
                      Advertised possible setpoints only. This does not establish the installed
                      target, temperature relationship or qualification.
                    </p>
                    {definition.source ? (
                      <InventorySourceDetails source={definition.source} />
                    ) : null}
                    {data.state.temperatureClaims[definition.id] ? (
                      <p
                        className="text-xs"
                        data-temperature-claim-lifecycle={
                          data.state.temperatureClaims[definition.id].lifecycle.kind
                        }
                      >
                        {data.state.temperatureClaims[definition.id].lifecycle.kind === 'withdrawn'
                          ? 'Withdrawn source evidence stays withdrawn when this pack is applied.'
                          : 'Active source evidence'}
                      </p>
                    ) : null}
                  </>
                ) : null}
                {row.status === 'new' ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Apply ${'name' in definition ? definition.name : definition.id}`}
                      checked={selected.has(definition.id)}
                      disabled={!preview.canApply}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(definition.id);
                          else next.delete(definition.id);
                          return next;
                        })
                      }
                    />
                    Apply this new definition
                  </label>
                ) : target ? (
                  <InventoryCatalogVersionState status={inventoryCatalogStatusAt(data, target)} />
                ) : null}
                {row.installedReferences.length ? (
                  <p className="text-xs">
                    Installed:{' '}
                    {row.installedReferences.map((reference) => reference.name).join('; ')}
                  </p>
                ) : null}
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">
                    {row.status === 'conflicting'
                      ? 'Compare exact definitions'
                      : 'Exact definition'}
                  </summary>
                  {row.status === 'conflicting' ? (
                    <>
                      <p className="mt-2 font-medium">Saved definition</p>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-bg-muted p-2">
                        {JSON.stringify(savedDefinition(data, definition), null, 2)}
                      </pre>
                      <p className="mt-2 font-medium">Proposed definition</p>
                    </>
                  ) : null}
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-bg-muted p-2">
                    {JSON.stringify(definition, null, 2)}
                  </pre>
                </details>
              </article>
            );
          })}
        </div>
      </div>
    </InventoryPhysicalDialog>
  );
}
