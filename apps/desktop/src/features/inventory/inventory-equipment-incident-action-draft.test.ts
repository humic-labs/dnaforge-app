import { expect, it } from 'vitest';
import { inventoryEquipmentIncidentActionChoicesSchema } from '../../shared/inventory-equipment-incidents';
import {
  equipmentIncidentFollowUpAction,
  equipmentIncidentFollowUpDraft,
} from './inventory-equipment-incident-action-draft';
import type { InventoryEquipmentIncidentAction } from '@waypoint/domain-services';
const sha = `sha256:${'b'.repeat(64)}` as const,
  incident = { incidentId: 'incident', intentSha256: sha },
  predecessor = { factId: 'previous-fact', intentSha256: sha },
  reason = 'Exact operator report';
const actions: Exclude<InventoryEquipmentIncidentAction, { kind: 'report' }>[] = [
  {
    kind: 'manual-temperature',
    incident,
    reading: {
      kind: 'measured',
      temperature: { value: '-60', unit: 'C' },
      observedAt: 90,
      pointLabel: 'Upper rack',
    },
    supersedes: predecessor,
    reason,
  },
  {
    kind: 'manual-temperature',
    incident,
    reading: { kind: 'withdrawn' },
    supersedes: predecessor,
    reason,
  },
  {
    kind: 'completed-relocation',
    incident,
    moves: [
      {
        item: { kind: 'storage', id: 'holder' },
        destination: { kind: 'located', storageId: 'rescue', slotId: 'A' },
      },
      {
        item: { kind: 'vessel', id: 'tube' },
        destination: { kind: 'stack-top', stackId: 'stack' },
      },
    ],
    corrects: predecessor,
    reason,
  },
  {
    kind: 'impact-review',
    incident,
    subjects: [
      { root: { rootId: 'root-one', intentSha256: sha }, supersedes: predecessor },
      { root: { rootId: 'root-two', intentSha256: sha }, supersedes: null },
    ],
    disposition: 'keep-incident-restriction',
    basis: 'Documented assessment',
    reason,
  },
  { kind: 'resolve', incident, resolution: 'reported-in-error', reason },
];
it.each(actions)('preserves exact $kind action pins through ordinary draft fields', (action) => {
  const result = equipmentIncidentFollowUpAction(equipmentIncidentFollowUpDraft(action), reason);
  expect(result).toEqual(action);
  expect(
    inventoryEquipmentIncidentActionChoicesSchema.parse({
      identity: { namespace: 'manual', actionId: 'one' },
      action: result,
    }).action
  ).toEqual(action);
});
it('requires an explicit decision, complete relocation and a real observation time', () => {
  expect(() =>
    equipmentIncidentFollowUpAction(
      { kind: 'impact-review', incident, subjects: [], disposition: '', basis: '' },
      reason
    )
  ).toThrow(/Choose/);
  expect(() =>
    equipmentIncidentFollowUpAction(
      {
        kind: 'completed-relocation',
        incident,
        moves: [{ item: null, destination: null }],
        corrects: null,
      },
      reason
    )
  ).toThrow(/Choose/);
  expect(() =>
    equipmentIncidentFollowUpAction(
      {
        kind: 'manual-temperature',
        incident,
        readingKind: 'measured',
        temperature: '-60',
        observedTime: '2026-02-30T10:00:00.000Z',
        pointLabel: 'Probe',
        supersedes: null,
      },
      reason
    )
  ).toThrow(/valid UTC/);
});
