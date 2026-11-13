import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  draftDesignAssemblyOutputSchema,
  setPrimerOverhangLengthOutputSchema,
} from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { draftDesignAssemblyTool } from './draft-design-assembly';
import { setPrimerOverhangLengthTool } from './set-primer-overhang-length';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

                                                                      
function undraftedDesign(method: 'gibson' | 'goldengate' = 'gibson'): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Overhang target', 'circular', method);
  store.addRegion(designId, region('left', 'ATCG'.repeat(50)));
  store.addRegion(designId, region('right', 'GCTA'.repeat(50)));
  return designId;
}

                                                                                 
async function draftedDesign(): Promise<string> {
  const designId = undraftedDesign('gibson');
  await execDesignContract(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });
  return designId;
}

function storedDesign(designId: string): SequenceDesign {
  return useDesignStore.getState().designs[designId];
}

type PrimerProjection = {
  id: string;
  direction: 'forward' | 'reverse';
  fragmentIndex: number;
  junctionIndex: number | null;
  overhangLength: number;
  annealingLength: number;
  overhangSequence: string;
  pbsLength: number;
  pbsSequence: string;
  sequence: string;
  tm: number | null;
};

type OverhangResult = {
  status: string;
  designId: string;
  designVersion?: number;
  previousVersion?: number;
  previousOverhangLength?: number;
  requestedLength?: number;
  junctionIndex?: number;
  versionGuardApplied: boolean;
  revalidationRequired: boolean;
  primer: PrimerProjection | null;
  partnerPrimer: PrimerProjection | null;
  homology?: { onLeft: number; onRight: number; tmEstimate: number | null } | null;
  previousHomology?: { onLeft: number; onRight: number } | null;
  warnings?: Array<{ code: string; message: string }>;
  error?: string;
  code?: string;
  currentVersion?: number | null;
  retriable?: boolean;
  validRange?: [number, number];
  validFragmentRange?: [number, number];
  validDirections?: string[];
  fragmentCount?: number;
  currentOverhangLength?: number;
  currentPbsLength?: number;
  knownPrimers?: Array<{
    primerId: string;
    fragmentIndex: number;
    direction: string;
    junctionIndex: number | null;
  }>;
  supportedAssemblyMethods?: string[];
  currentAssemblyMethod?: string;
  regionCount?: number;
  mutation?: { effect: string; beforeVersion: number; afterVersion: number };
};

                                                                
const DOWNSTREAM_FORWARD = { fragmentIndex: 1, direction: 'forward' as const };

