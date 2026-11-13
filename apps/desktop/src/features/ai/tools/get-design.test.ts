import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { getDesignOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import type { DesignRegion } from '../../design/types';
import { getDesignTool } from './get-design';
import { buildRealAssemblyPipelineDesign } from '../../../test/scenarios/assembly-real-pipeline';
import { deriveAssemblyIssues } from '../../assembly/issues/assembly-issues';

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

describe('get_design tool', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('reads canonical design state by id', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Derivative', 'circular', 'gibson');
    store.addRegion(designId, region('AmpR promoter', 'A'.repeat(105)));

    const result = await execDesignContract<{
      exists: boolean;
      designId: string;
      resourceUri: string;
      name: string;
      assemblyMethod: string;
      version: number;
      regionCount: number;
      regions: Array<{ sourceSequenceName: string; length: number }>;
    }>(getDesignOutputSchema, getDesignTool, { designId });

    expect(result).toMatchObject({
      exists: true,
      designId,
      resourceUri: `waypoint://design/${encodeURIComponent(designId)}`,
      name: 'Derivative',
      assemblyMethod: 'gibson',
      version: 1,
      regionCount: 1,
      regions: [{ sourceSequenceName: 'AmpR promoter', length: 105 }],
    });
  });

  it('accepts a waypoint design resource URI', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Derivative', 'circular', 'gibson');

    const result = await execDesignContract<{
      exists: boolean;
      designId: string;
      resourceUri: string;
      name: string;
    }>(getDesignOutputSchema, getDesignTool, {
      designId: `waypoint://design/${encodeURIComponent(designId)}`,
    });

    expect(result).toMatchObject({
      exists: true,
      designId,
      resourceUri: `waypoint://design/${encodeURIComponent(designId)}`,
      name: 'Derivative',
    });
  });

  it('returns exists=false for a missing design', async () => {
    const result = await execDesignContract<{
      exists: boolean;
      designId: string;
      resourceUri: string;
      error: string;
    }>(getDesignOutputSchema, getDesignTool, { designId: 'missing-design' });

    expect(result).toMatchObject({
      exists: false,
      designId: 'missing-design',
      resourceUri: 'waypoint://design/missing-design',
    });
    expect(result.error).toContain('Design not found');
  });

  it('bounds large composed-sequence payloads while preserving length and a preview', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Large construct', 'linear', 'gibson');
    store.addRegion(designId, region('large part', 'ACGT'.repeat(15_000)));

    const result = await execDesignContract<{
      composedSequenceLength: number;
      composedSequenceIncluded: boolean;
      composedSequence: string | null;
      composedSequencePreview: string | null;
    }>(getDesignOutputSchema, getDesignTool, { designId });

    expect(result.composedSequenceLength).toBe(60_000);
    expect(result.composedSequenceIncluded).toBe(false);
    expect(result.composedSequence).toBeNull();
    expect(result.composedSequencePreview).toBe('ACGT'.repeat(250));
  });

  it('reports the actual Tm model and whether authoritative verification is pending', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Q5 construct', 'linear', 'gibson');
    store.addRegion(designId, region('Q5 template', 'AAAACCCC' + 'A'.repeat(40) + 'CCCCAAAA'));
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          pcrPolymerase: 'q5',
          designPrimers: [
            {
              fragmentIndex: 0,
              forward: {
                id: 'f',
                name: 'f',
                direction: 'forward',
                fragmentIndex: 0,
                junctionIndex: 0,
                sequence: 'AAAACCCC',
                pbs: { start: 0, end: 8, sequence: 'AAAACCCC' },
                overhang: { length: 0, sequence: '' },
                tm: 50,
              },
              reverse: {
                id: 'r',
                name: 'r',
                direction: 'reverse',
                fragmentIndex: 0,
                junctionIndex: 0,
                sequence: 'TTTTGGGG',
                pbs: { start: 0, end: 8, sequence: 'TTTTGGGG' },
                overhang: { length: 0, sequence: '' },
                tm: 50,
              },
            },
          ],
        },
      },
    }));

    const result = await execDesignContract<{
      tmResolution: {
        model: { kind: string; prodcode?: string };
        source: string;
        pendingNebVerification: boolean;
        primerCount: number;
        verifiedPrimerCount: number;
      };
    }>(getDesignOutputSchema, getDesignTool, { designId });

    expect(result.tmResolution).toMatchObject({
      model: { kind: 'neb', prodcode: 'q5-0' },
      source: 'reaction',
      pendingNebVerification: true,
      primerCount: 2,
      verifiedPrimerCount: 0,
    });
  });

  it('projects the exact persisted Golden Gate schema and MoClo run for UI/agent parity', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Schema projection', 'circular', 'goldengate');
    const schema = {
      id: 'custom-schema',
      name: 'Custom schema',
      revision: 1,
      origin: { type: 'custom' as const },
      enzyme: 'BsaI' as const,
      slots: [
        {
          id: 'slot-1',
          label: 'Regulatory part',
          outgoingOverhang: 'AATG',
          preferredRoles: [{ id: 'SO:0000167', label: 'Promoter' }],
        },
      ],
    };
    store.setGoldenGateSchema(designId, schema, 0);
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          mocloFactory: {
            runId: 'factory-run-1',
            kitId: 'ytk',
            kitRevision: 1,
            recipeId: 'ytk-multigene-device',
            stageId: 'expression-cassette',
            stageInputs: [],
          },
        },
      },
    }));

    const result = await execDesignContract<{ goldenGateSchema: unknown; mocloFactory: unknown }>(
      getDesignOutputSchema,
      getDesignTool,
      { designId }
    );

    expect(result.goldenGateSchema).toEqual(schema);
    expect(result.mocloFactory).toEqual({
      runId: 'factory-run-1',
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
      stageId: 'expression-cassette',
      stageInputs: [],
    });
  });
});

describe('get_design — assembly issues  C1: the false-clean)', () => {
  beforeEach(() => {
    resetDesignStore();
  });

  it('surfaces an internal Type IIS site that design.validationErrors structurally cannot carry', async () => {
                                                                               
                                                                               
                                                                     
    const design = buildRealAssemblyPipelineDesign('goldengate-invalid-internal-site');
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

                                                            
    const issues = deriveAssemblyIssues({ design });
    const internal = issues.filter((issue) => issue.kind === 'gg-internal-site');
    expect(internal.length).toBeGreaterThan(0);
    expect(internal[0].severity).toBe('error');

                                                                               
                                                                       
                                                                               
                                                                           
    expect(internal[0].gates.run).toBe(false);
    expect(internal[0].gates.finalize).toBe(true);
    expect(design.validationErrors.some((e) => e.code.includes('internal'))).toBe(false);

    const result = await execDesignContract<{
      validationErrorCount: number;
      assemblyIssues: Array<{
        kind: string;
        severity: string;
        gates: { run: boolean; finalize: boolean; export: boolean };
        title: string;
        detail: string;
      }>;
      blocksFinalize: boolean;
    }>(getDesignOutputSchema, getDesignTool, { designId: design.id });

                                                                                
                                                                          
    expect(result.assemblyIssues).toBeDefined();
    const reported = result.assemblyIssues.filter((issue) => issue.kind === 'gg-internal-site');
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0].severity).toBe('error');
    expect(reported[0].gates.finalize).toBe(true);

                                                                            
                             
    expect(result.blocksFinalize).toBe(true);
  });
});
