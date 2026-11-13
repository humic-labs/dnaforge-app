import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getComposedSequence, type DesignRegion, type DesignSpacer } from './types';
import { assemblyDispatcher, useDesignStore } from './store';
import {
  designWithSelectedPendingSpacer,
  selectAssemblyBoundaries,
  selectProductLayout,
  selectProductLayoutItems,
} from './assembly-boundaries';

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

describe('getComposedSequence with spacers', () => {
  const makeRegion = (id: string, sequence: string): DesignRegion => ({
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: `Region ${id}`,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
  });

  it('returns empty string for empty regions and no spacers', () => {
    expect(getComposedSequence([], [])).toBe('');
  });

  it('returns region sequence when no spacers', () => {
    const regions = [makeRegion('1', 'ATCG')];
    expect(getComposedSequence(regions, [])).toBe('ATCG');
  });

  it('concatenates regions without spacers', () => {
    const regions = [makeRegion('1', 'ATCG'), makeRegion('2', 'GGCC')];
    expect(getComposedSequence(regions, [])).toBe('ATCGGGCC');
  });

  it('inserts spacer between regions at junction 0', () => {
    const regions = [makeRegion('1', 'ATCG'), makeRegion('2', 'GGCC')];
    const spacers: DesignSpacer[] = [{ id: 's1', junctionIndex: 0, sequence: 'AAA' }];
    expect(getComposedSequence(regions, spacers)).toBe('ATCGAAAGGCC');
  });

  it('inserts multiple spacers at different junctions', () => {
    const regions = [makeRegion('1', 'ATCG'), makeRegion('2', 'GGCC'), makeRegion('3', 'TTAA')];
    const spacers: DesignSpacer[] = [
      { id: 's1', junctionIndex: 0, sequence: 'AAA' },
      { id: 's2', junctionIndex: 1, sequence: 'CCC' },
    ];
    expect(getComposedSequence(regions, spacers)).toBe('ATCGAAAGGCCCCCTTAA');
  });

  it('handles spacer at last junction (before circular closure)', () => {
    const regions = [makeRegion('1', 'ATCG'), makeRegion('2', 'GGCC')];
    const spacers: DesignSpacer[] = [{ id: 's1', junctionIndex: 1, sequence: 'TTT' }];
    expect(getComposedSequence(regions, spacers)).toBe('ATCGGGCCTTT');
  });

  it('ignores spacers with out-of-range junction indices', () => {
    const regions = [makeRegion('1', 'ATCG')];
    const spacers: DesignSpacer[] = [{ id: 's1', junctionIndex: 5, sequence: 'AAA' }];
    expect(getComposedSequence(regions, spacers)).toBe('ATCG');
  });
});

