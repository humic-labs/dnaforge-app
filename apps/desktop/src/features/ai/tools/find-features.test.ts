import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFindFeaturesTool as originalCreateFindFeaturesTool } from './find-features';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { findFeaturesOutputSchema } from './sequence-output-schemas';
const createFindFeaturesTool = checkedSequenceToolFactory(
  originalCreateFindFeaturesTool,
  findFeaturesOutputSchema
);

import { execTool, resetCanvasStore } from './test-helpers';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import { parseBiologyContent } from './parse-biology-file';

const { mockPlatform, mockResolveSequenceDocumentById } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readTextFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  mockResolveSequenceDocumentById: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolveSequenceDocumentById,
  resolveCanonicalSequenceDocumentById: mockResolveSequenceDocumentById,
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

type MockFeature = {
  displayName: string;
  type: string;
  start: number;
  end: number;
  direction: string;
  qualifiers: Record<string, string[]>;
  color?: string;
};

const mockFeatures: MockFeature[] = [
  {
    displayName: 'AmpR',
    type: 'CDS',
    start: 1629,
    end: 2489,
    direction: 'forward',
    qualifiers: { gene: ['bla'], product: ['beta-lactamase'] },
    color: '#3B82F6',
  },
  {
    displayName: 'AmpR promoter',
    type: 'promoter',
    start: 2490,
    end: 2594,
    direction: 'forward',
    qualifiers: { label: ['AmpR promoter'] },
    color: '#22C55E',
  },
  {
    displayName: 'ori',
    type: 'rep_origin',
    start: 2315,
    end: 2686,
    direction: 'none',
    qualifiers: { note: ['high-copy-number ColE1/pMB1/pBR322/pUC origin of replication'] },
    color: '#F97316',
  },
  {
    displayName: 'lacZ-alpha',
    type: 'CDS',
    start: 217,
    end: 596,
    direction: 'forward',
    qualifiers: { gene: ['lacZ'] },
    color: '#3B82F6',
  },
  {
    displayName: 'lac promoter',
    type: 'promoter',
    start: 146,
    end: 216,
    direction: 'forward',
    qualifiers: {},
    color: '#22C55E',
  },
];

function setupGenBankMocks() {
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(genBankContent('pUC19', 2686, mockFeatures));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => {
    const fileNameByDocumentId: Record<string, string> = {
      puc19: 'plasmids/pUC19.gb',
      'seq-fasta': 'seq.fasta',
      'chr11-transcripts': 'chr11.gff3',
      notes: 'notes.txt',
      missing: 'missing.gb',
      big: 'big.gb',
      'outside-puc19': '/tmp/outside/pUC19.gb',
    };
    const sourceName = fileNameByDocumentId[documentId] ?? `${documentId}.gb`;
    return {
      documentId,
      sourcePath: sourceName.startsWith('/') ? sourceName : `${WORKSPACE}/${sourceName}`,
      ref: { kind: 'catalog-sequence', entityId: documentId },
    };
  });
});

