import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  stat: vi.fn(),
  operation: vi.fn(),
  open: vi.fn(),
  ngsImport: vi.fn(),
  retain: vi.fn(),
  variantSource: vi.fn(),
  variantImport: vi.fn(),
  variantLoad: vi.fn(),
  inspectCall: vi.fn(),
  inspectMutation: vi.fn(),
  waitProtein: vi.fn(),
  selectProtein: vi.fn(),
  activate: vi.fn(),
  findTab: vi.fn(),
}));
vi.mock('./path-utils', () => ({
  loadSequenceDocumentBiologyFile: mocks.load,
  normalizeSequenceDocumentId: (id: string) => id,
  getUserFolders: (folders: unknown) => folders,
  resolveMultiRootPath: (_folders: unknown, path: string) => ({
    absolutePath: `/project/${path}`,
    folder: { path: '/project' },
  }),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: { stat: mocks.stat } }) }));
vi.mock('../../../services/managed-operations', () => ({
  managedOperations: { getOperation: mocks.operation },
}));
vi.mock('./open-tab', () => ({ openTabInCanvas: mocks.open }));
vi.mock('../../sequence/public/store', () => ({
  useSequenceStore: { getState: () => ({ getSequence: () => null }) },
}));
vi.mock('../../alignment-manager/public/ngs-read-analysis', () => ({
  importNgsReadAnalysis: mocks.ngsImport,
  retainNgsReadOperation: mocks.retain,
}));
vi.mock('../../sequence/public/variant-source-operation-client', () => ({
  waitForVariantSourceResult: mocks.variantSource,
}));
vi.mock('../../alignment-manager/public/variant-analysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../alignment-manager/public/variant-analysis')>()),
  activateVariantAnalysis: mocks.activate,
  importSequenceVariantAnalysis: mocks.variantImport,
  inspectVariantAnalysisCall: mocks.inspectCall,
  loadVariantAnalysis: mocks.variantLoad,
}));
vi.mock('../../alignment-manager/public/variant-protein-measurement', async () => {
  const { z } = await import('zod');
  return {
    variantProteinMeasurementOptionsSchema: z.object({}),
    applyVariantProteinMeasurement: vi.fn(),
  };
});
vi.mock('../../structure-drawer/public/api/protein-identity', () => ({
  sha256Hex: () => 'reference-sha',
}));
vi.mock('../../structure-drawer/public/state/selected-codon-registry', () => ({
  getWorkspaceResidueSelectionsStore: () => ({}),
}));
vi.mock('../../structure-drawer/public/inspection-allele', () => ({
  selectInspectionProteinProduct: mocks.selectProtein,
  waitForInspectionProteinProduct: mocks.waitProtein,
}));
vi.mock('../../alignment-manager/public/inspect-mutation-protein', () => ({
  inspectMutationProtein: mocks.inspectMutation,
}));
vi.mock('../../structure-drawer/public/structure-inspection', () => ({
  structureInspectionId: () => 'inspection-one',
}));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({ findTab: mocks.findTab, setTabViewState: vi.fn() }),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock('../../alignment-manager/public/store', () => ({
  useVerificationStore: {
    getState: () => ({
      registerReferenceSource: vi.fn(),
      checkStaleness: vi.fn(),
      setActiveSession: vi.fn(),
      setSessionViewPreferences: vi.fn(),
      referenceFileChecksums: { reference: 'reference-sha' },
      staleReferences: {},
      staleSessionIds: {},
      verificationState: {
        reference: {
          sessions: [
            {
              id: 'session',
              tracks: [{ id: 'track', mutations: [{ id: 'mutation', position: 4 }] }],
            },
          ],
        },
      },
    }),
  },
}));

import {
  createAnalyzeNgsReadsTool,
  createGetNgsAnalysisTool,
  analyzeNgsReadsSchema,
} from './ngs-read-analysis';
import {
  createStartSequenceVariantTool,
  createImportSequenceVariantTool,
  createGetVariantAnalysisTool,
  createInspectVariantCallTool,
} from './sequence-variant-analysis';
import { createInspectSequenceVariantTool } from './clone-protein-workflow';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { assertToolOperationResult } from '../../agent-bridge/public/tool-result';
import {
  analyzeNgsReadsOutputSchema,
  getNgsAnalysisOutputSchema,
  startVariantCallsOutputSchema,
  importVariantCallsOutputSchema,
  getVariantAnalysisOutputSchema,
  inspectVariantCallOutputSchema,
  inspectSequenceVariantOutputSchema,
} from './sequence-output-schemas';
import {
  handleSeqListAnnotations,
  seqListAnnotationsOutputSchema,
} from '../../agent-bridge/sequence-tools';

