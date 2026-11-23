import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createListFilesTool, listFilesSchema } from './list-files';
import { execTool as executeTool } from './test-helpers';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolResultDisplay } from '../../../components/chat/ToolResultDisplay';
import type { DocumentAvailabilityProbe } from '../../../shared/document-availability';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readDir: vi.fn().mockResolvedValue([]),
      readTextFileSlice: vi.fn().mockResolvedValue({ text: '', bytesRead: 0 }),
      exists: vi.fn().mockResolvedValue(false),
    },
    workspace: {} as { checkDocument?: (request: { path: string }) => Promise<DocumentAvailabilityProbe> },
  },
}));

const { mockOpenPackage, mockFindByMemberPath, mockGetCatalogEntityForFilePath, mockGetCatalogIconContextsForPaths } = vi.hoisted(
  () => ({
    mockOpenPackage: vi.fn().mockResolvedValue(null),
    mockFindByMemberPath: vi.fn().mockResolvedValue(null),
    mockGetCatalogEntityForFilePath: vi.fn().mockResolvedValue(null),
    mockGetCatalogIconContextsForPaths: vi.fn().mockResolvedValue(new Map()),
  })
);

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    openPackage: mockOpenPackage,
    findByMemberPath: mockFindByMemberPath,
  },
}));

vi.mock('../../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/workspace-catalog')>()),
  getCatalogEntityForFilePath: mockGetCatalogEntityForFilePath,
  getCatalogIconContextsForPaths: mockGetCatalogIconContextsForPaths,
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.fs.readDir.mockResolvedValue([]);
  mockPlatform.fs.exists.mockResolvedValue(false);
  delete mockPlatform.workspace.checkDocument;
  mockOpenPackage.mockResolvedValue(null);
  mockFindByMemberPath.mockResolvedValue(null);
  mockGetCatalogEntityForFilePath.mockResolvedValue(null);
  mockGetCatalogIconContextsForPaths.mockResolvedValue(new Map());
  mockPlatform.fs.readTextFileSlice.mockResolvedValue({ text: '', bytesRead: 0 });
});

