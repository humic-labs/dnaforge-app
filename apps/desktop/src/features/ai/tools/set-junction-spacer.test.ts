import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { setJunctionSpacerOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { getComposedSequenceForDesign } from '../../design/restriction-digest';
import type { DesignRegion } from '../../design/types';
import { setJunctionSpacerTool } from './set-junction-spacer';

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

                                                                               
function twoPartDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Spacer target', 'circular', 'gibson');
  store.addRegion(designId, region('left', 'AAATTT'));
  store.addRegion(designId, region('right', 'GGGCCC'));
  return designId;
}

type SpacerResult = {
  status: string;
  designId: string;
  designVersion: number;
  previousVersion: number;
  versionGuardApplied: boolean;
  revalidationRequired: boolean;
  spacer: { id: string; junctionIndex: number; sequence: string; name: string | null } | null;
  replaced: { previousSequence: string; previousName: string | null } | null;
  replacedSpacers: Array<{
    id: string;
    junctionIndex: number;
    sequence: string;
    name: string | null;
  }>;
  error?: string;
  code?: string;
  validRange?: [number, number];
  junctionCount?: number;
  currentVersion?: number;
};

describe('set_junction_spacer', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('refuses to rewrite a junction owned by a reusable Golden Gate schema', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Locked schema', 'circular', 'goldengate');
    store.setGoldenGateSchema(
      designId,
      {
        id: 'kit-schema',
        name: 'Kit schema',
        revision: 1,
        origin: { type: 'kit', kitId: 'kit', kitName: 'Kit' },
        enzyme: 'BsaI',
        slots: [
          { id: 'left', label: 'Left', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'right', label: 'Right', outgoingOverhang: 'GGAG', preferredRoles: [] },
        ],
      },
      0
    );

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'GGCC',
      }
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_STRUCTURE_LOCKED',
    });
    expect(useDesignStore.getState().designs[designId].spacers).toEqual([]);
  });

  it('inserts a spacer and changes the composed PRODUCT, not just a field', async () => {
    const designId = twoPartDesign();
    const before = useDesignStore.getState().designs[designId];

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'gcc',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.spacer?.sequence).toBe('GCC');
    expect(result.spacer?.junctionIndex).toBe(0);
    expect(result.replaced).toBeNull();
    expect(result.previousVersion).toBe(before.version);
    expect(result.designVersion).toBeGreaterThan(before.version);

                                                
    const after = useDesignStore.getState().designs[designId];
    expect(getComposedSequenceForDesign(after)).toBe('AAATTTGCCGGGCCC');
  });

  it('reports what it replaced instead of silently clobbering', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setJunctionSpacerOutputSchema, setJunctionSpacerTool, {
      designId,
      junctionIndex: 0,
      sequence: 'AAA',
    });

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
        name: 'linker',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.replaced).toEqual({ previousSequence: 'AAA', previousName: null });
    expect(result.spacer?.sequence).toBe('TTT');
    expect(result.spacer?.name).toBe('linker');
  });

  it('returns the current spacer projection on an exact no-op retry', async () => {
    const designId = twoPartDesign();
    const first = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
        name: 'linker',
      }
    );

    const retry = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
        name: 'linker',
      }
    );

    expect(retry.status).toBe('noop');
    expect(retry.spacer).toEqual(first.spacer);
    expect(retry.junctionCount).toBe(2);
    expect(retry.replaced).toBeNull();
    expect(retry.replacedSpacers).toEqual([]);
    expect(retry.designVersion).toBe(first.designVersion);
    expect(retry.revalidationRequired).toBe(false);
  });

  it('reports every duplicate spacer destroyed by a junction-level replacement', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setJunctionSpacerOutputSchema, setJunctionSpacerTool, {
      designId,
      junctionIndex: 0,
      sequence: 'AAA',
      name: 'first',
    });
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          spacers: [
            ...state.designs[designId].spacers,
            {
              id: 'duplicate-spacer',
              junctionIndex: 0,
              sequence: 'CCC',
              name: 'second',
            },
          ],
        },
      },
    }));

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
      }
    );

    expect(result.status).toBe('applied');
    expect(result.replacedSpacers).toEqual([
      expect.objectContaining({ sequence: 'AAA', name: 'first' }),
      expect.objectContaining({ id: 'duplicate-spacer', sequence: 'CCC', name: 'second' }),
    ]);
    expect(useDesignStore.getState().designs[designId].spacers).toHaveLength(1);
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('TTT');
  });

  it('refuses spacerId and junctionIndex when they name different gaps', async () => {
    const designId = twoPartDesign();
    const inserted = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'AAA',
      }
    );
    const beforeVersion = useDesignStore.getState().designs[designId].version;

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        spacerId: inserted.spacer!.id,
        junctionIndex: 1,
        sequence: 'TTT',
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect(useDesignStore.getState().designs[designId].version).toBe(beforeVersion);
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('AAA');
  });

  it('clears the spacer with an empty sequence', async () => {
    const designId = twoPartDesign();
    await execDesignContract(setJunctionSpacerOutputSchema, setJunctionSpacerTool, {
      designId,
      junctionIndex: 0,
      sequence: 'AAA',
    });

    const cleared = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: '',
      }
    );

    expect(cleared.status).toBe('applied');
    expect(cleared.spacer).toBeNull();
    const after = useDesignStore.getState().designs[designId];
    expect(after.spacers).toHaveLength(0);
    expect(getComposedSequenceForDesign(after)).toBe('AAATTTGGGCCC');
  });

  it('is a noop when clearing an already-absent spacer', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: '',
      }
    );
    expect(result.status).toBe('noop');
    expect(result.spacer).toBeNull();
    expect(result.junctionCount).toBe(2);
    expect(result.revalidationRequired).toBe(false);
  });

  it('refuses an out-of-range junction and tells the agent the valid range', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 99,
        sequence: 'AAA',
      }
    );

    expect(result.status).toBe('rejected');
                                                                      
    expect(result.validRange).toEqual([0, 1]);
    expect(result.junctionCount).toBe(2);
  });

  it('normalizes IUPAC ambiguity bases at the tool boundary', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'aCgTn',
      }
    );
    expect(result.status).toBe('applied');
    expect(result.spacer?.sequence).toBe('ACGTN');
  });

  it.each(['ß', 'ſ'])('refuses non-nucleotide %s before case conversion', async (sequence) => {
    const designId = twoPartDesign();
    const before = useDesignStore.getState().designs[designId];
    const result = await execDesignContract<SpacerResult>(setJunctionSpacerOutputSchema, setJunctionSpacerTool, {
      designId,
      junctionIndex: 0,
      sequence,
    });

    expect(result.status).toBe('rejected');
    expect(useDesignStore.getState().designs[designId]).toEqual(before);
  });

  it('returns a STRUCTURED stale-version refusal, never a thrown handler error', async () => {
    const designId = twoPartDesign();
    const stale = useDesignStore.getState().designs[designId].version;
                                             
    await execDesignContract(setJunctionSpacerOutputSchema, setJunctionSpacerTool, {
      designId,
      junctionIndex: 0,
      sequence: 'AAA',
    });

    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
        expectedDesignVersion: stale,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.currentVersion).toBeGreaterThan(stale);
  });

  it('reports whether the version guard actually applied', async () => {
    const designId = twoPartDesign();
    const version = useDesignStore.getState().designs[designId].version;

    const guarded = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'AAA',
        expectedDesignVersion: version,
      }
    );
    expect(guarded.versionGuardApplied).toBe(true);

    const unguarded = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'TTT',
      }
    );
                                                                                
                                                                           
    expect(unguarded.versionGuardApplied).toBe(false);
  });

  it('tells the agent that validation must be re-run', async () => {
    const designId = twoPartDesign();
    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId,
        junctionIndex: 0,
        sequence: 'AAA',
      }
    );
                                                                       
                                                                  
    expect(result.revalidationRequired).toBe(true);
  });

  it('returns a structured not-found instead of throwing', async () => {
    const result = await execDesignContract<SpacerResult>(
      setJunctionSpacerOutputSchema,
      setJunctionSpacerTool,
      {
        designId: 'nope',
        junctionIndex: 0,
        sequence: 'AAA',
      }
    );
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('nope');
  });
});
