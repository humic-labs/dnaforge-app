import { useEffect } from 'react';
import {
  inventoryCatalogRecipeEligibility,
  inventoryCatalogVersionStatus,
  inventoryEquipmentCatalogUpdatePreview,
  inventoryStoragePositions,
  type InventoryConfigurationCommand,
} from '@waypoint/domain-services';
import { Button, Notice, TextField } from '../../components/ui';
import {
  inventoryCanEdit,
  type InventoryCatalogState,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventorySourceDetails } from './InventoryPhysicalControls';
import type { InventoryDialog } from './inventory-view';
import {
  inventoryCatalogStatusAt,
  InventoryCatalogEligibilityNotice,
  InventoryCatalogVersionActions,
  InventoryCatalogVersionState,
} from './InventoryCatalogSelection';

export interface InventorySetupView {
  tab: 'types' | 'recipes';
  query: string;
}

export function InventorySetup({
  data,
  controller,
  status,
  catalog,
  view,
  onViewChange,
  onDialog,
  onClose,
}: {
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  catalog: InventoryCatalogState;
  view: InventorySetupView;
  onViewChange(view: InventorySetupView): void;
  onDialog(dialog: InventoryDialog): void;
  onClose(): void;
}) {
  const { tab, query } = view;
  const editable = inventoryCanEdit(status);
  const physical = data.availability?.physical;
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
  useEffect(() => {
    if (tab === 'recipes') void controller.loadCatalog(data.project.projectId);
  }, [tab, controller, data.project.projectId]);
  return (
    <InventoryPhysicalDialog
      title="Inventory setup"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
    >
      <div data-testid="inventory-setup" className="space-y-4">
        <div role="tablist" aria-label="Inventory setup">
          <Button
            role="tab"
            aria-selected={tab === 'types'}
            onClick={() => onViewChange({ ...view, tab: 'types' })}
          >
            Types
          </Button>
          <Button
            role="tab"
            aria-selected={tab === 'recipes'}
            onClick={() => onViewChange({ ...view, tab: 'recipes' })}
          >
            Equipment recipes
          </Button>
        </div>
        <TextField
          aria-label="Search inventory setup"
          value={query}
          onChange={(event) => onViewChange({ ...view, query: event.target.value })}
          placeholder="Search types, models or recipes"
        />
        {tab === 'types' ? (
          <div className="space-y-3">
            <Button disabled={!editable} onClick={() => onDialog({ kind: 'physical-type' })}>
              New type
            </Button>
            {(physical?.typeVersions ?? [])
              .filter((type) => matches(`${type.name} ${type.description}`))
              .map((type) => {
                const target = { kind: 'type-version', versionId: type.id } as const;
                const selection = inventoryCatalogStatusAt(data, target);
                return (
                  <article
                    key={type.id}
                    data-type-version-id={type.id}
                    data-type-id={type.typeId}
                    className="space-y-3 rounded border border-border p-4"
                  >
                    <h3 className="font-semibold">
                      {type.name} · v{type.version}
                    </h3>
                    <p className="text-xs text-fg-muted">{type.description}</p>
                    <InventoryCatalogVersionState status={selection} />
                    <InventoryCatalogEligibilityNotice
                      data={data}
                      eligibility={selection?.eligibility}
                    />
                    <p className="text-xs text-fg-muted">
                      {type.definition.kind === 'storage'
                        ? `Storage location · ${inventoryStoragePositions(type.definition).length} configured positions`
                        : type.definition.mobility === 'movable'
                          ? 'Movable container'
                          : 'Permanent well'}
                    </p>
                    {type.sources.map((source, index) => (
                      <InventorySourceDetails key={index} source={source} />
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={
                          !editable ||
                          selection?.eligibility.kind !== 'selectable' ||
                          (type.definition.kind === 'vessel' &&
                            type.definition.mobility === 'fixed-well')
                        }
                        onClick={() =>
                          onDialog(
                            type.definition.kind === 'storage'
                              ? { kind: 'location', typeVersionId: type.id }
                              : { kind: 'container', typeVersionId: type.id }
                          )
                        }
                      >
                        Use type
                      </Button>
                      <Button
                        disabled={!editable}
                        onClick={() => onDialog({ kind: 'physical-type', versionId: type.id })}
                      >
                        Publish new version
                      </Button>
                      <InventoryCatalogVersionActions
                        data={data}
                        target={target}
                        editable={editable}
                        onDialog={onDialog}
                      />
                    </div>
                  </article>
                );
              })}
            {!physical?.typeVersions.length ? (
              <p className="text-sm text-fg-muted">
                No custom types yet. Unspecified inventory remains usable.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4" data-testid="inventory-equipment-recipes">
            <Button disabled={!editable} onClick={() => onDialog({ kind: 'equipment-recipe' })}>
              New equipment recipe
            </Button>
            <h3 className="text-sm font-semibold">Saved recipes</h3>
            {(physical?.recipeVersions ?? [])
              .filter((recipe) =>
                matches(`${recipe.name} ${recipe.model.manufacturer} ${recipe.model.model}`)
              )
              .map((recipe) => {
                const target = { kind: 'recipe-version', versionId: recipe.id } as const;
                const selection = inventoryCatalogStatusAt(data, target);
                const root = recipe.components.find((component) => component.parentKey === null);
                const shell = root
                  ? inventoryCatalogVersionStatus(data.state, target, [root.key])
                  : null;
                return (
                  <article
                    key={recipe.id}
                    data-recipe-version-id={recipe.id}
                    className="space-y-3 rounded border border-border p-4"
                  >
                    <h4 className="font-semibold">
                      {recipe.name} · v{recipe.version}
                    </h4>
                    <p className="text-xs text-fg-muted">
                      {recipe.model.manufacturer} {recipe.model.model} · {recipe.components.length}{' '}
                      recorded components
                    </p>
                    <InventoryCatalogVersionState status={selection} />
                    <InventoryCatalogEligibilityNotice
                      data={data}
                      eligibility={selection?.eligibility}
                    />
                    {recipe.sources.map((source, index) => (
                      <InventorySourceDetails key={index} source={source} />
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={!editable || shell?.eligibility.kind !== 'selectable'}
                        onClick={() => onDialog({ kind: 'install-recipe', versionId: recipe.id })}
                      >
                        Add equipment
                      </Button>
                      <InventoryCatalogVersionActions
                        data={data}
                        target={target}
                        editable={editable}
                        onDialog={onDialog}
                      />
                      <Button
                        disabled={!editable}
                        onClick={() => onDialog({ kind: 'equipment-recipe', versionId: recipe.id })}
                      >
                        Publish new version
                      </Button>
                    </div>
                  </article>
                );
              })}
            <h3 className="text-sm font-semibold">Manufacturer catalog</h3>
            {catalog.kind === 'failed' && catalog.projectId === data.project.projectId ? (
              <Notice
                tone="error"
                actions={
                  <Button onClick={() => void controller.loadCatalog(data.project.projectId)}>
                    Retry catalog
                  </Button>
                }
              >
                {catalog.message}
              </Notice>
            ) : catalog.kind !== 'ready' || catalog.projectId !== data.project.projectId ? (
              <p className="text-sm text-fg-muted">Loading equipment catalog…</p>
            ) : (
              catalog.entries
                .filter((entry) =>
                  matches(
                    `${entry.name} ${entry.model.manufacturer} ${entry.model.model} ${entry.nominalBoxClass}`
                  )
                )
                .map((entry) => {
                  const recipe = entry.definitions.find(
                    (
                      definition
                    ): definition is Extract<
                      InventoryConfigurationCommand,
                      { kind: 'define-equipment-recipe' }
                    > =>
                      definition.kind === 'define-equipment-recipe' &&
                      definition.id === entry.recipeVersionId
                  );
                  const root = recipe?.components.find((component) => component.parentKey === null);
                  const preview = inventoryEquipmentCatalogUpdatePreview(data.state, entry);
                  const shell =
                    recipe && root
                      ? inventoryCatalogRecipeEligibility(
                          data.state,
                          entry.recipeVersionId,
                          recipe.components,
                          [root.key]
                        )
                      : null;
                  return (
                    <article
                      key={entry.id}
                      data-catalog-id={entry.id}
                      className="space-y-3 rounded border border-border p-4"
                    >
                      <h4 className="font-semibold">{entry.name}</h4>
                      <p className="text-xs text-fg-muted">{entry.description}</p>
                      <p className="text-sm">
                        Catalog box positions: {entry.boxPositions} · {entry.nominalBoxClass}
                      </p>
                      <p className="text-xs text-fg-muted">
                        This is one source-backed configuration, separate from installed components
                        and occupied positions.
                      </p>
                      <details>
                        <summary className="cursor-pointer text-xs font-medium">
                          Recipe components
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs text-fg-muted">
                          {recipe?.components.map((component) => {
                            const type = entry.definitions.find(
                              (definition) =>
                                definition.kind === 'define-physical-type' &&
                                definition.id === component.typeVersionId
                            );
                            return (
                              <li key={component.key}>
                                {component.name} ·{' '}
                                {type && 'name' in type ? type.name : 'Type unavailable'}
                                {component.positionId ? ` · Position ${component.positionId}` : ''}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                      {entry.sources.map((source, index) => (
                        <InventorySourceDetails key={index} source={source} />
                      ))}
                      {data.state.recipeVersions[entry.recipeVersionId] ? (
                        <InventoryCatalogVersionState
                          status={inventoryCatalogStatusAt(data, {
                            kind: 'recipe-version',
                            versionId: entry.recipeVersionId,
                          })}
                        />
                      ) : null}
                      <InventoryCatalogEligibilityNotice data={data} eligibility={shell} />
                      {!preview.canApply ? (
                        <p className="text-xs text-fg-muted">
                          This pack conflicts with saved definitions. Preview the catalog update to
                          inspect the differences.
                        </p>
                      ) : null}
                      <Button
                        disabled={!editable || shell?.kind !== 'selectable' || !preview.canApply}
                        onClick={() => onDialog({ kind: 'install-catalog', catalogId: entry.id })}
                      >
                        Add equipment
                      </Button>
                      <Button
                        onClick={() => onDialog({ kind: 'catalog-preview', catalogId: entry.id })}
                      >
                        Preview catalog update
                      </Button>
                    </article>
                  );
                })
            )}
          </div>
        )}
      </div>
    </InventoryPhysicalDialog>
  );
}
