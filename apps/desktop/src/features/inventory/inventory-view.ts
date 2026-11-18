import type { InventoryScientificDialog } from './InventoryScientificForm';
import type { InventoryStockroomDialog } from './InventoryStockroomForm';
import type { InventoryArrivalDialog } from './InventoryArrivalForm';
import type { InventoryContentsDialog } from './InventoryContentsForm';
import type { InventoryData } from './inventory-controller';
import type { InventoryValidityDialog } from './InventoryValidityForms';
import type { InventoryLotControlsDialog } from './InventoryLotControlsForm';
import type { InventoryMaterialDialog } from './InventoryMaterialForm';
import type { InventoryCompositionDialog } from './InventoryCompositionForm';
import type { InventoryReservationDialog } from './InventoryReservations';
import type { InventoryCustodyDialog } from './InventoryCustodyForm';
import type { InventoryPhysicalDialogKind } from './inventory-physical-view';
import type { InventoryItemCodeDialog } from './inventory-item-code-view';
import type { InventoryTemperatureDialog } from './inventory-temperature-view';
import {
  INVENTORY_AMOUNT_UNITS,
  inventoryAmountUnitDefinition,
  inventoryStoragePositions,
  inventoryStackItems,
  type InventoryCommand,
  type InventoryAvailabilityBlocker,
  type InventoryItemCustody,
  type InventoryLocationPathEntry,
  type InventoryConcentration,
  type InventoryConcentrationUnit,
  type InventoryLocatedPlacement,
  type InventoryState,
  type InventoryStorage,
  type InventoryVessel,
  type InventoryPrincipal,
  type InventoryRecordedPrincipal,
  type InventoryAmount,
  type InventoryAmountUnit,
  type InventoryQuantityInput,
  type InventoryStockActionAdmission,
} from '@waypoint/domain-services';

export function inventoryStockAction(
  data: InventoryData,
  stockId: string,
  action: 'reserve' | 'withdraw'
): InventoryStockActionAdmission | undefined {
  const snapshot = data.availability;
  if (
    !snapshot ||
    snapshot.revision !== data.state.revision ||
    snapshot.projectId !== data.project.projectId ||
    snapshot.inventoryId !== data.project.defaultInventoryId
  )
    return undefined;
  return snapshot.stocks[stockId]?.actions?.[action];
}

export function inventoryAmountUnitLabel(unit: InventoryAmountUnit): string {
  return unit.replace(/^u/u, 'µ');
}

export function inventoryAmountUnitOptions(unit?: InventoryAmountUnit) {
  return INVENTORY_AMOUNT_UNITS.filter(
    (candidate) =>
      !unit ||
      inventoryAmountUnitDefinition(candidate).dimension ===
        inventoryAmountUnitDefinition(unit).dimension
  ).map((value) => ({ value, label: inventoryAmountUnitLabel(value) }));
}

export function inventoryAmountLabel(amount: InventoryQuantityInput | InventoryAmount): string {
  const unit = inventoryAmountUnitLabel('unit' in amount ? amount.unit : 'uL');
  return 'kind' in amount && amount.kind === 'unknown'
    ? `Unknown ${unit}`
    : `${amount.value} ${unit}`;
}

export function inventoryPrincipalLabel(
  holder: InventoryRecordedPrincipal,
  current?: InventoryPrincipal
): string {
  if (holder.kind === 'imported') {
    const person =
      holder.principal.kind === 'agent'
        ? `agent ${holder.principal.identityId}`
        : holder.principal.kind === 'organization-account'
          ? `organization account ${holder.principal.accountId} · ${holder.principal.orgId}`
          : 'desktop profile';
    return `Imported ${person} · ${holder.source.projectId} / ${holder.source.inventoryId}`;
  }
  if (holder.kind === 'agent') return `Agent ${holder.identityId}`;
  if (holder.kind === 'organization-account')
    return current?.kind === 'organization-account' &&
      current.orgId === holder.orgId &&
      current.accountId === holder.accountId
      ? 'You'
      : `Organization account ${holder.accountId} · ${holder.orgId}`;
  if (current?.kind !== 'local-profile') return 'Desktop profile';
  return holder.profileKey === current.profileKey
    ? 'This desktop profile'
    : 'Another desktop profile';
}

export type InventorySelection =
  | { kind: 'all' }
  | { kind: 'unplaced' }
  | { kind: 'disposed' }
  | { kind: 'location'; id: string };

export type InventoryItem = { kind: 'storage' | 'vessel'; id: string };

