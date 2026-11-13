import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferToolOutput } from 'ai';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  createGetSequenceTool as originalCreateGetSequenceTool,
  sequenceResourceUri,
} from './get-sequence';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { getSequenceOutputSchema } from './sequence-output-schemas';
const createGetSequenceTool = checkedSequenceToolFactory(
  originalCreateGetSequenceTool,
  getSequenceOutputSchema
);

import { execTool, resetCanvasStore } from './test-helpers';
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

function setupGenBankMocks(sequence = 'ATGCGT') {
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(
    genBankContent('pUC19', sequence, [
      {
        displayName: 'AmpR promoter',
        type: 'promoter',
        start: 1179,
        end: 1283,
        direction: 'forward',
      },
    ])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => {
    if (documentId === 'missing-sequence') {
      throw new Error('The sequence source is no longer available in this project.');
    }
    const sourcePath =
      documentId === 'outside-puc19'
        ? '/tmp/outside/pUC19.gb'
        : `${WORKSPACE}/plasmids/${documentId}.gb`;
    return {
      documentId,
      sourcePath,
      ref: { kind: 'catalog-sequence', entityId: documentId },
    };
  });
});

describe('get_sequence — origin-spanning window (circular)', () => {
  it('returns the bases spanning the origin, not a 1-base stub', async () => {
    setupGenBankMocks('AAAACCCCGGGGTTTT');
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{ sequence: string | null; window?: { length: number } }>(
      tool,
      { documentId: 'puc19', start: 15, end: 2, wraps: true }
    );

    expect(result.sequence).toBe('TTAA');
    expect(result.window?.length).toBe(4);
  });

  it('refuses to wrap a LINEAR record', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
    mockPlatform.fs.readTextFile.mockResolvedValue(
      [
        'LOCUS       linearSeq             16 bp    DNA     linear   SYN 01-JAN-2026',
        'DEFINITION  linearSeq.',
        'FEATURES             Location/Qualifiers',
        'ORIGIN',
        '        1 AAAACCCCGGGGTTTT',
        '//',
      ].join('\n')
    );

    const tool = createGetSequenceTool(singleFolder);
    const result = await execTool<{ error?: string; sequence?: string | null }>(tool, {
      documentId: 'puc19',
      start: 15,
      end: 2,
      wraps: true,
    });

    expect(result.error).toMatch(/linear|circular/i);
    expect(result.sequence).toBeUndefined();
  });

  it('refuses a backwards window rather than silently clamping it', async () => {
    setupGenBankMocks('AAAACCCCGGGGTTTT');
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{ error?: string; sequence?: string | null }>(
      tool,
      { documentId: 'puc19', start: 15, end: 2 }
    );

    expect(result.error).toMatch(/wrap|origin|start/i);
  });
});

