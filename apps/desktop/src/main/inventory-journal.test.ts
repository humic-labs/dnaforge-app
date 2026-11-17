// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryState,
  type InventoryCommand,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  inventoryReceiptSchema,
  type InventoryApplyImportRequest,
  type NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import { nativeInventoryRequestDigest, replayNativeInventoryEntries } from './inventory-journal';
import {
  nativeInventoryArchive,
  nativeInventoryImportPreview,
  replayNativeInventoryJournal,
} from './inventory-archive';

const authority = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const principal = { kind: 'agent' as const, identityId: 'receiving-scientist' };
const received: readonly InventoryCommand[] = [
  ...['lot-a', 'lot-b'].map((id) => ({
    kind: 'create-lot' as const,
    id,
    materialId: 'material',
    name: id,
    origin: { kind: 'received' as const, supplier: 'Supplier', lotNumber: id },
  })),
  { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
  {
    kind: 'receive-lot-stock',
    id: 'stock',
    vesselId: 'tube',
    lotId: 'lot-a',
    quantity: { kind: 'known', value: '20', unit: 'uL' },
    quality: 'usable',
  },
];
const associate = (lotId: string): InventoryCommand => ({
  kind: 'associate-stock-lot',
  stockId: 'stock',
  lotId,
  reason: 'Verified supplier attribution',
});
function entry(
  index: number,
  commands: readonly InventoryCommand[],
  version: 1 | 2 | undefined
): NativeInventoryHistoryEntry {
  const request = {
    project: 'project',
    inventoryId: 'inventory',
    operationId: `operation-${index}`,
    expectedRevision: index,
    commands,
  };
  return {
    request,
    receipt: {
      status: 'committed',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      revision: index + 1,
      actor: 'native:journal-fixture',
      recordedAt: index + 1,
      requestDigest: nativeInventoryRequestDigest(request),
      ...(version === undefined ? {} : { context: { version, principal, authority } }),
    },
  };
}
function apply(state: InventoryState, row: NativeInventoryHistoryEntry): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: row.request.expectedRevision,
      commands: 'commands' in row.request ? row.request.commands : [],
    },
    row.receipt.context ? { at: row.receipt.recordedAt, principal, authority } : undefined
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function replay(entries: readonly NativeInventoryHistoryEntry[]): InventoryState {
  const unused = () => {
    throw new Error('Unrelated source importer invoked.');
  };
  return replayNativeInventoryEntries(
    entries,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused
  );
}
function v18Snapshot(state: InventoryState): unknown {
  const { lotRecalls: _recalls, ...facts } = state;
  return {
    ...facts,
    schema: 'dnaforge.inventory.v18',
    lots: Object.fromEntries(
      Object.entries(state.lots).map(([id, lot]) => {
        const { controls: _controls, lotConstraints: _constraints, ...old } = lot;
        return [id, old];
      })
    ),
    stocks: Object.fromEntries(
      Object.entries(state.stocks).map(([id, stock]) => {
        const { lotConstraints: _constraints, ...old } = stock;
        return [id, old];
      })
    ),
  };
}

describe('versioned native inventory replay', () => {
  it('preserves missing and V1 receipt context exactly while admitting explicit V2', () => {
    for (const version of [undefined, 1, 2] as const) {
      const receipt = entry(0, received, version).receipt;
      expect(inventoryReceiptSchema.parse(receipt)).toEqual(receipt);
    }
    expect(() =>
      inventoryReceiptSchema.parse({
        ...entry(0, received, 2).receipt,
        context: { version: 3, principal, authority },
      })
    ).toThrow();
  });

  it.each([undefined, 1] as const)(
    'replays a legacy %s prefix like its erased-association snapshot',
    (version) => {
      const history = [entry(0, received, version), entry(1, [associate('lot-b')], version)];
      const oldSnapshot = v18Snapshot(history.reduce(apply, createInventoryState()));
      const savedBefore = JSON.stringify(history);
      const state = replay(history);
      expect(state).toEqual(parseInventoryState(oldSnapshot));
      expect(state.stocks.stock.lotConstraints).toEqual({
        knowledge: 'legacy-partial',
        lotIds: ['lot-b'],
      });
      expect(JSON.stringify(history)).toBe(savedBefore);
    }
  );

  it('preserves cumulative associations for explicit V2 receipts', () => {
    const history = [entry(0, received, 2), entry(1, [associate('lot-b')], 2)];
    const state = replay(history);
    expect(state).toEqual(history.reduce(apply, createInventoryState()));
    expect(state.stocks.stock.lotConstraints).toEqual({
      knowledge: 'recorded',
      lotIds: ['lot-a', 'lot-b'],
    });
  });

  it('retains the partial baseline when V2 begins and accumulates subsequent associations', () => {
    const prefix = [entry(0, received, 1), entry(1, [associate('lot-b')], 1)];
    const baseline = parseInventoryState(v18Snapshot(prefix.reduce(apply, createInventoryState())));
    const next = entry(2, [associate('lot-a')], 2);
    const state = replay([...prefix, next]);
    expect(state).toEqual(apply(baseline, next));
    expect(state.stocks.stock.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['lot-a', 'lot-b'],
    });
  });

  it.each([undefined, 1] as const)('refuses receipt semantics regression to %s', (version) => {
    expect(() => replay([entry(0, received, 2), entry(1, [associate('lot-b')], version)])).toThrow(
      'cannot return to the legacy version'
    );
  });

  it.each([undefined, 1] as const)(
    'refuses new lot control commands with legacy %s semantics',
    (version) => {
      expect(() =>
        replay([
          entry(0, received, version),
          entry(
            1,
            [{ kind: 'manage-lot', lotId: 'lot-a', reason: 'Start explicit local assessment' }],
            version
          ),
        ])
      ).toThrow('Lot controls require current receipt semantics');
    }
  );
});

