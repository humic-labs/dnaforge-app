import { expect, it } from 'vitest';
import {
  inventoryEquipmentIncidentFixture,
  recordedEquipmentIncidentFixture,
  equipmentIncidentAction,
  equipmentIncidentCommands,
  equipmentIncidentTarget,
  equipmentIncidentContext,
} from './inventory-equipment-incident.fixtures';
import {
  inventoryEquipmentIncidentActionPreview,
  inventoryEquipmentIncidentCurrentStatus,
  inventoryEquipmentIncidentSubjects,
  inventoryEquipmentIncidentFacts,
  inventoryEquipmentIncidentManualFact,
} from './inventory-equipment-incidents';
import { inventoryEquipmentIncidentRootReview } from './inventory-incident-constraints';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  parseInventoryState,
  parseInventoryEquipmentIncidentActionSummary,
  parseInventoryEquipmentIncidentSubjectProjection,
} from './inventory-validation';
import { adoptInventoryState } from './inventory-adoption';
import type { InventoryEquipmentIncidentActionChoices } from './inventory-equipment-incident-types';
const action = (
  id: string,
  value: InventoryEquipmentIncidentActionChoices['action']
): InventoryEquipmentIncidentActionChoices => ({
  identity: { namespace: 'incident-tests', actionId: id },
  action: value,
});
it('captures actual contents independently of outage noticed time and preserves exact retry before current admission', () => {
  const f = inventoryEquipmentIncidentFixture(),
    before = JSON.stringify(f.state),
    p = inventoryEquipmentIncidentActionPreview(f.state, f.input);
  expect(p.kind).toBe('ready');
  expect(JSON.stringify(f.state)).toBe(before);
  const r = recordedEquipmentIncidentFixture();
  expect(r.recorded.revision).toBe(f.state.revision + 1);
  expect(r.incident.contentsWhenRecorded).toBe(100);
  expect(r.incident.choices.action.kind === 'report' && r.incident.choices.action.noticedAt).toBe(
    90
  );
  expect(r.incident.initial.vessels).toHaveLength(4);
  expect(r.incident.initial.reviewRootIds).toHaveLength(3);
  expect(r.recorded.stocks.stock.quantity).toEqual(f.state.stocks.stock.quantity);
  expect(r.recorded.stocks.stock.incidentReviewRootIds).toHaveLength(1);
  expect(
    inventoryEquipmentIncidentActionPreview(r.recorded, {
      ...f.input,
      target: { ...f.input.target, revision: 0 },
      asOf: 0,
    }).kind
  ).toBe('no-change');
  expect(
    inventoryEquipmentIncidentActionPreview(r.recorded, {
      ...f.input,
      action: { ...f.choices.action, reason: 'Changed intent' },
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'EQUIPMENT_INCIDENT_CONFLICT' }] });
  expect(parseInventoryEquipmentIncidentActionSummary(r.summary)).toEqual(r.summary);
  for (const v of inventoryEquipmentIncidentSubjects(r.recorded, r.incident.id, 'initial'))
    expect(parseInventoryEquipmentIncidentSubjectProjection(v)).toEqual(v);
});
it('guards every primitive, blocks new contents and internal composite arrivals but allows actual rescue', () => {
  const f = recordedEquipmentIncidentFixture(),
    pin = { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 };
  for (const commands of [
    [{ kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'Use' }],
    [
      {
        kind: 'receive-stock',
        id: 'new',
        vesselId: 'empty',
        materialId: 'material',
        quantity: { kind: 'known', value: '1', unit: 'uL' },
        quality: 'usable',
      },
    ],
    [
      { kind: 'create-vessel', id: 'visitor', name: 'Visitor', placement: { kind: 'unplaced' } },
      {
        kind: 'move-vessel',
        id: 'visitor',
        placement: { kind: 'located', storageId: 'rack', slotId: 'empty' },
      },
      { kind: 'move-vessel', id: 'visitor', placement: { kind: 'unplaced' } },
    ],
  ] as const) {
    const before = JSON.stringify(f.recorded);
    const result = applyInventoryCommandBatch(
      f.recorded,
      { expectedRevision: f.recorded.revision, commands },
      f.context
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(f.recorded)).toBe(before);
  }
  const rescued = equipmentIncidentAction(
    f.recorded,
    action('rescue', {
      kind: 'completed-relocation',
      incident: pin,
      moves: [
        {
          item: { kind: 'storage', id: 'rack' },
          destination: { kind: 'located', storageId: 'rescue', slotId: 'A' },
        },
      ],
      corrects: null,
      reason: 'Operator reports completed whole-holder rescue',
    })
  );
  expect(rescued.state.storage.rack.placement).toEqual({
    kind: 'located',
    storageId: 'rescue',
    slotId: 'A',
  });
  expect(rescued.state.stocks).toEqual(f.recorded.stocks);
  expect(inventoryEquipmentIncidentSubjects(rescued.state, f.incident.id, 'initial')).toHaveLength(
    6
  );
  expect(inventoryEquipmentIncidentSubjects(rescued.state, f.incident.id, 'current')).toHaveLength(
    1
  );
});
it('carries only the original confirmed episode root through identification and refuses empty/possible bypass', () => {
  const f = recordedEquipmentIncidentFixture(),
    root = Object.values(f.recorded.equipmentIncidentReviewRoots).find(
      (r) => r.binding.kind === 'contents-episode' && r.binding.vesselId === 'unknown'
    )!;
  const identified = equipmentIncidentCommands(f.recorded, [
    {
      kind: 'identify-vessel-stock',
      id: 'identified',
      vesselId: 'unknown',
      materialId: 'material',
      quantity: { kind: 'unknown', unit: 'uL' },
      quality: 'usable',
      reason: 'Identified existing contents',
    },
  ]);
  expect(identified.stocks.identified.incidentReviewRootIds).toEqual([root.id]);
  expect(
    Object.values(identified.equipmentIncidentFacts).filter((f) => f.kind === 'contents-identified')
  ).toHaveLength(1);
  for (const vesselId of ['possible', 'empty']) {
    const commands =
      vesselId === 'empty'
        ? [
            {
              kind: 'record-vessel-contents' as const,
              vesselId,
              knowledge: 'unidentified' as const,
              reason: 'Later knowledge',
            },
            {
              kind: 'identify-vessel-stock' as const,
              id: 'bad',
              vesselId,
              materialId: 'material',
              quantity: { kind: 'unknown' as const, unit: 'uL' as const },
              quality: 'usable' as const,
              reason: 'Cannot prove old presence',
            },
          ]
        : [
            {
              kind: 'identify-vessel-stock' as const,
              id: 'bad',
              vesselId,
              materialId: 'material',
              quantity: { kind: 'unknown' as const, unit: 'uL' as const },
              quality: 'usable' as const,
              reason: 'Unconfirmed presence',
            },
          ];
    expect(
      applyInventoryCommandBatch(
        f.recorded,
        { expectedRevision: f.recorded.revision, commands },
        f.context
      )
    ).toMatchObject({ ok: false, code: 'INCIDENT_INBOUND_BLOCKED' });
  }
});
it('keeps Remove independent and later Keep follows released stock through actual transfer lineage', () => {
  const f = recordedEquipmentIncidentFixture(),
    pin = { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 },
    root = Object.values(f.recorded.equipmentIncidentReviewRoots).find(
      (r) => r.binding.kind === 'stock'
    )!,
    rootPin = { rootId: root.id, intentSha256: root.intentSha256 };
  let r = equipmentIncidentAction(
    f.recorded,
    action('rescue', {
      kind: 'completed-relocation',
      incident: pin,
      moves: [
        {
          item: { kind: 'storage', id: 'rack' },
          destination: { kind: 'located', storageId: 'rescue', slotId: 'A' },
        },
      ],
      corrects: null,
      reason: 'Completed relocation',
    })
  );
  r = equipmentIncidentAction(
    r.state,
    action('remove', {
      kind: 'impact-review',
      incident: pin,
      subjects: [{ root: rootPin, supersedes: null }],
      disposition: 'remove-incident-restriction',
      basis: 'Explicit local subject review',
      reason: 'Remove this incident restriction only',
    })
  );
  const remove = r.record.actionProof;
  let state = equipmentIncidentCommands(r.state, [
    {
      kind: 'create-vessel',
      id: 'aliquot-vessel',
      name: 'Aliquot',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'transfer',
      sourceStockId: 'stock',
      quantity: { value: '2', unit: 'uL' },
      destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'aliquot-vessel' },
      reason: 'Recorded actual transfer after review',
    },
  ]);
  expect(state.stocks.aliquot.incidentReviewRootIds).toEqual([root.id]);
  const keep = equipmentIncidentAction(
    state,
    action('keep', {
      kind: 'impact-review',
      incident: pin,
      subjects: [
        {
          root: rootPin,
          supersedes: { factId: remove.actionId, intentSha256: remove.intentSha256 },
        },
      ],
      disposition: 'keep-incident-restriction',
      basis: 'Later restricting correction',
      reason: 'Keep under review',
    })
  );
  expect(
    applyInventoryCommandBatch(
      keep.state,
      {
        expectedRevision: keep.state.revision,
        commands: [
          {
            kind: 'consume',
            stockId: 'aliquot',
            quantity: { value: '1', unit: 'uL' },
            reason: 'Must remain blocked',
          },
        ],
      },
      f.context
    )
  ).toMatchObject({ ok: false, code: 'INCIDENT_REVIEW_REQUIRED' });
  const resolved = equipmentIncidentAction(
    keep.state,
    action('resolved', {
      kind: 'resolve',
      incident: pin,
      resolution: 'reported-resolved',
      reason: 'Reported equipment repair',
    })
  );
  expect(inventoryEquipmentIncidentCurrentStatus(resolved.state, f.incident.id)).toMatchObject({
    lifecycle: 'resolved',
    review: { kept: 1, pending: 2 },
  });
  expect(inventoryEquipmentIncidentRootReview(resolved.state, root.id).restriction).toBe('kept');
});
it('retains each selected manual observation and its own configuration, independently of resolution', () => {
  const f = recordedEquipmentIncidentFixture(),
    pin = { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 };
  const reading = equipmentIncidentAction(
    f.recorded,
    action('reading', {
      kind: 'manual-temperature',
      incident: pin,
      reading: {
        kind: 'measured',
        temperature: { value: '-60', unit: 'C' },
        observedAt: 90,
        pointLabel: 'Manual probe near upper rack',
      },
      supersedes: null,
      reason: 'Manual observation',
    })
  );
  const fact = inventoryEquipmentIncidentManualFact(
    reading.state,
    reading.record.actionProof.actionId,
    100,
    20
  )!;
  expect(fact.freshness.state).toBe('fresh');
  expect(
    inventoryEquipmentIncidentManualFact(
      reading.state,
      reading.record.actionProof.actionId,
      111,
      20
    )?.freshness.state
  ).toBe('stale');
  expect(inventoryEquipmentIncidentFacts(reading.state, f.incident.id)).toHaveLength(1);
});
it('wraps imported Remove without rewriting original choices and rejects dangling canonical root references', () => {
  const f = recordedEquipmentIncidentFixture(),
    pin = { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 },
    root = Object.values(f.recorded.equipmentIncidentReviewRoots).find(
      (r) => r.binding.kind === 'stock'
    )!;
  const r = equipmentIncidentAction(
    f.recorded,
    action('remove', {
      kind: 'impact-review',
      incident: pin,
      subjects: [{ root: { rootId: root.id, intentSha256: root.intentSha256 }, supersedes: null }],
      disposition: 'remove-incident-restriction',
      basis: 'Local review',
      reason: 'Remove restriction',
    })
  );
  const imported = adoptInventoryState(
    null,
    r.state,
    {
      source: {
        archiveSha256: `sha256:${'b'.repeat(64)}`,
        projectId: 'project',
        inventoryId: 'inventory',
        revision: r.state.revision,
      },
      materialBindings: { material: 'destination-material' },
    },
    { ...f.context, at: 200 }
  );
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw Error(imported.message);
  expect(inventoryEquipmentIncidentRootReview(imported.state, root.id).restriction).toBe(
    'imported-removal-unconfirmed'
  );
  expect(imported.state.equipmentIncidentFacts[r.record.actionProof.actionId].intentSha256).toBe(
    r.record.actionProof.intentSha256
  );
  expect(imported.state.equipmentIncidents[f.incident.id].choices).toEqual(f.choices);
  expect(() =>
    parseInventoryState({
      ...r.state,
      stocks: {
        ...r.state.stocks,
        stock: { ...r.state.stocks.stock, incidentReviewRootIds: ['missing-root'] },
      },
    })
  ).toThrow();
});
it('keeps initial cohort projection stable after rescue and permits unrelated refill only after episode closure and resolution', () => {
  const f = recordedEquipmentIncidentFixture(),
    pin = { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 };
  const initial = inventoryEquipmentIncidentSubjects(f.recorded, f.incident.id, 'initial');
  const rescued = equipmentIncidentAction(
    f.recorded,
    action('rescue', {
      kind: 'completed-relocation',
      incident: pin,
      moves: [
        {
          item: { kind: 'storage', id: 'rack' },
          destination: { kind: 'located', storageId: 'rescue', slotId: 'A' },
        },
      ],
      corrects: null,
      reason: 'Completed rescue',
    })
  );
  expect(inventoryEquipmentIncidentSubjects(rescued.state, f.incident.id, 'initial')).toEqual(
    initial
  );
  let state = equipmentIncidentCommands(rescued.state, [
    {
      kind: 'declare-vessel-empty',
      vesselId: 'unknown',
      reason: 'Explicitly observed empty after rescue',
    },
  ]);
  state = equipmentIncidentAction(
    state,
    action('resolve', {
      kind: 'resolve',
      incident: pin,
      resolution: 'reported-resolved',
      reason: 'Reported repaired',
    })
  ).state;
  state = equipmentIncidentCommands(state, [
    {
      kind: 'receive-stock',
      id: 'unrelated-refill',
      vesselId: 'unknown',
      materialId: 'material',
      quantity: { kind: 'known', value: '2', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  expect(state.stocks['unrelated-refill'].incidentReviewRootIds).toEqual([]);
  expect(inventoryEquipmentIncidentCurrentStatus(state, f.incident.id).review.pending).toBe(3);
});
it('copies roots into prepared material and retains them through provenance attribution without affecting siblings', () => {
  const f = recordedEquipmentIncidentFixture(),
    root = Object.values(f.recorded.equipmentIncidentReviewRoots).find(
      (r) => r.binding.kind === 'stock'
    )!;
  let state = equipmentIncidentCommands(f.recorded, [
    {
      kind: 'create-lot',
      id: 'prepared',
      materialId: 'material',
      name: 'Referenced preparation',
      origin: {
        kind: 'prepared',
        sourceStockIds: ['stock'],
        method: 'Declared preparation lineage',
      },
    },
    {
      kind: 'create-vessel',
      id: 'output',
      name: 'Outside output',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'receive-lot-stock',
      id: 'prepared-stock',
      vesselId: 'output',
      lotId: 'prepared',
      quantity: { kind: 'known', value: '2', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  expect(state.lots.prepared.incidentReviewRootIds).toEqual([root.id]);
  expect(state.stocks['prepared-stock'].incidentReviewRootIds).toEqual([root.id]);
  expect(
    applyInventoryCommandBatch(
      state,
      {
        expectedRevision: state.revision,
        commands: [
          {
            kind: 'consume',
            stockId: 'prepared-stock',
            quantity: { value: '1', unit: 'uL' },
            reason: 'Blocked ancestor restriction',
          },
        ],
      },
      f.context
    )
  ).toMatchObject({ ok: false, code: 'INCIDENT_REVIEW_REQUIRED' });
  state = equipmentIncidentCommands(state, [
    {
      kind: 'create-lot',
      id: 'independent-lot',
      materialId: 'material',
      name: 'Independent batch',
      origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'Independent' },
    },
    {
      kind: 'create-vessel',
      id: 'sibling-vessel',
      name: 'Unexposed sibling',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'receive-lot-stock',
      id: 'sibling',
      vesselId: 'sibling-vessel',
      lotId: 'independent-lot',
      quantity: { kind: 'known', value: '2', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'associate-stock-lot',
      stockId: 'prepared-stock',
      lotId: 'independent-lot',
      reason: 'Explicit provenance correction',
    },
  ]);
  expect(state.stocks['prepared-stock'].incidentReviewRootIds).toEqual([root.id]);
  expect(state.stocks.sibling.incidentReviewRootIds).toEqual([]);
  expect(state.lots['independent-lot'].incidentReviewRootIds).toEqual([]);
  state = equipmentIncidentCommands(state, [
    {
      kind: 'associate-stock-lot',
      stockId: 'sibling',
      lotId: 'prepared',
      reason: 'Explicitly associate the affected preparation',
    },
  ]);
  expect(state.stocks.sibling.incidentReviewRootIds).toEqual([root.id]);
  expect(parseInventoryState(state)).toEqual(state);
});
it('upcasts genuine raw29 without writes and refuses new empty raw fields before inherited caps', () => {
  const f = inventoryEquipmentIncidentFixture();
  const raw = structuredClone(f.state) as unknown as Record<string, unknown>;
  raw.schema = 'dnaforge.inventory.v29';
  delete raw.equipmentIncidents;
  delete raw.equipmentIncidentReviewRoots;
  delete raw.equipmentIncidentFacts;
  for (const row of Object.values(raw.stocks as Record<string, Record<string, unknown>>))
    delete row.incidentReviewRootIds;
  const bytes = JSON.stringify(raw);
  expect(parseInventoryState(raw, { allowEquipmentIncidents: false }).equipmentIncidents).toEqual(
    {}
  );
  expect(JSON.stringify(raw)).toBe(bytes);
  expect(() => parseInventoryState(f.state, { allowEquipmentIncidents: false })).toThrow();
  expect(() =>
    parseInventoryState({ ...raw, equipmentIncidents: {} }, { allowEquipmentIncidents: false })
  ).toThrow();
});
it('expires a relocation preview at its relevant held-stock deadline without hashing the clock or unrelated holds', () => {
  const fixture = inventoryEquipmentIncidentFixture();
  const timed = equipmentIncidentCommands(fixture.state, [
    {
      kind: 'create-vessel',
      id: 'unrelated-vessel',
      name: 'Unrelated',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'receive-stock',
      id: 'unrelated-stock',
      vesselId: 'unrelated-vessel',
      materialId: 'material',
      quantity: { kind: 'known', value: '10', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'reserve-quantity',
      id: 'unrelated-deadline',
      stockId: 'unrelated-stock',
      quantity: { value: '1', unit: 'uL' },
      deadline: 110,
      purpose: 'Unrelated short hold',
    },
    {
      kind: 'reserve-quantity',
      id: 'holder-deadline',
      stockId: 'stock',
      quantity: { value: '2', unit: 'uL' },
      deadline: 130,
      purpose: 'Owned allocation inside the selected holder',
    },
  ]);
  const reported = equipmentIncidentAction(timed, fixture.choices);
  const choices = action('timed-rescue', {
    kind: 'completed-relocation',
    incident: reported.record.incident,
    moves: [
      {
        item: { kind: 'storage', id: 'rack' },
        destination: { kind: 'located', storageId: 'rescue', slotId: 'A' },
      },
    ],
    corrects: null,
    reason: 'Completed whole-holder rescue under an owned allocation',
  });
  const input = {
    ...choices,
    target: equipmentIncidentTarget(reported.state),
    principal: fixture.context.principal,
    authority: fixture.context.authority,
  };
  const preview = inventoryEquipmentIncidentActionPreview(reported.state, { ...input, asOf: 105 });
  expect(preview.kind).toBe('ready');
  expect(preview.nextBoundaryAt).toBe(130);
  const later = inventoryEquipmentIncidentActionPreview(reported.state, { ...input, asOf: 115 });
  expect(later.kind).toBe('ready');
  expect(later.nextBoundaryAt).toBe(130);
  expect(later.kind === 'ready' && later.planDigest).toBe(
    preview.kind === 'ready' && preview.planDigest
  );
  expect(reported.state.storage.rack.placement).toEqual({
    kind: 'located',
    storageId: 'equipment',
    slotId: 'A',
  });
});