export type InventoryDialog =
  | InventoryScientificDialog
  | InventoryStockroomDialog
  | InventoryArrivalDialog
  | { kind: 'export-archive' }
  | { kind: 'import-archive' }
  | { kind: 'receive-table' }
  | { kind: 'stocktake' }
  | { kind: 'source-revision' }
  | { kind: 'import-hierarchy' }
  | { kind: 'receive-mapped-table' }
  | { kind: 'inspect-benchling-capture' }
  | InventoryContentsDialog
  | InventoryLotControlsDialog
  | InventoryValidityDialog
  | InventoryMaterialDialog
  | InventoryCompositionDialog
  | InventoryReservationDialog
  | InventoryCustodyDialog
  | InventoryPhysicalDialogKind
  | InventoryItemCodeDialog
  | InventoryTemperatureDialog
  | { kind: 'item-label'; codeId: string }
  | { kind: 'none' }
  | { kind: 'container'; placement?: InventoryLocatedPlacement; typeVersionId?: string }
  | { kind: 'location'; parentId?: string; typeVersionId?: string }
  | { kind: 'receive'; placement?: InventoryLocatedPlacement; vesselId?: string }
  | { kind: 'move'; item: InventoryItem }
  | { kind: 'use'; stockId: string }
  | { kind: 'reconcile'; stockId: string }
  | { kind: 'quality'; stockId: string; quality: 'usable' | 'quarantined' }
  | { kind: 'dispose'; item: InventoryItem };

export function inventoryConcentrationUnitLabel(unit: InventoryConcentrationUnit): string {
  return unit.replace('ug', 'µg').replace('uL', 'µL').replace('uM', 'µM');
}

export function inventoryConcentrationLabel(concentration: InventoryConcentration): string {
  if (concentration.kind === 'unknown') {
    return concentration.reason === 'missing-input'
      ? 'Unknown · missing input measurement'
      : concentration.reason === 'incompatible-units'
        ? 'Unknown · incompatible measurement units'
        : 'Unmeasured';
  }
  const amount =
    concentration.denominator === '1'
      ? concentration.numerator
      : `${concentration.numerator}/${concentration.denominator}`;
  return `${amount} ${inventoryConcentrationUnitLabel(concentration.unit)}`;
}

export function inventoryOccupant(
  state: InventoryState,
  storageId: string,
  position: string
): InventoryStorage | InventoryVessel | undefined {
  return [...Object.values(state.storage), ...Object.values(state.vessels)].find(
    (item) =>
      item.placement.kind === 'located' &&
      item.placement.storageId === storageId &&
      item.placement.slotId === position
  );
}

export function locationPath(state: InventoryState, id: string): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let current = state.storage[id];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    if (current.placement.kind !== 'located') break;
    names.unshift(current.placement.slotId);
    current = state.storage[current.placement.storageId];
  }
  return names.join(' / ');
}

export function inventoryLocationPathLabel(path: readonly InventoryLocationPathEntry[]): string {
  return path
    .flatMap((entry) => (entry.position === null ? [entry.name] : [entry.position, entry.name]))
    .join(' / ');
}

export function inventoryBlockerLabel(
  blocker: InventoryAvailabilityBlocker,
  state?: Pick<InventoryState, 'lots'>
): string {
  const lot = 'lotId' in blocker ? (state?.lots[blocker.lotId]?.name ?? blocker.lotId) : '';
  const labels: Record<InventoryAvailabilityBlocker['code'], string> = {
    VALIDITY_UNRESOLVED: 'A validity rule or opening status is unresolved',
    MATERIAL_EXPIRED: `Material expired at ${'deadlineAt' in blocker ? new Date(blocker.deadlineAt).toISOString() : ''}`,
    OPENING_REQUIRED: 'Record first opening before withdrawing this stock',
    OPENING_TIME_UNKNOWN: 'First-opening time is unknown',
    VALIDITY_CHRONOLOGY_CONFLICT: 'Opening conflicts with an earlier recorded material derivation',
    VALIDITY_ASSESSMENT_IMPORTED: 'A validity rule requires a local decision',
    LOT_NOT_RELEASED: `Lot ${lot} is ${'assessment' in blocker && blocker.assessment === 'unassessed' ? 'unassessed' : 'assessment' in blocker ? blocker.assessment : 'not released'}`,
    LOT_ASSESSMENT_IMPORTED: `Lot ${lot} requires a local release decision`,
    LOT_RECALLED: `Lot ${lot} has an active recall`,
    QUANTITY_UNKNOWN: 'Recorded quantity is unknown',
    INCIDENT_REVIEW_REQUIRED: 'An equipment incident restriction blocks use',
    STOCK_QUARANTINED: 'This stock is quarantined',
    VESSEL_DISPOSED: 'This container has been disposed',
    ALLOCATION_SHORTFALL: 'Reservations exceed recorded stock',
    ITEM_RESERVED: 'This item is reserved',
    EXPIRY_PENDING: 'Past deadline; still allocated until released or expired',
    ITEM_CHECKED_OUT: 'This item is checked out to another holder',
    ITEM_IN_TRANSIT: 'This item is in transit',
    ITEM_MISSING: 'The current location of this item is unknown',
    POSITION_UNAVAILABLE: 'This position is marked unavailable',
  };
  return labels[blocker.code];
}

