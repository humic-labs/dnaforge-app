import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { addDesignRegionOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useDesignStore } from '../../design/store';
import { createAddDesignRegionTool } from './add-design-region';

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

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function mockParsedSource({
  sequence = 'AACCGGTTAACC',
  circular = true,
}: {
  sequence?: string;
  circular?: boolean;
} = {}) {
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(
    genBankContent('pUC19', sequence, circular, [
      {
        displayName: 'AmpR promoter',
        type: 'promoter',
        start: 3,
        end: 8,
        direction: 'forward',
        color: '#22C55E',
      },
    ])
  );
}

describe('add_design_region tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDesignStore();
    mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => ({
      documentId,
      sourcePath: `${WORKSPACE}/plasmids/pUC19.gb`,
      ref: { kind: 'catalog-sequence', entityId: documentId },
    }));
  });

  it('adds a source sequence range to an existing design', async () => {
    mockParsedSource();
    const designId = useDesignStore.getState().createDesign('Derivative', 'circular', 'gibson');
    const tool = createAddDesignRegionTool(singleFolder);

    const result = await execDesignContract<{
      regionId: string;
      length: number;
      regionCount: number;
      sourceStart1Indexed: number;
      sourceEnd1Indexed: number;
      annotationCount: number;
      version: number;
      previousVersion: number;
      mutation: {
        operationId: string;
        effect: string;
        beforeVersion: number | null;
        afterVersion: number | null;
        target: { type: string; id: string };
        expected: { regionId: string; regionCount: number; length: number };
      };
    }>(addDesignRegionOutputSchema, tool, {
      designId,
      documentId: 'puc19',
      start: 3,
      end: 8,
      label: 'AmpR promoter',
    });

    const design = useDesignStore.getState().designs[designId];
    expect(result).toMatchObject({
      regionId: expect.any(String),
      length: 6,
      regionCount: 1,
      sourceStart1Indexed: 3,
      sourceEnd1Indexed: 8,
      annotationCount: 1,
      version: 1,
      previousVersion: 0,
    });
    expect(result.mutation).toMatchObject({
      operationId: 'test',
      effect: 'added_design_region',
      beforeVersion: 0,
      afterVersion: 1,
      target: { type: 'design', id: designId },
      expected: {
        regionId: result.regionId,
        regionCount: 1,
        length: 6,
      },
    });
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(`${WORKSPACE}/plasmids/pUC19.gb`);
    expect(design.regions).toHaveLength(1);
    expect(design.regions[0]).toMatchObject({
      id: result.regionId,
      sourceSequenceId: 'puc19',
      sourceSequenceName: 'AmpR promoter',
      sourceStart: 2,
      sourceEnd: 8,
      sourceLength: 12,
      sourceIsCircular: true,
      sequence: 'CCGGTT',
      sourceType: 'pcr',
    });
    expect(design.regions[0].annotations).toEqual([
      expect.objectContaining({
        name: 'AmpR promoter',
        start: 0,
        end: 6,
        strand: 'forward',
      }),
    ]);
    expect(design.assemblyState).toBe('drafting');
  });

  it('adds a stable source document from another open project', async () => {
    const folders: WorkspaceFolder[] = [
      { name: 'My Project', path: '/home/user/my-project', addedAt: 1 },
      { name: 'DNAForge Samples', path: '/home/user/samples', addedAt: 2 },
    ];
    mockResolveSequenceDocumentById.mockResolvedValueOnce({
      documentId: 'sample-pgex',
      sourcePath: '/home/user/samples/sequences/pGEX-4T-1.gb',
      ref: { kind: 'catalog-sequence', entityId: 'sample-pgex' },
    });
    mockParsedSource();
    const designId = useDesignStore
      .getState()
      .createDesign('My Project design', 'circular', 'gibson');

    const result = await execDesignContract<{
      regionId: string;
      sourceDocumentId: string;
      length: number;
    }>(addDesignRegionOutputSchema, createAddDesignRegionTool(folders), {
      designId,
      documentId: 'sample-pgex',
      start: 3,
      end: 8,
    });

    expect(result).toMatchObject({
      regionId: expect.any(String),
      sourceDocumentId: 'sample-pgex',
      length: 6,
    });
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(
      '/home/user/samples/sequences/pGEX-4T-1.gb'
    );
  });

  it('returns an error when the target design does not exist', async () => {
    const tool = createAddDesignRegionTool(singleFolder);

    const result = await execDesignContract<{ error: string; regionId: null }>(
      addDesignRegionOutputSchema,
      tool,
      {
        designId: 'missing-design',
        documentId: 'puc19',
      }
    );

    expect(result.regionId).toBeNull();
    expect(result.error).toContain('Design not found');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('supports wrapped ranges on circular sequences', async () => {
    mockParsedSource({ sequence: 'AACCGGTTAACC', circular: true });
    const designId = useDesignStore.getState().createDesign('Wrapped', 'circular', 'gibson');
    const tool = createAddDesignRegionTool(singleFolder);

    const result = await execDesignContract<{
      length: number;
      wraps: boolean;
      regionCount: number;
    }>(addDesignRegionOutputSchema, tool, {
      designId,
      documentId: 'puc19',
      start: 10,
      end: 3,
      wraps: true,
      label: 'origin-spanning fragment',
    });

    const region = useDesignStore.getState().designs[designId].regions[0];
    expect(result).toMatchObject({ length: 6, wraps: true, regionCount: 1 });
    expect(region).toMatchObject({
      sourceSequenceName: 'origin-spanning fragment',
      sourceStart: 9,
      sourceEnd: 3,
      sourceLength: 12,
      sourceIsCircular: true,
      sequence: 'ACCAAC',
    });
  });

  it('rejects wraps=true for ranges that do not cross the origin', async () => {
    mockParsedSource({ sequence: 'AACCGGTTAACC', circular: true });
    const designId = useDesignStore.getState().createDesign('Wrapped', 'circular', 'gibson');
    const tool = createAddDesignRegionTool(singleFolder);

    const result = await execDesignContract<{ error: string; regionId: null }>(
      addDesignRegionOutputSchema,
      tool,
      {
        designId,
        documentId: 'puc19',
        start: 3,
        end: 8,
        wraps: true,
      }
    );

    expect(result.regionId).toBeNull();
    expect(result.error).toContain('cross the origin');
    expect(useDesignStore.getState().designs[designId].regions).toEqual([]);
  });
});

function genBankContent(
  name: string,
  sequence: string,
  circular: boolean,
  features: Array<{
    displayName: string;
    type: string;
    start: number;
    end: number;
    direction: string;
  }>
): string {
  const topology = circular ? 'circular' : 'linear';
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
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     ${topology} SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}