describe('list_files tool (single folder)', () => {
  it('advertises only verified opens and uses the read-only package result for a stable reference', async () => {
    const packagePath = `${WORKSPACE}/Plasmid`;
    const pdfPath = `${WORKSPACE}/Encrypted.pdf`;
    const imagePath = `${WORKSPACE}/Panel.png`;
    const productPath = `${packagePath}/product.gb`;
    mockPlatform.fs.exists.mockImplementation(async (path) => path === `${packagePath}/.forge`);
    mockPlatform.fs.readDir.mockImplementation(async (path) =>
      path === WORKSPACE
        ? [
            { name: 'Encrypted.pdf', isDirectory: false, isFile: true },
            { name: 'Panel.png', isDirectory: false, isFile: true },
            { name: 'Plasmid', isDirectory: true, isFile: false },
          ]
        : [{ name: 'plasmid.json', isDirectory: false, isFile: true }]
    );
    const checked = vi.fn(async ({ path }): Promise<DocumentAvailabilityProbe> => {
      if (path === pdfPath) return {
        state: 'blocked', code: 'password', recognized: true,
        reason: 'This file is password-protected.', paths: [pdfPath],
      };
      if (path === imagePath) return { state: 'ready', kind: 'image', revision: 'image', paths: [imagePath] };
      expect(path).toBe(packagePath);
      return {
        state: 'ready', kind: 'sequence-package', revision: 'sequence',
        paths: [productPath],
        sequencePackage: { documentId: 'stable-doc', name: 'Plasmid', productPath },
      };
    });
    mockPlatform.workspace.checkDocument = checked;
    const result = await execTool<{ entries: Array<Record<string, unknown>> }>(createListFilesTool(singleFolder), {});
    const entries = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(entries.get('Encrypted.pdf')).toMatchObject({
      documentAvailability: { state: 'blocked', code: 'password', recognized: true },
    });
    expect(entries.get('Encrypted.pdf')).not.toHaveProperty('nextOpenInput');
    expect(entries.get('Panel.png')).toMatchObject({
      nextOpenInput: { type: 'file', entityId: imagePath },
      documentAvailability: { state: 'ready', kind: 'image' },
    });
    expect(entries.get('Plasmid')).toMatchObject({
      type: 'sequence-document',
      documentId: 'stable-doc',
      nextOpenInput: { type: 'sequence', entityId: 'stable-doc' },
    });
    expect(JSON.stringify(result.entries)).not.toContain(productPath);
    expect(mockOpenPackage).not.toHaveBeenCalled();
    expect(mockFindByMemberPath).not.toHaveBeenCalled();
  });

  it('preserves declared managed RNA identity through the expanded extensionless result', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([{ name: 'transcript', isDirectory: true }]);
    mockOpenPackage.mockResolvedValueOnce({
      document: { id: 'rna-document', name: 'transcript', entity: { schema: { name: 'rna_sequence' } } },
      productPath: `${WORKSPACE}/transcript/product.gb`,
    });
    const output = await execTool<{ entries: unknown[] }>(createListFilesTool(singleFolder), {});
    render(createElement(ToolResultDisplay, {
      toolName: 'list_files',
      content: JSON.stringify({ input: {}, output }),
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('transcript').parentElement?.querySelector('svg')).toHaveAttribute(
      'data-entity-color-family', 'rna'
    );
  });

  it('publishes optional-filter guidance without accepting empty filters', () => {
    expect(listFilesSchema.shape.nameQuery.description).toContain('Omit');
    expect(listFilesSchema.shape.biologyQuery.description).toContain('Omit');
    expect(listFilesSchema.safeParse({ path: '', recursive: true }).success).toBe(true);
    expect(listFilesSchema.safeParse({ path: '', recursive: true, nameQuery: '' }).success).toBe(
      false
    );
    expect(listFilesSchema.safeParse({ biologyQuery: '' }).success).toBe(false);
    expect(mockPlatform.fs.readDir).not.toHaveBeenCalled();
  });

  it('lists files in workspace root directory', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'plasmid.gb', isDirectory: false, isFile: true },
      { name: 'data', isDirectory: true, isFile: false },
    ]);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{ entries: any[] }>(tool, { path: '.', recursive: false });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith(WORKSPACE);
    expect(result.entries).toHaveLength(2);

    expect(result.entries[0].type).toBe('directory');
    expect(result.entries[1]).toMatchObject({
      name: 'plasmid.gb',
      type: 'sequence-source',
      importRequired: true,
    });
  });

  it('reports unsearched subdirectories and a scoped continuation for a filtered miss', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'sequences', isDirectory: true, isFile: false },
      { name: 'node_modules', isDirectory: true, isFile: false },
    ]);
    const tool = createListFilesTool(singleFolder);
    const result = await execTool(tool, { nameQuery: 'pUC19' });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      entries: [],
      count: 0,
      searchScope: {
        kind: 'current_directory',
        unsearchedDirectoryCount: 1,
        nextSearchInput: { path: '.', recursive: true, nameQuery: 'pUC19' },
      },
    });
  });

  it('finds the nested target when the suggested recursive search is executed', async () => {
    mockPlatform.fs.readDir
      .mockResolvedValueOnce([{ name: 'sequences', isDirectory: true, isFile: false }])
      .mockResolvedValueOnce([{ name: 'sequences', isDirectory: true, isFile: false }])
      .mockResolvedValueOnce([{ name: 'pUC19.gb', isDirectory: false, isFile: true }]);
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'puc19-document' });
    const tool = createListFilesTool(singleFolder);
    const initial = await execTool<{ searchScope: { nextSearchInput: unknown } }>(tool, {
      nameQuery: 'pUC19',
    });
    const result = await execTool(tool, initial.searchScope.nextSearchInput);

    expect(result).toMatchObject({
      count: 1,
      searchScope: { kind: 'recursive' },
      entries: [{ name: 'pUC19.gb', type: 'sequence-document', documentId: 'puc19-document' }],
    });
    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith(`${WORKSPACE}/sequences`);
  });

  it('does not suggest another recursive search when no subdirectories remain', async () => {
    const result = await execTool(createListFilesTool(singleFolder), { nameQuery: 'missing' });
    expect(result).toMatchObject({
      count: 0,
      searchScope: { kind: 'current_directory', unsearchedDirectoryCount: 0 },
    });
    expect(result).not.toHaveProperty('searchScope.nextSearchInput');
  });

  it('lists files recursively when recursive=true', async () => {
    mockPlatform.fs.readDir
      .mockResolvedValueOnce([{ name: 'sub', isDirectory: true, isFile: false }])
      .mockResolvedValueOnce([{ name: 'deep.fasta', isDirectory: false, isFile: true }]);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{ entries: any[] }>(tool, { recursive: true });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({
      name: 'deep.fasta',
      type: 'sequence-source',
      importRequired: true,
    });
  });

  it('identifies biology file extensions correctly', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'seq.gb', isDirectory: false, isFile: true },
      { name: 'seq.gbk', isDirectory: false, isFile: true },
      { name: 'seq.fasta', isDirectory: false, isFile: true },
      { name: 'notes.txt', isDirectory: false, isFile: true },
      { name: 'config.json', isDirectory: false, isFile: true },
    ]);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{ entries: any[] }>(tool, {});

    const bio = result.entries.filter((e: any) => e.isBiologyFile);
    const nonBio = result.entries.filter((e: any) => !e.isBiologyFile);
    expect(bio).toHaveLength(3);
    expect(nonBio).toHaveLength(2);
  });

  it('filters out excluded directories', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: true, isFile: false },
      { name: '.git', isDirectory: true, isFile: false },
      { name: '__pycache__', isDirectory: true, isFile: false },
      { name: 'src', isDirectory: true, isFile: false },
    ]);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{ entries: any[] }>(tool, {});

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('src');
  });

  it('sorts results: directories first, then alphabetically', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'zebra.txt', isDirectory: false, isFile: true },
      { name: 'alpha', isDirectory: true, isFile: false },
      { name: 'apple.gb', isDirectory: false, isFile: true },
    ]);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{ entries: any[] }>(tool, {});

    expect(result.entries[0].name).toBe('alpha');
    expect(result.entries[1].name).toBe('apple.gb');
    expect(result.entries[2].name).toBe('zebra.txt');
  });

  it('rejects path traversal attempts', async () => {
    const tool = createListFilesTool(singleFolder);
    await expect(execTool(tool, { path: '../../../etc' })).rejects.toThrow(/project boundary/i);
  });

  it('rejects normalized path traversal (e.g. foo/../../etc)', async () => {
    const tool = createListFilesTool(singleFolder);
    await expect(execTool(tool, { path: 'foo/../../etc/passwd' })).rejects.toThrow(
      /project boundary/i
    );
  });

  it('rejects absolute paths', async () => {
    const tool = createListFilesTool(singleFolder);
    await expect(execTool(tool, { path: '/etc/passwd' })).rejects.toThrow(/absolute/i);
  });

  it('handles permission denied gracefully', async () => {
    mockPlatform.fs.readDir.mockRejectedValueOnce(new Error('Permission denied'));

    const tool = createListFilesTool(singleFolder);
    await expect(execTool(tool, { path: '.' })).rejects.toThrow('Permission denied');
  });

  it('truncates output when directory has >100 entries', async () => {
    const largeDir = Array.from({ length: 200 }, (_, i) => ({
      name: `file-${String(i).padStart(3, '0')}.gb`,
      isDirectory: false,
    }));
    mockPlatform.fs.readDir.mockResolvedValueOnce(largeDir);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{
      entries: unknown[];
      count: number;
      truncated?: boolean;
      truncatedMessage?: string;
    }>(tool, { path: '.' });

    expect(result.count).toBe(200);
    expect(result.entries.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedMessage).toContain('200');
    expect(result.truncatedMessage).toContain('100');
  });

  it('filters a recursive listing by name before applying the 100-entry cap', async () => {
    const largeDir = [
      ...Array.from({ length: 150 }, (_, i) => ({
        name: `file-${String(i).padStart(3, '0')}.gb`,
        isDirectory: false,
      })),
      { name: 'T1T2_MBP.gb', isDirectory: false },
    ];
    mockPlatform.fs.readDir.mockResolvedValueOnce(largeDir);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{
      entries: Array<{ name: string }>;
      count: number;
      truncated?: boolean;
    }>(tool, { path: '.', recursive: true, nameQuery: 'mbp' });

    expect(result.entries).toEqual([expect.objectContaining({ name: 'T1T2_MBP.gb' })]);
    expect(result.count).toBe(1);
    expect(result.truncated).toBeUndefined();
  });

  it('finds a managed sequence by biological annotation before applying the 100-entry cap', async () => {
    const productPath = `${WORKSPACE}/ODC_0141/ODC_0141.gb`;
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      ...Array.from({ length: 150 }, (_, i) => ({
        name: `SAMPLE_${String(i).padStart(4, '0')}`,
        isDirectory: true,
      })),
      { name: 'ODC_0141', isDirectory: true },
    ]);
    mockOpenPackage.mockImplementation(async (packageRoot: string) =>
      packageRoot === `${WORKSPACE}/ODC_0141`
        ? {
            document: { id: 'odc-0141', name: 'ODC_0141' },
            productPath,
          }
        : null
    );
    mockPlatform.fs.readTextFileSlice.mockImplementation(async (path: string) => ({
      text:
        path === productPath
          ? '     misc_feature    29..1129\n                     /label="N1N2_MBP"'
          : '',
      bytesRead: path === productPath ? 78 : 0,
    }));

    const result = await execTool<{
      entries: Array<{ name: string; documentId?: string }>;
      count: number;
      biologyQuery?: string;
      biologyFilesSearched?: number;
      biologyFilesPartiallySearched?: number;
      biologyResolution?: {
        status: string;
        matchingSourceExists: boolean;
        recommendedDocumentId: string | null;
        recommendedName: string | null;
        nextAction: string;
      };
      truncated?: boolean;
    }>(createListFilesTool(singleFolder), {
      path: '.',
      recursive: true,
      biologyQuery: 'mbp',
    });

    expect(result).toMatchObject({
      biologyQuery: 'mbp',
      count: 1,
      entries: [{ name: 'ODC_0141', documentId: 'odc-0141' }],
      biologyFilesSearched: 1,
      biologyFilesPartiallySearched: 0,
      biologyResolution: {
        status: 'matching_sources_found',
        matchingSourceExists: true,
        recommendedDocumentId: 'odc-0141',
        recommendedName: 'ODC_0141',
        nextAction:
          'Inspect recommendedDocumentId with get_sequence before concluding that this biological source is missing.',
      },
    });
    expect(result.truncated).toBeUndefined();
    expect(result.entries[0]).toMatchObject({
      biologyMatches: [expect.stringContaining('N1N2_MBP')],
      biologySearchPartial: false,
    });
    expect(mockPlatform.fs.readTextFileSlice).toHaveBeenCalledWith(productPath, expect.any(Number));
  });

  it('does not expand a short biological token into a longer unrelated gene name', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'yeast-chromosome.gb', isDirectory: false, isFile: true },
      { name: 'mbp-part.gb', isDirectory: false, isFile: true },
    ]);
    mockPlatform.fs.readTextFileSlice.mockImplementation(async (path: string) => ({
      text: path.endsWith('/mbp-part.gb')
        ? 'FEATURES             Location/Qualifiers\n     CDS             29..1129\n                     /label="N1N2_MBP"\nORIGIN'
        : 'FEATURES             Location/Qualifiers\n     gene            1..300\n                     /gene="MBP1"\n                     /product="Mbp1p transcription factor"\nORIGIN',
      bytesRead: 160,
    }));

    const result = await execTool<{
      entries: Array<{ name: string }>;
      count: number;
    }>(createListFilesTool(singleFolder), {
      path: '.',
      recursive: true,
      biologyQuery: 'MBP',
    });

    expect(result).toMatchObject({
      count: 1,
      entries: [{ name: 'mbp-part.gb' }],
    });
  });

  it('falls back to a longer short-query token when there is no discrete match', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'gfp-variant.gb', isDirectory: false, isFile: true },
    ]);
    mockPlatform.fs.readTextFileSlice.mockResolvedValueOnce({
      text: 'FEATURES             Location/Qualifiers\n     CDS             1..720\n                     /label="GFPuv"\nORIGIN',
      bytesRead: 120,
    });

    const result = await execTool<{
      entries: Array<{ name: string }>;
      count: number;
    }>(createListFilesTool(singleFolder), {
      path: '.',
      recursive: true,
      biologyQuery: 'GFP',
    });

    expect(result).toMatchObject({
      count: 1,
      entries: [{ name: 'gfp-variant.gb' }],
    });
  });

  it('does not treat a raw sequence motif as biological metadata', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'unrelated.gb', isDirectory: false, isFile: true },
    ]);
    mockPlatform.fs.readTextFileSlice.mockResolvedValueOnce({
      text: [
        'LOCUS       unrelated',
        'FEATURES             Location/Qualifiers',
        '     CDS             1..12',
        '                     /label="unrelated enzyme"',
        'ORIGIN',
        '        1 catcatcatcat',
        '//',
      ].join('\n'),
      bytesRead: 151,
    });

    const result = await execTool<{
      entries: Array<{ name: string; biologyMatches?: string[] }>;
      count: number;
      biologyFilesSearched: number;
    }>(createListFilesTool(singleFolder), {
      path: '.',
      recursive: true,
      biologyQuery: 'cat',
    });

    expect(result).toMatchObject({
      entries: [],
      count: 0,
      biologyFilesSearched: 1,
      biologyResolution: {
        status: 'no_matching_sources',
        matchingSourceExists: false,
        recommendedDocumentId: null,
        recommendedName: null,
      },
    });
  });

  it('does not truncate when under the limit', async () => {
    const smallDir = Array.from({ length: 50 }, (_, i) => ({
      name: `file-${i}.gb`,
      isDirectory: false,
    }));
    mockPlatform.fs.readDir.mockResolvedValueOnce(smallDir);

    const tool = createListFilesTool(singleFolder);
    const result = await execTool<{
      entries: unknown[];
      count: number;
      truncated?: boolean;
    }>(tool, { path: '.' });

    expect(result.count).toBe(50);
    expect(result.entries.length).toBe(50);
    expect(result.truncated).toBeUndefined();
  });
});