describe('get_sequence tool', () => {
  it('reads canonical sequence state by stable document ID', async () => {
    setupGenBankMocks();
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{
      exists: boolean;
      documentId: string;
      resourceUri: string;
      name: string;
      format: string;
      length: number;
      sequence: string;
      featureCount: number;
      features: Array<{ name: string; start: number; end: number }>;
    }>(tool, { documentId: 'puc19' });

    expect(result).toMatchObject({
      exists: true,
      documentId: 'puc19',
      resourceUri: sequenceResourceUri('puc19'),
      name: 'pUC19',
      format: 'genbank',
      length: 6,
      sequence: 'ATGCGT',
      featureCount: 1,
      features: [{ name: 'AmpR promoter', start: 1179, end: 1283 }],
    });
  });

  it('accepts a waypoint sequence resource URI', async () => {
    setupGenBankMocks();
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{
      exists: boolean;
      documentId: string;
      resourceUri: string;
    }>(tool, { documentId: sequenceResourceUri('puc19') });

    expect(result).toMatchObject({
      exists: true,
      documentId: 'puc19',
      resourceUri: sequenceResourceUri('puc19'),
    });
  });

  it('rejects a physical path even when it is inside the open workspace', async () => {
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{
      exists: boolean;
      error: string;
    }>(tool, { documentId: `${WORKSPACE}/plasmids/pUC19.gb` });

    expect(result.exists).toBe(false);
    expect(result.error).toContain('Physical sequence paths are deprecated');
  });

  it('does not inline very large sequences', async () => {
    setupGenBankMocks('A'.repeat(50_001));
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{
      exists: boolean;
      sequenceIncluded: boolean;
      sequence: string | null;
      sequencePreview: string;
    }>(tool, { documentId: 'puc19' });

    expect(result.exists).toBe(true);
    expect(result.sequenceIncluded).toBe(false);
    expect(result.sequence).toBeNull();
    expect(result.sequencePreview).toHaveLength(1000);
  });

  it('keeps reference metadata within the native tool budget while retaining every requested base', async () => {
    const bases = 'ACGT'.repeat(10_633) + 'AC';
    setupGenBankMocks(bases);
    const tool = createGetSequenceTool(singleFolder);
    const metadata = await execTool<InferToolOutput<typeof tool>>(tool, { documentId: 'puc19' });
    if (!('sequencePreview' in metadata)) throw new Error('Expected sequence metadata');
    expect(metadata).toMatchObject({ length: 42_534, circular: true, sequenceIncluded: false, sequence: null });
    expect(metadata.sequencePreview).toBe(bases.slice(0, 1000));
    expect(JSON.stringify(metadata).length).toBeLessThan(10_000);
    const window = await execTool<InferToolOutput<typeof tool>>(tool, { documentId: 'puc19', start: 1, end: bases.length });
    if (!('window' in window)) throw new Error('Expected a sequence window');
    expect(window.sequence).toBe(bases);
    expect(window.window).toEqual({ start: 1, end: 42_534, length: 42_534 });
  });

  it('returns exists=false when stable identity has no source', async () => {
    const tool = createGetSequenceTool(singleFolder);

    const result = await execTool<{ exists: boolean; error: string }>(tool, {
      documentId: 'missing-sequence',
    });

    expect(result.exists).toBe(false);
    expect(result.error).toContain('source is no longer available');
  });
});

describe('get_sequence tool — repository source outside mounted workspace', () => {
  const OUTSIDE = '/tmp/outside/pUC19.gb';

  beforeEach(() => {
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });

  afterEach(() => {
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });

  it('serves an open-tab file from the resident store (zero FS read)', async () => {
    const parsed = parseBiologyContent(
      genBankContent('pUC19', 'ATGCGT', [
        {
          displayName: 'AmpR promoter',
          type: 'promoter',
          start: 1179,
          end: 1283,
          direction: 'forward',
        },
      ]),
      OUTSIDE
    );
    useSequenceStore.setState({ sequences: { 'outside-puc19': parsed.sequence } });
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'outside-puc19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'outside-puc19' },
      label: 'pUC19.gb',
    });

    const tool = createGetSequenceTool([]);
    const result = await execTool<{
      exists: boolean;
      documentId: string;
      name: string;
      format: string;
      sequence: string;
      features: Array<{ name: string; start: number; end: number }>;
    }>(tool, { documentId: 'outside-puc19' });

    expect(result.exists).toBe(true);
    expect(result.documentId).toBe('outside-puc19');
    expect(result.name).toBe('pUC19');
    expect(result.format).toBe('genbank');
    expect(result.sequence).toBe('ATGCGT');
    expect(result.features[0]).toMatchObject({ name: 'AmpR promoter', start: 1179, end: 1283 });
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('reads the repository source when the resident cache is empty', async () => {
    setupGenBankMocks();

    const tool = createGetSequenceTool([]);
    const result = await execTool<{ exists: boolean; documentId: string; name: string }>(tool, {
      documentId: 'outside-puc19',
    });

    expect(result.exists).toBe(true);
    expect(result.documentId).toBe('outside-puc19');
    expect(result.name).toBe('pUC19');
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(OUTSIDE);
  });

  it('still errors cleanly for a document whose source is unavailable', async () => {
    const tool = createGetSequenceTool([]);
    const result = await execTool<{ exists: boolean; error: string }>(tool, {
      documentId: 'missing-sequence',
    });

    expect(result.exists).toBe(false);
    expect(result.error).toContain('source is no longer available');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });
});

function genBankContent(
  name: string,
  sequence: string,
  features: Array<{
    displayName: string;
    type: string;
    start: number;
    end: number;
    direction: string;
  }>
): string {
  const featureLines = features.flatMap((feature) => {
    const location =
      feature.direction === 'reverse'
        ? `complement(${feature.start}..${feature.end})`
        : `${feature.start}..${feature.end}`;
    return [
      `     ${feature.type.padEnd(15)} ${location}`,
      `                     /label="${feature.displayName}"`,
    ];
  });
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}
