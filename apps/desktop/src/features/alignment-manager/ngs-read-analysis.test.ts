import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
const mocked = vi.hoisted(() => ({ getOperation: vi.fn(), getResult: vi.fn(), persist: vi.fn() }));
vi.mock('../../services/managed-operations', () => ({ managedOperations: mocked }));
vi.mock('./variant-analysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./variant-analysis')>()),
  persistVariantAnalysis: mocked.persist,
}));
import { importNgsReadAnalysis } from './ngs-read-analysis';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
const sequence = {
  sequence: 'ACGT'.repeat(30),
  circular: true,
  annotations: [],
  name: 'Reference',
} as AnnotatedSequence;
const evidence = () => ({
  documentId: 'dna-1',
  inputRevision: 'revision-1',
  sourceLabel: 'reads.fastq',
  sourceSha256: 'a'.repeat(64),
  referenceSha256: sha256Hex(sequence.sequence),
  totalReads: 6,
  totalBases: 1200,
  mappedReads: 5,
  unmappedReads: 1,
  mappingQualityReads: 5,
  coverage: Array(120).fill(5),
  circularMethod: 'two-origins-central-half',
  settings: {
    documentId: 'dna-1',
    readPath: '/fixture/reads.fastq',
    referenceSequence: sequence.sequence,
    isCircular: true,
    preset: 'sr',
    minBaseQuality: 20,
    minMappingQuality: 20,
    minDepth: 3,
    minAlternateCount: 3,
    minAlleleFraction: 0.5,
    threads: 2,
  },
  versions: { minimap2: 'fixture' },
  commands: [['minimap2']],
  artifacts: [
    {
      originOffset: 0,
      alignmentPath: '/fixture/alignment.bam',
      referencePath: '/fixture/reference.fa',
      pileupPath: '/fixture/pileup.vcf',
      alignmentSha256: 'b'.repeat(64),
      pileupSha256: 'c'.repeat(64),
    },
  ],
  excludedAlleles: 0,
  countBasis: 'AD',
  calls: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  mocked.getOperation.mockResolvedValue({
    kind: 'ngs-read-analysis',
    state: 'succeeded',
    subject: { input_revision: 'revision-1' },
  });
  mocked.getResult.mockResolvedValue({
    kind: 'ngs-read-analysis',
    operation_id: 'job-1',
    status: 'available',
    result: evidence(),
  });
  mocked.persist.mockImplementation((data, id) => ({ data, analysisId: id }));
});
describe('completed raw-read import boundary', () => {
  it('uses the job identity for restart-safe persistence and retains all evidence', async () => {
    const imported = await importNgsReadAnalysis('job-1', 'dna-1', sequence, 'Reads');
    expect(imported.analysisId).toBe('job-1');
    expect(imported.data.readEvidence).toMatchObject({
      operationId: 'job-1',
      totalReads: 6,
      sourceSha256: 'a'.repeat(64),
    });
  });
  it('imports a web job result whose alignment files were not retained', async () => {
    mocked.getResult.mockResolvedValue({
      kind: 'ngs-read-analysis',
      operation_id: 'job-1',
      status: 'available',
      result: { ...evidence(), artifacts: [] },
    });
    const imported = await importNgsReadAnalysis('job-1', 'dna-1', sequence, 'Reads');
    expect(imported.data.readEvidence).toMatchObject({ operationId: 'job-1', artifacts: [] });
  });
  for (const [label, change] of [
    ['wrong operation revision', { inputRevision: 'old' }],
    ['incomplete read accounting', { unmappedReads: 0 }],
    ['impossible qualified count', { mappingQualityReads: 6 }],
    ['stale reference hash', { referenceSha256: '0'.repeat(64) }],
    ['wrong document', { documentId: 'another' }],
  ] as const)
    it(`refuses ${label} without saving`, async () => {
      mocked.getResult.mockResolvedValue({
        kind: 'ngs-read-analysis',
        operation_id: 'job-1',
        status: 'available',
        result: { ...evidence(), ...change },
      });
      await expect(importNgsReadAnalysis('job-1', 'dna-1', sequence, 'Reads')).rejects.toThrow(
        'does not match'
      );
      expect(mocked.persist).not.toHaveBeenCalled();
    });
  it('refuses a topology edit even when reference bases are unchanged', async () => {
    await expect(
      importNgsReadAnalysis('job-1', 'dna-1', { ...sequence, circular: false }, 'Reads')
    ).rejects.toThrow('does not match');
    expect(mocked.persist).not.toHaveBeenCalled();
  });
  it('never imports a nonterminal job', async () => {
    mocked.getOperation.mockResolvedValue({ kind: 'ngs-read-analysis', state: 'running' });
    await expect(importNgsReadAnalysis('job-1', 'dna-1', sequence, 'Reads')).rejects.toThrow(
      'running'
    );
    expect(mocked.getResult).not.toHaveBeenCalled();
  });
});
