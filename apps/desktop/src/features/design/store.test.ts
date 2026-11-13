import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  assemblyDispatcher,
  hydrateDesign,
  migratePersistedDesignState,
  partializeDesigns,
  useDesignStore,
} from './store';
import type { DesignRegion, SequenceDesign } from './types';
import type { GoldenGateAssemblySchema } from './golden-gate-schema';
import {
  designWithSelectedPendingSpacer,
  productLayoutSegmentId,
  selectProductLayout,
  selectProductLayoutItems,
} from './assembly-boundaries';
import { createAppTmCalculator, useSettingsStore } from '../junction-workbench/settings';
import {
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  DEFAULT_TM_MODEL,
  OWCZARZY_TM_MODEL,
} from './algorithms/tm-model';

let uuidCounter = 0;
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
  uuidCounter++;
  return `design-${uuidCounter.toString().padStart(4, '0')}-0000-0000-0000-000000000000`;
});

function resetStore() {
  uuidCounter = 0;
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
    draftDesignIds: {},
  });
}

function createMockRegion(overrides: Partial<DesignRegion> = {}): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: overrides.sourceSequenceId || 'source-seq-1',
    sourceSequenceName: overrides.sourceSequenceName || 'Test Sequence',
    sourceStart: overrides.sourceStart || 0,
    sourceEnd: overrides.sourceEnd || 100,
    sequence: overrides.sequence || 'ATCGATCGATCGATCGATCG'.repeat(5),
    annotations: overrides.annotations || [],
  };
}

function createAssemblyRegion(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
  };
}

function twoSlotGoldenGateSchema(): GoldenGateAssemblySchema {
  return {
    id: 'custom-two-slot',
    name: 'Custom two-slot schema',
    revision: 1,
    origin: { type: 'custom' },
    enzyme: 'BsaI',
    slots: [
      {
        id: 'first',
        label: 'First part',
        outgoingOverhang: 'AATG',
        preferredRoles: [],
      },
      {
        id: 'second',
        label: 'Second part',
        outgoingOverhang: 'GGAG',
        preferredRoles: [],
      },
    ],
  };
}

function lockedTwoSlotGoldenGateSchema(): GoldenGateAssemblySchema {
  return {
    ...twoSlotGoldenGateSchema(),
    id: 'kit-two-slot',
    name: 'Kit two-slot schema',
    origin: { type: 'kit', kitId: 'test-kit', kitName: 'Test kit' },
  };
}

async function createRdSpacerPcrDesign(
  spacerSequence = 'TTT',
  rdSide: 'left' | 'right' = 'left'
): Promise<string> {
  const store = useDesignStore.getState();
  const id = store.createDesign('RD spacer PCR', 'circular', 'gibson');
  const rdRegion = {
    ...createAssemblyRegion('RD', 'A'.repeat(100)),
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    rdSourceEnzymeName: 'BsaI',
  } satisfies Omit<DesignRegion, 'id'>;
  const pcrRegion = createAssemblyRegion('PCR', 'C'.repeat(100));
  const regions = rdSide === 'left' ? [rdRegion, pcrRegion] : [pcrRegion, rdRegion];
  for (const region of regions) {
    store.addRegion(id, region);
  }
  useDesignStore.setState((state) => ({
    designs: {
      ...state.designs,
      [id]: {
        ...state.designs[id],
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: spacerSequence }],
      },
    },
  }));
  await draftAssemblyAndWait(id);
  return id;
}

async function draftAssemblyAndWait(designId: string): Promise<void> {
  const dispatch = vi.spyOn(assemblyDispatcher, 'dispatch');
  let result: ReturnType<typeof assemblyDispatcher.dispatch> | undefined;
  try {
    useDesignStore.getState().draftAssembly(designId);
    result = dispatch.mock.results.at(-1)?.value;
  } finally {
    dispatch.mockRestore();
  }
  await result?.result;
}

