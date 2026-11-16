import { inventoryCommandWithdrawals } from './inventory-materials';
import { inventoryReservationDestinationFailure } from './inventory-reservation-placement';
import type {
  InventoryCommand,
  InventoryConfigurationCommand,
  InventoryExecutionContext,
  InventoryState,
  InventoryStorage,
  InventoryVessel,
  InventoryPhysicalItem,
  InventoryPhysicalConfiguration,
  InventoryPhysicalTypeVersion,
  InventoryEquipmentRecipeVersion,
  InventoryFitEvidence,
  InventoryFitSubject,
  InventoryGeometry,
  InventoryPlacementCompatibility,
  InventoryPhysicalProjection,
  InventoryChildPolicy,
  InventoryLayout,
  InventoryTransition,
  InventoryMetadata,
} from './inventory-types';
import { classifyMetadataValues, validateMetadataValues } from './metadata-fields';
import {
  emptyInventoryPhysicalConfiguration,
  unknownInventoryGeometry,
  normalizeInventoryGeometry,
  inventoryGeometryExceeds,
  inventoryOrientedDimensions,
} from './inventory-geometry';
import {
  inventoryDestinationPlacement,
  inventoryPlacementFailure,
  placeInventoryItem,
} from './inventory-placement';
import { inventoryStoragePositions, inventoryWellId } from './inventory-layout';
import { inventoryCustodyAccess } from './inventory-custody';
import {
  inventoryCatalogProjection,
  inventoryCatalogTypeAdoption,
  inventoryCatalogVersionStatus,
} from './inventory-catalog-lifecycle';

type State = Pick<
  InventoryState,
  'storage' | 'vessels' | 'typeVersions' | 'recipeVersions' | 'fitEvidence'
>;
export interface InventoryConfigurationDraft extends Omit<
  InventoryState,
  'schema' | 'revision' | 'storage' | 'vessels' | 'typeVersions' | 'recipeVersions' | 'fitEvidence'
> {
  readonly storage: Record<string, InventoryStorage>;
  readonly vessels: Record<string, InventoryVessel>;
  readonly typeVersions: Record<string, InventoryPhysicalTypeVersion>;
  readonly recipeVersions: Record<string, InventoryEquipmentRecipeVersion>;
  readonly fitEvidence: Record<string, InventoryFitEvidence>;
}
type Failure = Extract<InventoryTransition, { ok: false }>;
const refuse = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });
const record = (state: Pick<InventoryState, 'storage' | 'vessels'>, item: InventoryPhysicalItem) =>
  item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
