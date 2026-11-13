import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { setGoldenGateOffsetOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { getComposedSequenceForDesign } from '../../design/restriction-digest';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/AssemblyWorkbenchReducer';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { setGoldenGateOffsetTool } from './set-golden-gate-offset';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function pcrRegion(name: string, sequence: string): Omit<DesignRegion, 'id'> {
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

                                                                           
function rdRegion(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    ...pcrRegion(name, sequence),
    sourceType: 'rd',
    rdSourceEnzyme: 'BsaI',
    rdOverhangs: { upstream: 'AATG', downstream: 'GCAA' },
  };
}

                                                                            
function draft(designId: string): void {
  const design = useDesignStore.getState().designs[designId];
  const result = applyAssemblyWorkbenchCommand({
    design,
    viewState: createAssemblyWorkbenchViewState(design),
    command: { type: 'draftAssembly', expectedDesignVersion: design.version },
  });
  useDesignStore.getState().commitWorkbenchDesign(designId, result.nextDesign, design.version);
}

function goldenGateDesign(
  regions: Array<Omit<DesignRegion, 'id'>>,
  { drafted = true }: { drafted?: boolean } = {}
): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Offset target', 'circular', 'goldengate');
  for (const region of regions) store.addRegion(designId, region);
  if (drafted) draft(designId);
  return designId;
}

                                                                           
function twoPartGoldenGate(): string {
  return goldenGateDesign([
    pcrRegion('left', 'ACGT'.repeat(60)),
    pcrRegion('right', 'TGCA'.repeat(60)),
  ]);
}

function designOf(designId: string): SequenceDesign {
  return useDesignStore.getState().designs[designId];
}

function junctionsOf(designId: string) {
  return designOf(designId).goldenGateJunctions ?? [];
}

type JunctionProjection = {
  junctionId: string | null;
  junctionIndex: number;
  offset: number;
  overhang: string;
  overhangStart: number;
  overhangEnd: number;
  overhangSource: string;
  offsetEditable: boolean;
  isValid: boolean;
  validationError: string | null;
};

type OffsetResult = {
  status: string;
  designId: string;
  designVersion?: number;
  previousVersion?: number;
  versionGuardApplied: boolean;
  revalidationRequired: boolean;
  junction: JunctionProjection | null;
  junctions?: JunctionProjection[];
  duplicateOverhangs?: string[];
  offset?: number;
  previousOffset?: number | null;
  overhangChanged?: boolean;
  offsetLimitBp?: number;
  validOffsetRange?: [number, number];
  validRange?: [number, number];
  junctionCount?: number;
  knownJunctions?: Array<{ junctionId: string; junctionIndex: number }>;
  assemblyMethod?: string;
  supportedAssemblyMethods?: string[];
  editableJunctionIndexes?: number[];
  overhangSource?: string;
  currentVersion?: number | null;
  retriable?: boolean;
  code?: string;
  error?: string;
  mutation?: {
    operationId: string;
    toolName: string;
    effect: string;
    beforeVersion: number;
    afterVersion: number;
    changed: boolean;
  };
};

async function setOffset(args: Record<string, unknown>): Promise<OffsetResult> {
  return execDesignContract<OffsetResult>(
    setGoldenGateOffsetOutputSchema,
    setGoldenGateOffsetTool,
    args
  );
}