describe('useDesignStore', () => {
  beforeEach(() => {
    resetStore();
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      tmConditions: DEFAULT_TM_CONDITIONS,
    });
  });

  describe('artifact draft lifecycle', () => {
    it('keeps an unsaved design usable in memory but out of persisted state', () => {
      const store = useDesignStore.getState();
      const id = store.createDraftDesign('Untitled Assembly', 'goldengate');

      expect(useDesignStore.getState().designs[id]).toBeDefined();
      expect(useDesignStore.getState().draftDesignIds[id]).toBe(true);
      expect(
        partializeDesigns(
          useDesignStore.getState().designs,
          useDesignStore.getState().draftDesignIds
        )[id]
      ).toBeUndefined();
    });

    it('promotes only the explicitly saved design into durable state', () => {
      const store = useDesignStore.getState();
      const id = store.createDraftDesign('Untitled Assembly', 'goldengate');

      store.commitDraftDesign(id);

      expect(useDesignStore.getState().draftDesignIds[id]).toBeUndefined();
      expect(
        partializeDesigns(
          useDesignStore.getState().designs,
          useDesignStore.getState().draftDesignIds
        )[id]
      ).toBeDefined();
    });

    it('deleting a discarded design also removes its transient identity', () => {
      const store = useDesignStore.getState();
      const id = store.createDraftDesign('Untitled Assembly', 'goldengate');

      store.deleteDesign(id);

      expect(useDesignStore.getState().designs[id]).toBeUndefined();
      expect(useDesignStore.getState().draftDesignIds[id]).toBeUndefined();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Design CRUD', () => {
    describe('createDesign', () => {
      it('creates a new design with default values', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('My Design');

        const state = useDesignStore.getState();
        expect(state.designs[id]).toBeDefined();
        expect(state.designs[id].name).toBe('My Design');
        expect(state.designs[id].topology).toBe('circular');
        expect(state.designs[id].assemblyMethod).toBe('gibson');
        expect(state.designs[id].regions).toEqual([]);
        expect(state.designs[id].spacers).toEqual([]);
        expect(state.designs[id].assemblyState).toBe('preflight');
        expect(state.designs[id].validationErrors).toEqual([]);
        expect(state.designs[id].version).toBe(0);
        expect(state.designs[id].status).toBe('draft');
        expect(state.designs[id].constructId).toEqual(expect.any(String));
        expect(state.designs[id].constructId).not.toBe(id);
        expect(state.activeDesignId).toBe(id);
      });

      it('binds a missing construct id without bumping the draft version', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Unbound');
        useDesignStore.setState({
          designs: {
            ...useDesignStore.getState().designs,
            [id]: { ...useDesignStore.getState().designs[id], constructId: undefined },
          },
        });

        store.bindDesignConstructId(id, 'construct-bound');
        expect(useDesignStore.getState().designs[id].constructId).toBe('construct-bound');
        expect(useDesignStore.getState().designs[id].version).toBe(0);
        expect(() => store.bindDesignConstructId(id, 'construct-other')).toThrow(
          /already bound to construct construct-bound/
        );
      });

      it('normalizes legacy linear topology inputs to circular', () => {
        const store = useDesignStore.getState();
        const id = (store.createDesign as any)('Linear Design', 'linear');

        const state = useDesignStore.getState();
        expect(state.designs[id].topology).toBe('circular');
      });

      it('creates design with specified assembly method', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('GoldenGate Design', 'circular', 'goldengate');

        const state = useDesignStore.getState();
        expect(state.designs[id].assemblyMethod).toBe('goldengate');
        expect(state.designs[id].goldenGateConfig).toEqual({ enzyme: 'BsaI' });
        expect(state.designs[id].goldenGateJunctions).toEqual([]);
      });

      it('creates designs with unique IDs', () => {
        const store = useDesignStore.getState();
        const id1 = store.createDesign('Design 1');
        const id2 = store.createDesign('Design 2');

        expect(id1).not.toBe(id2);
        expect(Object.keys(useDesignStore.getState().designs)).toHaveLength(2);
      });

      it('sets timestamps on creation', () => {
        const store = useDesignStore.getState();
        const beforeCreate = new Date();
        const id = store.createDesign('Timed Design');
        const afterCreate = new Date();

        const design = useDesignStore.getState().designs[id];
        expect(design.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
        expect(design.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
        expect(design.updatedAt.getTime()).toEqual(design.createdAt.getTime());
      });
    });

    describe('commitWorkbenchDesign', () => {
      it('commits only when the current store version matches the reducer pre-image', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Workbench CAS');
        const current = useDesignStore.getState().designs[id];
        const nextDesign: SequenceDesign = {
          ...current,
          name: 'Committed',
          version: current.version + 1,
        };

        expect(store.commitWorkbenchDesign(id, nextDesign, current.version)).toBe(true);
        expect(useDesignStore.getState().designs[id].name).toBe('Committed');

        const staleNextDesign: SequenceDesign = {
          ...useDesignStore.getState().designs[id],
          name: 'Stale overwrite',
          version: 999,
        };

        expect(store.commitWorkbenchDesign(id, staleNextDesign, current.version)).toBe(false);
        expect(useDesignStore.getState().designs[id].name).toBe('Committed');
      });
    });

    describe('setGoldenGateSchema', () => {
      it('applies the shared versioned schema command and refuses a stale retry', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Schema CAS', 'circular', 'goldengate');
        const initialVersion = useDesignStore.getState().designs[id].version;

        const applied = store.setGoldenGateSchema(id, twoSlotGoldenGateSchema(), initialVersion);

        expect(applied.status).toBe('applied');
        expect(useDesignStore.getState().designs[id]).toMatchObject({
          version: initialVersion + 1,
          goldenGateSchema: twoSlotGoldenGateSchema(),
          regions: [
            { sourceSequenceName: 'Empty First part', isPlaceholder: true },
            { sourceSequenceName: 'Empty Second part', isPlaceholder: true },
          ],
        });

        expect(
          store.setGoldenGateSchema(id, twoSlotGoldenGateSchema(), initialVersion)
        ).toMatchObject({ status: 'rejected', code: 'stale-version' });
        expect(useDesignStore.getState().designs[id].version).toBe(initialVersion + 1);
      });

      it('keeps an explicit schema aligned when ordinary part actions insert and remove slots', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Aligned schema', 'circular', 'goldengate');
        store.setGoldenGateSchema(id, twoSlotGoldenGateSchema(), 0);
        const firstRegionId = useDesignStore.getState().designs[id].regions[0].id;

        store.insertRegionAt(id, 1, createAssemblyRegion('Inserted RBS', 'ACGT'));
        expect(
          useDesignStore.getState().designs[id].goldenGateSchema?.slots.map((slot) => ({
            label: slot.label,
            outgoingOverhang: slot.outgoingOverhang,
          }))
        ).toEqual([
          { label: 'First part', outgoingOverhang: 'AATG' },
          { label: 'Inserted RBS', outgoingOverhang: null },
          { label: 'Second part', outgoingOverhang: 'GGAG' },
        ]);

        store.removeRegion(id, firstRegionId);
        expect(
          useDesignStore.getState().designs[id].goldenGateSchema?.slots.map((slot) => slot.label)
        ).toEqual(['Inserted RBS', 'Second part']);
      });

      it('keeps a reusable schema slot count, order, and junctions fixed below the UI', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Locked schema', 'circular', 'goldengate');
        store.setGoldenGateSchema(id, lockedTwoSlotGoldenGateSchema(), 0);
        const before = useDesignStore.getState().designs[id];
        const [first, second] = before.regions;

        store.addRegion(id, createAssemblyRegion('Appended', 'ACGT'));
        store.insertRegionAt(id, 1, createAssemblyRegion('Inserted', 'TGCA'));
        store.removeRegion(id, first.id);
        store.reorderRegions(id, [second.id, first.id]);
        expect(
          store.reorderProductLayoutSegments(
            id,
            selectProductLayout(before).reverse().map(productLayoutSegmentId)
          )
        ).toBe(false);
        expect(store.setJunctionSpacer(id, 0, 'AATT')).toBe(false);
        store.addSpacer(id, 0, 'AATT');

        const after = useDesignStore.getState().designs[id];
        expect(after.version).toBe(before.version);
        expect(after.regions.map((region) => region.id)).toEqual([first.id, second.id]);
        expect(after.goldenGateSchema).toEqual(lockedTwoSlotGoldenGateSchema());
        expect(after.spacers).toEqual([]);
      });
    });

    describe('deleteDesign', () => {
      it('removes design from state', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('To Delete');

        expect(useDesignStore.getState().designs[id]).toBeDefined();

        store.deleteDesign(id);

        expect(useDesignStore.getState().designs[id]).toBeUndefined();
      });

      it('clears activeDesignId if deleting active design', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Active Design');

        expect(useDesignStore.getState().activeDesignId).toBe(id);

        store.deleteDesign(id);

        expect(useDesignStore.getState().activeDesignId).toBeNull();
      });

      it('preserves activeDesignId when deleting different design', () => {
        const store = useDesignStore.getState();
        const id1 = store.createDesign('Design 1');
        const id2 = store.createDesign('Design 2');

        store.deleteDesign(id1);

        expect(useDesignStore.getState().activeDesignId).toBe(id2);
      });
    });

    describe('updateDesign', () => {
      it('updates design name', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Original Name');

        store.updateDesign(id, { name: 'New Name' });

        expect(useDesignStore.getState().designs[id].name).toBe('New Name');
      });

      it('ignores legacy linear topology updates', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion({ sequence: 'ATCG'.repeat(25) }));
        store.addRegion(id, createMockRegion({ sequence: 'GCTA'.repeat(25) }));

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1', junctionIndex: 0 } as any],
              designPrimers: [{ fragmentIndex: 0 } as any],
              status: 'computed',
            },
          },
        }));

        (store.updateDesign as any)(id, { topology: 'linear' });

        const design = useDesignStore.getState().designs[id];
        expect(design.topology).toBe('circular');
        expect(design.homologyRegions).toEqual([{ id: 'hr-1', junctionIndex: 0 } as any]);
        expect(design.designPrimers).toEqual([{ fragmentIndex: 0 } as any]);
        expect(design.status).toBe('computed');
      });

      it('clears draft assembly when defaultHomologyLength changes', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              status: 'computed',
            },
          },
        }));

        store.updateDesign(id, { defaultHomologyLength: 40 });

        const design = useDesignStore.getState().designs[id];
        expect(design.defaultHomologyLength).toBe(40);
        expect(design.homologyRegions).toEqual([]);
        expect(design.status).toBe('draft');
      });

      it('does nothing for non-existent design', () => {
        const store = useDesignStore.getState();
        const initialState = useDesignStore.getState();

        store.updateDesign('non-existent', { name: 'New Name' });

        expect(useDesignStore.getState()).toEqual(initialState);
      });
    });

    describe('setActiveDesign', () => {
      it('sets the active design', () => {
        const store = useDesignStore.getState();
        const id1 = store.createDesign('Design 1');
        store.createDesign('Design 2');

        store.setActiveDesign(id1);

        expect(useDesignStore.getState().activeDesignId).toBe(id1);
      });

      it('can set active design to null', () => {
        const store = useDesignStore.getState();
        store.createDesign('Design');

        store.setActiveDesign(null);

        expect(useDesignStore.getState().activeDesignId).toBeNull();
      });
    });

    describe('getOrCreateDesign', () => {
      it('returns active design if exists', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Existing');

        const result = store.getOrCreateDesign();

        expect(result).toBe(id);
      });

      it('activates first design if no active design', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('First');
        store.setActiveDesign(null);

        const result = store.getOrCreateDesign();

        expect(result).toBe(id);
        expect(useDesignStore.getState().activeDesignId).toBe(id);
      });

      it('creates new design if no designs exist', () => {
        const store = useDesignStore.getState();

        const result = store.getOrCreateDesign();

        expect(result).toBeTruthy();
        expect(useDesignStore.getState().designs[result]).toBeDefined();
        expect(useDesignStore.getState().designs[result].name).toBe('Untitled');
      });
    });
  });

  describe('Region Operations', () => {
    describe('addRegion', () => {
      it('adds region to design', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion());

        const design = useDesignStore.getState().designs[id];
        expect(design.regions).toHaveLength(1);
        expect(design.regions[0].sequence).toBe('ATCGATCGATCGATCGATCG'.repeat(5));
      });

      it('assigns unique ID to region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        const design = useDesignStore.getState().designs[id];
        expect(design.regions[0].id).not.toBe(design.regions[1].id);
      });

      it('resets status to draft when adding region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: { ...state.designs[id], status: 'computed' },
          },
        }));

        store.addRegion(id, createMockRegion());

        expect(useDesignStore.getState().designs[id].status).toBe('draft');
      });

      it('clears homology regions and primers when adding region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              designPrimers: [{ fragmentIndex: 0 } as any],
            },
          },
        }));

        store.addRegion(id, createMockRegion());

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
      });

      it('reanchors a circular closure spacer when appending a region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular');
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.setJunctionSpacer(id, 1, 'AAGC');

        const before = useDesignStore.getState().designs[id];
        expect(before.spacers[0].anchor).toEqual({
          leftRegionId: before.regions[1].id,
          rightRegionId: before.regions[0].id,
        });

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'X' }));

        const after = useDesignStore.getState().designs[id];
        expect(after.spacers[0]).toMatchObject({ junctionIndex: 1, sequence: 'AAGC' });
        expect(after.spacers[0].anchor).toEqual({
          leftRegionId: after.regions[1].id,
          rightRegionId: after.regions[2].id,
        });
      });
    });

    describe('insertRegionAt', () => {
      it('inserts region at specified index', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Third' }));
        store.insertRegionAt(id, 1, createMockRegion({ sourceSequenceName: 'Middle' }));

        const design = useDesignStore.getState().designs[id];
        expect(design.regions).toHaveLength(3);
        expect(design.regions[0].sourceSequenceName).toBe('First');
        expect(design.regions[1].sourceSequenceName).toBe('Middle');
        expect(design.regions[2].sourceSequenceName).toBe('Third');
      });

      it('assigns appended regions color slots from the initial left-to-right order', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Third' }));

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Second',
          'Third',
        ]);
        expect(design.regions.map((region) => region.colorIndex)).toEqual([0, 1, 2]);
      });

      it('does not recolor existing regions when inserting into the middle', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Third' }));
        const beforeInsert = useDesignStore.getState().designs[id].regions;
        expect(beforeInsert.map((region) => region.colorIndex)).toEqual([0, 1]);

        store.insertRegionAt(id, 1, createMockRegion({ sourceSequenceName: 'Middle' }));

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Middle',
          'Third',
        ]);
        expect(design.regions.map((region) => region.colorIndex)).toEqual([0, 2, 1]);
      });

      it('clears draft assembly when inserting region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              status: 'computed',
            },
          },
        }));

        store.insertRegionAt(id, 0, createMockRegion());

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.status).toBe('draft');
      });

      it('keeps existing spacers attached to the same upstream part on normal insertion', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Third' }));
        store.setJunctionSpacer(id, 1, 'GG');

        store.insertRegionAt(id, 1, createMockRegion({ sourceSequenceName: 'Middle' }));

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Middle',
          'Second',
          'Third',
        ]);
        expect(design.spacers).toMatchObject([{ junctionIndex: 2, sequence: 'GG' }]);
      });

      it('re-anchors a spacer to the resulting gap when an insertion splits its old gap', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular');
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.setJunctionSpacer(id, 1, 'GG');

        store.insertRegionAt(id, 2, createMockRegion({ sourceSequenceName: 'Inserted' }));

        const design = useDesignStore.getState().designs[id];
        const spacer = design.spacers[0];
        expect(spacer.junctionIndex).toBe(1);
        expect(spacer.anchor).toEqual({
          leftRegionId: design.regions[1].id,
          rightRegionId: design.regions[2].id,
        });
      });
    });

    describe('insertRegionAtProductBoundary', () => {
      it('inserts above an existing spacer without moving the spacer below the new part', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.setJunctionSpacer(id, 0, 'GG');

        const upperSpacerBoundary = selectProductLayoutItems(useDesignStore.getState().designs[id])
          .filter((item) => item.kind === 'boundary')
          .find((item) => item.leftKind === 'part' && item.rightKind === 'spacer')?.id;
        expect(upperSpacerBoundary).toBeDefined();

        store.insertRegionAtProductBoundary(
          id,
          upperSpacerBoundary!,
          createMockRegion({ sourceSequenceName: 'Inserted before spacer' })
        );

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Inserted before spacer',
          'Second',
        ]);
        expect(design.spacers).toMatchObject([{ junctionIndex: 1, sequence: 'GG' }]);
      });

      it('inserts below an existing spacer while keeping that spacer above the new part', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.setJunctionSpacer(id, 0, 'GG');

        const lowerSpacerBoundary = selectProductLayoutItems(useDesignStore.getState().designs[id])
          .filter((item) => item.kind === 'boundary')
          .find((item) => item.leftKind === 'spacer' && item.rightKind === 'part')?.id;
        expect(lowerSpacerBoundary).toBeDefined();

        store.insertRegionAtProductBoundary(
          id,
          lowerSpacerBoundary!,
          createMockRegion({ sourceSequenceName: 'Inserted after spacer' })
        );

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Inserted after spacer',
          'Second',
        ]);
        expect(design.spacers).toMatchObject([{ junctionIndex: 0, sequence: 'GG' }]);
      });

      it('resolves boundaries around the selected pending spacer instead of dropping the click', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));
        store.setSelectedJunction(id, 0);

        const pendingUpperBoundary = selectProductLayoutItems(
          designWithSelectedPendingSpacer(useDesignStore.getState().designs[id])
        )
          .filter((item) => item.kind === 'boundary')
          .find((item) => item.leftKind === 'part' && item.rightKind === 'spacer')?.id;
        expect(pendingUpperBoundary).toBeDefined();

        store.insertRegionAtProductBoundary(
          id,
          pendingUpperBoundary!,
          createMockRegion({ sourceSequenceName: 'Inserted before pending spacer' })
        );

        const design = useDesignStore.getState().designs[id];
        expect(design.regions.map((region) => region.sourceSequenceName)).toEqual([
          'First',
          'Inserted before pending spacer',
          'Second',
        ]);
        expect(design.spacers).toEqual([]);
        expect(design.selectedJunctionIndex).toBeNull();
      });
    });

    describe('removeRegion', () => {
      it('removes region by ID', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'First' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));

        const regionId = useDesignStore.getState().designs[id].regions[0].id;
        store.removeRegion(id, regionId);

        const design = useDesignStore.getState().designs[id];
        expect(design.regions).toHaveLength(1);
        expect(design.regions[0].sourceSequenceName).toBe('Second');
      });

      it('clears draft assembly when removing region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              designPrimers: [{ fragmentIndex: 0 } as any],
              status: 'computed',
            },
          },
        }));

        const regionId = useDesignStore.getState().designs[id].regions[0].id;
        store.removeRegion(id, regionId);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
        expect(design.status).toBe('draft');
      });
    });

    describe('clearRegion', () => {
      it('resets a part to an empty placeholder slot WITHOUT removing it, keeping id + colour', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(
          id,
          createMockRegion({ sourceSequenceName: 'First', sequence: 'ATCGATCG' })
        );
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'Second' }));

        const before = useDesignStore.getState().designs[id].regions[0];
        store.clearRegion(id, before.id);

        const design = useDesignStore.getState().designs[id];
        expect(design.regions).toHaveLength(2);
        const cleared = design.regions[0];
        expect(cleared.id).toBe(before.id);
        expect(cleared.colorIndex).toBe(before.colorIndex);
        expect(cleared.isPlaceholder).toBe(true);
        expect(cleared.sequence).toBe('');
        expect(cleared.sourceSequenceId).toBe('placeholder');
        expect(cleared.sourceSequenceName).toBe('Empty slot');
        expect(design.regions[1].sourceSequenceName).toBe('Second');
      });

      it('drops RD / Golden Gate mapping fields on clear (full reset, not a merge)', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, {
          ...createMockRegion({ sourceSequenceName: 'RD part' }),
          sourceType: 'rd',
          ggType: 'insert',
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzymeName: 'BsaI',
        });
        const regionId = useDesignStore.getState().designs[id].regions[0].id;
        store.clearRegion(id, regionId);

        const cleared = useDesignStore.getState().designs[id].regions[0];
        expect(cleared.sourceType).toBeUndefined();
        expect(cleared.rdOverhangs).toBeUndefined();
        expect(cleared.ggType).toBeUndefined();
        expect(cleared.rdSourceEnzymeName).toBeUndefined();
      });

      it('clears the drafted assembly when clearing a region', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              designPrimers: [{ fragmentIndex: 0 } as any],
              status: 'computed',
            },
          },
        }));

        const regionId = useDesignStore.getState().designs[id].regions[0].id;
        store.clearRegion(id, regionId);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
        expect(design.status).toBe('draft');
      });

      it('is a no-op for an unknown region id', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        const before = useDesignStore.getState().designs[id].regions;
        store.clearRegion(id, 'does-not-exist');
        expect(useDesignStore.getState().designs[id].regions).toEqual(before);
      });
    });

    describe('reverseComplementRegion', () => {
      it('replaces the part in place and invalidates its drafted assembly', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, {
          ...createMockRegion({
            sourceSequenceId: '/workspace/source.gb',
            sourceStart: 2,
            sourceEnd: 8,
            sequence: 'AACCGT',
          }),
          sourceSequence: 'AAAACCGTGGTT',
          sourceLength: 12,
        });
        const before = useDesignStore.getState().designs[id].regions[0];
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              designPrimers: [{ fragmentIndex: 0 } as any],
              status: 'computed',
            },
          },
        }));

        expect(store.reverseComplementRegion(id, before.id)).toBe(true);

        const design = useDesignStore.getState().designs[id];
        expect(design.regions[0]).toMatchObject({
          id: before.id,
          colorIndex: before.colorIndex,
          sequence: 'ACGGTT',
          sourceStart: 4,
          sourceEnd: 10,
        });
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
        expect(design.status).toBe('draft');
      });
    });

    describe('reorderRegions', () => {
      it('reorders regions by ID array', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));

        const regions = useDesignStore.getState().designs[id].regions;
        const newOrder = [regions[2].id, regions[0].id, regions[1].id];

        store.reorderRegions(id, newOrder);

        const reordered = useDesignStore.getState().designs[id].regions;
        expect(reordered[0].sourceSequenceName).toBe('C');
        expect(reordered[1].sourceSequenceName).toBe('A');
        expect(reordered[2].sourceSequenceName).toBe('B');
      });

      it('preserves stable color slots with each region across reorder', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));

        const regions = useDesignStore.getState().designs[id].regions;
        store.reorderRegions(id, [regions[2].id, regions[0].id, regions[1].id]);

        const reordered = useDesignStore.getState().designs[id].regions;
        expect(reordered.map((region) => region.sourceSequenceName)).toEqual(['C', 'A', 'B']);
        expect(reordered.map((region) => region.colorIndex)).toEqual([2, 0, 1]);
      });

      it('rejects incompatible reorders of fixed Golden Gate digest fragments', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = useDesignStore.getState();
        const id = store.createDesign('CIDAR order', 'circular', 'goldengate');
        const addRdRegion = (name: string, upstream: string, downstream: string) =>
          store.addRegion(id, {
            ...createAssemblyRegion(name, 'ATCG'.repeat(20)),
            sourceType: 'rd',
            ggType: 'insert',
            rdOverhangs: { upstream, downstream },
            rdSourceEnzyme: 'BsaI',
          });
        addRdRegion('A-B', 'AATG', 'GCTT');
        addRdRegion('B-C', 'GCTT', 'CGCT');
        addRdRegion('C-A', 'CGCT', 'AATG');

        const original = useDesignStore.getState().designs[id];
        store.reorderRegions(id, [
          original.regions[0].id,
          original.regions[2].id,
          original.regions[1].id,
        ]);
        expect(
          useDesignStore.getState().designs[id].regions.map((region) => region.sourceSequenceName)
        ).toEqual(['A-B', 'B-C', 'C-A']);

        const segments = selectProductLayout(original);
        const applied = store.reorderProductLayoutSegments(id, [
          productLayoutSegmentId(segments[0]),
          productLayoutSegmentId(segments[2]),
          productLayoutSegmentId(segments[1]),
        ]);
        expect(applied).toBe(false);
        expect(
          useDesignStore.getState().designs[id].regions.map((region) => region.sourceSequenceName)
        ).toEqual(['A-B', 'B-C', 'C-A']);
        consoleSpy.mockRestore();
      });

      it('pushes spacer product segments when region reordering crosses their slot', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));
        store.setJunctionSpacer(id, 0, 'AAGC');

        const original = useDesignStore.getState().designs[id].regions;
        store.reorderRegions(id, [original[2].id, original[0].id, original[1].id]);

        const movedFromAfterSpacer = useDesignStore.getState().designs[id];
        expect(movedFromAfterSpacer.spacers).toEqual([
          expect.objectContaining({ junctionIndex: 1, sequence: 'AAGC' }),
        ]);
        expect(
          selectProductLayout(movedFromAfterSpacer).map((segment) =>
            segment.kind === 'part'
              ? segment.region.sourceSequenceName
              : `spacer:${segment.spacer.sequence}`
          )
        ).toEqual(['C', 'A', 'spacer:AAGC', 'B']);

        store.reorderRegions(id, [original[0].id, original[1].id, original[2].id]);
        const reset = useDesignStore.getState().designs[id];
        expect(reset.spacers).toEqual([expect.objectContaining({ junctionIndex: 0 })]);

        store.reorderRegions(id, [original[1].id, original[0].id, original[2].id]);
        const movedFromBeforeSpacer = useDesignStore.getState().designs[id];
        expect(movedFromBeforeSpacer.spacers).toEqual([
          expect.objectContaining({ junctionIndex: 0, sequence: 'AAGC' }),
        ]);
        expect(
          selectProductLayout(movedFromBeforeSpacer).map((segment) =>
            segment.kind === 'part'
              ? segment.region.sourceSequenceName
              : `spacer:${segment.spacer.sequence}`
          )
        ).toEqual(['B', 'spacer:AAGC', 'A', 'C']);
      });

      it('reorders parts and spacers through one product-segment order', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));
        store.setJunctionSpacer(id, 0, 'AAGC');

        const original = useDesignStore.getState().designs[id];
        const originalSegments = selectProductLayout(original);
        expect(
          originalSegments.map((segment) =>
            segment.kind === 'part'
              ? segment.region.sourceSequenceName
              : `spacer:${segment.spacer.sequence}`
          )
        ).toEqual(['A', 'spacer:AAGC', 'B', 'C']);

        const byLabel = new Map(
          originalSegments.map((segment) => [
            segment.kind === 'part' ? segment.region.sourceSequenceName : 'spacer',
            productLayoutSegmentId(segment),
          ])
        );
        const applied = store.reorderProductLayoutSegments(id, [
          byLabel.get('C')!,
          byLabel.get('A')!,
          byLabel.get('spacer')!,
          byLabel.get('B')!,
        ]);

        expect(applied).toBe(true);
        const updated = useDesignStore.getState().designs[id];
        expect(updated.regions.map((region) => region.sourceSequenceName)).toEqual(['C', 'A', 'B']);
        expect(updated.regions.map((region) => region.colorIndex)).toEqual([2, 0, 1]);
        expect(updated.spacers).toEqual([
          expect.objectContaining({ junctionIndex: 1, sequence: 'AAGC' }),
        ]);
        expect(updated.spacers[0].anchor).toEqual({
          leftRegionId: updated.regions[1].id,
          rightRegionId: updated.regions[2].id,
        });
        expect(
          selectProductLayout(updated).map((segment) =>
            segment.kind === 'part'
              ? segment.region.sourceSequenceName
              : `spacer:${segment.spacer.sequence}`
          )
        ).toEqual(['C', 'A', 'spacer:AAGC', 'B']);
      });

      it('reorders product segments when legacy regions share the same id', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        const design = useDesignStore.getState().designs[id];
        const duplicateRegions: DesignRegion[] = [
          { ...createMockRegion({ sourceSequenceName: 'A' }), id: 'legacy-duplicate' },
          { ...createMockRegion({ sourceSequenceName: 'B' }), id: 'legacy-duplicate' },
          { ...createMockRegion({ sourceSequenceName: 'C' }), id: 'legacy-duplicate' },
        ];

        useDesignStore.setState({
          designs: {
            ...useDesignStore.getState().designs,
            [id]: {
              ...design,
              regions: duplicateRegions,
            },
          },
        });

        const originalSegments = selectProductLayout(useDesignStore.getState().designs[id]);
        expect(new Set(originalSegments.map(productLayoutSegmentId)).size).toBe(3);

        const applied = store.reorderProductLayoutSegments(id, [
          productLayoutSegmentId(originalSegments[0]),
          productLayoutSegmentId(originalSegments[2]),
          productLayoutSegmentId(originalSegments[1]),
        ]);

        expect(applied).toBe(true);
        expect(
          useDesignStore.getState().designs[id].regions.map((region) => region.sourceSequenceName)
        ).toEqual(['A', 'C', 'B']);
      });

      it('does nothing if region count mismatch', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));

        const regions = useDesignStore.getState().designs[id].regions;
        store.reorderRegions(id, [regions[0].id]);

        const result = useDesignStore.getState().designs[id].regions;
        expect(result[0].sourceSequenceName).toBe('A');
        expect(result[1].sourceSequenceName).toBe('B');

        consoleSpy.mockRestore();
      });

      it('clears draft assembly when reordering', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              status: 'computed',
            },
          },
        }));

        const regions = useDesignStore.getState().designs[id].regions;
        store.reorderRegions(id, [regions[1].id, regions[0].id]);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.status).toBe('draft');
      });
    });
  });

  describe('Spacer Operations', () => {
    describe('addSpacer', () => {
      it('adds spacer at junction', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        store.addSpacer(id, 0, 'ATCG', 'Spacer 1');

        const design = useDesignStore.getState().designs[id];
        expect(design.spacers).toHaveLength(1);
        expect(design.spacers[0].junctionIndex).toBe(0);
        expect(design.spacers[0].sequence).toBe('ATCG');
        expect(design.spacers[0].name).toBe('Spacer 1');
      });

      it('sets and clears spacers through the shared junction command path', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        const added = store.setJunctionSpacer(id, 0, 'aa tc', 'Linker');
        expect(added).toBe(true);
        expect(useDesignStore.getState().designs[id].spacers).toEqual([
          expect.objectContaining({
            junctionIndex: 0,
            sequence: 'aatc',
            name: 'Linker',
          }),
        ]);

        const cleared = store.setJunctionSpacer(id, 0, '');
        expect(cleared).toBe(true);
        expect(useDesignStore.getState().designs[id].spacers).toEqual([]);
      });

      it('does not allow two spacers at the same junction through the store action', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        store.addSpacer(id, 0, 'ATCG', 'Spacer 1');
        store.addSpacer(id, 0, 'GGGG', 'Duplicate spacer');

        const design = useDesignStore.getState().designs[id];
        expect(design.spacers).toHaveLength(1);
        expect(design.spacers[0]).toMatchObject({
          junctionIndex: 0,
          sequence: 'ATCG',
          name: 'Spacer 1',
        });
      });

      it('redrafts assembly when adding spacer', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              status: 'computed',
            },
          },
        }));

        store.addSpacer(id, 0, 'ATCG');

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions.length).toBeGreaterThan(0);
        expect(design.status).toBe('computed');
      });
    });

    describe('updateSpacer', () => {
      it('updates spacer sequence', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        store.addSpacer(id, 0, 'ATCG');

        const spacerId = useDesignStore.getState().designs[id].spacers[0].id;
        store.updateSpacer(id, spacerId, { sequence: 'GCTA' });

        expect(useDesignStore.getState().designs[id].spacers[0].sequence).toBe('GCTA');
      });

      it('updates spacer name', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        store.addSpacer(id, 0, 'ATCG');

        const spacerId = useDesignStore.getState().designs[id].spacers[0].id;
        store.updateSpacer(id, spacerId, { name: 'New Name' });

        expect(useDesignStore.getState().designs[id].spacers[0].name).toBe('New Name');
      });
    });

    describe('removeSpacer', () => {
      it('removes spacer by ID', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        store.addSpacer(id, 0, 'ATCG');

        const spacerId = useDesignStore.getState().designs[id].spacers[0].id;
        store.removeSpacer(id, spacerId);

        expect(useDesignStore.getState().designs[id].spacers).toHaveLength(0);
      });

      it('redrafts assembly when removing spacer', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        store.addSpacer(id, 0, 'ATCG');

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: [{ id: 'hr-1' } as any],
              status: 'computed',
            },
          },
        }));

        const spacerId = useDesignStore.getState().designs[id].spacers[0].id;
        store.removeSpacer(id, spacerId);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions.length).toBeGreaterThan(0);
        expect(design.status).toBe('computed');
      });
    });

    describe('moveSpacerToProductBoundary', () => {
      it('moves an existing spacer to a legal part-to-part product boundary', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));
        store.setJunctionSpacer(id, 0, 'AAGC');

        const spacerId = useDesignStore.getState().designs[id].spacers[0].id;
        const targetBoundary = selectProductLayoutItems(useDesignStore.getState().designs[id])
          .filter((item) => item.kind === 'boundary')
          .find((item) => item.leftKind === 'part' && item.rightKind === 'part')?.id;
        expect(targetBoundary).toBeDefined();

        const moved = store.moveSpacerToProductBoundary(id, spacerId, targetBoundary!);

        expect(moved).toBe(true);
        expect(useDesignStore.getState().designs[id].spacers).toEqual([
          expect.objectContaining({
            id: spacerId,
            junctionIndex: 1,
            sequence: 'AAGC',
            anchor: {
              leftRegionId: useDesignStore.getState().designs[id].regions[1].id,
              rightRegionId: useDesignStore.getState().designs[id].regions[2].id,
            },
          }),
        ]);
      });

      it('rejects moves to boundaries adjacent to a spacer', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'A' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'B' }));
        store.addRegion(id, createMockRegion({ sourceSequenceName: 'C' }));
        store.setJunctionSpacer(id, 0, 'AAGC');

        const design = useDesignStore.getState().designs[id];
        const spacerId = design.spacers[0].id;
        const spacerAdjacentBoundary = selectProductLayoutItems(design)
          .filter((item) => item.kind === 'boundary')
          .find((item) => item.leftKind === 'part' && item.rightKind === 'spacer')?.id;
        expect(spacerAdjacentBoundary).toBeDefined();

        const moved = store.moveSpacerToProductBoundary(id, spacerId, spacerAdjacentBoundary!);

        expect(moved).toBe(false);
        expect(useDesignStore.getState().designs[id].spacers).toEqual([
          expect.objectContaining({
            junctionIndex: 0,
            sequence: 'AAGC',
          }),
        ]);
      });
    });
  });

  describe('Assembly Method', () => {
    describe('setAssemblyMethod', () => {
      it('switches from gibson to goldengate', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');

        store.setAssemblyMethod(id, 'goldengate');

        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('goldengate');
        expect(design.goldenGateConfig).toEqual({ enzyme: 'BsaI' });
        expect(design.goldenGateJunctions).toEqual([]);
      });

      it('switches from goldengate to gibson', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');

        store.setAssemblyMethod(id, 'gibson');

        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('gibson');
        expect(design.goldenGateConfig).toBeUndefined();
        expect(design.goldenGateJunctions).toBeUndefined();
      });

      it('clears primers when switching methods', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              designPrimers: [{ fragmentIndex: 0 } as any],
              status: 'computed',
            },
          },
        }));

        store.setAssemblyMethod(id, 'goldengate');

        const design = useDesignStore.getState().designs[id];
        expect(design.designPrimers).toEqual([]);
        expect(design.status).toBe('draft');
      });

      it('restores compatible drafts when switching back to an assembly method', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');
        store.addRegion(id, createAssemblyRegion('left', 'A'.repeat(80)));
        store.addRegion(id, createAssemblyRegion('right', 'C'.repeat(80)));
        const gibsonHomology = [
          {
            id: 'gibson-homology',
            junctionIndex: 0,
            junctionPosition: 80,
            start: 50,
            end: 110,
            encoding: { onLeft: 30, onRight: 30 },
            metadata: { sequence: 'A'.repeat(30) + 'C'.repeat(30) },
          },
        ];
        const gibsonPrimers = [{ fragmentIndex: 0, forward: {}, reverse: {} } as any];

        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions: gibsonHomology,
              designPrimers: gibsonPrimers,
              assemblyState: 'ready',
              status: 'computed',
            },
          },
        }));

        store.setAssemblyMethod(id, 'goldengate');
        const goldengateJunctions = [
          {
            junctionIndex: 0,
            junctionPosition: 80,
            offset: 1,
            overhangStart: 79,
            overhangEnd: 83,
            overhang: 'ACGT',
            source: { type: 'pcr-designed' as const },
            isValid: true,
          },
        ];
        const goldengatePrimers = [{ fragmentIndex: 1, forward: {}, reverse: {} } as any];
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              goldenGateJunctions: goldengateJunctions,
              designPrimers: goldengatePrimers,
              assemblyState: 'ready',
              status: 'computed',
            },
          },
        }));

        store.setAssemblyMethod(id, 'gibson');
        let design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('gibson');
        expect(design.homologyRegions).toEqual(gibsonHomology);
        expect(design.designPrimers).toEqual(gibsonPrimers);
        expect(design.assemblyState).toBe('ready');

        store.setAssemblyMethod(id, 'goldengate');
        design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('goldengate');
        expect(design.goldenGateJunctions).toEqual(goldengateJunctions);
        expect(design.designPrimers).toEqual(goldengatePrimers);
        expect(design.assemblyState).toBe('ready');
      });

      it('does not restore a method draft after the fragment composition changes', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');
        store.addRegion(id, createAssemblyRegion('left', 'A'.repeat(80)));
        store.addRegion(id, createAssemblyRegion('right', 'C'.repeat(80)));
        const homologyRegions = [
          {
            id: 'stale-homology',
            junctionIndex: 0,
            junctionPosition: 80,
            start: 50,
            end: 110,
            encoding: { onLeft: 30, onRight: 30 },
          },
        ];
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              homologyRegions,
              designPrimers: [{ fragmentIndex: 0, forward: {}, reverse: {} } as any],
              assemblyState: 'ready',
              status: 'computed',
            },
          },
        }));

        store.setAssemblyMethod(id, 'goldengate');
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              regions: state.designs[id].regions.map((region, index) =>
                index === 0 ? { ...region, sequence: `${region.sequence}G`, sourceEnd: 81 } : region
              ),
            },
          },
        }));

        store.setAssemblyMethod(id, 'gibson');
        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('gibson');
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
        expect(design.assemblyState).toBe('drafting');
      });

      it('allows specifying enzyme for goldengate', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');

        store.setAssemblyMethod(id, 'goldengate', 'BsmBI');

        expect(useDesignStore.getState().designs[id].goldenGateConfig?.enzyme).toBe('BsmBI');
      });

      it('infers a unique RD source enzyme when switching an existing Gibson draft to Golden Gate', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');
        store.addRegion(
          id,
          createAssemblyRegion('BsmBI RD', 'A'.repeat(80)) as Omit<DesignRegion, 'id'>
        );
        store.addRegion(id, createAssemblyRegion('PCR', 'C'.repeat(80)));
        const rdRegionId = useDesignStore.getState().designs[id].regions[0].id;
        store.updateRegion(id, rdRegionId, {
          sourceType: 'rd',
          ggType: 'insert',
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzyme: 'BsmBI',
          rdSourceEnzymeName: 'BsmBI',
        });

        store.setAssemblyMethod(id, 'goldengate');

        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyMethod).toBe('goldengate');
        expect(design.goldenGateConfig?.enzyme).toBe('BsmBI');
      });
    });
  });

  describe('Draft Assembly', () => {
    describe('draftAssembly', () => {
      it('requires at least 2 regions', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());

        await draftAssemblyAndWait(id);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
      });

      it('creates homology regions for gibson assembly', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');

        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));

        await draftAssemblyAndWait(id);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions.length).toBeGreaterThan(0);
        expect(design.designPrimers.length).toBeGreaterThan(0);
        expect(design.assemblyState).toBe('ready');
        expect(design.status).toBe('computed');
      });

      it('creates goldengate junctions for goldengate assembly', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');

        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));

        await draftAssemblyAndWait(id);

        const design = useDesignStore.getState().designs[id];
        expect(design.goldenGateJunctions?.length).toBeGreaterThan(0);
        expect(design.designPrimers.length).toBeGreaterThan(0);
        expect(design.assemblyState).toBe('ready');
        expect(design.status).toBe('computed');
      });
    });

    describe('clearDraftAssembly', () => {
      it('clears all draft assembly data', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');
        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));
        await draftAssemblyAndWait(id);

        expect(useDesignStore.getState().designs[id].homologyRegions.length).toBeGreaterThan(0);

        store.clearDraftAssembly(id);

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions).toEqual([]);
        expect(design.designPrimers).toEqual([]);
        expect(design.selectedJunctionIndex).toBeNull();
        expect(design.scrollToPosition).toBeNull();
        expect(design.assemblyState).toBe('drafting');
        expect(design.status).toBe('draft');
        expect(design.assemblyWorkbench?.autoDraftPrimers).toBe(false);
      });

      it('keeps an explicit primer clear durable across spacer edits until Draft is pressed', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));
        await draftAssemblyAndWait(id);
        await vi.waitFor(() =>
          expect(useDesignStore.getState().designs[id].designPrimers.length).toBeGreaterThan(0)
        );

        store.clearDraftAssembly(id);
        store.setJunctionSpacer(id, 0, 'aRnY');

        const cleared = useDesignStore.getState().designs[id];
        expect(cleared.spacers[0]?.sequence).toBe('aRnY');
        expect(cleared.designPrimers).toEqual([]);
        expect(cleared.goldenGateJunctions).toEqual([]);
        expect(cleared.assemblyWorkbench?.autoDraftPrimers).toBe(false);

        await draftAssemblyAndWait(id);

        await vi.waitFor(() => {
          const redrafted = useDesignStore.getState().designs[id];
          expect(redrafted.validationErrors).toEqual([]);
          expect(redrafted.assemblyState).toBe('ready');
          expect(redrafted.designPrimers.length).toBeGreaterThan(0);
          expect(redrafted.assemblyWorkbench?.autoDraftPrimers).toBe(true);
        });
      });

      it('clears goldengate junctions for goldengate designs', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));
        await draftAssemblyAndWait(id);

        store.clearDraftAssembly(id);

        expect(useDesignStore.getState().designs[id].goldenGateJunctions).toEqual([]);
      });

      it('clears stale workbench primer edit intents with the draft', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, createAssemblyRegion('Region 1', 'ATCG'.repeat(50)));
        store.addRegion(id, createAssemblyRegion('Region 2', 'GCTA'.repeat(50)));
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: {
              ...state.designs[id],
              assemblyWorkbench: {
                junctions: [],
                primers: [],
                primerEditIntents: [
                  {
                    id: 'stale-pbs',
                    regionId: state.designs[id].regions[0].id,
                    direction: 'reverse',
                    junctionIndex: 0,
                    field: 'pbsLength',
                    length: 33,
                    updatedAtVersion: 999,
                  },
                ],
              },
            },
          },
        }));

        store.clearDraftAssembly(id);

        expect(useDesignStore.getState().designs[id].assemblyWorkbench?.primerEditIntents).toEqual(
          []
        );
      });
    });

    describe('setSelectedJunction', () => {
      it('sets the selected junction index', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.setSelectedJunction(id, 2);

        expect(useDesignStore.getState().designs[id].selectedJunctionIndex).toBe(2);
      });

      it('can clear selection with null', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.setSelectedJunction(id, 2);

        store.setSelectedJunction(id, null);

        expect(useDesignStore.getState().designs[id].selectedJunctionIndex).toBeNull();
      });
    });
  });

  describe('Status and Results', () => {
    describe('setStatus', () => {
      it('sets design status', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.setStatus(id, 'computed');

        expect(useDesignStore.getState().designs[id].status).toBe('computed');
        expect(useDesignStore.getState().designs[id].assemblyState).toBe('ready');
      });

      it('updates timestamp when setting status', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        const originalUpdatedAt = useDesignStore.getState().designs[id].updatedAt;

        store.setStatus(id, 'computed');

        expect(useDesignStore.getState().designs[id].updatedAt.getTime()).toBeGreaterThanOrEqual(
          originalUpdatedAt.getTime()
        );
      });
    });

    describe('setAssemblyResult', () => {
      it('sets assembly result and updates status to computed', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        const mockResult = { sequence: 'ATCG' } as any;
        store.setAssemblyResult(id, mockResult);

        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyResult).toEqual(mockResult);
        expect(design.assemblyState).toBe('ready');
        expect(design.status).toBe('computed');
      });
    });

    describe('clearAssemblyResult', () => {
      it('clears assembly result and resets status to draft', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.setAssemblyResult(id, { sequence: 'ATCG' } as any);

        store.clearAssemblyResult(id);

        const design = useDesignStore.getState().designs[id];
        expect(design.assemblyResult).toBeUndefined();
        expect(design.assemblyState).toBe('drafting');
        expect(design.status).toBe('draft');
      });
    });
  });

  describe('Navigation', () => {
    describe('navigateToPosition', () => {
      it('sets scroll position', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.navigateToPosition(id, 150);

        expect(useDesignStore.getState().designs[id].scrollToPosition).toBe(150);
      });
    });

    describe('clearScrollPosition', () => {
      it('clears scroll position', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.navigateToPosition(id, 150);

        store.clearScrollPosition(id);

        expect(useDesignStore.getState().designs[id].scrollToPosition).toBeNull();
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles operations on non-existent designs gracefully', async () => {
      const store = useDesignStore.getState();

      store.addRegion('non-existent', createMockRegion());
      store.removeRegion('non-existent', 'region-id');
      store.addSpacer('non-existent', 0, 'ATCG');
      store.setStatus('non-existent', 'computed');
      await draftAssemblyAndWait('non-existent');

      expect(useDesignStore.getState().designs).toEqual({});
    });

    it('preserves other designs when modifying one', () => {
      const store = useDesignStore.getState();
      const id1 = store.createDesign('Design 1');
      const id2 = store.createDesign('Design 2');

      store.addRegion(id1, createMockRegion());

      expect(useDesignStore.getState().designs[id1].regions).toHaveLength(1);
      expect(useDesignStore.getState().designs[id2].regions).toHaveLength(0);
    });
  });

  describe('Persistence', () => {
    it('round-trips an explicit Golden Gate schema without a parallel persistence format', () => {
      const store = useDesignStore.getState();
      const id = store.createDesign('Persisted schema', 'circular', 'goldengate');
      const schema = twoSlotGoldenGateSchema();
      store.setGoldenGateSchema(id, schema, 0);

      const partialized = partializeDesigns(useDesignStore.getState().designs);
      expect(partialized[id].goldenGateSchema).toEqual(schema);
      expect(migratePersistedDesignState({ designs: partialized })).toMatchObject({
        designs: { [id]: { goldenGateSchema: schema } },
      });
    });

    it('migrates legacy status to assemblyState', () => {
      const now = new Date();
      const legacyDesign = {
        id: 'legacy',
        name: 'Legacy',
        topology: 'circular',
        regions: [],
        spacers: [],
        status: 'draft',
        assemblyMethod: 'gibson',
        defaultHomologyLength: 30,
        homologyRegions: [],
        designPrimers: [],
        selectedJunctionIndex: null,
        scrollToPosition: null,
        highlightRange: null,
        createdAt: now,
        updatedAt: now,
      } as any;

      const migrated = migratePersistedDesignState({
        designs: {
          draft: { ...legacyDesign, id: 'draft', status: 'draft' },
          computed: { ...legacyDesign, id: 'computed', status: 'computed' },
          assembled: { ...legacyDesign, id: 'assembled', status: 'assembled' },
        },
      }) as any;

      expect(migrated.designs.draft.assemblyState).toBe('drafting');
      expect(migrated.designs.computed.assemblyState).toBe('ready');
      expect(migrated.designs.assembled.assemblyState).toBe('assembled');
      expect(migrated.designs.draft.validationErrors).toEqual([]);
      expect(migrated.designs.draft.version).toBe(0);
    });

    it('normalizes persisted linear assembly designs to circular', () => {
      const now = new Date();
      const migrated = migratePersistedDesignState({
        designs: {
          legacyLinear: {
            id: 'legacyLinear',
            name: 'Legacy Linear',
            topology: 'linear',
            regions: [],
            spacers: [],
            status: 'draft',
            assemblyMethod: 'gibson',
            defaultHomologyLength: 30,
            homologyRegions: [],
            designPrimers: [],
            selectedJunctionIndex: null,
            scrollToPosition: null,
            highlightRange: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      }) as any;

      expect(migrated.designs.legacyLinear.topology).toBe('circular');
    });

    it('persists duplicate spacer DNA instead of silently deleting it', () => {
      const now = new Date();
      const design = {
        id: 'duplicate-spacers',
        name: 'Duplicate spacers',
        topology: 'circular',
        regions: [
          createMockRegion({ id: 'left', sequence: 'AAAA' }),
          createMockRegion({ id: 'right', sequence: 'CCCC' }),
        ],
        spacers: [
          { id: 'first', junctionIndex: 0, sequence: 'GG' },
          { id: 'second', junctionIndex: 0, sequence: 'TT' },
        ],
        status: 'draft',
        assemblyState: 'drafting',
        assemblyMethod: 'gibson',
        defaultHomologyLength: 30,
        homologyRegions: [],
        designPrimers: [],
        validationErrors: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      } as unknown as SequenceDesign;

      const partialized = partializeDesigns({ [design.id]: design });

      expect(partialized[design.id].spacers.map((spacer) => spacer.id)).toEqual([
        'first',
        'second',
      ]);
    });

    it('keeps assembly method draft snapshots in persisted designs', () => {
      const store = useDesignStore.getState();
      const id = store.createDesign('Drafted design', 'circular', 'gibson');
      store.addRegion(id, createAssemblyRegion('left', 'A'.repeat(80)));
      store.addRegion(id, createAssemblyRegion('right', 'C'.repeat(80)));
      const gibsonHomology = [
        {
          id: 'persisted-gibson-homology',
          junctionIndex: 0,
          junctionPosition: 80,
          start: 51,
          end: 109,
          encoding: { onLeft: 29, onRight: 29 },
        },
      ];
      const gibsonPrimers = [{ fragmentIndex: 0, forward: {}, reverse: {} } as any];
      useDesignStore.setState((state) => ({
        designs: {
          ...state.designs,
          [id]: {
            ...state.designs[id],
            homologyRegions: gibsonHomology,
            designPrimers: gibsonPrimers,
            assemblyState: 'ready',
            status: 'computed',
          },
        },
      }));

      store.setAssemblyMethod(id, 'goldengate');
      const partialized = partializeDesigns(useDesignStore.getState().designs) as any;

      expect(partialized[id].assemblyMethodDrafts?.gibson?.homologyRegions).toEqual(gibsonHomology);
      expect(partialized[id].assemblyMethodDrafts?.gibson?.designPrimers).toEqual(gibsonPrimers);
      expect(partialized[id].assemblyMethodDrafts?.gibson?.compositionKey).toEqual(
        expect.any(String)
      );
    });

    it('excludes proposedPlans from persisted designs', () => {
      const store = useDesignStore.getState();
      const id = store.createDesign('Design');
      useDesignStore.setState((state) => ({
        designs: {
          ...state.designs,
          [id]: {
            ...state.designs[id],
            proposedPlans: [{ id: 'future-plan' }] as never[],
          },
        },
      }));

      const partialized = partializeDesigns(useDesignStore.getState().designs) as any;

      expect(partialized[id].proposedPlans).toBeUndefined();
      expect(useDesignStore.getState().designs[id].proposedPlans).toHaveLength(1);
    });

    it('handles corrupted persisted state gracefully', () => {
      useDesignStore.setState({
        designs: {} as any,
        activeDesignId: 'non-existent',
      });

      const store = useDesignStore.getState();

      const id = store.getOrCreateDesign();
      expect(id).toBeTruthy();
      expect(useDesignStore.getState().designs[id]).toBeDefined();
    });
  });

  describe('Homology Region Operations', () => {
    describe('updateHomologyRegion', () => {
      it('does nothing for non-existent design', () => {
        const store = useDesignStore.getState();
        store.updateHomologyRegion('non-existent', 0, { start: 10 });
        expect(useDesignStore.getState().designs).toEqual({});
      });

      it('does nothing for design without homology regions', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');

        store.updateHomologyRegion(id, 0, { start: 10 });

        expect(useDesignStore.getState().designs[id]).toBeDefined();
        expect(useDesignStore.getState().designs[id].homologyRegions).toEqual([]);
      });

      it('updates homology region encoding', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const newEncoding = { onLeft: 15, onRight: 10 };
        store.updateHomologyRegion(id, 0, { encoding: newEncoding });

        const design = useDesignStore.getState().designs[id];
        expect(design.homologyRegions[0].encoding).toEqual(newEncoding);
      });

      it('recomputes primers when updating homology region', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        store.updateHomologyRegion(id, 0, { encoding: { onLeft: 20, onRight: 5 } });

        const design = useDesignStore.getState().designs[id];
        expect(design).toBeDefined();
        expect(design.homologyRegions.length).toBeGreaterThan(0);
      });

      it('updates timestamp when modifying homology region', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const originalUpdatedAt = useDesignStore.getState().designs[id].updatedAt;
        store.updateHomologyRegion(id, 0, { encoding: { onLeft: 10, onRight: 15 } });

        expect(useDesignStore.getState().designs[id].updatedAt.getTime()).toBeGreaterThanOrEqual(
          originalUpdatedAt.getTime()
        );
      });

      it('derives RD-adjacent Gibson ranges from template anchors instead of centered splitting', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign();

        store.updateHomologyRegion(id, 0, { start: 90, end: 100 });

        const homology = useDesignStore
          .getState()
          .designs[id].homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology?.encoding).toEqual({ onLeft: 10, onRight: 0 });
        expect(homology?.start).toBe(90);
        expect(homology?.end).toBe(100);
        expect(homology?.metadata?.sequence).toBe('A'.repeat(10));
      });

      it('derives PCR-to-RD Gibson ranges from right template anchors instead of centered splitting', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign('TTT', 'right');

        store.updateHomologyRegion(id, 0, { start: 103, end: 113 });

        const homology = useDesignStore
          .getState()
          .designs[id].homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology?.encoding).toEqual({ onLeft: 0, onRight: 10 });
        expect(homology?.start).toBe(103);
        expect(homology?.end).toBe(113);
        expect(homology?.metadata?.sequence).toBe('A'.repeat(10));
      });

      it('interprets RD-adjacent forward primer overhang edits as tail length without counting spacer cargo as homology', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign('TTA');

        store.updatePrimerOverhang(id, 1, 'forward', 12);

        const design = useDesignStore.getState().designs[id];
        const homology = design.homologyRegions.find((region) => region.junctionIndex === 0);
        const pcrPrimer = design.designPrimers.find((pair) => pair.fragmentIndex === 1)?.forward;

        expect(homology?.encoding).toEqual({ onLeft: 9, onRight: 0 });
        expect(homology?.start).toBe(91);
        expect(homology?.end).toBe(100);
        expect(homology?.metadata?.sequence).toBe('A'.repeat(9));
        expect(pcrPrimer?.overhang).toMatchObject({
          length: 9,
          tailLength: 12,
          spacerSequence: 'TTA',
          sequence: `${'A'.repeat(9)}TTA`,
        });
      });

      it('does not unlock the PCR side after an RD-to-PCR spacer-only tail edit', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign('TTA');

        store.updatePrimerOverhang(id, 1, 'forward', 2);
        store.updateHomologyRegion(id, 0, { start: 100, end: 100 });

        const homology = useDesignStore
          .getState()
          .designs[id].homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology?.encoding).toEqual({ onLeft: 0, onRight: 0 });
        expect(homology?.start).toBe(103);
        expect(homology?.end).toBe(100);
        expect(homology?.metadata?.sequence).toBe('');
      });

      it('interprets PCR-to-RD reverse primer overhang edits as tail length without counting spacer cargo as homology', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign('TTA', 'right');

        store.updatePrimerOverhang(id, 0, 'reverse', 12);

        const design = useDesignStore.getState().designs[id];
        const homology = design.homologyRegions.find((region) => region.junctionIndex === 0);
        const pcrPrimer = design.designPrimers.find((pair) => pair.fragmentIndex === 0)?.reverse;

        expect(homology?.encoding).toEqual({ onLeft: 0, onRight: 9 });
        expect(homology?.start).toBe(103);
        expect(homology?.end).toBe(112);
        expect(homology?.metadata?.sequence).toBe('A'.repeat(9));
        expect(pcrPrimer?.overhang).toMatchObject({
          length: 9,
          tailLength: 12,
          spacerSequence: 'TAA',
          sequence: `${'T'.repeat(9)}TAA`,
        });
      });

      it('does not unlock the PCR side after a PCR-to-RD spacer-only tail edit', async () => {
        const store = useDesignStore.getState();
        const id = await createRdSpacerPcrDesign('TTA', 'right');

        store.updatePrimerOverhang(id, 0, 'reverse', 2);
        store.updateHomologyRegion(id, 0, { start: 103, end: 103 });

        const homology = useDesignStore
          .getState()
          .designs[id].homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology?.encoding).toEqual({ onLeft: 0, onRight: 0 });
        expect(homology?.start).toBe(103);
        expect(homology?.end).toBe(100);
        expect(homology?.metadata?.sequence).toBe('');
      });

      it('hydrates persisted RD-adjacent Gibson homology without treating spacer cargo as overlap', async () => {
        const id = await createRdSpacerPcrDesign('TTA');
        const design = useDesignStore.getState().designs[id];
        const homology = design.homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology).toBeDefined();

        const hydrated = hydrateDesign({
          ...design,
          homologyRegions: [
            {
              ...homology!,
              templateBasis: undefined,
              start: 88,
              end: 103,
              metadata: {
                sequence: `${'A'.repeat(12)}TTA`,
                tmEstimate: 0,
                gcContent: 0,
              },
            },
          ],
        });
        const hydratedHomology = hydrated.homologyRegions[0];

        expect(hydratedHomology.templateBasis).toMatchObject({
          leftHomologyEnd: 100,
          rightHomologyStart: 103,
          spacerLength: 3,
          spacerContributesToAnnealing: false,
          leftSpacerIncludedInHomology: false,
          leftHomologyAllowed: true,
          rightHomologyAllowed: false,
        });
        expect(hydratedHomology.start).toBe(100 - homology!.encoding.onLeft);
        expect(hydratedHomology.end).toBe(100);
        expect(hydratedHomology.metadata?.sequence).toBe('A'.repeat(homology!.encoding.onLeft));
      });

      it('hydrates persisted PCR-to-RD Gibson homology with spacer excluded from overlap metadata', async () => {
        const id = await createRdSpacerPcrDesign('TTA', 'right');
        const design = useDesignStore.getState().designs[id];
        const homology = design.homologyRegions.find((region) => region.junctionIndex === 0);
        expect(homology).toBeDefined();

        const hydrated = hydrateDesign({
          ...design,
          homologyRegions: [
            {
              ...homology!,
              templateBasis: undefined,
              start: 100,
              end: 103 + homology!.encoding.onRight,
              metadata: {
                sequence: `TTA${'A'.repeat(homology!.encoding.onRight)}`,
                tmEstimate: 0,
                gcContent: 0,
              },
            },
          ],
        });
        const hydratedHomology = hydrated.homologyRegions[0];

        expect(hydratedHomology.templateBasis).toMatchObject({
          leftHomologyEnd: 100,
          rightHomologyStart: 103,
          spacerLength: 3,
          spacerContributesToAnnealing: false,
          leftSpacerIncludedInHomology: false,
          leftHomologyAllowed: false,
          rightHomologyAllowed: true,
        });
        expect(hydratedHomology.start).toBe(103);
        expect(hydratedHomology.end).toBe(103 + homology!.encoding.onRight);
        expect(hydratedHomology.metadata?.sequence).toBe('A'.repeat(homology!.encoding.onRight));
      });

      it('clears stale verified Tm provenance when hydration recomputes primer geometry', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Hydrated Tm', 'circular', 'gibson');
        store.addRegion(id, createAssemblyRegion('left', 'A'.repeat(80)));
        store.addRegion(id, createAssemblyRegion('right', 'C'.repeat(80)));
        await draftAssemblyAndWait(id);
        const design = useDesignStore.getState().designs[id];
        const verified = {
          model: { kind: 'neb' as const, prodcode: 'q5-0', polymerase: 'q5' as const },
          source: 'neb' as const,
          verified: true,
        };

        const hydrated = hydrateDesign({
          ...design,
          designPrimers: design.designPrimers.map((pair) => ({
            ...pair,
            forward: { ...pair.forward, tmProvenance: verified },
            reverse: { ...pair.reverse, tmProvenance: verified },
          })),
        });

        for (const pair of hydrated.designPrimers) {
          expect(pair.forward.tmProvenance).toBeUndefined();
          expect(pair.reverse.tmProvenance).toBeUndefined();
        }
      });
    });
  });

  describe('Golden Gate Operations', () => {
    it('migrates persisted RD/RD fusion sites from the left fragment to the actual product bases', async () => {
      const store = useDesignStore.getState();
      const id = store.createDesign('Persisted RD assembly', 'circular', 'goldengate');
      store.addRegion(id, {
        ...createAssemblyRegion('A', 'GGAGAAAATACT'),
        sourceType: 'rd',
        rdSourceEnzyme: 'BsaI',
        rdOverhangs: { upstream: 'GGAG', downstream: 'TACT' },
      });
      store.addRegion(id, {
        ...createAssemblyRegion('B', 'TACTCCCCGGAG'),
        sourceType: 'rd',
        rdSourceEnzyme: 'BsaI',
        rdOverhangs: { upstream: 'TACT', downstream: 'GGAG' },
      });
      await draftAssemblyAndWait(id);

      const current = useDesignStore.getState().designs[id];
      const hydrated = hydrateDesign({
        ...current,
        goldenGateJunctions: current.goldenGateJunctions.map((junction) => ({
          ...junction,
          offset: -2,
          overhangStart: junction.junctionPosition - 4,
          overhangEnd: junction.junctionPosition,
        })),
      });

      expect(hydrated.goldenGateJunctions.map((junction) => junction.offset)).toEqual([2, 2]);
      expect(hydrated.goldenGateJunctions.map((junction) => junction.overhangStart)).toEqual(
        hydrated.goldenGateJunctions.map((junction) => junction.junctionPosition)
      );
    });

    describe('updateGoldenGateOffset', () => {
      it('does nothing for non-existent design', () => {
        const store = useDesignStore.getState();
        store.updateGoldenGateOffset('non-existent', 0, 2);
        expect(useDesignStore.getState().designs).toEqual({});
      });

      it('does nothing for non-goldengate design', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'gibson');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());

        store.updateGoldenGateOffset(id, 0, 2);

        expect(useDesignStore.getState().designs[id].assemblyMethod).toBe('gibson');
      });

      it('updates junction offset for goldengate design', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const versionBefore = useDesignStore.getState().designs[id].version;
        store.updateGoldenGateOffset(id, 0, 3);

        const design = useDesignStore.getState().designs[id];
        expect(design.goldenGateJunctions).toBeDefined();
        expect(design.version).toBe(versionBefore + 1);
        if (design.goldenGateJunctions && design.goldenGateJunctions.length > 0) {
          expect(design.goldenGateJunctions[0].offset).toBe(3);
        }
      });

      it('recomputes goldengate primers after offset change', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design', 'circular', 'goldengate');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        store.updateGoldenGateOffset(id, 0, -2);

        const design = useDesignStore.getState().designs[id];
        expect(design).toBeDefined();
        expect(design.goldenGateJunctions).toBeDefined();
      });
    });
  });

  describe('Primer Modifications', () => {
    describe('updatePrimerPbs', () => {
      it('does nothing for non-existent design', () => {
        const store = useDesignStore.getState();
        store.updatePrimerPbs('non-existent', 0, 'forward', 25);
        expect(useDesignStore.getState().designs).toEqual({});
      });

      it('does nothing for design without primers', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());

        store.updatePrimerPbs(id, 0, 'forward', 25);

        const primers = useDesignStore.getState().designs[id].designPrimers;
        expect(!primers || primers.length === 0).toBe(true);
      });

      it('updates forward primer PBS length', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const primersBeforeCount = useDesignStore.getState().designs[id].designPrimers?.length ?? 0;
        if (primersBeforeCount > 0) {
          const versionBefore = useDesignStore.getState().designs[id].version;
          store.updatePrimerPbs(id, 0, 'forward', 30);

          const design = useDesignStore.getState().designs[id];
          expect(design.designPrimers).toBeDefined();
          expect(design.version).toBe(versionBefore + 1);
        }
      });

      it('updates reverse primer PBS length', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const primersBeforeCount = useDesignStore.getState().designs[id].designPrimers?.length ?? 0;
        if (primersBeforeCount > 0) {
          store.updatePrimerPbs(id, 0, 'reverse', 28);

          const design = useDesignStore.getState().designs[id];
          expect(design.designPrimers).toBeDefined();
        }
      });

      it('keeps the explicit app-wide Tm model when a primer PBS is edited', async () => {
        useSettingsStore.setState({
          tmModel: OWCZARZY_TM_MODEL,
          tmModelExplicit: true,
          primerConcNm: 125,
          tmConditions: {
            monovalentMm: 75,
            divalentMm: 2,
            dntpMm: 0.8,
          },
        });
        const store = useDesignStore.getState();
        const id = store.createDesign('Custom Tm model');
        store.addRegion(id, createMockRegion({ sequence: 'ACGT'.repeat(40) }));
        store.addRegion(id, createMockRegion({ sequence: 'TGCA'.repeat(40) }));
        await draftAssemblyAndWait(id);

        store.updatePrimerPbs(id, 0, 'forward', 30);

        const primer = useDesignStore.getState().designs[id].designPrimers[0].forward;
        expect(primer.tm).toBeCloseTo(createAppTmCalculator(null).estimate(primer.pbs.sequence), 6);
      });
    });

    describe('updatePrimerOverhang', () => {
      it('does nothing for non-existent design', () => {
        const store = useDesignStore.getState();
        store.updatePrimerOverhang('non-existent', 0, 'forward', 30);
        expect(useDesignStore.getState().designs).toEqual({});
      });

      it('does nothing for design without primers', () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());

        store.updatePrimerOverhang(id, 0, 'forward', 30);

        const primers = useDesignStore.getState().designs[id].designPrimers;
        expect(!primers || primers.length === 0).toBe(true);
      });

      it('updates forward primer overhang length', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const primersBeforeCount = useDesignStore.getState().designs[id].designPrimers?.length ?? 0;
        if (primersBeforeCount > 0) {
          store.updatePrimerOverhang(id, 0, 'forward', 35);

          const design = useDesignStore.getState().designs[id];
          expect(design.designPrimers).toBeDefined();
          expect(design.homologyRegions).toBeDefined();
        }
      });

      it('updates reverse primer overhang length', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const primersBeforeCount = useDesignStore.getState().designs[id].designPrimers?.length ?? 0;
        if (primersBeforeCount > 0) {
          store.updatePrimerOverhang(id, 0, 'reverse', 32);

          const design = useDesignStore.getState().designs[id];
          expect(design.designPrimers).toBeDefined();
        }
      });

      it('recomputes homology encoding when changing overhang', async () => {
        const store = useDesignStore.getState();
        const id = store.createDesign('Design');
        store.addRegion(id, createMockRegion());
        store.addRegion(id, createMockRegion());
        await draftAssemblyAndWait(id);

        const design = useDesignStore.getState().designs[id];
        if (
          design.designPrimers &&
          design.designPrimers.length > 0 &&
          design.homologyRegions.length > 0
        ) {
          store.updatePrimerOverhang(id, 0, 'forward', 40);

          const updatedDesign = useDesignStore.getState().designs[id];
          expect(updatedDesign.homologyRegions[0].encoding).toBeDefined();
        }
      });
    });
  });

  describe('store .revision (per-store-invariants)', () => {
    it('exposes a numeric revision field', () => {
      expect(typeof useDesignStore.getState().revision).toBe('number');
    });

    it('createDesign bumps revision', () => {
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().createDesign('A');
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('addRegion bumps revision', () => {
      const id = useDesignStore.getState().createDesign('A');
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().addRegion(id, createMockRegion());
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('updateDesign bumps revision', () => {
      const id = useDesignStore.getState().createDesign('A');
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().updateDesign(id, { name: 'renamed' });
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('updateDesign on unknown id is a no-op (no bump)', () => {
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().updateDesign('does-not-exist', { name: 'x' });
      expect(useDesignStore.getState().revision).toBe(before);
    });

    it('setActiveDesign bumps revision', () => {
      const id = useDesignStore.getState().createDesign('A');
      const idB = useDesignStore.getState().createDesign('B');
      useDesignStore.getState().setActiveDesign(id);
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().setActiveDesign(idB);
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('deleteDesign bumps revision', () => {
      const id = useDesignStore.getState().createDesign('A');
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().deleteDesign(id);
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('removeRegion bumps revision', () => {
      const id = useDesignStore.getState().createDesign('A');
      useDesignStore.getState().addRegion(id, createMockRegion());
      const regionId = useDesignStore.getState().designs[id].regions[0].id;
      const before = useDesignStore.getState().revision;
      useDesignStore.getState().removeRegion(id, regionId);
      expect(useDesignStore.getState().revision).toBe(before + 1);
    });

    it('per-design version bumps alongside store revision (independence)', () => {
      const id = useDesignStore.getState().createDesign('A');
      const beforeRevision = useDesignStore.getState().revision;
      const beforeDesignVersion = useDesignStore.getState().designs[id].version ?? 0;
      useDesignStore.getState().addRegion(id, createMockRegion());
      expect(useDesignStore.getState().revision).toBe(beforeRevision + 1);
      expect(useDesignStore.getState().designs[id].version).toBe(beforeDesignVersion + 1);
    });
  });
});