export function inventoryCustodyLabel(custody: InventoryItemCustody | undefined): string {
  return custody
    ? {
        available: 'Available',
        'checked-out': 'Checked out',
        'in-transit': 'In transit',
        missing: 'Missing',
      }[custody.state.kind]
    : 'Custody unavailable';
}

export function vesselLocation(
  state: InventoryState,
  vessel: InventoryVessel,
  custody?: InventoryItemCustody
): string {
  if (custody?.state.kind === 'missing') return 'Location unknown';
  if (custody && custody.state.kind !== 'available') return inventoryCustodyLabel(custody);
  return vessel.placement.kind === 'located'
    ? `${locationPath(state, vessel.placement.storageId)} / ${vessel.placement.slotId}`
    : 'Unplaced';
}

export function stockInSelection(
  state: InventoryState,
  vessel: InventoryVessel,
  selection: InventorySelection
): boolean {
  if (selection.kind === 'disposed') return vessel.lifecycle === 'disposed';
  if (vessel.lifecycle === 'disposed') return false;
  if (selection.kind === 'all') return true;
  if (selection.kind === 'unplaced') return vessel.placement.kind === 'unplaced';
  let placement = vessel.placement;
  const visited = new Set<string>();
  while (placement.kind === 'located' && !visited.has(placement.storageId)) {
    if (placement.storageId === selection.id) return true;
    visited.add(placement.storageId);
    const parent = state.storage[placement.storageId];
    if (!parent || parent.placement.kind !== 'located') break;
    placement = parent.placement;
  }
  return false;
}

export function destinationCommands(
  state: InventoryState,
  item: InventoryItem,
  destination: InventoryLocatedPlacement | null
): InventoryCommand[] {
  const current = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  if (destination && state.storage[destination.storageId]?.layout.kind === 'stack')
    return [{ kind: 'push-stack', stackId: destination.storageId, item }];
  const placement =
    destination ??
    (item.kind === 'storage' ? { kind: 'root' as const } : { kind: 'unplaced' as const });
  if (
    current.placement.kind === 'located' &&
    state.storage[current.placement.storageId]?.layout.kind === 'stack'
  )
    return [
      { kind: 'pop-stack', stackId: current.placement.storageId, item, destination: placement },
    ];
  return item.kind === 'storage'
    ? [{ kind: 'move-storage', id: item.id, placement: placement as InventoryStorage['placement'] }]
    : [{ kind: 'move-vessel', id: item.id, placement: placement as InventoryVessel['placement'] }];
}

export function destinationPositions(
  state: InventoryState,
  storage: InventoryStorage,
  movingId?: string
): readonly string[] {
  if (storage.layout.kind === 'stack')
    return inventoryStackItems(state, storage.id).length < storage.layout.capacity ? ['top'] : [];
  return inventoryStoragePositions(storage).filter((position) => {
    const occupant = inventoryOccupant(state, storage.id, position);
    return !occupant || occupant.id === movingId;
  });
}