describe('assembly boundary selectors', () => {
  const makeRegion = (id: string, sequence: string): DesignRegion => ({
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: `Region ${id}`,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
  });

  it('models spacers as boundary-owned product segments rather than parts', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'boundary-design',
      name: 'Boundary Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'GG' }],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const boundaries = selectAssemblyBoundaries(design);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      junctionIndex: 0,
      leftRegion: expect.objectContaining({ id: 'left' }),
      rightRegion: expect.objectContaining({ id: 'right' }),
      spacer: expect.objectContaining({ id: 'spacer-0', sequence: 'GG' }),
    });

    expect(selectProductLayout(design).map((segment) => segment.kind)).toEqual([
      'part',
      'spacer',
      'part',
    ]);
    expect(
      selectProductLayout(design).map((segment) =>
        segment.kind === 'part' ? segment.region.id : segment.spacer.id
      )
    ).toEqual(['left', 'spacer-0', 'right']);
  });

  it('projects spacers as first-class layout items with insertion boundaries on both sides', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'spacer-layout-design',
      name: 'Spacer Layout Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'GG' }],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const layout = selectProductLayoutItems(design);
    expect(layout.map((item) => item.kind)).toEqual([
      'part',
      'boundary',
      'spacer',
      'boundary',
      'part',
      'boundary',
    ]);

    const [upperBoundary, lowerBoundary] = layout.filter((item) => item.kind === 'boundary');
    expect(upperBoundary).toMatchObject({
      kind: 'boundary',
      leftKind: 'part',
      rightKind: 'spacer',
      canAddPart: true,
      canAddSpacer: false,
      partInsertIndex: 1,
      moveSpacerAfterInsertedPartJunctionIndex: 0,
    });
    expect(lowerBoundary).toMatchObject({
      kind: 'boundary',
      leftKind: 'spacer',
      rightKind: 'part',
      canAddPart: true,
      canAddSpacer: false,
      partInsertIndex: 1,
    });
  });

  it('allows adding a spacer only at part-to-part boundaries', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'part-boundary-design',
      name: 'Part Boundary Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const boundary = selectProductLayoutItems(design).find((item) => item.kind === 'boundary');
    expect(boundary).toMatchObject({
      kind: 'boundary',
      leftKind: 'part',
      rightKind: 'part',
      canAddPart: true,
      canAddSpacer: true,
      spacerJunctionIndex: 0,
      partInsertIndex: 1,
    });
  });

  it('keeps product boundary IDs stable enough for legacy regions without IDs', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const leftWithoutId = makeRegion('left', 'AAAA') as Partial<DesignRegion>;
    delete leftWithoutId.id;
    const design = {
      id: 'legacy-region-layout-design',
      name: 'Legacy Region Layout Design',
      topology: 'linear' as const,
      regions: [leftWithoutId as DesignRegion, makeRegion('right', 'CCCC')],
      spacers: [],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const boundary = selectProductLayoutItems(design).find((item) => item.kind === 'boundary');

    expect(boundary?.id).toBe(
      'product-boundary:legacy-region-layout-design:part:region-0:part:right'
    );
  });

  it('only position-qualifies duplicate region IDs in product layout identity', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'duplicate-region-layout-design',
      name: 'Duplicate Region Layout Design',
      topology: 'linear' as const,
      regions: [
        makeRegion('same-region-id', 'AAAA'),
        makeRegion('same-region-id', 'CCCC'),
        makeRegion('unique-region-id', 'GGGG'),
      ],
      spacers: [],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const layout = selectProductLayout(design);
    expect(layout.map((item) => item.layoutId)).toEqual([
      'same-region-id:0',
      'same-region-id:1',
      'unique-region-id',
    ]);
    expect(new Set(layout.map((item) => item.layoutId)).size).toBe(3);
  });

  it('gives legacy spacer records without IDs a stable layout ID', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const spacerWithoutId = { junctionIndex: 0, sequence: 'GG' } as DesignSpacer;
    const design = {
      id: 'legacy-spacer-layout-design',
      name: 'Legacy Spacer Layout Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [spacerWithoutId],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const spacer = selectProductLayout(design).find((item) => item.kind === 'spacer');

    expect(spacer?.spacer.id).toBe('spacer:legacy-spacer-layout-design:junction:0');
  });

  it('projects the selected empty spacer through the shared product layout without persisting it', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'pending-spacer-layout-design',
      name: 'Pending Spacer Layout Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: 0,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const projected = designWithSelectedPendingSpacer(design);

    expect(design.spacers).toEqual([]);
    expect(projected.spacers).toMatchObject([{ junctionIndex: 0, sequence: '' }]);
    expect(selectProductLayoutItems(projected).map((item) => item.kind)).toEqual([
      'part',
      'boundary',
      'spacer',
      'boundary',
      'part',
      'boundary',
    ]);
  });

  it('reports duplicate persisted spacers on a boundary without letting consumers diverge', () => {
    const now = new Date('2026-05-11T00:00:00.000Z');
    const design = {
      id: 'duplicate-spacer-design',
      name: 'Duplicate Spacer Design',
      topology: 'linear' as const,
      regions: [makeRegion('left', 'AAAA'), makeRegion('right', 'CCCC')],
      spacers: [
        { id: 'first', junctionIndex: 0, sequence: 'GG' },
        { id: 'second', junctionIndex: 0, sequence: 'TT' },
      ],
      version: 1,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      proposedPlans: [],
      status: 'draft' as const,
      assemblyMethod: 'gibson' as const,
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: now,
      updatedAt: now,
    };

    const boundary = selectAssemblyBoundaries(design)[0];
    expect(boundary.spacer?.id).toBe('first');
    expect(boundary.duplicateSpacers.map((spacer) => spacer.id)).toEqual(['second']);
  });
});