const folders = [{ path: '/project', name: 'Project', addedAt: 1 }];
const options = { toolCallId: 'sequence-contract', messages: [] };
const call = {
  id: 'allele-one',
  position: 4,
  allele_index: 1,
  reference: 'A',
  alternate: 'G',
  filters: ['PASS'],
  genotype: '0/1',
  quality: 50,
  reference_count: 10,
  alternate_count: 5,
  total_allele_count: 15,
  allele_fraction: 1 / 3,
};
const analysis = {
  analysisId: 'analysis-one',
  documentId: 'reference',
  name: 'Calls',
  sample: 'sample-one',
  sourceIdentity: 'source-one',
  referenceSha256: 'reference-sha',
  countBasis: 'allele counts',
  calls: [call],
};
const readEvidence = {
  sourceSha256: 'reads-sha',
  referenceSha256: 'reference-sha',
  totalReads: 10,
  totalBases: 40,
  mappedReads: 8,
  unmappedReads: 2,
  mappingQualityReads: 7,
  coverage: [2, 0, 3, 4],
  circularMethod: 'linear',
  versions: { minimap2: '2.28' },
  countBasis: 'pileup reads',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({
    documentId: 'reference',
    name: 'Reference',
    sourcePath: '/project/reference.gb',
    biology: {
      format: 'genbank',
      sequence: { name: 'Reference', sequence: 'ATGA', length: 4, circular: false, annotations: [] },
      features: [
        {
          displayName: 'Feature',
          type: 'CDS',
          start: 1,
          end: 4,
          direction: 'forward',
          qualifiers: { gene: ['example'], locus_tag: ['tag-one'] },
        },
      ],
    },
  });
  mocks.stat.mockImplementation(async (path: string) => ({
    isFile: path !== '/project',
    canonicalPath: path,
  }));
  mocks.open.mockResolvedValue({});
  mocks.operation.mockResolvedValue({
    id: 'operation-one',
    kind: 'variant-source-preparation',
    state: 'succeeded',
    error: null,
  });
  mocks.variantSource.mockResolvedValue({
    sourcePath: '/project/calls.vcf',
    samples: ['sample-one'],
  });
  mocks.variantImport.mockResolvedValue({ analysisId: 'analysis-one', data: analysis });
  mocks.variantLoad.mockResolvedValue(analysis);
  mocks.inspectCall.mockReturnValue(null);
  mocks.inspectMutation.mockReturnValue(null);
  mocks.findTab.mockReturnValue({ panelId: 'panel-one', tabId: 'tab-one' });
  mocks.waitProtein.mockResolvedValue({
    proteinProduct: 'reference',
    sequence: 'M',
    inspectionTarget: { document_id: 'reference', protein_key: 'protein-one' },
    structureViewId: 'view-one',
    structureError: null,
    structureStatus: 'ready',
    message: 'Protein viewer ready.',
  });
  mocks.ngsImport.mockResolvedValue({
    analysisId: 'analysis-one',
    data: {
      ...analysis,
      readEvidence,
    },
  });
});

async function checked(schema: Parameters<typeof assertMcpOutput>[0], result: unknown) {
  assertToolOperationResult(result);
  expect(result).toMatchObject({ ok: true });
  assertMcpOutput(schema, result);
  return result;
}