describe('list_files tool (multi-folder)', () => {
  const multiFolders: WorkspaceFolder[] = [
    { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
    { name: 'Shared Plasmids', path: '/shared/plasmids', addedAt: 2 },
  ];

  it('lists all folder roots when no path given', async () => {
    const tool = createListFilesTool(multiFolders);
    const result = await execTool<{ entries: any[] }>(tool, {});

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].name).toBe('Lab Data');
    expect(result.entries[0].type).toBe('directory');
    expect(result.entries[1].name).toBe('Shared Plasmids');
  });

  it('lists all folder roots for path "."', async () => {
    const tool = createListFilesTool(multiFolders);
    const result = await execTool<{ entries: any[] }>(tool, { path: '.' });

    expect(result.entries).toHaveLength(2);
  });

  it('searches every user folder when a root biology query is supplied', async () => {
    mockPlatform.fs.readDir
      .mockResolvedValueOnce([{ name: 'unrelated.gb', isDirectory: false, isFile: true }])
      .mockResolvedValueOnce([{ name: 'ODC_0141.gb', isDirectory: false, isFile: true }]);
    mockPlatform.fs.readTextFileSlice.mockImplementation(async (path: string) => ({
      text: path.endsWith('/ODC_0141.gb')
        ? 'FEATURES             Location/Qualifiers\n     CDS             29..1129\n                     /label="N1N2_MBP"\nORIGIN'
        : 'FEATURES             Location/Qualifiers\n     CDS             1..300\n                     /label="unrelated"\nORIGIN',
      bytesRead: 128,
    }));

    const result = await execTool<{
      entries: Array<{ name: string }>;
      count: number;
      biologyQuery?: string;
      biologyFilesSearched?: number;
    }>(createListFilesTool(multiFolders), {
      recursive: true,
      biologyQuery: 'MBP',
    });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/home/user/lab');
    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/shared/plasmids');
    expect(result).toMatchObject({
      biologyQuery: 'MBP',
      biologyFilesSearched: 2,
      count: 1,
      entries: [
        {
          name: 'ODC_0141.gb',
          biologyMatches: [expect.stringContaining('N1N2_MBP')],
        },
      ],
    });
  });

  it('lists contents of a specific folder', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'pUC19.gb', isDirectory: false, isFile: true, isSymlink: false },
    ] as any);

    const tool = createListFilesTool(multiFolders);
    const result = await execTool<{ entries: any[] }>(tool, { path: 'Shared Plasmids' });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/shared/plasmids');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: 'pUC19.gb',
      type: 'sequence-source',
      importRequired: true,
    });
  });

  it('lists contents of a subfolder within a folder', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'seq.gb', isDirectory: false, isFile: true, isSymlink: false },
    ] as any);

    const tool = createListFilesTool(multiFolders);
    const result = await execTool<{ entries: any[] }>(tool, { path: 'Lab Data/sequences' });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/home/user/lab/sequences');
    expect(result.entries[0]).toMatchObject({
      name: 'seq.gb',
      type: 'sequence-source',
      importRequired: true,
    });
  });

  it('throws for ambiguous path', async () => {
    const tool = createListFilesTool(multiFolders);
    await expect(execTool(tool, { path: 'unknown/dir' })).rejects.toThrow(/could not determine/i);
  });
});