function archiveAdoption(
  managed: boolean,
  version: 1 | 2 | undefined,
  legacySnapshot = !managed
): NativeInventoryHistoryEntry {
  const commands: readonly InventoryCommand[] = managed
    ? [
        ...received,
        { kind: 'manage-lot', lotId: 'lot-a', reason: 'Manage received material' },
        {
          kind: 'assess-lot',
          lotId: 'lot-a',
          assessment: 'released',
          reason: 'Local source release',
        },
      ]
    : received;
  const sourceEntry = entry(0, commands, legacySnapshot ? 1 : 2);
  const sourceState = apply(createInventoryState(), sourceEntry);
  const artifact = nativeInventoryArchive({
    projectId: sourceEntry.request.project,
    inventoryId: sourceEntry.request.inventoryId,
    state: {
      revision: sourceState.revision,
      json: JSON.stringify(legacySnapshot ? v18Snapshot(sourceState) : sourceState),
    },
    history: [
      {
        operationId: sourceEntry.request.operationId,
        revision: sourceEntry.receipt.revision,
        requestJson: JSON.stringify(sourceEntry.request),
        receiptJson: JSON.stringify(sourceEntry.receipt),
      },
    ],
  });
  const target = {
    projectId: 'destination-project',
    inventoryId: 'destination-inventory',
    present: false,
    revision: 0,
  };
  const binding = { sourceMaterialId: 'material', destinationMaterialId: 'material' };
  const preview = nativeInventoryImportPreview(
    artifact.sourceText,
    target,
    { bindings: [binding] },
    [{ ...binding, kind: 'admitted', fingerprint: `sha256:${'b'.repeat(64)}` }],
    10
  );
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const request: InventoryApplyImportRequest = {
    kind: 'adopt-archive',
    project: target.projectId,
    inventoryId: target.inventoryId,
    operationId: 'adopt-history',
    expectedRevision: 0,
    sourceText: artifact.sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
  return {
    request,
    receipt: {
      ...entry(0, [], version).receipt,
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      recordedAt: 10,
      requestDigest: nativeInventoryRequestDigest(request),
    },
  };
}

describe('archive adoption at the receipt semantics boundary', () => {
  it.each([undefined, 1] as const)(
    'refuses a real managed archive wrapped in legacy %s adoption',
    (version) => {
      const row = archiveAdoption(true, version);
      expect(() => replayNativeInventoryJournal([row])).toThrow(
        version === undefined
          ? 'An adoption requires its native receipt context'
          : 'A legacy receipt cannot adopt a current lot-constraint archive'
      );
    }
  );
  it('refuses downgrading a current untracked archive through a V1 adoption', () => {
    expect(() => replayNativeInventoryJournal([archiveAdoption(false, 1, false)])).toThrow(
      'A legacy receipt cannot adopt a current lot-constraint archive'
    );
  });

  it('preserves a real legacy archive and its original V1 adoption semantics', () => {
    const row = archiveAdoption(false, 1);
    const state = replayNativeInventoryJournal([row]);
    expect(state.revision).toBe(1);
    expect(state.lots['lot-a'].controls).toEqual({ kind: 'legacy-untracked' });
    expect(state.stocks.stock.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['lot-a'],
    });
  });
  it('permits a managed V2 adoption without treating imported release as local authority', () => {
    const row = archiveAdoption(true, 2);
    const state = replayNativeInventoryJournal([row]);
    expect(state.lots['lot-a'].controls).toMatchObject({
      kind: 'managed',
      assessment: { value: 'released', by: { kind: 'imported' } },
    });
    expect(state.stocks.stock.lotConstraints).toEqual({ knowledge: 'recorded', lotIds: ['lot-a'] });
  });
});