export function historyLabel(command: InventoryCommand, state: InventoryState): string {
  switch (command.kind) {
    case 'record-vessel-contents':
      return command.knowledge === 'unobserved'
        ? 'Recorded unobserved contents'
        : 'Recorded unidentified material';
    case 'record-vessels-contents':
      return 'Recorded container contents status';
    case 'declare-vessel-empty':
      return 'Declared container empty';
    case 'identify-vessel-stock':
      return `Identified existing contents in ${state.vessels[command.vesselId]?.name ?? 'container'}`;
    case 'record-inventory-observation':
      return `Recorded observation ${command.observationId}`;
    case 'apply-inventory-observation':
      return 'Applied an inventory observation';
    case 'record-temperature-claim':
      return command.assertion.kind === 'qualified-envelope'
        ? 'Recorded installed temperature qualification'
        : 'Recorded specified operating range';
    case 'withdraw-temperature-claim':
      return 'Withdrew temperature evidence';
    case 'record-equipment-setpoint':
      return 'Recorded operator-reported setpoint';
    case 'record-storage-requirement':
      return `Recorded ${command.target.kind} temperature requirement`;
    case 'attach-item-code':
      return `Attached item code ${command.namespace} ${JSON.stringify(command.value)}`;
    case 'retire-item-code':
      return 'Retired item code';
    case 'retire-catalog-version':
      return 'Retired catalog version';
    case 'restore-catalog-version':
      return 'Restored catalog version';
    case 'define-physical-type':
      return `Published type ${command.name}`;
    case 'define-equipment-recipe':
      return `Published equipment recipe ${command.name}`;
    case 'instantiate-physical-type':
      return `Added typed item ${command.name}`;
    case 'instantiate-equipment-recipe':
      return `Added equipment ${command.name}`;
    case 'configure-item':
      return 'Updated installed arrangement';
    case 'reconfigure-storage':
      return 'Updated installed layout';
    case 'record-item-geometry':
      return 'Recorded installed dimensions';
    case 'record-fit-evidence':
      return 'Recorded fit evidence';
    case 'checkout-item':
      return 'Checked out item';
    case 'start-item-transit':
      return 'Started item transfer';
    case 'return-item':
      return 'Recorded item return or arrival';
    case 'report-item-missing':
      return 'Reported item missing';
    case 'locate-item':
      return 'Recorded item location';
    case 'reserve-quantity':
      return `Reserved ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit} for ${command.purpose}`;
    case 'reserve-item':
      return `Reserved item for ${command.purpose}`;
    case 'release-reservation':
      return 'Released reservation';
    case 'cancel-reservation':
      return 'Cancelled reservation';
    case 'expire-reservations':
      return 'Recorded reservation expiry';
    case 'fulfill-reservations':
      return `Fulfilled reservation · ${historyLabel(command.withdrawal, state)}`;
    case 'create-lot':
      return `Added batch ${command.name}`;
    case 'record-expected-delivery':
      return `Recorded expected delivery ${command.name}`;
    case 'allocate-arrival':
      return `Matched original received amount ${command.quantity.value} ${command.quantity.unit}`;
    case 'withdraw-arrival-allocation':
      return 'Withdrew original receipt matching';
    case 'close-expected-delivery-remainder':
      return 'Closed unreceived expected remainder';
    case 'reopen-expected-delivery':
      return 'Reopened expected delivery matching';
    case 'record-reorder-rule':
      return `Recorded reorder rule ${command.name}`;
    case 'retire-reorder-rule':
      return 'Retired reorder rule';
    case 'record-stock-opening':
      return `Recorded ${command.value} observation for ${state.vessels[state.stocks[command.stockId]?.vesselId]?.name ?? command.stockId}`;
    case 'correct-stock-opening':
      return `Corrected opening observation ${command.supersedesId}: ${command.value}`;
    case 'record-validity-decision':
      return `Recorded validity decision: ${command.rule.kind}`;
    case 'correct-validity-decision':
      return `Corrected validity family head ${command.supersedesId}: ${command.rule.kind}`;
    case 'manage-lot':
      return `Started managing lot ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'assess-lot':
      return `Assessed lot ${state.lots[command.lotId]?.name ?? command.lotId}: ${command.assessment}`;
    case 'record-lot-recall':
      return `Recorded recall ${command.id} for ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'withdraw-lot-recall':
      return `Withdrew recall ${command.recallId}`;
    case 'receive-lot-stock':
      return `Received batch ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'associate-stock-lot':
      return `Attributed stock to ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'set-vessel-limits':
      return `Recorded container limits for ${state.vessels[command.vesselId]?.name ?? command.vesselId}`;
    case 'record-composition':
      return command.composition.kind === 'unknown'
        ? 'Marked composition unknown'
        : 'Recorded homogeneous composition';
    case 'transfer':
      return `Transferred ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'pool':
      return `Pooled stocks into ${command.name}`;
    case 'dilute':
      return `Diluted stock into ${command.name}`;
    case 'create-storage':
    case 'create-layout-storage':
      return `Added location ${command.name}`;
    case 'create-vessel':
      return `Added container ${command.name}`;
    case 'receive-stock':
      return `Received stock in ${state.vessels[command.vesselId]?.name ?? 'container'}`;
    case 'move-storage':
      return `Moved ${state.storage[command.id]?.name ?? 'location'}`;
    case 'move-vessel':
      return `Moved ${state.vessels[command.id]?.name ?? 'container'}`;
    case 'consume':
      return `Used ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'reconcile':
      return command.quantity.kind === 'unknown'
        ? 'Marked quantity unknown'
        : `Recorded ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'set-quality':
      return command.quality === 'quarantined' ? 'Quarantined stock' : 'Released stock';
    case 'dispose-vessel':
      return `Disposed ${state.vessels[command.id]?.name ?? 'container'}`;
    case 'dispose-plate':
      return `Disposed plate ${state.storage[command.id]?.name ?? ''}`;
    case 'push-stack':
      return `Placed on top of ${state.storage[command.stackId]?.name ?? 'stack'}`;
    case 'pop-stack':
      return `Removed from ${state.storage[command.stackId]?.name ?? 'stack'}`;
  }
}