describe('list_files tool with pinned dev folders ', () => {
  const userFolderWithPinned: WorkspaceFolder[] = [
    { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
    { name: 'Dev Assets', path: '/dev/assets', addedAt: 1, pinned: true },
    { name: 'Test Fixtures', path: '/dev/fixtures', addedAt: 2, pinned: true },
  ];

  it('lists workspace root contents (no folder-roots index) for unprefixed path', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'plasmid.gb', isDirectory: false, isFile: true },
    ] as any);

    const tool = createListFilesTool(userFolderWithPinned);
    const result = await execTool<{ entries: any[] }>(tool, { path: '.' });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/mock/workspace');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('plasmid.gb');
  });

  it('tool description does NOT instruct LLM to prefix paths', () => {
    const tool = createListFilesTool(userFolderWithPinned);
    expect(tool.description).not.toMatch(/Prefix paths with the folder name/);
  });

  it('preserves explicit folder-name prefix in returned child paths', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'mutant-A.gb', isDirectory: false, isFile: true },
    ] as any);

    const tool = createListFilesTool(userFolderWithPinned);
    const result = await execTool<{ entries: any[] }>(tool, {
      path: 'workspace/data/variants',
    });

    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/mock/workspace/data/variants');
    expect(result.entries[0]).toMatchObject({
      name: 'mutant-A.gb',
      type: 'sequence-source',
      importRequired: true,
    });
  });

  it('two user folders + pinned dev folders lists only user folders at root', async () => {
    const twoUsersOnePinned: WorkspaceFolder[] = [
      { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
      { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
      { name: 'Dev Assets', path: '/dev/assets', addedAt: 2, pinned: true },
    ];

    const tool = createListFilesTool(twoUsersOnePinned);
    const result = await execTool<{ entries: any[]; count: number }>(tool, { path: '.' });

    expect(result.count).toBe(2);
    expect(result.entries.map((e) => e.name)).toEqual(['workspace', 'Lab Data']);
    expect(result.entries.map((e) => e.name)).not.toContain('Dev Assets');
  });

  it('pinned-only set lists pinned folders at root (visibleFolders fallback)', async () => {
    const pinnedOnly: WorkspaceFolder[] = [
      { name: 'Dev Assets', path: '/dev/assets', addedAt: 0, pinned: true },
      { name: 'Test Fixtures', path: '/dev/fixtures', addedAt: 1, pinned: true },
    ];

    const tool = createListFilesTool(pinnedOnly);
    expect(tool.description).not.toMatch(/Prefix paths with the folder name/);
  });
});