export function inventoryRecordIdExists(
  state: Pick<
    InventoryState,
    | 'storage'
    | 'vessels'
    | 'stocks'
    | 'lots'
    | 'reservations'
    | 'typeVersions'
    | 'recipeVersions'
    | 'fitEvidence'
    | 'itemCodes'
    | 'temperatureClaims'
  >,
  id: string
): boolean {
  return [
    state.storage,
    state.vessels,
    state.stocks,
    state.lots,
    state.reservations,
    state.typeVersions,
    state.recipeVersions,
    state.fitEvidence,
    state.itemCodes,
    state.temperatureClaims,
  ].some((rows) => Object.hasOwn(rows, id));
}
export function inventoryEffectiveGeometry(
  state: State,
  item: InventoryPhysicalItem
): InventoryGeometry {
  const row = record(state, item);
  if (!row) throw new TypeError('The configured item does not exist.');
  return structuredClone(
    row.configuration.geometryOverride?.geometry ??
      (row.configuration.typeVersionId
        ? state.typeVersions[row.configuration.typeVersionId]?.definition.geometry
        : undefined) ??
      unknownInventoryGeometry()
  );
}
function customized(state: State, item: InventoryPhysicalItem): boolean {
  const row = record(state, item)!;
  const configuration = row.configuration;
  const type = configuration.typeVersionId
    ? state.typeVersions[configuration.typeVersionId]
    : undefined;
  return (
    (configuration.geometryOverride !== null &&
      JSON.stringify(configuration.geometryOverride.geometry) !==
        JSON.stringify(type?.definition.geometry ?? unknownInventoryGeometry())) ||
    Object.keys(configuration.unavailablePositions).length > 0 ||
    Boolean(
      item.kind === 'storage' &&
      type?.definition.kind === 'storage' &&
      JSON.stringify((row as InventoryStorage).layout) !== JSON.stringify(type.definition.layout)
    )
  );
}
function subjectMatches(
  state: State,
  pin: InventoryFitSubject,
  item: InventoryPhysicalItem
): boolean {
  const row = record(state, item);
  if (!row) return false;
  return pin.kind === 'installed'
    ? pin.item.kind === item.kind &&
        pin.item.id === item.id &&
        pin.configurationRevision === row.configuration.revision
    : pin.versionId === row.configuration.typeVersionId && !customized(state, item);
}
function policyAllows(policy: InventoryChildPolicy, typeId: string | null): boolean {
  return (
    policy.kind === 'any-legal' ||
    (policy.kind === 'types' && typeId !== null && policy.typeIds.includes(typeId))
  );
}
export function inventoryPlacementCompatibility(
  state: State,
  item: InventoryPhysicalItem,
  parentId: string,
  positionId: string,
  creating = false
): InventoryPlacementCompatibility {
  const child = record(state, item),
    parent = state.storage[parentId];
  if ((!child && !creating) || !parent)
    return {
      logical: 'incompatible',
      fit: 'unknown',
      reasons: ['ITEM_NOT_FOUND'],
      evidenceIds: [],
      evidenceBasis: [],
    };
  const childConfiguration = child?.configuration ?? emptyInventoryPhysicalConfiguration();
  const parentType = parent.configuration.typeVersionId
    ? state.typeVersions[parent.configuration.typeVersionId]
    : undefined;
  const childType = childConfiguration.typeVersionId
    ? state.typeVersions[childConfiguration.typeVersionId]
    : undefined;
  const policy =
    parentType?.definition.kind === 'storage'
      ? parentType.definition.childPolicy
      : { kind: 'any-legal' as const };
  const rule =
    parentType?.definition.kind === 'storage'
      ? parentType.definition.positionRules[positionId]
      : undefined;
  const reasons: string[] = [];
  if (parent.configuration.unavailablePositions[positionId] || rule?.kind === 'unavailable')
    reasons.push('POSITION_UNAVAILABLE');
  const intrinsic =
    item.kind === 'vessel' &&
    child &&
    'kind' in child &&
    child.kind === 'fixed-well' &&
    parent.layout.kind === 'fixed-well' &&
    item.id === inventoryWellId(parentId, positionId);
  if (
    !intrinsic &&
    (!policyAllows(policy, childType?.typeId ?? null) ||
      (rule?.kind === 'available' &&
        rule.childPolicy &&
        !policyAllows(rule.childPolicy, childType?.typeId ?? null)))
  )
    reasons.push('CHILD_TYPE_NOT_ALLOWED');
  const external = child
    ? inventoryEffectiveGeometry(state, item).external
    : unknownInventoryGeometry().external;
  const usable = inventoryEffectiveGeometry(state, { kind: 'storage', id: parentId }).usable;
  const turns: readonly (0 | 1 | 2 | 3)[] =
    childConfiguration.orientation.kind === 'known'
      ? [childConfiguration.orientation.quarterTurns]
      : [];
  const geometryBad = inventoryOrientedDimensions(external, childConfiguration.orientation).every(
    (shape) =>
      inventoryGeometryExceeds(shape, usable, 0) ||
      (rule?.kind === 'available' &&
        rule.usable !== null &&
        inventoryGeometryExceeds(shape, rule.usable, 0))
  );
  if (geometryBad) reasons.push('GEOMETRY_EXCEEDED');
  const matching = Object.values(state.fitEvidence).filter(
    (evidence) =>
      turns.length > 0 &&
      subjectMatches(state, evidence.parent, { kind: 'storage', id: parentId }) &&
      subjectMatches(state, evidence.child, item) &&
      (evidence.positionId === null || evidence.positionId === positionId) &&
      turns.every((turn) => evidence.orientations.includes(turn))
  );
  const evidenceIds = matching.map((evidence) => evidence.id),
    evidenceBasis = [...new Set(matching.map((evidence) => evidence.basis))];
  const positive = matching.some((evidence) => evidence.result === 'compatible'),
    negative = matching.some((evidence) => evidence.result === 'incompatible');
  const logical = reasons.some((reason) => reason !== 'GEOMETRY_EXCEEDED')
    ? 'incompatible'
    : 'allowed';
  if (logical === 'incompatible' || geometryBad)
    return { logical, fit: 'incompatible', reasons, evidenceIds, evidenceBasis };
  if (positive && negative)
    return {
      logical,
      fit: 'unknown',
      reasons: ['CONFLICTING_FIT_EVIDENCE'],
      evidenceIds,
      evidenceBasis,
    };
  return {
    logical,
    fit: negative ? 'incompatible' : positive ? 'compatible' : 'unknown',
    reasons: negative ? ['SCOPED_INCOMPATIBILITY'] : positive ? [] : ['FIT_NOT_ESTABLISHED'],
    evidenceIds,
    evidenceBasis,
  };
}
export function inventoryPhysicalProjection(state: State): InventoryPhysicalProjection {
  const items: Record<string, InventoryPhysicalProjection['items'][string]> = Object.create(null);
  for (const item of [
    ...Object.keys(state.storage).map((id) => ({ kind: 'storage' as const, id })),
    ...Object.keys(state.vessels).map((id) => ({ kind: 'vessel' as const, id })),
  ]) {
    const row = record(state, item)!,
      type = row.configuration.typeVersionId
        ? state.typeVersions[row.configuration.typeVersionId]
        : null;
    items[item.id] = {
      item,
      configuration: structuredClone(row.configuration),
      type: type ? structuredClone(type) : null,
      recipe: row.configuration.recipe
        ? structuredClone(state.recipeVersions[row.configuration.recipe.recipeVersionId])
        : null,
      geometry: inventoryEffectiveGeometry(state, item),
      customized: customized(state, item),
      metadataIssues: classifyMetadataValues(type?.fields ?? [], row.configuration.metadata, {
        rejectUnknownFields: true,
      }),
      placementCompatibility:
        row.placement.kind === 'located'
          ? inventoryPlacementCompatibility(
              state,
              item,
              row.placement.storageId,
              row.placement.slotId
            )
          : null,
    };
  }
  return {
    catalog: inventoryCatalogProjection(state),
    typeVersions: structuredClone(Object.values(state.typeVersions)),
    recipeVersions: structuredClone(Object.values(state.recipeVersions)),
    fitEvidence: structuredClone(Object.values(state.fitEvidence)),
    items,
  };
}
function children(state: State, id: string): InventoryPhysicalItem[] {
  return [
    ...Object.values(state.storage)
      .filter((row) => row.placement.kind === 'located' && row.placement.storageId === id)
      .map((row) => ({ kind: 'storage' as const, id: row.id })),
    ...Object.values(state.vessels)
      .filter((row) => row.placement.kind === 'located' && row.placement.storageId === id)
      .map((row) => ({ kind: 'vessel' as const, id: row.id })),
  ];
}
function logicalChildrenFailure(state: InventoryConfigurationDraft, id: string): Failure | null {
  for (const child of children(state, id)) {
    const row = record(state, child)!;
    if (row.placement.kind !== 'located') continue;
    const fit = inventoryPlacementCompatibility(state, child, id, row.placement.slotId);
    if (
      fit.logical === 'incompatible' &&
      !(
        child.kind === 'vessel' &&
        'kind' in row &&
        row.kind === 'fixed-well' &&
        !Object.values(state.stocks).some((stock) => stock.vesselId === child.id)
      )
    )
      return refuse(
        'INCOMPATIBLE_LAYOUT',
        'The configuration would make an occupied child or position logically incompatible.'
      );
  }
  return null;
}
function putConfiguration(
  state: InventoryConfigurationDraft,
  item: InventoryPhysicalItem,
  configuration: InventoryPhysicalConfiguration
): void {
  if (!Number.isSafeInteger(configuration.revision))
    throw new TypeError('The physical configuration revision cannot advance safely.');
  if (item.kind === 'storage')
    state.storage[item.id] = { ...state.storage[item.id], configuration };
  else state.vessels[item.id] = { ...state.vessels[item.id], configuration };
}
function bindingFailure(
  type: InventoryPhysicalTypeVersion,
  item: InventoryPhysicalItem,
  row: InventoryStorage | InventoryVessel
): Failure | null {
  if (type.definition.kind !== item.kind)
    return refuse('INCOMPATIBLE_LAYOUT', 'The physical type does not match this item kind.');
  if (type.definition.kind === 'vessel' && 'kind' in row && type.definition.mobility !== row.kind)
    return refuse(
      'INCOMPATIBLE_LAYOUT',
      'Permanent wells and movable containers cannot change physical identity.'
    );
  return null;
}
function version(rows: readonly { version: number }[]): number {
  const value = Math.max(0, ...rows.map((row) => row.version)) + 1;
  if (!Number.isSafeInteger(value)) throw new TypeError('Physical version exhausted.');
  return value;
}
export function applyInventoryConfigurationCommand(
  state: InventoryConfigurationDraft,
  command: InventoryCommand,
  context: InventoryExecutionContext | undefined,
  apply: (command: InventoryCommand) => Failure | null
): Failure | null | undefined {
  if (
    ![
      'define-physical-type',
      'define-equipment-recipe',
      'instantiate-physical-type',
      'instantiate-equipment-recipe',
      'configure-item',
      'record-item-geometry',
      'reconfigure-storage',
      'record-fit-evidence',
      'retire-catalog-version',
      'restore-catalog-version',
    ].includes(command.kind)
  )
    return undefined;
  if (!context)
    return refuse(
      'CONTEXT_REQUIRED',
      'Physical configuration requires trusted actor and clock context.'
    );
  const cmd = command as InventoryConfigurationCommand;
  const publication = { publishedAt: context.at, publishedBy: { ...context.principal } };
  const instantiate = (
    typeVersionId: string,
    id: string,
    name: string,
    metadata: InventoryMetadata,
    destination: Extract<
      InventoryConfigurationCommand,
      { kind: 'instantiate-physical-type' }
    >['destination']
  ): Failure | null => {
    if (inventoryRecordIdExists(state, id))
      return refuse('ID_ALREADY_EXISTS', 'The installed component identifier already exists.');
    const type = state.typeVersions[typeVersionId];
    if (!type)
      return refuse('INVALID_INVENTORY_INPUT', 'The physical type version does not exist.');
    const eligibility = inventoryCatalogVersionStatus(state, {
      kind: 'type-version',
      versionId: typeVersionId,
    })!.eligibility;
    if (eligibility.kind === 'blocked')
      return refuse(
        'CATALOG_VERSION_RETIRED',
        'The physical type version is retired for new selection.'
      );
    const errors = validateMetadataValues(type.fields, metadata, { rejectUnknownFields: true });
    if (errors.length) return refuse('INVALID_INVENTORY_INPUT', errors.join(' '));
    let invalid: Failure | null;
    if (type.definition.kind === 'storage')
      invalid = apply({
        kind: 'create-layout-storage',
        id,
        name,
        layout: type.definition.layout,
        placement: { kind: 'root' },
      });
    else {
      if (type.definition.mobility !== 'movable')
        return refuse('FIXED_WELL_IMMUTABLE', 'A permanent well is created with its plate.');
      invalid = apply({ kind: 'create-vessel', id, name, placement: { kind: 'unplaced' } });
    }
    if (invalid) return invalid;
    const item: InventoryPhysicalItem = { kind: type.definition.kind, id };
    putConfiguration(state, item, {
      ...emptyInventoryPhysicalConfiguration(),
      revision: 1,
      typeVersionId,
      metadata: structuredClone(metadata),
    });
    if (type.definition.kind === 'vessel') {
      invalid = apply({
        kind: 'set-vessel-limits',
        vesselId: id,
        limits: type.definition.limits,
        reason: 'Apply pinned physical type limits',
      });
      if (invalid) return invalid;
    }
    const placement = inventoryDestinationPlacement(state, item, destination);
    if ('ok' in placement) return placement;
    if (placement.kind === 'located') {
      invalid = inventoryCustodyAccess(
        state,
        { kind: 'storage', id: placement.storageId },
        context.principal
      );
      if (invalid) return invalid;
      invalid = inventoryReservationDestinationFailure(
        state,
        { kind: 'storage', id: placement.storageId },
        context.principal
      );
      if (invalid) return invalid;
      const fit = inventoryPlacementCompatibility(
        state,
        item,
        placement.storageId,
        placement.slotId
      );
      if (fit.logical === 'incompatible' || fit.fit === 'incompatible')
        return refuse('INCOMPATIBLE_LAYOUT', fit.reasons.join(', '));
    }
    placeInventoryItem(state, item, record(state, item)!, placement);
    return null;
  };
  switch (cmd.kind) {
    case 'retire-catalog-version':
    case 'restore-catalog-version': {
      const rows = cmd.target.kind === 'type-version' ? state.typeVersions : state.recipeVersions;
      const row = rows[cmd.target.versionId];
      if (!row) return refuse('INVALID_INVENTORY_INPUT', 'The catalog version does not exist.');
      if ((cmd.kind === 'retire-catalog-version') !== (row.selection.kind === 'available'))
        return refuse(
          'INVALID_CATALOG_TRANSITION',
          'The catalog version is already in the requested selection state.'
        );
      const selection =
        cmd.kind === 'retire-catalog-version'
          ? {
              kind: 'retired' as const,
              at: context.at,
              by: { ...context.principal },
              reason: cmd.reason,
            }
          : { kind: 'available' as const };
      if (cmd.target.kind === 'type-version')
        state.typeVersions[row.id] = { ...state.typeVersions[row.id], selection };
      else state.recipeVersions[row.id] = { ...state.recipeVersions[row.id], selection };
      return null;
    }
    case 'define-physical-type': {
      if (inventoryRecordIdExists(state, cmd.id))
        return refuse('ID_ALREADY_EXISTS', 'The type version identifier already exists.');
      const previous = Object.values(state.typeVersions).filter((row) => row.typeId === cmd.typeId);
      if (
        previous.some(
          (row) =>
            row.definition.kind !== cmd.definition.kind ||
            (row.definition.kind === 'vessel' &&
              cmd.definition.kind === 'vessel' &&
              row.definition.mobility !== cmd.definition.mobility)
        )
      )
        return refuse(
          'INCOMPATIBLE_LAYOUT',
          'A physical type family cannot change item kind or mobility.'
        );
      if (cmd.definition.kind === 'storage') {
        const positions = inventoryStoragePositions(cmd.definition);
        if (Object.keys(cmd.definition.positionRules).some((key) => !positions.includes(key)))
          return refuse('INVALID_PLACEMENT', 'Position rules must name actual type positions.');
      }
      const definition = {
        ...structuredClone(cmd.definition),
        geometry: normalizeInventoryGeometry(cmd.definition.geometry),
      };
      state.typeVersions[cmd.id] = {
        id: cmd.id,
        typeId: cmd.typeId,
        version: version(previous),
        name: cmd.name,
        description: cmd.description,
        fields: structuredClone(cmd.fields),
        sources: structuredClone(cmd.sources),
        definition,
        selection: { kind: 'available' },
        ...publication,
      };
      return null;
    }
    case 'instantiate-physical-type':
      return instantiate(cmd.typeVersionId, cmd.id, cmd.name, cmd.metadata, cmd.destination);
    case 'record-item-geometry': {
      const row = record(state, cmd.item);
      if (!row)
        return refuse(
          cmd.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
          'The measured item does not exist.'
        );
      putConfiguration(state, cmd.item, {
        ...row.configuration,
        revision:
          row.configuration.revision +
          (JSON.stringify(inventoryEffectiveGeometry(state, cmd.item)) !==
          JSON.stringify(normalizeInventoryGeometry(cmd.geometry))
            ? 1
            : 0),
        geometryOverride: {
          geometry: normalizeInventoryGeometry(cmd.geometry),
          source: structuredClone(cmd.source),
          at: context.at,
          by: { ...context.principal },
          reason: cmd.reason,
        },
      });
      return null;
    }
    case 'configure-item': {
      const row = record(state, cmd.item);
      if (!row)
        return refuse(
          cmd.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
          'The configured item does not exist.'
        );
      const type = cmd.typeVersionId ? state.typeVersions[cmd.typeVersionId] : undefined;
      if (cmd.typeVersionId && !type)
        return refuse('INVALID_INVENTORY_INPUT', 'The physical type version does not exist.');
      const eligibility = inventoryCatalogTypeAdoption(state, cmd.item, cmd.typeVersionId);
      if (eligibility?.kind === 'blocked')
        return refuse(
          'CATALOG_VERSION_RETIRED',
          'The physical type version is retired for new adoption.'
        );
      if (type) {
        const invalid = bindingFailure(type, cmd.item, row);
        if (invalid) return invalid;
      }
      const errors = validateMetadataValues(type?.fields ?? [], cmd.metadata, {
        rejectUnknownFields: true,
      });
      if (errors.length) return refuse('INVALID_INVENTORY_INPUT', errors.join(' '));
      if (cmd.item.kind === 'vessel' && Object.keys(cmd.unavailablePositions).length)
        return refuse('INVALID_PLACEMENT', 'A vessel has no child positions.');
      if (cmd.item.kind === 'storage') {
        const positions = inventoryStoragePositions(row as InventoryStorage);
        if (Object.keys(cmd.unavailablePositions).some((key) => !positions.includes(key)))
          return refuse(
            'INVALID_PLACEMENT',
            'Unavailable positions must exist in the installed layout.'
          );
      }
      putConfiguration(state, cmd.item, {
        ...row.configuration,
        revision:
          row.configuration.revision +
          (row.configuration.typeVersionId !== cmd.typeVersionId ||
          JSON.stringify(row.configuration.orientation) !== JSON.stringify(cmd.orientation) ||
          JSON.stringify(Object.keys(row.configuration.unavailablePositions).sort()) !==
            JSON.stringify(Object.keys(cmd.unavailablePositions).sort())
            ? 1
            : 0),
        typeVersionId: cmd.typeVersionId,
        metadata: structuredClone(cmd.metadata),
        orientation: structuredClone(cmd.orientation),
        unavailablePositions: structuredClone(cmd.unavailablePositions),
      });
      return cmd.item.kind === 'storage' ? logicalChildrenFailure(state, cmd.item.id) : null;
    }
    case 'reconfigure-storage': {
      const row = state.storage[cmd.storageId];
      if (!row) return refuse('STORAGE_NOT_FOUND', 'The installed location does not exist.');
      const access = inventoryCustodyAccess(
        state,
        { kind: 'storage', id: row.id },
        context.principal
      );
      if (access) return access;
      if (
        (row.layout.kind === 'fixed-well' || cmd.layout.kind === 'fixed-well') &&
        JSON.stringify(row.layout) !== JSON.stringify(cmd.layout)
      )
        return refuse(
          'FIXED_WELL_IMMUTABLE',
          'Permanent-well geometry requires explicit reconciliation or replacement.'
        );
      const updated = {
          ...row,
          layout: structuredClone(cmd.layout),
          configuration: {
            ...row.configuration,
            revision:
              row.configuration.revision +
              (JSON.stringify(row.layout) !== JSON.stringify(cmd.layout) ? 1 : 0),
          },
        },
        positions = inventoryStoragePositions({ ...row, layout: cmd.layout });
      if (
        children(state, row.id).some((item) => {
          const child = record(state, item)!;
          return child.placement.kind === 'located' && !positions.includes(child.placement.slotId);
        })
      )
        return refuse('SLOT_OCCUPIED', 'The layout would remove an occupied position.');
      if (cmd.layout.kind === 'stack') {
        const occupied = children(state, row.id)
          .map((item) => record(state, item)!.placement)
          .filter((placement) => placement.kind === 'located')
          .map((placement) => Number(placement.slotId))
          .sort((a, b) => a - b);
        if (occupied.some((position, index) => position !== index + 1))
          return refuse(
            'STACK_OPERATION_REQUIRED',
            'The stack requires a contiguous occupied prefix.'
          );
      }
      if (!Number.isSafeInteger(updated.configuration.revision))
        return refuse(
          'REVISION_EXHAUSTED',
          'Physical configuration revision cannot advance safely.'
        );
      state.storage[row.id] = updated;
      for (const child of children(state, row.id)) {
        const placement = record(state, child)!.placement;
        if (placement.kind === 'located') {
          const invalid = inventoryPlacementFailure(
            state,
            child,
            placement,
            cmd.layout.kind === 'stack'
              ? 'stack'
              : cmd.layout.kind === 'fixed-well'
                ? 'fixed-well'
                : 'ordinary',
            false
          );
          if (invalid) return invalid;
        }
      }
      return logicalChildrenFailure(state, row.id);
    }
    case 'define-equipment-recipe': {
      if (inventoryRecordIdExists(state, cmd.id))
        return refuse('ID_ALREADY_EXISTS', 'The recipe version identifier already exists.');
      const keys = new Map(cmd.components.map((component) => [component.key, component]));
      if (
        keys.size !== cmd.components.length ||
        cmd.components.filter((component) => component.parentKey === null).length !== 1
      )
        return refuse(
          'INVALID_INVENTORY_INPUT',
          'A recipe requires distinct keys and exactly one root.'
        );
      const occupied = new Set<string>();
      for (const component of cmd.components) {
        const type = state.typeVersions[component.typeVersionId];
        if (
          !type ||
          (type.definition.kind === 'vessel' && type.definition.mobility === 'fixed-well')
        )
          return refuse(
            'INVALID_INVENTORY_INPUT',
            'Recipe components require existing movable physical types.'
          );
        if (component.parentKey === null) {
          if (component.positionId !== null)
            return refuse('INVALID_PLACEMENT', 'A recipe root has no parent position.');
          continue;
        }
        const parent = keys.get(component.parentKey),
          parentType = parent ? state.typeVersions[parent.typeVersionId] : undefined;
        if (!parent || parentType?.definition.kind !== 'storage' || component.positionId === null)
          return refuse(
            'INVALID_PLACEMENT',
            'Each recipe child requires a storage parent and position.'
          );
        if (
          parentType.definition.layout.kind === 'fixed-well' ||
          (parentType.definition.layout.kind === 'removable-tube' &&
            type.definition.kind !== 'vessel')
        )
          return refuse(
            'INCOMPATIBLE_LAYOUT',
            'The recipe child violates its parent layout semantics.'
          );
        if (
          !inventoryStoragePositions(parentType.definition).includes(component.positionId) ||
          !policyAllows(parentType.definition.childPolicy, type.typeId) ||
          parentType.definition.positionRules[component.positionId]?.kind === 'unavailable'
        )
          return refuse(
            'INCOMPATIBLE_LAYOUT',
            'The recipe child is not allowed in its parent position.'
          );
        const position = JSON.stringify([component.parentKey, component.positionId]);
        if (occupied.has(position))
          return refuse('SLOT_OCCUPIED', 'Recipe children cannot share a position.');
        occupied.add(position);
        const visited = new Set<string>([component.key]);
        let ancestor = parent;
        while (ancestor) {
          if (visited.has(ancestor.key))
            return refuse('CONTAINMENT_CYCLE', 'Recipe containment cannot contain a cycle.');
          visited.add(ancestor.key);
          if (ancestor.parentKey === null) break;
          const next = keys.get(ancestor.parentKey);
          if (!next) return refuse('INVALID_PLACEMENT', 'Recipe parent is missing.');
          ancestor = next;
        }
      }
      for (const parent of cmd.components) {
        const type = state.typeVersions[parent.typeVersionId];
        if (type.definition.kind === 'storage' && type.definition.layout.kind === 'stack') {
          const ordinals = cmd.components
            .filter((child) => child.parentKey === parent.key)
            .map((child) => Number(child.positionId))
            .sort((a, b) => a - b);
          if (ordinals.some((value, index) => value !== index + 1))
            return refuse(
              'STACK_OPERATION_REQUIRED',
              'Recipe stack children require a contiguous ordered prefix.'
            );
        }
      }
      state.recipeVersions[cmd.id] = {
        id: cmd.id,
        recipeId: cmd.recipeId,
        version: version(
          Object.values(state.recipeVersions).filter((row) => row.recipeId === cmd.recipeId)
        ),
        name: cmd.name,
        description: cmd.description,
        model: structuredClone(cmd.model),
        components: structuredClone(cmd.components),
        sources: structuredClone(cmd.sources),
        selection: { kind: 'available' },
        ...publication,
      };
      return null;
    }
    case 'instantiate-equipment-recipe': {
      const recipe = state.recipeVersions[cmd.recipeVersionId];
      if (!recipe) return refuse('INVALID_INVENTORY_INPUT', 'The recipe version does not exist.');
      const selected = new Map(cmd.components.map((binding) => [binding.key, binding]));
      if (
        selected.size !== cmd.components.length ||
        new Set(cmd.components.map((binding) => binding.id)).size !== cmd.components.length
      )
        return refuse(
          'ID_ALREADY_EXISTS',
          'Selected components require distinct keys and identifiers.'
        );
      const components = new Map(recipe.components.map((component) => [component.key, component])),
        root = recipe.components.find((component) => component.parentKey === null)!;
      if (!selected.has(root.key) || cmd.components.some((binding) => !components.has(binding.key)))
        return refuse(
          'INVALID_INVENTORY_INPUT',
          'Select the root and only declared recipe components.'
        );
      for (const binding of cmd.components) {
        const component = components.get(binding.key)!;
        if (component.parentKey !== null && !selected.has(component.parentKey))
          return refuse(
            'INVALID_PLACEMENT',
            'An installed component requires its selected actual parent.'
          );
      }
      const eligibility = inventoryCatalogVersionStatus(
        state,
        { kind: 'recipe-version', versionId: recipe.id },
        [...selected.keys()]
      )!.eligibility;
      if (eligibility.kind === 'blocked')
        return refuse(
          eligibility.blockers[0].code,
          'The selected recipe or selected component type is retired for new installation.'
        );
      for (const parent of recipe.components) {
        const type = state.typeVersions[parent.typeVersionId];
        if (type.definition.kind === 'storage' && type.definition.layout.kind === 'stack') {
          const ordinals = recipe.components
            .filter((child) => child.parentKey === parent.key && selected.has(child.key))
            .map((child) => Number(child.positionId))
            .sort((a, b) => a - b);
          if (ordinals.some((value, index) => value !== index + 1))
            return refuse(
              'STACK_OPERATION_REQUIRED',
              'Selected stack components must form an explicit occupied prefix.'
            );
        }
      }
      const pending = new Set(selected.keys()),
        installed = new Set<string>();
      while (pending.size) {
        let progressed = false;
        for (const key of pending) {
          const component = components.get(key)!,
            binding = selected.get(key)!;
          if (component.parentKey !== null && !installed.has(component.parentKey)) continue;
          const parent = component.parentKey === null ? null : components.get(component.parentKey)!,
            parentType = parent ? state.typeVersions[parent.typeVersionId] : undefined;
          const inStack =
            parentType?.definition.kind === 'storage' &&
            parentType.definition.layout.kind === 'stack';
          if (
            inStack &&
            [...pending].some(
              (other) =>
                components.get(other)!.parentKey === component.parentKey &&
                Number(components.get(other)!.positionId) < Number(component.positionId)
            )
          )
            continue;
          const destination =
            component.parentKey === null
              ? cmd.destination
              : inStack
                ? { kind: 'stack-top' as const, stackId: selected.get(component.parentKey)!.id }
                : {
                    kind: 'located' as const,
                    storageId: selected.get(component.parentKey)!.id,
                    slotId: component.positionId!,
                  };
          const invalid = instantiate(
            component.typeVersionId,
            binding.id,
            component.parentKey === null ? cmd.name : component.name,
            binding.metadata,
            destination
          );
          if (invalid) return invalid;
          const type = state.typeVersions[component.typeVersionId],
            item = { kind: type.definition.kind, id: binding.id } as const,
            row = record(state, item)!;
          putConfiguration(state, item, {
            ...row.configuration,
            recipe: { recipeVersionId: recipe.id, componentKey: key },
          });
          installed.add(key);
          pending.delete(key);
          progressed = true;
        }
        if (!progressed)
          return refuse('CONTAINMENT_CYCLE', 'The selected recipe is not an installable tree.');
      }
      return null;
    }
    case 'record-fit-evidence': {
      if (inventoryRecordIdExists(state, cmd.id))
        return refuse('ID_ALREADY_EXISTS', 'The fit evidence identifier already exists.');
      for (const pin of [cmd.parent, cmd.child]) {
        if (pin.kind === 'type-version') {
          if (!state.typeVersions[pin.versionId])
            return refuse(
              'INVALID_INVENTORY_INPUT',
              'Fit evidence requires an existing type version.'
            );
        } else {
          const row = record(state, pin.item);
          if (!row || row.configuration.revision !== pin.configurationRevision)
            return refuse('REVISION_CONFLICT', 'The fit subject configuration changed.');
        }
      }
      if (cmd.basis === 'manufacturer-supported' && cmd.source === null)
        return refuse(
          'INVALID_INVENTORY_INPUT',
          'A manufacturer assertion requires its applicable source.'
        );
      const { kind: _, ...facts } = cmd;
      state.fitEvidence[cmd.id] = {
        ...structuredClone(facts),
        at: context.at,
        by: { ...context.principal },
      };
      return null;
    }
  }
}
export function validateInventoryPhysicalState(state: InventoryState): void {
  const error = (message: string): never => {
    throw new TypeError(message);
  };
  const families = new Map<string, number[]>(),
    recipes = new Map<string, number[]>();
  for (const type of Object.values(state.typeVersions)) {
    if (type.publishedAt > state.lastRecordedAt)
      error('A physical type cannot be published after the recorded clock.');
    if (
      type.selection.kind === 'retired' &&
      (type.selection.at < type.publishedAt || type.selection.at > state.lastRecordedAt)
    )
      error('A catalog retirement must follow publication and the recorded clock.');
    families.set(type.typeId, [...(families.get(type.typeId) ?? []), type.version]);
    if (
      type.definition.kind === 'storage' &&
      Object.keys(type.definition.positionRules).some(
        (key) =>
          !inventoryStoragePositions(
            type.definition as Extract<typeof type.definition, { kind: 'storage' }>
          ).includes(key)
      )
    )
      error('Physical type policy names a missing position.');
  }
  for (const recipe of Object.values(state.recipeVersions)) {
    if (recipe.publishedAt > state.lastRecordedAt)
      error('A recipe cannot be published after the recorded clock.');
    if (
      recipe.selection.kind === 'retired' &&
      (recipe.selection.at < recipe.publishedAt || recipe.selection.at > state.lastRecordedAt)
    )
      error('A catalog retirement must follow publication and the recorded clock.');
    recipes.set(recipe.recipeId, [...(recipes.get(recipe.recipeId) ?? []), recipe.version]);
    const map = new Map(recipe.components.map((component) => [component.key, component]));
    if (
      map.size !== recipe.components.length ||
      recipe.components.filter((component) => component.parentKey === null).length !== 1
    )
      error('A saved recipe requires distinct components and one root.');
    const occupied = new Set<string>();
    for (const component of recipe.components) {
      if (!state.typeVersions[component.typeVersionId])
        error('A recipe references a missing physical type.');
      const seen = new Set<string>();
      let cursor: typeof component | undefined = component;
      while (cursor) {
        if (seen.has(cursor.key)) error('Saved recipe containment cannot cycle.');
        seen.add(cursor.key);
        if (cursor.parentKey === null) break;
        cursor = map.get(cursor.parentKey);
        if (!cursor) error('A saved recipe parent is missing.');
      }
      if (component.parentKey !== null) {
        const parent = map.get(component.parentKey)!,
          parentType = state.typeVersions[parent.typeVersionId];
        if (
          parentType.definition.kind !== 'storage' ||
          component.positionId === null ||
          !inventoryStoragePositions(parentType.definition).includes(component.positionId)
        )
          error('Saved recipe position is invalid.');
        const key = JSON.stringify([component.parentKey, component.positionId]);
        if (occupied.has(key)) error('Saved recipe components share a position.');
        occupied.add(key);
      }
    }
  }
  for (const values of [...families.values(), ...recipes.values()])
    if (values.sort((a, b) => a - b).some((value, index) => value !== index + 1))
      error('Physical versions require a unique consecutive history.');
  for (const item of [
    ...Object.keys(state.storage).map((id) => ({ kind: 'storage' as const, id })),
    ...Object.keys(state.vessels).map((id) => ({ kind: 'vessel' as const, id })),
  ]) {
    const row = record(state, item)!,
      configuration = row.configuration,
      type = configuration.typeVersionId
        ? state.typeVersions[configuration.typeVersionId]
        : undefined;
    if (configuration.typeVersionId && !type)
      error('An installed physical type version is missing.');
    if (type && bindingFailure(type, item, row))
      error('An installed type has incompatible kind or mobility.');
    const issues = validateMetadataValues(type?.fields ?? [], configuration.metadata, {
      rejectUnknownFields: true,
    });
    if (issues.length) error(issues.join(' '));
    if (configuration.geometryOverride && configuration.geometryOverride.at > state.lastRecordedAt)
      error('A local geometry observation exceeds recorded time.');
    if (
      configuration.recipe &&
      !state.recipeVersions[configuration.recipe.recipeVersionId]?.components.some(
        (component) => component.key === configuration.recipe!.componentKey
      )
    )
      error('An installed recipe pin is invalid.');
    const disabled = Object.keys(configuration.unavailablePositions);
    if (item.kind === 'vessel' && disabled.length)
      error('A vessel cannot disable child positions.');
    if (
      item.kind === 'storage' &&
      disabled.some((key) => !inventoryStoragePositions(row as InventoryStorage).includes(key))
    )
      error('An unavailable position is absent from the layout.');
  }
  for (const evidence of Object.values(state.fitEvidence)) {
    if (evidence.at > state.lastRecordedAt) error('Fit evidence exceeds recorded time.');
    for (const pin of [evidence.parent, evidence.child])
      if (pin.kind === 'type-version') {
        if (!state.typeVersions[pin.versionId]) error('Fit evidence has a missing type version.');
      } else {
        const row = record(state, pin.item);
        if (!row || pin.configurationRevision > row.configuration.revision)
          error('Fit evidence has an invalid installed pin.');
      }
    if (evidence.basis === 'manufacturer-supported' && evidence.source === null)
      error('A manufacturer assertion requires cited provenance.');
  }
}

