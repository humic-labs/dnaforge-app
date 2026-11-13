import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { removeDesignRegionOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { projectAssemblySlots } from '../../design/slot-projection';
import { getComposedSequence } from '../../design/types';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { MAX_INLINE_REMOVED_REGION_BP, removeDesignRegionTool } from './remove-design-region';

   
                                                                               
                                                                              
                                             
   

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

function resetStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

const designOf = (id: string) => useDesignStore.getState().designs[id];
const labelsOf = (id: string) => designOf(id).regions.map((r) => r.sourceSequenceName);
const productOf = (id: string) => getComposedSequence(designOf(id).regions, designOf(id).spacers);

                           
function threePartDesign(): string {
  const store = useDesignStore.getState();
  const id = store.createDesign('D', 'circular', 'gibson');
  store.addRegion(id, region('A', 'AAAA'));
  store.addRegion(id, region('B', 'CCCC'));
  store.addRegion(id, region('C', 'GGGG'));
  return id;
}

type Result = {
  status: string;
  code?: string;
  error?: string;
  remedy?: string;
  retriable?: boolean;
  knownRegionIds?: string[];
  actualSlotFingerprint?: string;
  slots?: Array<{ regionId: string; isEmpty: boolean }>;
  slotsBefore?: unknown[];
  gaps?: unknown[];
  gapsBefore?: unknown[];
  slotCount?: number;
  slotCountBefore?: number;
  composedLength?: number;
  composedLengthBefore?: number;
  removed?: {
    regionId: string;
    label: string;
    sequence?: string;
    sequenceIncluded: boolean;
    sequencePreview?: string;
    slotIndex: number;
  };
  movedSpacers?: Array<{
    spacerId: string;
    sequence: string;
    wasJunctionIndex: number;
    nowJunctionIndex: number;
    wasBetween: string;
    nowBetween: string;
  }>;
  droppedSpacers?: Array<{
    spacerId: string;
    sequence: string;
    wasBetweenLabels: string;
    wasJunctionIndex: number;
  }>;
  discardedDraft?: { homologyRegions: number; designPrimers: number; goldenGateJunctions: number };
  revalidationRequired?: boolean;
  versionGuardApplied?: boolean;
  designVersion?: number;
  previousVersion?: number;
};

function removeArgs(designId: string, slotIndex: number) {
  const slot = projectAssemblySlots(designOf(designId))[slotIndex];
  return {
    designId,
    regionId: slot.regionId,
    expectedSlotFingerprint: slot.occupantFingerprint,
  };
}

describe('remove_design_region — closes the undo ratchet without letting a blind call delete', () => {
  beforeEach(() => {
    resetStore();
  });

  it('refuses to delete a slot whose contents changed since the agent read it', async () => {
    const id = threePartDesign();
    const stale = projectAssemblySlots(designOf(id))[0];

                                                                            
                                                                             
                                                                            
    useDesignStore.getState().updateRegion(id, stale.regionId, region('SOMETHING-ELSE', 'TTTT'));

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      {
        designId: id,
        regionId: stale.regionId,
        expectedSlotFingerprint: stale.occupantFingerprint,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('SLOT_CHANGED');
    expect(result.actualSlotFingerprint).toBeDefined();
    expect(result.remedy).toMatch(/re-read/i);
                                                                
    expect(labelsOf(id)).toEqual(['SOMETHING-ELSE', 'B', 'C']);
  });

  it('removes the part, closes the gap, and shortens the construct', async () => {
    const id = threePartDesign();
    expect(productOf(id)).toBe('AAAACCCCGGGG');

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      removeArgs(id, 1)
    );

    expect(result.status).toBe('applied');
    expect(labelsOf(id)).toEqual(['A', 'C']);
    expect(productOf(id)).toBe('AAAAGGGG');
    expect(result.removed?.label).toBe('B');
                                                                         
                                  
    expect(result.removed?.sequence).toBe('CCCC');
    expect(result.removed?.sequenceIncluded).toBe(true);
    expect(result.slotCountBefore).toBe(3);
    expect(result.slotCount).toBe(2);
    expect(result.composedLengthBefore).toBe(12);
    expect(result.composedLength).toBe(8);
    expect(result.slotsBefore).toHaveLength(3);
    expect(result.slots).toHaveLength(2);
    expect(result.gapsBefore).toHaveLength(3);
    expect(result.gaps).toHaveLength(2);
                                                           
    expect(result.revalidationRequired).toBe(true);
  });

  it('does not commit a mutation whose response embeds an unbounded removed sequence', async () => {
    const store = useDesignStore.getState();
    const id = store.createDesign('large', 'circular', 'gibson');
    store.addRegion(id, region('large-part', 'A'.repeat(MAX_INLINE_REMOVED_REGION_BP + 1)));
    store.addRegion(id, region('small-part', 'CCCC'));

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      removeArgs(id, 0)
    );

    expect(result.status).toBe('applied');
    expect(result.removed?.sequenceIncluded).toBe(false);
    expect(result.removed).not.toHaveProperty('sequence');
    expect(result.removed?.sequencePreview).toHaveLength(1_000);
    expect(labelsOf(id)).toEqual(['small-part']);
  });

  it('reports a DROPPED spacer with its sequence when its parts stop being neighbours', async () => {
    const id = threePartDesign();
    useDesignStore.getState().setJunctionSpacer(id, 0, 'TTT');                   
    expect(productOf(id)).toBe('AAAATTTCCCCGGGG');

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      removeArgs(id, 0)
    );            

    expect(result.status).toBe('applied');
                                                                            
                                                                        
    expect(designOf(id).spacers).toHaveLength(0);
    expect(productOf(id)).toBe('CCCCGGGG');
    expect(result.droppedSpacers).toHaveLength(1);
    expect(result.droppedSpacers?.[0].sequence).toBe('TTT');
    expect(result.droppedSpacers?.[0].wasBetweenLabels).toBe('A→B');
    expect(result.movedSpacers).toEqual([]);
  });

  it('reports a spacer that MOVED with its parts, and keeps it in the product', async () => {
    const id = threePartDesign();
    useDesignStore.getState().setJunctionSpacer(id, 1, 'TTT');                   
    expect(productOf(id)).toBe('AAAACCCCTTTGGGG');

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      removeArgs(id, 0)
    );            

    expect(result.status).toBe('applied');
                                                                            
                                                                           
                
    expect(productOf(id)).toBe('CCCCTTTGGGG');
    expect(result.droppedSpacers).toEqual([]);
    expect(result.movedSpacers).toHaveLength(1);
    expect(result.movedSpacers?.[0].wasJunctionIndex).toBe(1);
    expect(result.movedSpacers?.[0].nowJunctionIndex).toBe(0);
    expect(result.movedSpacers?.[0].wasBetween).toBe(result.movedSpacers?.[0].nowBetween);
  });

  it('names the region ids that DO exist when the target does not', async () => {
    const id = threePartDesign();
    const realIds = designOf(id).regions.map((r) => r.id);

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      {
        designId: id,
        regionId: 'not-a-region',
        expectedSlotFingerprint: 'whatever',
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('slot-not-found');
    expect(result.knownRegionIds).toEqual(realIds);
    expect(result.remedy).toMatch(/get_design/);
    expect(labelsOf(id)).toEqual(['A', 'B', 'C']);
  });

  it('refuses a stale design version and says it is retriable', async () => {
    const id = threePartDesign();
    const args = removeArgs(id, 1);

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      {
        ...args,
        expectedDesignVersion: designOf(id).version + 5,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.versionGuardApplied).toBe(true);
    expect(labelsOf(id)).toEqual(['A', 'B', 'C']);
  });

  it('a repeated removal is refused instead of deleting whatever moved into the position', async () => {
    const id = threePartDesign();
    const args = removeArgs(id, 1);     

    const first = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      args
    );
    expect(first.status).toBe('applied');

                                                                              
                                
    const second = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      args
    );
    expect(second.status).toBe('rejected');
    expect(second.code).toBe('slot-not-found');
    expect(labelsOf(id)).toEqual(['A', 'C']);
  });

  it('reports the drafted primers and homology arms the removal discarded', async () => {
    const id = threePartDesign();
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [id]: {
          ...state.designs[id],
          designPrimers: [{}, {}] as unknown as SequenceDesign['designPrimers'],
          homologyRegions: [{}] as unknown as SequenceDesign['homologyRegions'],
        },
      },
    }));

    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      removeArgs(id, 2)
    );

    expect(result.status).toBe('applied');
                                                                                 
                                                                  
    expect(result.discardedDraft).toEqual({
      homologyRegions: 1,
      designPrimers: 2,
      goldenGateJunctions: 0,
    });
    expect(designOf(id).designPrimers).toEqual([]);
    expect(designOf(id).homologyRegions).toEqual([]);
  });

  it('returns a structured rejection — never a throw — for an unknown design', async () => {
    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      {
        designId: 'no-such-design',
        regionId: 'r1',
        expectedSlotFingerprint: 'x',
      }
    );
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('design-not-found');
    expect(result.remedy).toBeTruthy();
  });

  it('accepts a waypoint://design/{id} URI as the design id', async () => {
    const id = threePartDesign();
    const args = removeArgs(id, 0);
    const result = await execDesignContract<Result>(
      removeDesignRegionOutputSchema,
      removeDesignRegionTool,
      {
        ...args,
        designId: `waypoint://design/${encodeURIComponent(id)}`,
      }
    );
    expect(result.status).toBe('applied');
    expect(labelsOf(id)).toEqual(['B', 'C']);
  });
});