describe('endogenous source discovery', () => {
  it.each(['RAD51', 'YER095W'])(
    'discovers the annotated chromosome V source for %s beyond the prefix',
    async (query) => {
      const chromosome = readFileSync(
        resolve(
          __dirname,
          '../../../../../../test-fixtures/genomes/yeast-S288C/NC_001137.3-annotated.gb'
        )
      );
      expect(chromosome.indexOf('/gene="RAD51"')).toBeGreaterThan(256 * 1024);
      const incidental = Buffer.from(
        'LOCUS       incidental\nFEATURES             Location/Qualifiers\n     CDS             1..90\n                     /gene="OTHER"\n                     /note="Interacts with RAD51"\nORIGIN\n        1 acgt\n//'
      );
      mockPlatform.fs.readDir.mockResolvedValueOnce([
        { name: 'A-incidental.gb', isDirectory: false, isFile: true },
        { name: 'S288C-chromosome-V.gb', isDirectory: false, isFile: true },
      ]);
      mockGetCatalogEntityForFilePath.mockImplementation(async (path: string) => ({
        id: path.endsWith('S288C-chromosome-V.gb') ? 'chrV' : 'incidental',
      }));
      mockPlatform.fs.readTextFileSlice.mockImplementation(
        async (path: string, maxBytes: number) => {
          const buffer = (
            path.endsWith('S288C-chromosome-V.gb') ? chromosome : incidental
          ).subarray(0, maxBytes);
          return { text: buffer.toString('utf8'), bytesRead: buffer.length };
        }
      );
      const result = await execTool<{
        entries: Array<{ documentId: string }>;
        biologyResolution: { recommendedDocumentId: string };
        biologyFilesPartiallySearched: number;
      }>(createListFilesTool(singleFolder), { recursive: true, biologyQuery: query });
      expect(result.entries[0].documentId).toBe('chrV');
      expect(result.biologyResolution.recommendedDocumentId).toBe('chrV');
      expect(result.biologyFilesPartiallySearched).toBe(0);
    }
  );

  it('does not declare a source absent when its metadata search is incomplete', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'partial.gb', isDirectory: false, isFile: true },
    ]);
    mockPlatform.fs.readTextFileSlice.mockImplementation(
      async (_path: string, maxBytes: number) => ({
        text: 'LOCUS       partial\nFEATURES             Location/Qualifiers\n',
        bytesRead: maxBytes,
      })
    );
    const result = await execTool(createListFilesTool(singleFolder), { biologyQuery: 'YER095W' });
    expect(result).toMatchObject({
      count: 0,
      biologyResolution: { status: 'search_incomplete', matchingSourceExists: null },
    });
  });
});
import { listFilesOutputSchema } from './list-files';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(listFilesOutputSchema, result);
  }
  return result;
}