export function inventoryPhysicalPositionUnavailable(
  state: State,
  item: InventoryPhysicalItem
): boolean {
  const row = record(state, item);
  if (!row || row.placement.kind !== 'located') return false;
  const parent = state.storage[row.placement.storageId];
  if (!parent) return false;
  const type = parent.configuration.typeVersionId
    ? state.typeVersions[parent.configuration.typeVersionId]
    : undefined;
  return Boolean(
    parent.configuration.unavailablePositions[row.placement.slotId] ||
    (type?.definition.kind === 'storage' &&
      type.definition.positionRules[row.placement.slotId]?.kind === 'unavailable')
  );
}
export function inventoryConfigurationAccess(
  state: Pick<
    InventoryState,
    'storage' | 'vessels' | 'stocks' | 'typeVersions' | 'recipeVersions' | 'fitEvidence'
  >,
  command: InventoryCommand
): Failure | null {
  const items: InventoryPhysicalItem[] = inventoryCommandWithdrawals(command).flatMap((input) =>
    state.stocks[input.stockId]
      ? [{ kind: 'vessel' as const, id: state.stocks[input.stockId].vesselId }]
      : []
  );
  if (
    command.kind === 'receive-stock' ||
    command.kind === 'receive-lot-stock' ||
    command.kind === 'pool' ||
    command.kind === 'dilute'
  )
    items.push({ kind: 'vessel', id: command.vesselId });
  if (command.kind === 'transfer') {
    if (command.destination.kind === 'new-stock')
      items.push({ kind: 'vessel', id: command.destination.vesselId });
    else if (state.stocks[command.destination.stockId])
      items.push({ kind: 'vessel', id: state.stocks[command.destination.stockId].vesselId });
  }
  return items.some((item) => inventoryPhysicalPositionUnavailable(state, item))
    ? refuse('POSITION_UNAVAILABLE', 'The physical position is unavailable for use.')
    : null;
}
