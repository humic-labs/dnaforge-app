import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { setPrimerPbsLengthOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/AssemblyWorkbenchReducer';
import type { DesignPrimer, DesignRegion, SequenceDesign } from '../../design/types';
import { setPrimerPbsLengthTool } from './set-primer-pbs-length';

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

                                                                
function undraftedDesign(leftBp = 240, rightBp = 240): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('PBS target', 'circular', 'gibson');
  store.addRegion(designId, region('left', 'ACGT'.repeat(leftBp / 4)));
  store.addRegion(designId, region('right', 'TGCA'.repeat(rightBp / 4)));
  return designId;
}

   
                                                                               
                                                                           
   
function draftedDesign(leftBp = 240, rightBp = 240): string {
  const designId = undraftedDesign(leftBp, rightBp);
  const design = useDesignStore.getState().designs[designId];
  const drafted = applyAssemblyWorkbenchCommand({
    design,
    viewState: createAssemblyWorkbenchViewState(design),
    command: { type: 'draftAssembly', expectedDesignVersion: design.version },
  });
  expect(drafted.status).toBe('applied');
  expect(
    useDesignStore.getState().commitWorkbenchDesign(designId, drafted.nextDesign, design.version)
  ).toBe(true);
  return designId;
}

function storedDesign(designId: string): SequenceDesign {
  return useDesignStore.getState().designs[designId];
}

function primerAt(
  designId: string,
  fragmentIndex: number,
  direction: 'forward' | 'reverse'
): DesignPrimer {
  const pair = storedDesign(designId).designPrimers.find(
    (candidate) => candidate.fragmentIndex === fragmentIndex
  );
  if (!pair) throw new Error(`No primer pair for fragment ${fragmentIndex}`);
  return direction === 'forward' ? pair.forward : pair.reverse;
}

function pbsLength(primer: DesignPrimer): number {
  return primer.pbs.end - primer.pbs.start;
}

type PbsResult = {
  status: string;
  designId: string;
  code?: string;
  error?: string;
  designVersion?: number;
  previousVersion?: number;
  currentVersion?: number | null;
  versionGuardApplied: boolean;
  revalidationRequired: boolean;
  requestedLength: number;
  validLengthRange?: [number, number];
  validFragmentRange?: [number, number];
  fragmentCount?: number;
  appliedLength?: number;
  previousPbsLength?: number;
  changed?: boolean;
  retriable?: boolean;
  knownDesignIds?: string[];
  knownPrimers?: Array<{
    primerId: string;
    fragmentIndex: number;
    direction: 'forward' | 'reverse';
    pbsLength: number;
  }>;
  primerIdTarget?: string;
  fragmentTarget?: string;
  primer: {
    id: string;
    fragmentIndex: number;
    direction: 'forward' | 'reverse';
    pbsLength: number;
    pbsSequence: string;
    sequence: string;
    tm: number | null;
  } | null;
  mutation?: {
    operationId: string;
    toolName: string;
    effect: string;
    beforeVersion: number;
    afterVersion: number;
    changed: boolean;
  };
};

function reportedRange(result: PbsResult): [number, number] {
  expect(result.validLengthRange).toBeDefined();
  return result.validLengthRange as [number, number];
}