describe('sequence analysis MCP output contracts', () => {
  it('describes real raw-read and VCF preparation data without starting compute in the renderer', async () => {
    const prepared = await createAnalyzeNgsReadsTool(folders).execute!(
      analyzeNgsReadsSchema.parse({
        documentId: 'reference',
        path: 'reads.fastq',
        name: 'Reads',
        preset: 'sr',
      }),
      options
    );
    await checked(analyzeNgsReadsOutputSchema, prepared);
    expect(prepared).toMatchObject({
      input: { minDepth: 10, minBaseQuality: 20, referenceSequence: 'ATGA' },
    });
    await checked(
      startVariantCallsOutputSchema,
      await createStartSequenceVariantTool(folders).execute!(
        { documentId: 'reference', path: 'calls.vcf', chrom: 'chr1' },
        options
      )
    );
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it('reports imported raw-read accounting and failed-job observations as separate successful shapes', async () => {
    mocks.operation.mockResolvedValueOnce({ kind: 'ngs-read-analysis', state: 'succeeded' });
    const imported = await createGetNgsAnalysisTool(folders).execute!(
      { documentId: 'reference', operationId: 'operation-one', name: 'Reads' },
      options
    );
    await checked(getNgsAnalysisOutputSchema, imported);
    expect(imported).toMatchObject({
      totalReads: 10,
      mappedReads: 8,
      unmappedReads: 2,
      uncoveredBases: 1,
    });
    mocks.operation.mockResolvedValueOnce({
      kind: 'ngs-read-analysis',
      state: 'failed',
      error: { code: 'READS_FAILED', message: 'Aligner failed', details: { exitCode: 1 } },
    });
    const failedJob = await createGetNgsAnalysisTool(folders).execute!(
      { documentId: 'reference', operationId: 'operation-one', name: 'Reads' },
      options
    );
    await checked(getNgsAnalysisOutputSchema, failedJob);
    expect(failedJob).toMatchObject({ ok: true, status: 'failed' });
    expect(mocks.ngsImport).toHaveBeenCalledTimes(1);
  });

  it('preserves VCF pending, sample-choice, and imported-result models', async () => {
    const tool = createImportSequenceVariantTool(folders);
    const input = {
      documentId: 'reference',
      operationId: 'operation-one',
      chrom: 'chr1',
      name: 'Calls',
    };
    mocks.operation.mockResolvedValueOnce({
      kind: 'variant-source-preparation',
      state: 'running',
      error: null,
    });
    await checked(importVariantCallsOutputSchema, await tool.execute!(input, options));
    mocks.variantSource.mockResolvedValueOnce({
      sourcePath: '/project/calls.vcf',
      samples: ['one', 'two'],
    });
    const choose = await tool.execute!(input, options);
    await checked(importVariantCallsOutputSchema, choose);
    expect(choose).toMatchObject({ status: 'choose-sample', samples: ['one', 'two'] });
    const imported = await tool.execute!(input, options);
    await checked(importVariantCallsOutputSchema, imported);
    expect(imported).toMatchObject({ status: 'imported', calls: [call] });
    const malformed = { ...imported, calls: [{ ...call, quality: 'high' }] };
    expect(() => assertMcpOutput(importVariantCallsOutputSchema, malformed)).toThrow(
      'MCP output contract rejected factory data'
    );
  });

  it.each(['raw reads', 'imported VCF', 'saved page'])(
    'validates real coding context and exact inspection arguments from %s',
    async (source) => {
      mocks.load.mockResolvedValue({
        documentId: 'reference',
        name: 'Reference',
        biology: {
          sequence: {
            name: 'Reference',
            sequence: 'ATGAAATAA',
            length: 9,
            circular: false,
            annotations: [
              { id: 'cds', name: 'reporter', type: 'CDS', start: 1, end: 9, direction: 1 },
            ],
          },
        },
      });
      let result: unknown;
      const schema = source === 'raw reads' ? getNgsAnalysisOutputSchema
        : source === 'imported VCF' ? importVariantCallsOutputSchema : getVariantAnalysisOutputSchema;
      if (source === 'raw reads') {
        mocks.operation.mockResolvedValue({ kind: 'ngs-read-analysis', state: 'succeeded' });
        result = await createGetNgsAnalysisTool(folders).execute!(
          { documentId: 'reference', operationId: 'operation-one', name: 'Reads' }, options
        );
      } else if (source === 'imported VCF') {
        result = await createImportSequenceVariantTool(folders).execute!(
          { documentId: 'reference', operationId: 'operation-one', chrom: 'chr1', name: 'Calls' }, options
        );
      } else {
        result = await createGetVariantAnalysisTool(folders).execute!(
          { analysisId: 'analysis-one', offset: 0, limit: 100 }, options
        );
      }
      await checked(schema, result);
      const parsed = schema.parse(result);
      if (!('calls' in parsed)) throw new Error('Expected imported calls');
      const mapped = parsed.calls[0];
      expect(mapped).toMatchObject({
        proteinContext: {
          status: 'mapped', label: 'reporter', residues: [2], effect: 'missense',
          changes: [{ residue: 2, reference: 'K', alternate: 'E' }],
        },
        inspection: { tool: 'inspect_variant_call', arguments: { analysisId: 'analysis-one', callId: call.id } },
      });
      if (!('inspection' in mapped)) throw new Error('Expected an exact inspection continuation');
      const { inspection: _inspection, ...missingInspection } = mapped;
      for (const malformed of [
        missingInspection,
        { ...mapped, proteinContext: { ...mapped.proteinContext, residues: ['2'] } },
        { ...mapped, inspection: { ...mapped.inspection, arguments: { analysisId: 'analysis-one' } } },
        { ...mapped, unexpected: true },
      ]) {
        expect(() => assertMcpOutput(schema, { ...parsed, calls: [malformed] })).toThrow(
          'MCP output contract rejected factory data'
        );
      }
    }
  );

  it('keeps a completed raw-read population and its next-page instructions inside the strict contract', async () => {
    const calls = Array.from({ length: 106 }, (_, index) => ({ ...call, id: `allele-${index}` }));
    mocks.operation.mockResolvedValue({ kind: 'ngs-read-analysis', state: 'succeeded' });
    mocks.ngsImport.mockResolvedValue({
      analysisId: 'analysis-one', data: { ...analysis, calls, readEvidence },
    });
    const result = await createGetNgsAnalysisTool(folders).execute!(
      { documentId: 'reference', operationId: 'operation-one', name: 'Reads' }, options
    );
    await checked(getNgsAnalysisOutputSchema, result);
    expect(result).toMatchObject({
      callCount: 106, totalReads: 10, mappedReads: 8, unmappedReads: 2, nextOffset: 25,
      continuationTool: 'get_variant_analysis',
      continuation: { tool: 'get_variant_analysis', arguments: { analysisId: 'analysis-one', offset: 25, limit: 25 } },
    });
    const parsed = getNgsAnalysisOutputSchema.parse(result);
    if (parsed.status !== 'imported') throw new Error('Expected imported reads');
    expect(parsed.calls).toHaveLength(25);
    expect(parsed.calls.every((entry) => entry.proteinContext.status === 'unavailable')).toBe(true);
    expect(() => assertMcpOutput(getNgsAnalysisOutputSchema, {
      ...parsed, continuation: { tool: 'get_variant_analysis', arguments: { offset: 25, limit: 25 } },
    })).toThrow('MCP output contract rejected factory data');
  });

  it('returns typed paged saved calls, including a successful empty page', async () => {
    const tool = createGetVariantAnalysisTool(folders);
    const result = await tool.execute!(
      { analysisId: 'analysis-one', offset: 0, limit: 100 },
      options
    );
    await checked(getVariantAnalysisOutputSchema, result);
    expect(result).toMatchObject({ stale: false, calls: [call] });
    const empty = await tool.execute!(
      { analysisId: 'analysis-one', offset: 0, limit: 100, start: 100 },
      options
    );
    await checked(getVariantAnalysisOutputSchema, empty);
    expect(empty).toMatchObject({ matchingCalls: 0, calls: [] });
  });

  it('reports the actual protein inspection identities for VCF calls and clone mutations', async () => {
    const variant = await createInspectVariantCallTool(folders).execute!(
      { analysisId: 'analysis-one', callId: 'allele-one', proteinProduct: 'allele' },
      options
    );
    await checked(inspectVariantCallOutputSchema, variant);
    expect(mocks.selectProtein).toHaveBeenCalledWith('reference', 'allele');
    const clone = await createInspectSequenceVariantTool(folders).execute!(
      { documentId: 'reference', sessionId: 'session', trackId: 'track', mutationId: 'mutation' },
      options
    );
    await checked(inspectSequenceVariantOutputSchema, clone);
    expect(clone).toMatchObject({ inspectionId: 'inspection-one', position: 4, status: 'ready' });
  });

  it('validates actual paged annotation data and successful empty matches', async () => {
    const result = await handleSeqListAnnotations(
      { documentId: 'reference', limit: 1 },
      { folders }
    );
    await checked(seqListAnnotationsOutputSchema, result);
    expect(result).toMatchObject({
      returned: 1,
      annotations: [{ rawIndex: 0, geneName: 'example', locusTag: 'tag-one' }],
    });
    const empty = await handleSeqListAnnotations(
      { documentId: 'reference', kind: 'promoter' },
      { folders }
    );
    await checked(seqListAnnotationsOutputSchema, empty);
    expect(empty).toMatchObject({ returned: 0, annotations: [] });
    expect(() =>
      assertMcpOutput(seqListAnnotationsOutputSchema, {
        ...result,
        annotations: [{ ...result.annotations[0], rawIndex: 'zero' }],
      })
    ).toThrow('MCP output contract rejected factory data');
  });
});