describe('set_primer_overhang_length', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('resizes the tail of the primer that will actually be ordered', async () => {
    const designId = await draftedDesign();
    const before = storedDesign(designId);

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 14,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.primer?.overhangLength).toBe(14);
    expect(result.previousOverhangLength).not.toBe(14);
    expect(result.designVersion).toBeGreaterThan(before.version);

                                                                                
                                                                  
    const after = storedDesign(designId);
    const stored = after.designPrimers[1].forward;
    expect(stored.overhang.tailLength ?? stored.overhang.sequence.length).toBe(14);
    expect(stored.sequence).toBe(stored.overhang.sequence + stored.pbs.sequence);
    expect(stored.sequence).toBe(result.primer?.sequence);
  });

  it('reports the partner primer, which the same command silently rewrote', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 5,
      }
    );

    expect(result.status).toBe('applied');
                                                                              
                                                        
    expect(result.partnerPrimer).not.toBeNull();
    expect(result.partnerPrimer?.junctionIndex).toBe(result.primer?.junctionIndex);
    expect(result.partnerPrimer?.id).not.toBe(result.primer?.id);
    expect(result.partnerPrimer?.sequence).toBe(
      `${result.partnerPrimer?.overhangSequence}${result.partnerPrimer?.pbsSequence}`
    );
  });

  it('shrinks the shared homology when the tail is shortened below its natural arm', async () => {
    const designId = await draftedDesign();
    const natural = storedDesign(designId).homologyRegions[0].encoding.onLeft;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: natural - 4,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.previousHomology?.onLeft).toBe(natural);
                                                                              
                                                                             
    expect(result.homology?.onLeft).toBe(natural - 4);
    expect(storedDesign(designId).homologyRegions[0].encoding.onLeft).toBe(natural - 4);
  });

  it("warns when the tail starts consuming the primer's own binding site", async () => {
    const designId = await draftedDesign();
    const beforePbs = storedDesign(designId).designPrimers[1].forward.pbs.sequence.length;
    const natural = storedDesign(designId).homologyRegions[0].encoding.onLeft;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: natural + 5,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.primer?.pbsLength).toBe(beforePbs - 5);
                                                                               
                                                                        
    const warning = result.warnings?.find((item) => item.code === 'tail-consumes-pbs');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain(`PBS ${beforePbs} -> ${beforePbs - 5} bp`);
  });

  it('refuses a Golden Gate design by name instead of a generic mode error', async () => {
    const designId = undraftedDesign('goldengate');
    const before = storedDesign(designId).version;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('unsupported-mode-command');
                                                                           
                                                  
    expect(result.currentAssemblyMethod).toBe('goldengate');
    expect(result.supportedAssemblyMethods).toEqual(['gibson', 'nebuilder']);
    expect(result.error).toMatch(/sticky end/i);
    expect(storedDesign(designId).version).toBe(before);
  });

  it('refuses an undrafted design and names the step that fixes it', async () => {
    const designId = undraftedDesign('gibson');

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('no-drafted-primers');
    expect(result.error).toContain('draft_design_assembly');
    expect(result.regionCount).toBe(2);
  });

  it('refuses an unknown primerId and lists the primers that exist', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        primerId: 'not-a-primer',
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('primer-not-found');
    expect(result.knownPrimers).toHaveLength(4);
    expect(result.knownPrimers?.[0]).toMatchObject({
      fragmentIndex: expect.any(Number),
      direction: expect.stringMatching(/forward|reverse/),
    });
  });

  it('addresses the same primer by id as by fragmentIndex + direction', async () => {
    const designId = await draftedDesign();
    const byIndex = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 12,
      }
    );
    expect(byIndex.status).toBe('applied');

    const byId = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        primerId: byIndex.primer!.id,
        length: 13,
      }
    );

    expect(byId.status).toBe('applied');
    expect(byId.primer?.id).toBe(byIndex.primer?.id);
    expect(byId.primer?.overhangLength).toBe(13);
  });

  it('refuses primerId and fragment coordinates when they name different primers', async () => {
    const designId = await draftedDesign();
    const normalized = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        fragmentIndex: 0,
        direction: 'forward',
        length: 12,
      }
    );
    expect(normalized.status).toBe('applied');
    const primerId = normalized.primer!.id;
    const beforeVersion = storedDesign(designId).version;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        primerId,
        fragmentIndex: 1,
        direction: 'forward',
        length: 12,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect(storedDesign(designId).version).toBe(beforeVersion);
  });

  it('refuses an out-of-range fragmentIndex with the valid range and the count', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        fragmentIndex: 9,
        direction: 'forward',
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-target');
    expect(result.validFragmentRange).toEqual([0, 1]);
    expect(result.fragmentCount).toBe(2);
  });

  it('refuses a half-specified target and says which half is missing', async () => {
    const designId = await draftedDesign();

    const missingDirection = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        fragmentIndex: 1,
        length: 20,
      }
    );
    expect(missingDirection.status).toBe('rejected');
    expect(missingDirection.code).toBe('BAD_INPUT');
    expect(missingDirection.error).toContain('fragmentIndex without direction');

    const missingFragment = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        direction: 'forward',
        length: 20,
      }
    );
    expect(missingFragment.error).toContain('direction without fragmentIndex');

    const missingBoth = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        length: 20,
      }
    );
    expect(missingBoth.code).toBe('BAD_INPUT');
    expect(missingBoth.validDirections).toEqual(['forward', 'reverse']);
    expect(missingBoth.knownPrimers).toHaveLength(4);
  });

  it('refuses an out-of-range length with the range and the current value', async () => {
    const designId = await draftedDesign();
    const before = storedDesign(designId);

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 200,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-value');
    expect(result.validRange).toEqual([0, 60]);
    expect(result.currentOverhangLength).toBe(
      before.designPrimers[1].forward.overhang.tailLength ??
        before.designPrimers[1].forward.overhang.sequence.length
    );
    expect(storedDesign(designId).version).toBe(before.version);
  });

  it("surfaces the reducer's PBS-budget refusal with the numbers needed to retry", async () => {
    const designId = await draftedDesign();
    const primer = storedDesign(designId).designPrimers[1].forward;
    const natural = storedDesign(designId).homologyRegions[0].encoding.onLeft;
    const impossible = natural + primer.pbs.sequence.length + 1;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: impossible,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-value');
    expect(result.error).toMatch(/binding site/i);
                                                                            
    expect(result.currentOverhangLength).toBe(
      primer.overhang.tailLength ?? primer.overhang.sequence.length
    );
    expect(result.currentPbsLength).toBe(primer.pbs.sequence.length);
    expect(result.validRange).toEqual([0, 60]);
  });

  it('refuses a primer with no assembly junction and points at the ones that have one', async () => {
    const designId = await draftedDesign();
                                                                            
                                                                    
    const design = storedDesign(designId);
    const pairs = design.designPrimers.map((pair, index) =>
      index === 1 ? { ...pair, forward: { ...pair.forward, junctionIndex: null } } : pair
    );
    useDesignStore.setState((state) => ({
      designs: { ...state.designs, [designId]: { ...design, designPrimers: pairs } },
    }));

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-target');
    expect(result.error).toMatch(/no assembly junction/i);
    expect(result.knownPrimers?.length).toBeGreaterThan(0);
    expect(result.knownPrimers?.every((item) => item.junctionIndex !== null)).toBe(true);
  });

  it('returns a STRUCTURED stale-version refusal, never a thrown handler error', async () => {
    const designId = await draftedDesign();
    const stale = storedDesign(designId).version;
                                             
    await execDesignContract(setPrimerOverhangLengthOutputSchema, setPrimerOverhangLengthTool, {
      designId,
      ...DOWNSTREAM_FORWARD,
      length: 12,
    });

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 13,
        expectedDesignVersion: stale,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.currentVersion).toBeGreaterThan(stale);
  });

  it('reports whether the version guard actually applied', async () => {
    const designId = await draftedDesign();
    const version = storedDesign(designId).version;

    const guarded = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 12,
        expectedDesignVersion: version,
      }
    );
    expect(guarded.status).toBe('applied');
    expect(guarded.versionGuardApplied).toBe(true);

    const unguarded = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 13,
      }
    );
                                                                                
                                                                           
    expect(unguarded.status).toBe('applied');
    expect(unguarded.versionGuardApplied).toBe(false);
  });

  it('reports versionGuardApplied on refusals too, not only on writes', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        primerId: 'not-a-primer',
        length: 20,
        expectedDesignVersion: storedDesign(designId).version,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.versionGuardApplied).toBe(true);
  });

  it('tells the agent that validation must be re-run', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 12,
      }
    );

                                                                       
                                                                  
    expect(result.revalidationRequired).toBe(true);
  });

  it('reports the mutation it claims to have made', async () => {
    const designId = await draftedDesign();
    const before = storedDesign(designId).version;

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 12,
      }
    );

    expect(result.mutation).toMatchObject({
      effect: 'set_primer_overhang_length',
      beforeVersion: before,
      afterVersion: storedDesign(designId).version,
    });
  });

  it('returns a structured not-found instead of throwing', async () => {
    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId: 'nope',
        ...DOWNSTREAM_FORWARD,
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('design-not-found');
    expect(result.error).toContain('nope');
  });

  it('accepts a waypoint://design/{id} URI as well as a bare id', async () => {
    const designId = await draftedDesign();

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId: `waypoint://design/${encodeURIComponent(designId)}`,
        ...DOWNSTREAM_FORWARD,
        length: 12,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.designId).toBe(designId);
  });

  it('returns a structured failure instead of throwing on a malformed design', async () => {
    const designId = await draftedDesign();
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          designPrimers: undefined as unknown as SequenceDesign['designPrimers'],
        },
      },
    }));

    const result = await execDesignContract<OverhangResult>(
      setPrimerOverhangLengthOutputSchema,
      setPrimerOverhangLengthTool,
      {
        designId,
        ...DOWNSTREAM_FORWARD,
        length: 20,
      }
    );

                                                                             
                          
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('EXECUTION_FAILED');
    expect(result.error).toContain('Failed to set primer overhang length');
  });
});