describe('set_primer_pbs_length', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('resizes the PBS and rewrites the primer the design actually holds', async () => {
    const designId = draftedDesign();
    const before = storedDesign(designId);
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 25,
      }
    );

    expect(result.status).toBe('applied');

                                                                      
    const after = primerAt(designId, 0, 'forward');
    expect(pbsLength(after)).toBe(25);
    expect(after.pbs.sequence).toHaveLength(25);
                                                                              
                                                    
    expect(after.sequence.endsWith(after.pbs.sequence)).toBe(true);
    expect(after.sequence).toHaveLength(
      (after.goldenGateOverhang?.fullSequence ?? after.overhang.sequence).length + 25
    );
    expect(after.pbs.sequence).not.toBe(target.pbs.sequence);

    expect(result.appliedLength).toBe(25);
    const [min, max] = reportedRange(result);
    expect(min).toBeLessThanOrEqual(25);
    expect(max).toBeGreaterThanOrEqual(25);
    expect(result.changed).toBe(true);
    expect(result.previousPbsLength).toBe(pbsLength(target));
    expect(result.previousVersion).toBe(before.version);
    expect(result.designVersion).toBeGreaterThan(before.version);
  });

  it('returns the common mutation claim for the audit ledger', async () => {
    const designId = draftedDesign();
    const before = storedDesign(designId);
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      { designId, primerId: target.id, length: 25 },
      {
        toolCallId: 'call-pbs-1',
        messages: [],
        abortSignal: undefined as never,
      }
    );

    expect(result.mutation).toMatchObject({
      operationId: 'call-pbs-1',
      toolName: 'set_primer_pbs_length',
      effect: 'set_primer_pbs_length',
      beforeVersion: before.version,
      afterVersion: storedDesign(designId).version,
      changed: true,
    });
  });

  it('addresses the same primer by fragmentIndex + direction', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 1, 'reverse');
    const untouchedBefore = [
      pbsLength(primerAt(designId, 0, 'forward')),
      pbsLength(primerAt(designId, 0, 'reverse')),
      pbsLength(primerAt(designId, 1, 'forward')),
    ];

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        fragmentIndex: 1,
        direction: 'reverse',
        length: 31,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.primer?.id).toBe(target.id);
    expect(pbsLength(primerAt(designId, 1, 'reverse'))).toBe(31);
                                                                                 
                                                                    
    expect([
      pbsLength(primerAt(designId, 0, 'forward')),
      pbsLength(primerAt(designId, 0, 'reverse')),
      pbsLength(primerAt(designId, 1, 'forward')),
    ]).toEqual(untouchedBefore);
  });

  it('refuses a length the primer template cannot carry and reports the real range', async () => {
                                                                            
                                                                           
                                                                            
                                      
    const designId = draftedDesign(40, 40);
    const target = primerAt(designId, 0, 'reverse');
    expect(target.pbs.end).toBeLessThan(60);
    const lengthBefore = pbsLength(target);
    const versionBefore = useDesignStore.getState().designs[designId].version;

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 60,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-value');
    expect(result.requestedLength).toBe(60);
    const [min, max] = reportedRange(result);
    expect(max).toBeLessThan(60);
    expect(result.error).toContain(`${min}..${max}`);
    expect(pbsLength(primerAt(designId, 0, 'reverse'))).toBe(lengthBefore);
    expect(useDesignStore.getState().designs[designId].version).toBe(versionBefore);
  });

  it('refuses a forward PBS that would consume the next fragment', async () => {
    const designId = draftedDesign(40, 40);
    const target = primerAt(designId, 0, 'forward');
    const sequenceBefore = target.pbs.sequence;

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 60,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-value');
    expect(result.validLengthRange).toEqual([10, 40]);
    expect(result.error).toContain('10..40');
    expect(primerAt(designId, 0, 'forward').pbs.sequence).toBe(sequenceBefore);
  });

  it('refuses a length outside the primer range and names that range', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');

    const tooShort = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 9,
      }
    );
    expect(tooShort.status).toBe('rejected');
    expect(tooShort.code).toBe('invalid-command-value');
                                                                     
    const [min, max] = reportedRange(tooShort);
    expect(min).toBe(10);
    expect(tooShort.error).toContain(`${min}..${max}`);

    const tooLong = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: max + 1,
      }
    );
    expect(tooLong.status).toBe('rejected');
    expect(tooLong.code).toBe('invalid-command-value');
    expect(tooLong.validLengthRange).toEqual([min, max]);

                                                   
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(pbsLength(target));
  });

  it('accepts a length above 60 bp when the template provides it', async () => {
                                                                                 
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 80,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.appliedLength).toBe(80);
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(80);
  });

  it('accepts the whole template on a part shorter than 10 bp', async () => {
    const designId = draftedDesign(8, 240);
    const target = primerAt(designId, 0, 'forward');

    const refused = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 10,
      }
    );
    expect(refused.status).toBe('rejected');
    expect(refused.validLengthRange).toEqual([8, 8]);

    const accepted = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: refused.validLengthRange[1],
      }
    );
    expect(accepted.status).toBe('applied');
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(8);
  });

  it('refuses a primer with no template left and names draft_design_assembly', async () => {
    const designId = draftedDesign(40, 40);
    const target = primerAt(designId, 0, 'forward');
                                                                                  
    useDesignStore.setState((state) => {
      const design = state.designs[designId];
      return {
        designs: {
          ...state.designs,
          [designId]: {
            ...design,
            designPrimers: design.designPrimers.map((pair) =>
              pair.forward.id === target.id
                ? {
                    ...pair,
                    forward: { ...pair.forward, pbs: { ...pair.forward.pbs, start: 40, end: 40 } },
                  }
                : pair
            ),
          },
        },
      };
    });
    const versionBefore = storedDesign(designId).version;

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 20,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('primer-template-unavailable');
    expect(result.validLengthRange).toBeUndefined();
    expect(result.error).toMatch(/draft_design_assembly/);
    expect(storedDesign(designId).version).toBe(versionBefore);

                                                                          
    const stale = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 20,
        expectedDesignVersion: versionBefore - 1,
      }
    );
    expect(stale.code).toBe('stale-design-version');
    expect(stale.validLengthRange).toBeUndefined();
  });

  it('refuses when no addressing mode is supplied and lists the primers that exist', async () => {
    const designId = draftedDesign();

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      { designId, length: 25 }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('BAD_INPUT');
    expect(result.fragmentCount).toBe(2);
    expect(result.validFragmentRange).toEqual([0, 1]);
    expect(result.knownPrimers).toHaveLength(4);
    expect(result.knownPrimers?.map((primer) => primer.primerId)).toContain(
      primerAt(designId, 0, 'forward').id
    );
  });

  it('refuses a half-specified fragment address and names the missing field', async () => {
    const designId = draftedDesign();

    const noDirection = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        fragmentIndex: 0,
        length: 25,
      }
    );
    expect(noDirection.status).toBe('rejected');
    expect(noDirection.code).toBe('BAD_INPUT');
    expect(noDirection.error).toContain('direction');
    expect(noDirection.knownPrimers).toHaveLength(4);

    const noFragment = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        direction: 'forward',
        length: 25,
      }
    );
    expect(noFragment.status).toBe('rejected');
    expect(noFragment.code).toBe('BAD_INPUT');
    expect(noFragment.error).toContain('fragmentIndex');
  });

  it('refuses an out-of-range fragmentIndex and tells the agent the part count', async () => {
    const designId = draftedDesign();

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        fragmentIndex: 7,
        direction: 'forward',
        length: 25,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-target');
    expect(result.fragmentCount).toBe(2);
    expect(result.validFragmentRange).toEqual([0, 1]);
    expect(result.knownPrimers).toHaveLength(4);
  });

  it('refuses an unknown primerId and returns the known ids', async () => {
    const designId = draftedDesign();

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: 'no-such-primer',
        length: 25,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('primer-not-found');
    expect(result.knownPrimers?.map((primer) => primer.primerId)).toContain(
      primerAt(designId, 1, 'reverse').id
    );
  });

  it('refuses an undrafted design by naming draft_design_assembly', async () => {
    const designId = undraftedDesign();
    expect(storedDesign(designId).designPrimers).toHaveLength(0);

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        fragmentIndex: 0,
        direction: 'forward',
        length: 25,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('primers-not-drafted');
    expect(result.error).toContain('draft_design_assembly');
  });

  it('refuses when the two addressing modes disagree instead of silently preferring one', async () => {
    const designId = draftedDesign();
    const byId = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: byId.id,
        fragmentIndex: 1,
        direction: 'reverse',
        length: 25,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect(result.primerIdTarget).toBe(byId.id);
    expect(result.fragmentTarget).toBe(primerAt(designId, 1, 'reverse').id);
                                               
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(pbsLength(byId));
  });

  it('accepts both addressing modes when they agree', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        fragmentIndex: 0,
        direction: 'forward',
        length: 22,
      }
    );

    expect(result.status).toBe('applied');
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(22);
  });

  it('returns a STRUCTURED stale-version refusal, never a thrown handler error', async () => {
    const designId = draftedDesign();
    const stale = storedDesign(designId).version;
    const target = primerAt(designId, 0, 'forward');

                                             
    await execDesignContract(setPrimerPbsLengthOutputSchema, setPrimerPbsLengthTool, {
      designId,
      primerId: target.id,
      length: 20,
    });
    const afterOther = pbsLength(primerAt(designId, 0, 'forward'));

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 40,
        expectedDesignVersion: stale,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.currentVersion).toBeGreaterThan(stale);
                                            
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(afterOther);
  });

  it('reports a range on a stale refusal that a retry at the current version satisfies', async () => {
    const designId = draftedDesign();
    const stale = storedDesign(designId).version;
    const target = primerAt(designId, 0, 'forward');
    await execDesignContract(setPrimerPbsLengthOutputSchema, setPrimerPbsLengthTool, {
      designId,
      primerId: target.id,
      length: 20,
    });

    const refused = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 80,
        expectedDesignVersion: stale,
      }
    );
    expect(refused.code).toBe('stale-design-version');
    const [min, max] = reportedRange(refused);
    expect(min).toBeLessThanOrEqual(80);
    expect(max).toBeGreaterThanOrEqual(80);

    const retried = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 80,
        expectedDesignVersion: refused.currentVersion ?? undefined,
      }
    );
    expect(retried.status).toBe('applied');
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(80);
  });

  it('reports a lost commit race as retriable rather than throwing', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');
    const version = storedDesign(designId).version;

                                                                              
                                                                                
    const realCommit = useDesignStore.getState().commitWorkbenchDesign;
    useDesignStore.setState({
      commitWorkbenchDesign: (id, nextDesign, expectedVersion) => {
        useDesignStore.setState({ commitWorkbenchDesign: realCommit });
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [id]: { ...state.designs[id], version: state.designs[id].version + 5 },
          },
        }));
        return realCommit(id, nextDesign, expectedVersion);
      },
    });

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 30,
        expectedDesignVersion: version,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.currentVersion).toBe(version + 5);
    expect(result.error).toMatch(/get_design/);
  });

  it('reports whether the version guard actually applied', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');
    const version = storedDesign(designId).version;

    const guarded = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 24,
        expectedDesignVersion: version,
      }
    );
    expect(guarded.status).toBe('applied');
    expect(guarded.versionGuardApplied).toBe(true);

    const unguarded = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 26,
      }
    );
    expect(unguarded.status).toBe('applied');
                                                                                
                                                                           
    expect(unguarded.versionGuardApplied).toBe(false);
  });

  it('tells the agent that validation must be re-run', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId,
        primerId: target.id,
        length: 25,
      }
    );

                                                                       
                                                                  
    expect(result.revalidationRequired).toBe(true);
  });

  it('returns a structured not-found instead of throwing', async () => {
    const designId = draftedDesign();

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId: 'nope',
        primerId: 'whatever',
        length: 25,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('design-not-found');
    expect(result.error).toContain('nope');
    expect(result.knownDesignIds).toContain(designId);
  });

  it('accepts a waypoint://design/{id} URI as the design id', async () => {
    const designId = draftedDesign();
    const target = primerAt(designId, 0, 'forward');

    const result = await execDesignContract<PbsResult>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId: `waypoint://design/${encodeURIComponent(designId)}`,
        primerId: target.id,
        length: 28,
      }
    );

    expect(result.status).toBe('applied');
    expect(result.designId).toBe(designId);
    expect(pbsLength(primerAt(designId, 0, 'forward'))).toBe(28);
  });
});
