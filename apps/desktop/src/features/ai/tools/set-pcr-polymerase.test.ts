import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { setPcrPolymeraseOutputSchema } from './design-output-schemas';
   
                                 
  
                                                                              
                                                                                
                                          
   

import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/AssemblyWorkbenchReducer';
import { createAppTmCalculator } from '../../junction-workbench/settings';
import { primerTmSequence } from '../../design/algorithms/refine-design-tm';
import { resolveTmModel, NEB_TM_OPTIONS } from '../../design/algorithms/tm-model';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { setPcrPolymeraseTool, setPcrPolymeraseSchema } from './set-pcr-polymerase';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function region(name: string, sequence: string, sourceType: 'pcr' | 'rd' = 'pcr') {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType,
  } satisfies Omit<DesignRegion, 'id'>;
}

                                                                            
function twoPartDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Polymerase target', 'circular', 'gibson');
  store.addRegion(designId, region('left', 'AAATTT'));
  store.addRegion(designId, region('right', 'GGGCCC'));
  return designId;
}

function draftedTwoPartDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Drafted polymerase target', 'circular', 'gibson');
  store.addRegion(designId, region('left-long', 'ACGT'.repeat(60)));
  store.addRegion(designId, region('right-long', 'TGCA'.repeat(60)));
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

                                                                                      
function restrictionDigestOnlyDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('RD only', 'circular', 'goldengate');
  store.addRegion(designId, region('insert', 'AAATTT', 'rd'));
  store.addRegion(designId, region('backbone', 'GGGCCC', 'rd'));
  return designId;
}

                                                                                     
function storedPolymerase(designId: string): string | null | undefined {
  return useDesignStore.getState().designs[designId]?.pcrPolymerase;
}

type PolymeraseProjection = {
  prodcode: string;
  family: string | null;
  label: string | null;
} | null;

type PolymeraseResult = {
  status: string;
  designId: string;
  polymerase: PolymeraseProjection;
  previousPolymerase: PolymeraseProjection;
  tmModel: { kind: string; prodcode?: string; polymerase?: string } | null;
  resolvedFrom?: string;
  familyOptions?: string[];
  designVersion?: number;
  previousVersion?: number;
  currentVersion?: number | null;
  versionGuardApplied: boolean;
  revalidationRequired: boolean;
  warnings?: Array<{ code: string; message: string }>;
  error?: string;
  code?: string;
  retriable?: boolean;
  knownDesignIds?: string[];
  supportedFamilies?: string[];
  supportedProdcodes?: string[];
  prodcodesInRequestedFamily?: string[];
  prodcodeFamily?: string;
  note?: string;
  mutation?: {
    operationId: string;
    toolName: string;
    effect: string;
    beforeVersion: number;
    afterVersion: number;
    changed: boolean;
  };
};

