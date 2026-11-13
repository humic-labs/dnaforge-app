import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { createProtocolFromPdfOutputSchema, readPdfOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool } from './test-helpers';

const { mockCreateNativePaperProtocolPackage, mockExtractCurrentPdfFilePages, mockPlatform } =
  vi.hoisted(() => ({
    mockCreateNativePaperProtocolPackage: vi.fn(),
    mockExtractCurrentPdfFilePages: vi.fn(),
    mockPlatform: {
      fs: {
        readFile: vi.fn(),
        sha256File: vi.fn(),
        writeWorkspaceTextFileAtomic: vi.fn(),
      },
    },
  }));

vi.mock('../../../platform', () => ({ platform: () => mockPlatform }));
vi.mock('../../pdf/extract', () => ({
  extractCurrentPdfFilePages: mockExtractCurrentPdfFilePages,
}));
vi.mock('../../scientific-document/native-package', () => ({
  createNativePaperProtocolPackage: mockCreateNativePaperProtocolPackage,
}));

import { createProtocolFromPdfTool, createReadPdfTool } from './pdf-protocol';

const WORKSPACE = '/home/user/lab';
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.fs.readFile.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  mockPlatform.fs.sha256File.mockResolvedValue(`sha256:${'a'.repeat(64)}`);
  mockPlatform.fs.writeWorkspaceTextFileAtomic.mockResolvedValue({
    path: `${WORKSPACE}/paper.dnaforge-protocol.json`,
    contentHash: 'b'.repeat(64),
  });
  mockCreateNativePaperProtocolPackage.mockImplementation(
    async (input: { workspaceRoot: string; packagePath: string; document: unknown }) => ({
      rawId: 'paper-protocol-test',
      entityId: 'catalog-paper-protocol-test',
      metaPath: `${input.workspaceRoot}/${input.packagePath}/.forge/protocol.json`,
      document: input.document,
    })
  );
  mockExtractCurrentPdfFilePages.mockResolvedValue({
    sourceSha256: `sha256:${'a'.repeat(64)}`,
    parser: {
      name: 'opendataloader-pdf',
      version: '2.5.1',
      mode: 'deterministic-local',
      configuration: 'xycut-cluster-safety-on-images-off',
    },
    pageCount: 2,
    truncated: false,
    pages: [
      {
        page: 1,
        text: 'Cells were lysed. Samples were retained.',
        blocks: [
          {
            blockId: 'p1-b1',
            page: 1,
            kind: 'paragraph',
            text: 'Cells were lysed.',
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.02 },
          },
          {
            blockId: 'p1-b2',
            page: 1,
            kind: 'paragraph',
            text: 'Samples were retained.',
            rect: { x: 0.1, y: 0.23, width: 0.35, height: 0.02 },
          },
        ],
      },
      {
        page: 2,
        text: 'DNA was amplified.',
        blocks: [
          {
            blockId: 'p2-b1',
            page: 2,
            kind: 'paragraph',
            text: 'DNA was amplified.',
            rect: { x: 0.12, y: 0.18, width: 0.25, height: 0.02 },
          },
        ],
      },
    ],
  });
});