describe('find_features tool', () => {
  it('returns all features when no filters', async () => {
    setupGenBankMocks();
    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'puc19',
    });

    expect(result.matchCount).toBe(5);
    expect(result.features).toHaveLength(5);
    expect(result.features[0]).toEqual({
      name: 'AmpR',
      type: 'CDS',
      start: 1629,
      end: 2489,
      direction: 'forward',
    });
  });

  it('filters by query substring (case-insensitive)', async () => {
    setupGenBankMocks();
    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'puc19',
      query: 'amp',
    });

    expect(result.matchCount).toBe(2);
    expect(result.features.map((f: any) => f.name)).toEqual(['AmpR', 'AmpR promoter']);
  });

  it('filters by type (case-insensitive exact match)', async () => {
    setupGenBankMocks();
    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'puc19',
      type: 'CDS',
    });

    expect(result.matchCount).toBe(2);
    expect(result.features.map((f: any) => f.name)).toEqual(['AmpR', 'lacZ-alpha']);
  });

  it('AND logic: query + type narrows results', async () => {
    setupGenBankMocks();
    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'puc19',
      query: 'amp',
      type: 'CDS',
    });

    expect(result.matchCount).toBe(1);
    expect(result.features[0].name).toBe('AmpR');
  });

  it('returns empty features for FASTA file', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
    mockPlatform.fs.readTextFile.mockResolvedValue('>seq\nATCG');

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'seq-fasta',
    });

    expect(result.matchCount).toBe(0);
    expect(result.features).toEqual([]);
  });

  it('parses GFF3 input and surfaces splice structure to the agent (DNA-TG1 Phase 6)', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 2048 } as any);
    mockPlatform.fs.readTextFile.mockResolvedValue(`##gff-version 3
chr11\tDNAForge\tmRNA\t1\t100\t.\t+\t.\tID=tx1;Name=HBB
chr11\tDNAForge\texon\t1\t30\t.\t+\t.\tID=exon1;Parent=tx1
chr11\tDNAForge\texon\t50\t100\t.\t+\t.\tID=exon2;Parent=tx1
chr11\tDNAForge\tCDS\t5\t30\t.\t+\t0\tID=cds1;Parent=tx1
chr11\tDNAForge\tCDS\t50\t90\t.\t+\t0\tID=cds2;Parent=tx1`);

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{
      matchCount: number;
      features: Array<{
        name: string;
        segments?: Array<{ start: number; end: number }>;
        exons?: Array<{ start: number; end: number }>;
        cds?: Array<{ start: number; end: number }>;
        transcriptId?: string;
      }>;
    }>(tool, { documentId: 'chr11-transcripts' });

    expect(result.matchCount).toBe(1);
    expect(result.features[0].name).toBe('HBB');
    expect(result.features[0].segments).toEqual([
      { start: 1, end: 30 },
      { start: 50, end: 100 },
    ]);
    expect(result.features[0].exons?.length).toBe(2);
    expect(result.features[0].cds?.length).toBe(2);
    expect(result.features[0].transcriptId).toBe('tx1');
  });

  it('returns error for non-biology files', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
    mockPlatform.fs.readTextFile.mockResolvedValue('plain text');

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ error: string }>(tool, {
      documentId: 'notes',
    });

    expect(result.error).toContain('not a recognized biology format');
  });

  it('returns error for non-existent file', async () => {
    mockPlatform.fs.stat.mockRejectedValue(new Error('No such file'));

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ error: string }>(tool, {
      documentId: 'missing',
    });

    expect(result.error).toContain('Failed to find features');
  });

  it('caps results at 50', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
    const manyFeatures = Array.from({ length: 60 }, (_, i) => ({
      displayName: `feature_${i}`,
      type: 'misc_feature',
      start: i * 100 + 1,
      end: i * 100 + 50,
      direction: 'forward',
      qualifiers: {},
      color: '#000',
    }));
    mockPlatform.fs.readTextFile.mockResolvedValue(genBankContent('big', 6000, manyFeatures));

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'big',
    });

    expect(result.matchCount).toBe(60);
    expect(result.features).toHaveLength(50);
  });

  it('matches features by qualifier gene', async () => {
    setupGenBankMocks();
    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ matchCount: number; features: any[] }>(tool, {
      documentId: 'puc19',
      query: 'lacZ',
    });

    expect(result.matchCount).toBe(1);
    expect(result.features[0].name).toBe('lacZ-alpha');
  });

  it('returns stable identity without exposing a source path for multi-root workspaces', async () => {
    setupGenBankMocks();
    const multiFolders: WorkspaceFolder[] = [
      { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
      { name: 'Shared', path: '/shared/plasmids', addedAt: 2 },
    ];

    const tool = createFindFeaturesTool(multiFolders);
    const result = await execTool<{ documentId: string; path?: string }>(tool, {
      documentId: 'puc19',
    });

    expect(result.documentId).toBe('puc19');
    expect(result.path).toBeUndefined();
  });
});

describe('find_features tool — repository source outside mounted workspace', () => {
  const OUTSIDE = '/tmp/outside/pUC19.gb';

  beforeEach(() => {
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });

  afterEach(() => {
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });

  it('finds features from the resident store when no workspace is mounted', async () => {
    const parsed = parseBiologyContent(genBankContent('pUC19', 2686, mockFeatures), OUTSIDE);
    useSequenceStore.setState({ sequences: { 'outside-puc19': parsed.sequence } });
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'outside-puc19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'outside-puc19' },
      label: 'pUC19.gb',
    });

    const tool = createFindFeaturesTool([]);
    const result = await execTool<{ documentId: string; matchCount: number; features: any[] }>(
      tool,
      {
        documentId: 'outside-puc19',
        query: 'amp',
      }
    );

    expect(result.documentId).toBe('outside-puc19');
    expect(result.matchCount).toBe(2);
    expect(result.features.map((f) => f.name)).toEqual(['AmpR', 'AmpR promoter']);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('finds features when the repository source is outside the mounted workspace', async () => {
    const parsed = parseBiologyContent(genBankContent('pUC19', 2686, mockFeatures), OUTSIDE);
    useSequenceStore.setState({ sequences: { 'outside-puc19': parsed.sequence } });

    const tool = createFindFeaturesTool(singleFolder);
    const result = await execTool<{ documentId: string; matchCount: number }>(tool, {
      documentId: 'outside-puc19',
    });

    expect(result.documentId).toBe('outside-puc19');
    expect(result.matchCount).toBe(5);
  });

  it('reads and parses the repository source when the resident cache is empty', async () => {
    setupGenBankMocks();

    const tool = createFindFeaturesTool([]);
    const result = await execTool<{ matchCount: number }>(tool, {
      documentId: 'outside-puc19',
      type: 'CDS',
    });

    expect(result.matchCount).toBe(2);
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(OUTSIDE);
  });

  it('rejects a physical path even when no workspace is mounted', async () => {
    const tool = createFindFeaturesTool([]);
    const result = await execTool<{ error: string }>(tool, { documentId: '/tmp/not-open.gb' });

    expect(result.error).toContain('Physical sequence paths are deprecated');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });
});

function genBankContent(name: string, length: number, features: MockFeature[]): string {
  const sequence = 'a'.repeat(length);
  const featureLines = features.flatMap((feature) => {
    const location =
      feature.direction === 'reverse'
        ? `complement(${feature.start}..${feature.end})`
        : `${feature.start}..${feature.end}`;
    const qualifiers = {
      ...feature.qualifiers,
      label: [feature.displayName],
    };
    return [
      `     ${feature.type.padEnd(15)} ${location}`,
      ...Object.entries(qualifiers).flatMap(([key, values]) =>
        (values as string[]).map((value) => `                     /${key}="${value}"`)
      ),
    ];
  });
  return [
    `LOCUS       ${name.padEnd(16)} ${String(length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}