describe('set_pcr_polymerase', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('records the polymerase ON THE DESIGN and reports the Tm model it implies', async () => {
    const designId = twoPartDesign();
    const before = useDesignStore.getState().designs[designId];

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
      }
    );

    expect(result.status).toBe('applied');
                                                     
    expect(storedPolymerase(designId)).toBe('q5-0');
    expect(result.polymerase).toEqual({ prodcode: 'q5-0', family: 'q5', label: 'NEB Q5' });
    expect(result.previousPolymerase).toBeNull();
    expect(result.previousVersion).toBe(before.version);
    expect(result.designVersion).toBe(before.version + 1);

                                                                        
                                                                             
    expect(result.tmModel).toEqual(resolveTmModel({ reaction: { polymerase: 'q5-0' } }));
    expect(result.tmModel).toEqual({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
  });

  it('invalidates old Tm evidence and returns the common mutation claim', async () => {
    const designId = twoPartDesign();
    const before = useDesignStore.getState().designs[designId];
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          designPrimers: state.designs[designId].designPrimers.map((pair) => ({
            ...pair,
            forward: {
              ...pair.forward,
              tmProvenance: {
                source: 'neb',
                verified: true,
                model: { kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' },
                concNm: 500,
              },
            },
            reverse: {
              ...pair.reverse,
              tmProvenance: {
                source: 'neb',
                verified: true,
                model: { kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' },
                concNm: 500,
              },
            },
          })),
        },
      },
    }));

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      { designId, polymerase: 'q5' },
      {
        toolCallId: 'call-polymerase-1',
        messages: [],
        abortSignal: undefined as never,
      }
    );

    const after = useDesignStore.getState().designs[designId];
    expect(
      after.designPrimers.every(
        (pair) => pair.forward.tmProvenance === undefined && pair.reverse.tmProvenance === undefined
      )
    ).toBe(true);
    expect(result.mutation).toMatchObject({
      operationId: 'call-polymerase-1',
      toolName: 'set_pcr_polymerase',
      effect: 'set_pcr_polymerase',
      beforeVersion: before.version,
      afterVersion: after.version,
      changed: true,
    });
  });

  it('accepts an exact product code so a GC buffer is reachable, not just the family default', async () => {
    const designId = twoPartDesign();

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        prodcode: 'phusion-1',
      }
    );

    expect(result.status).toBe('applied');
    expect(storedPolymerase(designId)).toBe('phusion-1');
    expect(result.resolvedFrom).toBe('prodcode');
    expect(result.polymerase).toEqual({
      prodcode: 'phusion-1',
      family: 'phusion',
      label: 'NEB Phusion (GC)',
    });
                                                                                   
    expect(result.tmModel).toEqual({ kind: 'neb', prodcode: 'phusion-1', polymerase: 'phusion' });
  });

  it('resolves a bare family to its standard buffer AND names the alternatives', async () => {
    const designId = twoPartDesign();

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'phusion',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.resolvedFrom).toBe('family');
                                                                               
    expect(storedPolymerase(designId)).toBe('phusion-0');
                                                                            
                                                
    expect(result.familyOptions).toEqual(['phusion-0', 'phusion-1']);
  });

  it('reports what it replaced instead of silently clobbering', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setPcrPolymeraseOutputSchema, setPcrPolymeraseTool, {
      designId,
      polymerase: 'taq',
    });

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.previousPolymerase).toEqual({
      prodcode: 'taq-0',
      family: 'taq',
      label: 'NEB Taq',
    });
    expect(storedPolymerase(designId)).toBe('q5-0');
  });

  it('clears the polymerase so Tm falls back to the app-wide setting', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setPcrPolymeraseOutputSchema, setPcrPolymeraseTool, {
      designId,
      polymerase: 'q5',
    });

    const cleared = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        clear: true,
      }
    );

    expect(cleared.status).toBe('applied');
    expect(storedPolymerase(designId)).toBeNull();
    expect(cleared.polymerase).toBeNull();
    expect(cleared.previousPolymerase?.prodcode).toBe('q5-0');
                                                                                  
                                            
    expect(cleared.tmModel).toBeNull();
  });

  it('recomputes primer Tm when clearing a polymerase instead of relabeling stale values', async () => {
    const designId = draftedTwoPartDesign();
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          pcrPolymerase: 'q5-0',
          designPrimers: state.designs[designId].designPrimers.map((pair) => ({
            ...pair,
            forward: {
              ...pair.forward,
              tm: 999,
              tmProvenance: { source: 'neb', verified: true },
            },
            reverse: {
              ...pair.reverse,
              tm: 999,
              tmProvenance: { source: 'neb', verified: true },
            },
          })),
        },
      },
    }));

    const cleared = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        clear: true,
      }
    );

    expect(cleared.status).toBe('applied');
    const calculator = createAppTmCalculator(null);
    for (const pair of useDesignStore.getState().designs[designId].designPrimers) {
      for (const primer of [pair.forward, pair.reverse]) {
        expect(primer.tm).toBeCloseTo(calculator.estimate(primerTmSequence(primer)), 6);
        expect(primer.tm).not.toBe(999);
        expect(primer.tmProvenance).toBeUndefined();
      }
    }
  });

  it('is a noop that does NOT churn the version when the polymerase is already set', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setPcrPolymeraseOutputSchema, setPcrPolymeraseTool, {
      designId,
      polymerase: 'q5',
    });
    const settled = useDesignStore.getState().designs[designId].version;

    const again = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        prodcode: 'q5-0',
      }
    );

    expect(again.status).toBe('noop');
                                                                           
                                         
    expect(useDesignStore.getState().designs[designId].version).toBe(settled);
    expect(again.designVersion).toBe(settled);
    expect(again.revalidationRequired).toBe(false);
  });

  it('is a noop when clearing an already-absent polymerase', async () => {
    const designId = twoPartDesign();
    const before = useDesignStore.getState().designs[designId].version;

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        clear: true,
      }
    );

    expect(result.status).toBe('noop');
    expect(useDesignStore.getState().designs[designId].version).toBe(before);
  });

  it('warns (but still records) when the design has no PCR parts to amplify', async () => {
    const designId = restrictionDigestOnlyDesign();

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
      }
    );

                                                                                
                                                                     
    expect(result.status).toBe('applied');
    expect(storedPolymerase(designId)).toBe('q5-0');
    expect(result.warnings?.map((w) => w.code)).toContain('no-pcr-parts');
  });

  it('does not warn when the design has PCR parts', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
      }
    );
    expect(result.warnings).toEqual([]);
  });

  it('tells the agent that primers must be re-drafted after a change', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
      }
    );
                                                                                
                                       
    expect(result.revalidationRequired).toBe(true);
  });

  describe('refusals carry enough to self-correct', () => {
    it('unknown design → structured refusal listing the ids that DO exist', async () => {
      const real = twoPartDesign();

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        {
          designId: 'nope',
          polymerase: 'q5',
        }
      );

      expect(result.status).toBe('rejected');
      expect(result.code).toBe('design-not-found');
      expect(result.error).toContain('nope');
      expect(result.knownDesignIds).toEqual([real]);
    });

    it('no enzyme and no clear → refusal listing every valid family and product code', async () => {
      const designId = twoPartDesign();

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        { designId }
      );

      expect(result.status).toBe('rejected');
      expect(result.code).toBe('BAD_INPUT');
      expect(result.supportedFamilies).toEqual(['q5', 'phusion', 'onetaq', 'taq', 'longamp']);
      expect(result.supportedProdcodes).toEqual(NEB_TM_OPTIONS.map((o) => o.prodcode));
      expect(storedPolymerase(designId)).toBeUndefined();
    });

    it('clear combined with an enzyme → refusal rather than a coin flip', async () => {
      const designId = twoPartDesign();

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        {
          designId,
          clear: true,
          polymerase: 'q5',
        }
      );

      expect(result.status).toBe('rejected');
      expect(result.code).toBe('BAD_INPUT');
      expect(result.error).toMatch(/cannot be combined/i);
      expect(storedPolymerase(designId)).toBeUndefined();
    });

    it('family/prodcode disagreement → refusal naming the products in the family asked for', async () => {
      const designId = twoPartDesign();

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        {
          designId,
          polymerase: 'q5',
          prodcode: 'taq-0',
        }
      );

      expect(result.status).toBe('rejected');
      expect(result.code).toBe('BAD_INPUT');
      expect(result.prodcodeFamily).toBe('taq');
      expect(result.prodcodesInRequestedFamily).toEqual(['q5-0', 'q5hs-0']);
      expect(storedPolymerase(designId)).toBeUndefined();
    });

    it('a matching family/prodcode pair is accepted', async () => {
      const designId = twoPartDesign();

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        {
          designId,
          polymerase: 'q5',
          prodcode: 'q5hs-0',
        }
      );

      expect(result.status).toBe('applied');
      expect(storedPolymerase(designId)).toBe('q5hs-0');
    });

    it('a lost CAS is a RETRIABLE refusal, never a thrown handler error', async () => {
      const designId = twoPartDesign();
      const stale = useDesignStore.getState().designs[designId].version;
                                               
      await execDesignContract(setPcrPolymeraseOutputSchema, setPcrPolymeraseTool, {
        designId,
        polymerase: 'taq',
      });

      const result = await execDesignContract<PolymeraseResult>(
        setPcrPolymeraseOutputSchema,
        setPcrPolymeraseTool,
        {
          designId,
          polymerase: 'q5',
          expectedDesignVersion: stale,
        }
      );

      expect(result.status).toBe('rejected');
      expect(result.code).toBe('stale-design-version');
      expect(result.retriable).toBe(true);
      expect(result.currentVersion).toBeGreaterThan(stale);
                                        
      expect(storedPolymerase(designId)).toBe('taq-0');
    });
  });

  it('reports whether the version guard actually applied', async () => {
    const designId = twoPartDesign();
    const version = useDesignStore.getState().designs[designId].version;

    const guarded = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'q5',
        expectedDesignVersion: version,
      }
    );
    expect(guarded.status).toBe('applied');
    expect(guarded.versionGuardApplied).toBe(true);

    const unguarded = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId,
        polymerase: 'taq',
      }
    );
                                                                                
                                                                           
    expect(unguarded.status).toBe('applied');
    expect(unguarded.versionGuardApplied).toBe(false);
  });

  it('accepts a waypoint://design/{id} URI as well as a bare id', async () => {
    const designId = twoPartDesign();

    const result = await execDesignContract<PolymeraseResult>(
      setPcrPolymeraseOutputSchema,
      setPcrPolymeraseTool,
      {
        designId: `waypoint://design/${encodeURIComponent(designId)}`,
        polymerase: 'onetaq',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.designId).toBe(designId);
    expect(storedPolymerase(designId)).toBe('onetaq-0');
  });

  describe('schema', () => {
    it('rejects an unknown key so a typo fails loudly instead of being ignored', () => {
      expect(setPcrPolymeraseSchema.safeParse({ designId: 'd1', polymerse: 'q5' }).success).toBe(
        false
      );
    });

    it('rejects a polymerase or product code outside the real NEB catalog', () => {
      expect(setPcrPolymeraseSchema.safeParse({ designId: 'd1', polymerase: 'pfu' }).success).toBe(
        false
      );
      expect(setPcrPolymeraseSchema.safeParse({ designId: 'd1', prodcode: 'q5-9' }).success).toBe(
        false
      );
      expect(setPcrPolymeraseSchema.safeParse({ designId: 'd1', polymerase: 'q5' }).success).toBe(
        true
      );
    });

    it('offers every curated NEB product code as a callable value', () => {
      for (const option of NEB_TM_OPTIONS) {
        expect(
          setPcrPolymeraseSchema.safeParse({ designId: 'd1', prodcode: option.prodcode }).success
        ).toBe(true);
      }
    });

    it('keeps every callable param TOP-LEVEL (no union the MCP transport would strip)', () => {
      const shape = setPcrPolymeraseSchema.shape;
      expect(Object.keys(shape).sort()).toEqual([
        'clear',
        'designId',
        'expectedDesignVersion',
        'polymerase',
        'prodcode',
      ]);
    });
  });
});