describe('spacer store actions', () => {
  let designId: string;

  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null });

    designId = useDesignStore.getState().createDesign('Test Design', 'circular');
    const store = useDesignStore.getState();
    store.addRegion(designId, {
      sourceSequenceId: 'src1',
      sourceSequenceName: 'Region 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCGATCG',
      annotations: [],
    });
    store.addRegion(designId, {
      sourceSequenceId: 'src2',
      sourceSequenceName: 'Region 2',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'GGCCGGCCGGCC',
      annotations: [],
    });
  });

  describe('addSpacer', () => {
    it('adds a spacer at the specified junction', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAATTT');

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers).toHaveLength(1);
      expect(design.spacers[0].junctionIndex).toBe(0);
      expect(design.spacers[0].sequence).toBe('AAATTT');
    });

    it('adds spacer with optional name', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAATTT', 'Linker 1');

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers[0].name).toBe('Linker 1');
    });

    it('treats spacer junction index as unique', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA', 'First');
      store.addSpacer(designId, 0, 'TTT', 'Second');

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers).toHaveLength(1);
      expect(design.spacers[0]).toMatchObject({
        junctionIndex: 0,
        sequence: 'AAA',
        name: 'First',
      });
    });

    it('generates unique ID for spacer', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA');
      store.addSpacer(designId, 1, 'TTT');

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers[0].id).toBeDefined();
      expect(design.spacers[1].id).toBeDefined();
      expect(design.spacers[0].id).not.toBe(design.spacers[1].id);
    });

    it('redrafts assembly when adding spacer', async () => {
      const store = useDesignStore.getState();
      await draftAssemblyAndWait(designId);
      expect(useDesignStore.getState().designs[designId].status).toBe('computed');

      store.addSpacer(designId, 0, 'AAA');
      expect(useDesignStore.getState().designs[designId].status).toBe('computed');
    });
  });

  describe('updateSpacer', () => {
    it('updates spacer sequence', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA');
      const spacerId = useDesignStore.getState().designs[designId].spacers[0].id;

      store.updateSpacer(designId, spacerId, { sequence: 'TTTCCC' });

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers[0].sequence).toBe('TTTCCC');
    });

    it('updates spacer name', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA', 'Old Name');
      const spacerId = useDesignStore.getState().designs[designId].spacers[0].id;

      store.updateSpacer(designId, spacerId, { name: 'New Name' });

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers[0].name).toBe('New Name');
    });

    it('redrafts assembly when updating spacer', async () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA');
      const spacerId = useDesignStore.getState().designs[designId].spacers[0].id;
      await draftAssemblyAndWait(designId);

      store.updateSpacer(designId, spacerId, { sequence: 'TTT' });

      expect(useDesignStore.getState().designs[designId].status).toBe('computed');
    });
  });

  describe('removeSpacer', () => {
    it('removes spacer by ID', () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA');
      store.addSpacer(designId, 1, 'TTT');
      const spacerId = useDesignStore.getState().designs[designId].spacers[0].id;

      store.removeSpacer(designId, spacerId);

      const design = useDesignStore.getState().designs[designId];
      expect(design.spacers).toHaveLength(1);
      expect(design.spacers[0].sequence).toBe('TTT');
    });

    it('redrafts assembly when removing spacer', async () => {
      const store = useDesignStore.getState();
      store.addSpacer(designId, 0, 'AAA');
      const spacerId = useDesignStore.getState().designs[designId].spacers[0].id;
      await draftAssemblyAndWait(designId);

      store.removeSpacer(designId, spacerId);

      expect(useDesignStore.getState().designs[designId].status).toBe('computed');
    });
  });
});
