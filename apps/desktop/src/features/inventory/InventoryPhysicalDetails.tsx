import { inventoryStoragePositions } from '@waypoint/domain-services';
import { Button } from '../../components/ui';
import { registryFieldText } from '../../shared/components/entity-metadata/metadata-field-values';
import type { InventoryData } from './inventory-controller';
import { InventorySourceDetails } from './InventoryPhysicalControls';
import {
  inventoryDimensionLabel,
  inventoryFitReason,
  type InventoryPhysicalDialogKind,
} from './inventory-physical-view';
import { inventoryOccupant, type InventoryItem } from './inventory-view';
import {
  inventoryCatalogStatusAt,
  InventoryCatalogVersionState,
} from './InventoryCatalogSelection';

export function InventoryPhysicalDetails({
  data,
  item,
  editable,
  onDialog,
}: {
  data: InventoryData;
  item: InventoryItem;
  editable: boolean;
  onDialog(dialog: InventoryPhysicalDialogKind): void;
}) {
  const view = data.availability?.physical.items[item.id];
  if (!view) return null;
  const fit = view.placementCompatibility;
  const storage = item.kind === 'storage' ? data.state.storage[item.id] : undefined;
  const positions = storage ? inventoryStoragePositions(storage) : [];
  const defaults = view.type?.definition.geometry;
  return (
    <section
      data-testid="inventory-physical-details"
      data-item-id={item.id}
      className="space-y-3 rounded border border-border p-3 text-xs"
    >
      <h3 className="text-sm font-semibold">Installed arrangement</h3>
      <dl className="space-y-3">
        <div>
          <dt className="text-fg-muted">Type</dt>
          <dd className="mt-1" data-type-version-id={view.type?.id}>
            {view.type ? `${view.type.name} · v${view.type.version}` : 'Unspecified'}
            {view.type ? (
              <InventoryCatalogVersionState
                status={inventoryCatalogStatusAt(data, {
                  kind: 'type-version',
                  versionId: view.type.id,
                })}
              />
            ) : null}
          </dd>
        </div>
        {view.recipe ? (
          <div>
            <dt className="text-fg-muted">Recipe</dt>
            <dd className="mt-1" data-recipe-version-id={view.recipe.id}>
              {view.recipe.name} · v{view.recipe.version}
              {view.customized ? ' · Customized' : ''}
              <InventoryCatalogVersionState
                status={inventoryCatalogStatusAt(data, {
                  kind: 'recipe-version',
                  versionId: view.recipe.id,
                })}
              />
            </dd>
          </div>
        ) : view.customized ? (
          <p>Customized arrangement</p>
        ) : null}
        <div>
          <dt className="text-fg-muted">Mounting orientation</dt>
          <dd className="mt-1">
            {view.configuration.orientation.kind === 'known'
              ? `${view.configuration.orientation.quarterTurns * 90}°`
              : 'Unknown'}
          </dd>
        </div>
        {storage ? (
          <div>
            <dt className="text-fg-muted">Configured positions</dt>
            <dd className="mt-1">
              {positions.length} configured ·{' '}
              {
                positions.filter((position) => inventoryOccupant(data.state, storage.id, position))
                  .length
              }{' '}
              occupied
            </dd>
          </div>
        ) : null}
        {(['external', 'usable'] as const).map((group) => (
          <div key={group}>
            <dt className="text-fg-muted">
              {group === 'external' ? 'External dimensions' : 'Usable internal dimensions'}
            </dt>
            <dd className="mt-1 space-y-1">
              {(['width', 'height', 'depth'] as const).map((axis) => (
                <p key={axis}>
                  <span className="capitalize">{axis}</span>:{' '}
                  {inventoryDimensionLabel(view.geometry[group][axis])}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <div
        data-testid="inventory-placement-fit"
        data-fit={fit?.fit ?? 'unknown'}
        data-logical={fit?.logical}
        className="space-y-1"
      >
        <p>
          {!fit
            ? 'No parent placement recorded'
            : fit.logical === 'incompatible'
              ? 'Not allowed here'
              : 'Allowed here'}
        </p>
        <p className="font-medium">
          {fit?.fit === 'incompatible'
            ? 'Incompatible fit'
            : fit?.fit === 'compatible'
              ? 'Compatible fit'
              : 'Fit not established'}
        </p>
        {fit?.evidenceBasis.map((basis) => (
          <p key={basis}>
            {basis === 'manufacturer-supported'
              ? fit.fit === 'compatible'
                ? 'Manufacturer-supported for this configuration'
                : 'Manufacturer evidence'
              : fit.fit === 'compatible'
                ? 'Locally checked'
                : 'Local evidence'}
          </p>
        ))}
        {fit?.reasons.map((reason) => (
          <p key={reason} data-fit-reason={reason} className="text-fg-muted">
            {inventoryFitReason(reason)}
          </p>
        ))}
      </div>
      {view.type?.fields.map((field) => (
        <div key={field.key}>
          <p className="text-fg-muted">{field.label}</p>
          <p className="mt-1 break-words">
            {registryFieldText(field, view.configuration.metadata[field.key])}
          </p>
        </div>
      ))}
      {view.configuration.geometryOverride ? (
        <div className="space-y-1">
          <p className="font-medium">Installed dimensions override type defaults</p>
          <p>{view.configuration.geometryOverride.reason}</p>
          {view.configuration.geometryOverride.source ? (
            <InventorySourceDetails source={view.configuration.geometryOverride.source} />
          ) : null}
        </div>
      ) : null}
      {view.configuration.geometryOverride && defaults ? (
        <details>
          <summary className="cursor-pointer font-medium">Type default dimensions</summary>
          <div className="mt-2 space-y-2">
            {(['external', 'usable'] as const).map((group) => (
              <div key={group}>
                <p className="text-fg-muted">
                  {group === 'external' ? 'External' : 'Usable internal'}
                </p>
                {(['width', 'height', 'depth'] as const).map((axis) => (
                  <p key={axis}>
                    <span className="capitalize">{axis}</span>:{' '}
                    {inventoryDimensionLabel(defaults[group][axis])}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {[...(view.type?.sources ?? []), ...(view.recipe?.sources ?? [])].map((source, index) => (
        <InventorySourceDetails key={index} source={source} />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!editable}
          onClick={() => onDialog({ kind: 'physical-configuration', item })}
        >
          Edit installed arrangement
        </Button>
        <Button disabled={!editable} onClick={() => onDialog({ kind: 'physical-geometry', item })}>
          Record dimensions
        </Button>
        <Button disabled={!editable} onClick={() => onDialog({ kind: 'physical-fit', item })}>
          Record fit evidence
        </Button>
      </div>
    </section>
  );
}