describe('PDF protocol agent tools', () => {
  it('returns stable evidence block IDs and normalized geometry from a bounded page range', async () => {
    const result = await execTool<{
      sha256: string;
      pageCount: number;
      pages: Array<{ blocks: Array<{ blockId: string }> }>;
    }>(createReadPdfTool(folders), {
      path: 'source.pdf',
      pageStart: 1,
      pageEnd: 2,
      maxCharacters: 50_000,
    });

    assertMcpOutput(readPdfOutputSchema, result);
    expect(result).toMatchObject({ sha256: 'a'.repeat(64), pageCount: 2 });
    expect(result.pages[0].blocks[0].blockId).toBe('p1-b1');
    expect(result).toMatchObject({
      parser: { name: 'opendataloader-pdf', version: '2.5.1' },
    });
    expect(mockExtractCurrentPdfFilePages).toHaveBeenCalledWith(`${WORKSPACE}/source.pdf`, {
      pages: [1, 2],
      maxCharacters: 50_000,
      clampTrailingPages: true,
    });
  });

  it('creates a cataloged native Protocol package whose evidence comes only from extracted blocks', async () => {
    const workspaceEvents: Array<{ path: string; workspaceRoot: string; revealPath: string }> = [];
    const onWorkspaceFilesChanged = (event: Event) => {
      workspaceEvents.push(
        (event as CustomEvent<{ path: string; workspaceRoot: string; revealPath: string }>).detail
      );
    };
    window.addEventListener('waypoint:workspace-files-changed', onWorkspaceFilesChanged);
    const result = await execTool<{ protocolPath: string; stepCount: number }>(
      createProtocolFromPdfTool(folders),
      {
        pdfPath: 'source.pdf',
        outputPath: 'Protocols/Paper protocol',
        title: 'Paper protocol',
        overview: 'Extracted from the methods section.',
        steps: [
          {
            title: 'Lyse cells',
            instructions: 'Lyse the cells and retain the sample.',
            sourceStatus: 'source',
            evidenceBlockIds: ['p1-b1', 'p1-b2'],
          },
          {
            title: 'Amplify DNA',
            instructions: 'Amplify the DNA.',
            sourceStatus: 'resolved',
            evidenceBlockIds: ['p2-b1'],
          },
        ],
      }
    );
    window.removeEventListener('waypoint:workspace-files-changed', onWorkspaceFilesChanged);

    assertMcpOutput(createProtocolFromPdfOutputSchema, result);
    expect(result).toMatchObject({
      protocolPath: 'Protocols/Paper protocol/.forge/protocol.json',
      stepCount: 2,
    });
    expect(mockCreateNativePaperProtocolPackage).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      packagePath: 'Protocols/Paper protocol',
      document: expect.objectContaining({ kind: 'protocol', title: 'Paper protocol' }),
    });
    const persisted = mockCreateNativePaperProtocolPackage.mock.calls[0][0].document.raw;
    expect(persisted.pdfSources).toBeUndefined();
    expect(persisted.paperProtocol.sources[0]).toMatchObject({
      kind: 'pdf',
      workspacePath: 'source.pdf',
      sha256: `sha256:${'a'.repeat(64)}`,
      pageCount: 2,
      extraction: {
        name: 'opendataloader-pdf',
        version: '2.5.1',
        mode: 'deterministic-local',
        configuration: 'xycut-cluster-safety-on-images-off',
      },
    });
    expect(persisted.paperProtocol.candidate.status).toBe('proposed');
    expect(persisted.steps[0].pdfAnchors).toBeUndefined();
    expect(persisted.paperProtocol.evidence).toContainEqual(
      expect.objectContaining({
        stepId: 'paper-step-1',
        quote: 'Cells were lysed. Samples were retained.',
        locator: {
          kind: 'pdf_rects',
          page: 1,
          rects: [
            { x: 0.1, y: 0.2, width: 0.3, height: 0.02 },
            { x: 0.1, y: 0.23, width: 0.35, height: 0.02 },
          ],
        },
      })
    );
    expect(workspaceEvents).toEqual([
      {
        path: `${WORKSPACE}/Protocols/Paper protocol/.forge/protocol.json`,
        workspaceRoot: WORKSPACE,
        revealPath: `${WORKSPACE}/Protocols/Paper protocol/.forge/protocol.json`,
      },
    ]);
  });

  it('preserves remote URL provenance returned by capture_paper_url', async () => {
    await execTool(createProtocolFromPdfTool(folders), {
      pdfPath: 'Sources/source.pdf',
      outputPath: 'Protocols/Remote paper protocol',
      title: 'Remote paper protocol',
      remoteSource: {
        originalUrl: 'https://publisher.example/article?id=7',
        canonicalUrl: 'https://cdn.example/article-7.pdf',
        capturedAt: '2026-08-19T12:00:00.000Z',
        title: 'Publisher article title',
      },
      steps: [
        {
          title: 'Lyse cells',
          instructions: 'Lyse the cells.',
          evidenceBlockIds: ['p1-b1'],
        },
      ],
    });

    const persisted = mockCreateNativePaperProtocolPackage.mock.calls[0][0].document.raw;
    expect(persisted.provenance).toMatchObject({
      provider: 'paper-url-pdf',
      capturedAt: '2026-08-19T12:00:00.000Z',
    });
    expect(persisted.paperProtocol.sources[0]).toMatchObject({
      title: 'Publisher article title',
      originalUrl: 'https://publisher.example/article?id=7',
      canonicalUrl: 'https://cdn.example/article-7.pdf',
      workspacePath: 'Sources/source.pdf',
    });
  });

  it('rejects cross-root source provenance before extracting or writing a Protocol package', async () => {
    const multiRootFolders: WorkspaceFolder[] = [
      { name: 'Papers', path: '/home/user/papers', addedAt: 1 },
      { name: 'Protocols', path: '/home/user/protocols', addedAt: 2 },
    ];

    await expect(
      execTool(createProtocolFromPdfTool(multiRootFolders), {
        pdfPath: 'Papers/source.pdf',
        outputPath: 'Protocols/Paper protocol',
        title: 'Paper protocol',
        overview: '',
        steps: [
          {
            title: 'Lyse cells',
            instructions: 'Lyse the cells.',
            evidenceBlockIds: ['p1-b1'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/same mounted folder/i),
      stateChanged: false,
      partialEffects: [],
    });

    expect(mockPlatform.fs.readFile).not.toHaveBeenCalled();
    expect(mockExtractCurrentPdfFilePages).not.toHaveBeenCalled();
    expect(mockCreateNativePaperProtocolPackage).not.toHaveBeenCalled();
  });

  it('refuses model-invented evidence IDs instead of writing ungrounded highlights', async () => {
    await expect(
      execTool(createProtocolFromPdfTool(folders), {
        pdfPath: 'source.pdf',
        outputPath: 'Protocols/Paper protocol',
        title: 'Paper protocol',
        overview: '',
        steps: [
          {
            title: 'Invented step',
            instructions: 'Do something unsupported.',
            sourceStatus: 'hole',
            evidenceBlockIds: ['p1-b99'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching('PDF evidence block was not found'),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockCreateNativePaperProtocolPackage).not.toHaveBeenCalled();
  });
});
