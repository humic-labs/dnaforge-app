import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { reorderDesignRegionsOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { getComposedSequence } from '../../design/types';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { reorderDesignRegionsTool } from './reorder-design-regions';

   
                                                                              
                                                                            
                                                                               
                                               
   

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `s-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function resetStore(): void {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

const designOf = (id: string): SequenceDesign => useDesignStore.getState().designs[id];
const labelsOf = (id: string): string[] =>
  designOf(id).regions.map((entry) => entry.sourceSequenceName);
const productOf = (id: string): string =>
  getComposedSequence(designOf(id).regions, designOf(id).spacers);
const idsOf = (id: string): string[] => designOf(id).regions.map((entry) => entry.id);

function designWithParts(names: readonly string[]): string {
  const store = useDesignStore.getState();
  const id = store.createDesign('D', 'circular', 'gibson');
  for (const name of names) {
    store.addRegion(id, region(name, name.repeat(4)));
  }
  return id;
}

type Result = {
  status: string;
  code?: string;
  error?: string;
  remedy?: string;
  retriable?: boolean;
  currentVersion?: number;
  currentOrder?: string[];
  missingIds?: string[];
  unknownIds?: string[];
  duplicateIds?: string[];
  expectedLength?: number;
  receivedLength?: number;
  orderBefore?: string[];
  order?: string[];
  labelsBefore?: string[];
  labels?: string[];
  slotsBefore?: unknown[];
  slots?: unknown[];
  gapsBefore?: unknown[];
  gaps?: unknown[];
  composedLengthBefore?: number;
  composedLength?: number;
  movedSpacers?: Array<{
    spacerId: string;
    sequence: string;
    wasBetween: string;
    nowBetween: string;
    wasJunctionIndex: number;
    nowJunctionIndex: number;
  }>;
  droppedSpacers?: Array<{
    spacerId: string;
    sequence: string;
    wasBetweenLabels: string;
    wasJunctionIndex: number;
  }>;
  discardedDraft?: {
    homologyRegions: number;
    designPrimers: number;
    goldenGateJunctions: number;
  };
  revalidationRequired?: boolean;
  versionGuardApplied?: boolean;
  previousVersion?: number;
  designVersion?: number;
  mutation?: {
    operationId: string;
    toolName: string;
    effect: string;
    beforeVersion: number;
    afterVersion: number;
    changed: boolean;
  };
};

describe('reorder_design_regions — complete-order, spacer-safe assembly editing', () => {
  beforeEach(() => {
    resetStore();
  });

  it('applies one unambiguous complete ordering and changes the composed product', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    const [a, b, c] = idsOf(id);
    expect(productOf(id)).toBe('AAAABBBBCCCC');

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [c, a, b],
        expectedDesignVersion: designOf(id).version,
      }
    );

    expect(result.status).toBe('applied');
    expect(labelsOf(id)).toEqual(['C', 'A', 'B']);
    expect(productOf(id)).toBe('CCCCAAAABBBB');
    expect(result.orderBefore).toEqual([a, b, c]);
    expect(result.order).toEqual([c, a, b]);
    expect(result.labelsBefore).toEqual(['A', 'B', 'C']);
    expect(result.labels).toEqual(['C', 'A', 'B']);
    expect(result.slotsBefore).toHaveLength(3);
    expect(result.slots).toHaveLength(3);
    expect(result.gapsBefore).toHaveLength(3);
    expect(result.gaps).toHaveLength(3);
    expect(result.composedLengthBefore).toBe(12);
    expect(result.composedLength).toBe(12);
    expect(result.revalidationRequired).toBe(true);
    expect(result.versionGuardApplied).toBe(true);
  });

  it('moves a spacer with the same two parts and reports its new junction', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    useDesignStore.getState().setJunctionSpacer(id, 0, 'TTT');         
    const [a, b, c] = idsOf(id);
    expect(productOf(id)).toBe('AAAATTTBBBBCCCC');

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [c, a, b],
      }
    );

    expect(result.status).toBe('applied');
    expect(productOf(id)).toBe('CCCCAAAATTTBBBB');
    expect(result.droppedSpacers).toEqual([]);
    expect(result.movedSpacers).toHaveLength(1);
    expect(result.movedSpacers?.[0].sequence).toBe('TTT');
    expect(result.movedSpacers?.[0].wasJunctionIndex).toBe(0);
    expect(result.movedSpacers?.[0].nowJunctionIndex).toBe(1);
    expect(result.movedSpacers?.[0].wasBetween).toBe(result.movedSpacers?.[0].nowBetween);
  });

  it('reports spacer DNA as dropped when the anchored parts stop being adjacent', async () => {
    const id = designWithParts(['A', 'B', 'C', 'D']);
    useDesignStore.getState().setJunctionSpacer(id, 0, 'TTT');         
    const [a, b, c, d] = idsOf(id);
    expect(productOf(id)).toBe('AAAATTTBBBBCCCCDDDD');

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [a, c, b, d],
      }
    );

    expect(result.status).toBe('applied');
    expect(labelsOf(id)).toEqual(['A', 'C', 'B', 'D']);
    expect(productOf(id)).toBe('AAAACCCCBBBBDDDD');
    expect(designOf(id).spacers).toEqual([]);
    expect(result.movedSpacers).toEqual([]);
    expect(result.droppedSpacers).toHaveLength(1);
    expect(result.droppedSpacers?.[0].sequence).toBe('TTT');
    expect(result.droppedSpacers?.[0].wasBetweenLabels).toBe('A→B');
  });

  it('names every defect in an invalid permutation and leaves the design untouched', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    const [a, b, c] = idsOf(id);
    const version = designOf(id).version;

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [a, a, 'not-a-region'],
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('ORDER_NOT_A_PERMUTATION');
    expect(result.missingIds).toEqual([b, c]);
    expect(result.unknownIds).toEqual(['not-a-region']);
    expect(result.duplicateIds).toEqual([a]);
    expect(result.expectedLength).toBe(3);
    expect(result.receivedLength).toBe(3);
    expect(result.remedy).toMatch(/get_design/);
    expect(labelsOf(id)).toEqual(['A', 'B', 'C']);
    expect(designOf(id).version).toBe(version);
  });

  it('rejects an unchanged order without destroying drafted assembly state', async () => {
    const id = designWithParts(['A', 'B']);
    const version = designOf(id).version;
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [id]: {
          ...state.designs[id],
          designPrimers: [{}] as unknown as SequenceDesign['designPrimers'],
        },
      },
    }));

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: idsOf(id),
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('ORDER_UNCHANGED');
    expect(result.remedy).toMatch(/nothing to do/i);
    expect(designOf(id).version).toBe(version);
    expect(designOf(id).designPrimers).toHaveLength(1);
  });

  it('rejects designs with fewer than two parts instead of bumping their version', async () => {
    const id = designWithParts(['A']);
    const version = designOf(id).version;

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: idsOf(id),
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('NOTHING_TO_REORDER');
    expect(result.remedy).toMatch(/add parts/i);
    expect(designOf(id).version).toBe(version);
    expect(labelsOf(id)).toEqual(['A']);
  });

  it('refuses a stale caller version and returns the current ordering for recovery', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    const currentOrder = idsOf(id);

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [...currentOrder].reverse(),
        expectedDesignVersion: designOf(id).version + 1,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.currentVersion).toBe(designOf(id).version);
    expect(result.currentOrder).toEqual(currentOrder);
    expect(result.versionGuardApplied).toBe(true);
    expect(labelsOf(id)).toEqual(['A', 'B', 'C']);
  });

  it('a second write using the same version is a structured stale refusal', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    const [a, b, c] = idsOf(id);
    const expectedDesignVersion = designOf(id).version;

    const first = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [c, a, b],
        expectedDesignVersion,
      }
    );
    const second = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [b, c, a],
        expectedDesignVersion,
      }
    );

    expect(first.status).toBe('applied');
    expect(second.status).toBe('rejected');
    expect(second.code).toBe('stale-design-version');
    expect(second.retriable).toBe(true);
    expect(labelsOf(id)).toEqual(['C', 'A', 'B']);
  });

  it('reports the drafted assembly artifacts invalidated by a reorder', async () => {
    const id = designWithParts(['A', 'B', 'C']);
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [id]: {
          ...state.designs[id],
          designPrimers: [{}, {}] as unknown as SequenceDesign['designPrimers'],
          homologyRegions: [{}] as unknown as SequenceDesign['homologyRegions'],
          goldenGateJunctions: [{}, {}, {}] as unknown as SequenceDesign['goldenGateJunctions'],
        },
      },
    }));

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [...idsOf(id)].reverse(),
      }
    );

    expect(result.status).toBe('applied');
    expect(result.discardedDraft).toEqual({
      homologyRegions: 1,
      designPrimers: 2,
      goldenGateJunctions: 3,
    });
    expect(designOf(id).designPrimers).toEqual([]);
    expect(designOf(id).homologyRegions).toEqual([]);
  });

  it('returns the mutation claim used by the audit bridge', async () => {
    const id = designWithParts(['A', 'B']);
    const version = designOf(id).version;

    const result = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: id,
        order: [...idsOf(id)].reverse(),
      },
      {
        toolCallId: 'call-reorder-1',
        messages: [],
        abortSignal: undefined as never,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.mutation).toMatchObject({
      operationId: 'call-reorder-1',
      toolName: 'reorder_design_regions',
      effect: 'reordered_design_regions',
      beforeVersion: version,
      afterVersion: designOf(id).version,
      changed: true,
    });
  });

  it('accepts waypoint://design/{id} and rejects an unknown design without throwing', async () => {
    const id = designWithParts(['A', 'B']);
    const applied = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: `waypoint://design/${encodeURIComponent(id)}`,
        order: [...idsOf(id)].reverse(),
      }
    );
    const rejected = await execDesignContract<Result>(
      reorderDesignRegionsOutputSchema,
      reorderDesignRegionsTool,
      {
        designId: 'missing-design',
        order: ['a', 'b'],
      }
    );

    expect(applied.status).toBe('applied');
    expect(labelsOf(id)).toEqual(['B', 'A']);
    expect(rejected.status).toBe('rejected');
    expect(rejected.code).toBe('design-not-found');
    expect(rejected.remedy).toBeTruthy();
  });
});