describe('set_golden_gate_offset', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('slides the overhang WINDOW along the sequence without resizing it', async () => {
    const designId = twoPartGoldenGate();
    const before = junctionsOf(designId)[0];
    expect(before.offset).toBe(0);

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('applied');
    expect(result.offset).toBe(1);
    expect(result.previousOffset).toBe(0);

                                                                               
    const after = junctionsOf(designId)[0];
    expect(after.overhangStart).toBe(before.overhangStart + 1);
    expect(after.overhangEnd - after.overhangStart).toBe(before.overhangEnd - before.overhangStart);
    const composed = getComposedSequenceForDesign(designOf(designId));
    expect(after.overhang).toBe(composed.slice(after.overhangStart, after.overhangEnd));
    expect(result.overhangChanged).toBe(true);
    expect(result.junction?.overhang).toBe(after.overhang);
  });

  it('returns the common mutation claim for the audit ledger', async () => {
    const designId = twoPartGoldenGate();
    const before = designOf(designId);

    const result = await execDesignContract<OffsetResult>(
      setGoldenGateOffsetOutputSchema,
      setGoldenGateOffsetTool,
      { designId, junctionIndex: 0, offset: 1 },
      {
        toolCallId: 'call-offset-1',
        messages: [],
        abortSignal: undefined as never,
      }
    );

    expect(result.mutation).toMatchObject({
      operationId: 'call-offset-1',
      toolName: 'set_golden_gate_offset',
      effect: 'set_golden_gate_offset',
      beforeVersion: before.version,
      afterVersion: designOf(designId).version,
      changed: true,
    });
  });

  it('leaves the assembled PRODUCT identical — only the oligos change', async () => {
    const designId = twoPartGoldenGate();
    const productBefore = getComposedSequenceForDesign(designOf(designId));
    const primersBefore = designOf(designId).designPrimers.map((pair) => pair.forward.sequence);
    expect(primersBefore.length).toBeGreaterThan(0);

    const result = await setOffset({ designId, junctionIndex: 0, offset: 2 });

    expect(result.status).toBe('applied');
    expect(getComposedSequenceForDesign(designOf(designId))).toBe(productBefore);
    expect(designOf(designId).designPrimers.map((pair) => pair.forward.sequence)).not.toEqual(
      primersBefore
    );
  });

  it('addresses the same junction by junctionId as by junctionIndex', async () => {
    const designId = twoPartGoldenGate();
    const byIndex = await setOffset({ designId, junctionIndex: 0, offset: 1 });
    const junctionId = byIndex.junction?.junctionId;
    expect(junctionId).toBeTruthy();

    const byId = await setOffset({ designId, junctionId, offset: 3 });
    expect(byId.status).toBe('applied');
    expect(byId.junction?.junctionIndex).toBe(0);
    expect(junctionsOf(designId)[0].offset).toBe(3);
  });

  it('reports a no-op instead of burning a version on an unchanged offset', async () => {
    const designId = twoPartGoldenGate();
    const version = designOf(designId).version;

    const result = await setOffset({ designId, junctionIndex: 0, offset: 0 });

    expect(result.status).toBe('noop');
    expect(result.junction?.offset).toBe(0);
    expect(designOf(designId).version).toBe(version);
    expect(result.revalidationRequired).toBe(false);
  });

  it('surfaces the whole overhang set so a collision fix is verifiable', async () => {
                                                                            
                                                            
    const designId = goldenGateDesign([
      pcrRegion('a', 'ACGT'.repeat(60)),
      pcrRegion('b', 'ACGT'.repeat(60)),
    ]);
    expect(new Set(junctionsOf(designId).map((item) => item.overhang)).size).toBe(1);

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('applied');
    expect(result.duplicateOverhangs).toEqual([]);
    expect(result.junctions).toHaveLength(2);
    expect(new Set(junctionsOf(designId).map((item) => item.overhang)).size).toBe(2);
  });

  it('refuses an out-of-range junctionIndex and names the valid range', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({ designId, junctionIndex: 9, offset: 1 });

    expect(result.status).toBe('rejected');
                                                         
    expect(result.validRange).toEqual([0, 1]);
    expect(result.junctionCount).toBe(2);
  });

  it('refuses an unknown junctionId and lists the ids that exist', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({ designId, junctionId: 'jxn-nope', offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('junction-not-found');
    expect(result.knownJunctions).toHaveLength(2);
    expect(result.knownJunctions?.[0].junctionIndex).toBe(0);
    expect(result.knownJunctions?.[0].junctionId).toBeTruthy();
  });

  it('refuses a junctionId that disagrees with the junctionIndex', async () => {
    const designId = twoPartGoldenGate();
    const resolved = await setOffset({ designId, junctionIndex: 0, offset: 1 });
    const junctionId = resolved.junction?.junctionId;

    const result = await setOffset({ designId, junctionId, junctionIndex: 1, offset: 2 });

                                                                               
                                                                         
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect(junctionsOf(designId)[1].offset).toBe(0);
  });

  it('refuses neither address being supplied', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({ designId, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('BAD_INPUT');
    expect(result.validRange).toEqual([0, 1]);
  });

  it('refuses an offset past the limit and reports the limit', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({ designId, junctionIndex: 0, offset: 500 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-value');
    expect(result.offsetLimitBp).toBe(24);
    expect(result.validOffsetRange).toEqual([-24, 24]);
    expect(junctionsOf(designId)[0].offset).toBe(0);
  });

  it('honours a design-specific offset limit', async () => {
    const designId = twoPartGoldenGate();
    const design = designOf(designId);
    useDesignStore.setState({
      designs: {
        ...useDesignStore.getState().designs,
        [designId]: {
          ...design,
          goldenGateConfig: { enzyme: 'BsaI', offsetLimitBp: 6 },
        },
      },
    });

    const result = await setOffset({ designId, junctionIndex: 0, offset: 10 });

    expect(result.status).toBe('rejected');
    expect(result.offsetLimitBp).toBe(6);
    expect(result.validOffsetRange).toEqual([-6, 6]);
  });

  it('refuses a non-Golden-Gate design and names the method it needs', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Gibson design', 'circular', 'gibson');
    store.addRegion(designId, pcrRegion('left', 'AAATTT'));
    store.addRegion(designId, pcrRegion('right', 'GGGCCC'));

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('unsupported-mode-command');
    expect(result.assemblyMethod).toBe('gibson');
    expect(result.supportedAssemblyMethods).toEqual(['goldengate']);
  });

  it('refuses a restriction-digest junction because that end is a physical input', async () => {
    const designId = goldenGateDesign([
      pcrRegion('p1', 'ACGT'.repeat(40)),
      pcrRegion('p2', 'TGCA'.repeat(40)),
      rdRegion('rd', 'GGTTAACC'.repeat(20)),
    ]);
                                                                            
    const lockedOffsetBefore = junctionsOf(designId)[1].offset;

    const result = await setOffset({ designId, junctionIndex: 1, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('fixed-goldengate-junction');
    expect(result.overhangSource).toBe('pcr-matched-rd');
    expect(result.error).toMatch(/restriction digest/i);
                                                          
    expect(result.editableJunctionIndexes).toEqual([0]);
    expect(junctionsOf(designId)[1].offset).toBe(lockedOffsetBefore);
  });

  it('refuses an undrafted design and names the tool that fixes it', async () => {
    const designId = goldenGateDesign(
      [pcrRegion('left', 'ACGT'.repeat(60)), pcrRegion('right', 'TGCA'.repeat(60))],
      { drafted: false }
    );
    expect(junctionsOf(designId)).toHaveLength(0);

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('assembly-not-drafted');
    expect(result.error).toMatch(/draft_design_assembly/);
  });

  it('returns a STRUCTURED stale-version refusal, never a thrown handler error', async () => {
    const designId = twoPartGoldenGate();
    const stale = designOf(designId).version;
    await setOffset({ designId, junctionIndex: 0, offset: 1 });

    const result = await setOffset({
      designId,
      junctionIndex: 0,
      offset: 2,
      expectedDesignVersion: stale,
    });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.currentVersion).toBeGreaterThan(stale);
    expect(result.retriable).toBe(true);
    expect(junctionsOf(designId)[0].offset).toBe(1);
  });

  it('treats a LOST commit race as retriable, not as a handler error', async () => {
    const designId = twoPartGoldenGate();
    const realCommit = useDesignStore.getState().commitWorkbenchDesign;
                                                                               
                                                                            
                                                                              
    useDesignStore.setState({
      commitWorkbenchDesign: (id, nextDesign, expectedVersion) => {
        useDesignStore.setState({ commitWorkbenchDesign: realCommit });
        const current = useDesignStore.getState().designs[id];
        useDesignStore.setState({
          designs: {
            ...useDesignStore.getState().designs,
            [id]: { ...current, version: current.version + 1 },
          },
        });
        return realCommit(id, nextDesign, expectedVersion);
      },
    });

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.currentVersion).toBeGreaterThan(result.previousVersion ?? 0);
                                             
    expect(junctionsOf(designId)[0].offset).toBe(0);
  });

  it('returns a structured refusal instead of throwing on a corrupt junction', async () => {
    const designId = twoPartGoldenGate();
    const design = designOf(designId);
    useDesignStore.setState({
      designs: {
        ...useDesignStore.getState().designs,
        [designId]: {
          ...design,
                                                                           
          goldenGateJunctions: (design.goldenGateJunctions ?? []).map((junction) => ({
            ...junction,
            source: undefined as never,
          })),
        },
      },
    });

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

                                                                
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('EXECUTION_FAILED');
    expect(result.error).toMatch(/Failed to set Golden Gate offset/);
  });

  it('reports whether the version guard actually applied', async () => {
    const designId = twoPartGoldenGate();
    const version = designOf(designId).version;

    const guarded = await setOffset({
      designId,
      junctionIndex: 0,
      offset: 1,
      expectedDesignVersion: version,
    });
    expect(guarded.status).toBe('applied');
    expect(guarded.versionGuardApplied).toBe(true);

    const unguarded = await setOffset({ designId, junctionIndex: 0, offset: 2 });
                                                                                
    expect(unguarded.status).toBe('applied');
    expect(unguarded.versionGuardApplied).toBe(false);
  });

  it('tells the agent that validation must be re-run', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({ designId, junctionIndex: 0, offset: 1 });

                                                                       
                                                                  
    expect(result.revalidationRequired).toBe(true);
  });

  it('returns a structured not-found instead of throwing', async () => {
    const result = await setOffset({ designId: 'nope', junctionIndex: 0, offset: 1 });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('design-not-found');
    expect(result.error).toContain('nope');
  });

  it('accepts a waypoint://design/{id} URI', async () => {
    const designId = twoPartGoldenGate();

    const result = await setOffset({
      designId: `waypoint://design/${designId}`,
      junctionIndex: 0,
      offset: 1,
    });

    expect(result.status).toBe('applied');
    expect(result.designId).toBe(designId);
  });
});
