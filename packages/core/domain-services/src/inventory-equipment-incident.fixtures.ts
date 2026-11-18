import {
  createInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  inventoryEquipmentIncidentActionPreview,
  applyInventoryEquipmentIncidentAction,
} from './inventory-equipment-incidents';
import type {
  InventoryEquipmentIncidentActionChoices,
  InventoryEquipmentIncidentActionPreviewInput,
} from './inventory-equipment-incident-types';
export const equipmentIncidentContext = {
  at: 100,
  principal: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
  authority: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
};
export function equipmentIncidentTarget(state: InventoryState) {
  return {
    projectId: 'project',
    inventoryId: 'inventory',
    present: state.revision !== 0,
    revision: state.revision,
  };
}
export function equipmentIncidentCommands(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  at = 100
) {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...equipmentIncidentContext, at }
  );
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.state;
}
export function inventoryEquipmentIncidentFixture() {
  const state = equipmentIncidentCommands(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'equipment',
      name: 'Untyped reported freezer',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'rescue',
      name: 'Existing destination',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'rack',
      name: 'Whole holder',
      slots: ['known', 'unknown', 'possible', 'empty'],
      placement: { kind: 'located', storageId: 'equipment', slotId: 'A' },
    },
    ...['known', 'unknown', 'possible', 'empty'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'located' as const, storageId: 'rack', slotId: id },
    })),
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'known',
      materialId: 'material',
      quantity: { kind: 'known', value: '20', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'record-vessel-contents',
      vesselId: 'unknown',
      knowledge: 'unidentified',
      reason: 'Observed existing unidentified contents before outage report',
    },
    {
      kind: 'record-vessel-contents',
      vesselId: 'possible',
      knowledge: 'unobserved',
      reason: 'Contents not observed before outage report',
    },
  ]);
  const choices: InventoryEquipmentIncidentActionChoices = {
    identity: { namespace: 'incident-tests', actionId: 'open-one' },
    action: {
      kind: 'report',
      equipment: { storageId: 'equipment', configurationRevision: 0 },
      noticedAt: 90,
      description: 'Operator reports an outage',
      reason: 'Record affected contents now',
    },
  };
  const input: InventoryEquipmentIncidentActionPreviewInput = {
    ...choices,
    target: equipmentIncidentTarget(state),
    asOf: 100,
    principal: equipmentIncidentContext.principal,
    authority: equipmentIncidentContext.authority,
  };
  return { state, choices, input, context: equipmentIncidentContext };
}
export function equipmentIncidentAction(
  state: InventoryState,
  choices: InventoryEquipmentIncidentActionChoices,
  at = 100
) {
  const input = {
    ...choices,
    target: equipmentIncidentTarget(state),
    asOf: at,
    principal: equipmentIncidentContext.principal,
    authority: equipmentIncidentContext.authority,
  };
  const preview = inventoryEquipmentIncidentActionPreview(state, input);
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const applied = applyInventoryEquipmentIncidentAction(
    state,
    { ...choices, target: input.target, expectedPlanDigest: preview.planDigest },
    { ...equipmentIncidentContext, at }
  );
  if (!applied.ok) throw Error(`${applied.code}: ${applied.message}`);
  return { state: applied.state, preview, record: preview.record };
}
export function recordedEquipmentIncidentFixture() {
  const f = inventoryEquipmentIncidentFixture(),
    result = equipmentIncidentAction(f.state, f.choices);
  return {
    ...f,
    recorded: result.state,
    preview: result.preview,
    summary: result.record,
    incident: result.state.equipmentIncidents[result.record.incident.incidentId],
  };
}