describe('list_files explicit project scope', () => {
  const roots: WorkspaceFolder[] = [
    { name: 'Alpha', path: '/projects/alpha', addedAt: 1 },
    { name: 'Beta', path: '/projects/beta', addedAt: 2 },
  ];

  it('reads only the exact admitted project root', async () => {
    mockPlatform.fs.readDir.mockResolvedValue([
      { name: 'target.txt', isDirectory: false, isFile: true },
    ]);
    const result = await execTool<{ entries: Array<{ name: string }> }>(
      createListFilesTool(roots),
      { project: '/projects/beta', nameQuery: 'target' }
    );
    expect(mockPlatform.fs.readDir).toHaveBeenCalledTimes(1);
    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/projects/beta');
    expect(result.entries.map((entry) => entry.name)).toEqual(['target.txt']);
  });

  it('preserves the exact project, path and filters in a recursive continuation', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([
      { name: 'nested', isDirectory: true, isFile: false },
    ]);
    const result = await execTool(createListFilesTool(roots), {
      project: '/projects/beta',
      path: 'sequences',
      nameQuery: 'pUC19',
      biologyQuery: 'vector',
    });
    expect(mockPlatform.fs.readDir).toHaveBeenCalledTimes(1);
    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/projects/beta/sequences');
    expect(result).toMatchObject({
      searchScope: {
        kind: 'current_directory',
        unsearchedDirectoryCount: 1,
        nextSearchInput: {
          project: '/projects/beta',
          path: 'sequences',
          recursive: true,
          nameQuery: 'pUC19',
          biologyQuery: 'vector',
        },
      },
    });
  });

  it('refuses an unadmitted project without reading files', async () => {
    const result = await execTool<{ error?: string }>(createListFilesTool(roots), {
      project: '/projects/outside',
    });
    expect(result.error).toContain('unique mounted project');
    expect(mockPlatform.fs.readDir).not.toHaveBeenCalled();
  });

  it('refuses a duplicated project name without choosing a root', async () => {
    const duplicateNames = roots.map((root) => ({ ...root, name: 'Shared lab' }));
    const result = await execTool<{
      error?: string;
      code?: string;
      details?: { nextInputs?: Array<{ project: string; path: string }> };
    }>(createListFilesTool(duplicateNames), {
      project: 'Shared lab',
    });
    expect(result).toMatchObject({
      code: 'PROJECT_AMBIGUOUS',
      details: {
        nextInputs: duplicateNames.map((root) => ({ project: root.path, path: '.' })),
      },
    });
    expect(result.error).toContain('Multiple mounted projects have that name');
    expect(mockPlatform.fs.readDir).not.toHaveBeenCalled();
  });
});

describe('duplicate project names', () => {
  it('returns usable exact-root recovery inputs for an ambiguous advertised prefix', async () => {
    const folders = [
      { name: 'Samples', path: '/projects/one', addedAt: 1 },
      { name: 'Samples', path: '/projects/two', addedAt: 2 },
    ];
    const tool = createListFilesTool(folders);
    const result = await execTool<{ ok: boolean; details: { nextInputs: unknown[] } }>(tool, {
      path: 'Samples/sequences',
      recursive: true,
    });
    expect(result.ok).toBe(false);
    expect(result.details.nextInputs).toEqual([
      { project: '/projects/one', path: 'sequences', recursive: true },
      { project: '/projects/two', path: 'sequences', recursive: true },
    ]);
    expect(mockPlatform.fs.readDir).not.toHaveBeenCalled();
    await execTool(tool, result.details.nextInputs[1]);
    expect(mockPlatform.fs.readDir).toHaveBeenCalledWith('/projects/two/sequences');
  });
});
