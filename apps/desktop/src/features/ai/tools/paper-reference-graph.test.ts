import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import {
  getPaperReferenceGraphOutputSchema,
  recordPaperReferenceTraceOutputSchema,
} from './paper-output-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createGetPaperReferenceGraphTool,
  createRecordPaperReferenceTraceTool,
} from './paper-reference-graph';
import { execTool } from './test-helpers';

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  sha256File: vi.fn(),
}));
const mockExtractCurrentPdfFilePages = vi.hoisted(() => vi.fn());
const mockGetCurrentWorkspaceScope = vi.hoisted(() => vi.fn());

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: mockFs }),
}));

vi.mock('../../pdf/extract', () => ({
  extractCurrentPdfFilePages: mockExtractCurrentPdfFilePages,
}));

vi.mock('../../../stores/workspaceStore', () => ({
  getCurrentWorkspaceScope: mockGetCurrentWorkspaceScope,
  useWorkspaceStore: { getState: () => ({ activeWorkspaceFile: null }) },
}));

const folders = [{ path: '/workspace', name: 'workspace', addedAt: 0 }];
const sourceHash = `sha256:${'a'.repeat(64)}`;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:8122');
  (globalThis as unknown as { electronAPI: object }).electronAPI = {};
  mockFs.readFile.mockReset().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  mockFs.sha256File.mockReset().mockResolvedValue(sourceHash);
  mockExtractCurrentPdfFilePages.mockReset();
  mockGetCurrentWorkspaceScope.mockReset().mockReturnValue('workspace-scope-1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as { electronAPI?: object }).electronAPI;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('record_paper_reference_trace', () => {
  it('derives exact PDF evidence and records it through the authenticated sidecar', async () => {
    mockExtractCurrentPdfFilePages.mockResolvedValue({
      sourceSha256: sourceHash,
      pageCount: 12,
      pages: [
        {
          page: 3,
          text: 'See PMID: 24157548 for the upstream method.',
          blocks: [
            {
              blockId: 'p3-b2',
              page: 3,
              text: 'See PMID: 24157548 for the upstream method.',
              rect: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
            },
          ],
        },
      ],
      truncated: false,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        source_uri: `paper://sha256/${'a'.repeat(64)}`,
        source_sha256: 'a'.repeat(64),
        edge_count: 1,
        identifiers: [
          { scheme: 'pmid', value: '24157548', node_id: 'publication:pubmed:24157548' },
        ],
        replayed: false,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ edge_count: number }>(
      createRecordPaperReferenceTraceTool(folders),
      {
        source: { kind: 'pdf', path: 'Sources/paper.pdf', title: 'Paper' },
        traces: [
          {
            relationship: 'uses_method_from',
            target: { scheme: 'pmid', value: '24157548' },
            evidenceBlockIds: ['p3-b2'],
          },
        ],
      },
      {
        toolCallId: 'paper-graph-action',
        messages: [],
        grantedCapabilities: ['read-workspace', 'create-entity'],
      }
    );

    assertMcpOutput(recordPaperReferenceTraceOutputSchema, result);
    expect(result.edge_count).toBe(1);
    expect(mockExtractCurrentPdfFilePages).toHaveBeenCalledWith('/workspace/Sources/paper.pdf', {
      pages: [3],
      maxCharacters: 1_000_000,
    });
    const requestBody = requestJson(fetchMock);
    expect(requestBody).toEqual({
      workspace_id: 'workspace-scope-1',
      source_sha256: sourceHash,
      source: {
        kind: 'pdf',
        path: 'Sources/paper.pdf',
        title: 'Paper',
        media_type: 'application/pdf',
      },
      traces: [
        {
          relationship: 'uses_method_from',
          target: { scheme: 'pmid', value: '24157548' },
          evidence: {
            block_ids: ['p3-b2'],
            quote: 'See PMID: 24157548 for the upstream method.',
            locator: {
              kind: 'pdf_rects',
              page: 3,
              rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.04 }],
            },
          },
        },
      ],
      granted_capabilities: ['read-workspace', 'create-entity'],
    });
  });

  it('rejects a target identifier absent from the selected evidence before persistence', async () => {
    mockExtractCurrentPdfFilePages.mockResolvedValue({
      sourceSha256: sourceHash,
      pageCount: 1,
      pages: [
        {
          page: 1,
          text: 'No identifier is present.',
          blocks: [
            {
              blockId: 'p1-b1',
              page: 1,
              text: 'No identifier is present.',
              rect: { x: 0, y: 0, width: 1, height: 0.1 },
            },
          ],
        },
      ],
      truncated: false,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      execTool(createRecordPaperReferenceTraceTool(folders), {
        source: { kind: 'pdf', path: 'Sources/paper.pdf' },
        traces: [
          {
            relationship: 'cites',
            target: { scheme: 'doi', value: '10.1000/example' },
            evidenceBlockIds: ['p1-b1'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not contain DOI 10\.1000\/example/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a multi-root PDF path qualified inside private workspace metadata', async () => {
    mockExtractCurrentPdfFilePages.mockResolvedValue({
      sourceSha256: sourceHash,
      pageCount: 1,
      pages: [
        {
          page: 1,
          text: 'PMCID PMC999999999999',
          blocks: [
            {
              blockId: 'p1-b1',
              page: 1,
              text: 'PMCID PMC999999999999',
              rect: { x: 0, y: 0, width: 1, height: 0.1 },
            },
          ],
        },
      ],
      truncated: false,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        source_uri: `paper://sha256/${'a'.repeat(64)}`,
        source_sha256: 'a'.repeat(64),
        edge_count: 1,
        identifiers: [],
        replayed: false,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const multiRootFolders = [
      { path: '/workspace-a', name: 'root-a', addedAt: 0 },
      { path: '/workspace-b', name: 'root-b', addedAt: 0 },
    ];

    await execTool(createRecordPaperReferenceTraceTool(multiRootFolders), {
      source: { kind: 'pdf', path: 'root-b/Sources/paper.pdf' },
      traces: [
        {
          relationship: 'identifies_as',
          target: { scheme: 'pmcid', value: 'PMC999999999999' },
          evidenceBlockIds: ['p1-b1'],
        },
      ],
    });

    expect(requestJson(fetchMock).source).toEqual({
      kind: 'pdf',
      path: 'root-b/Sources/paper.pdf',
      media_type: 'application/pdf',
    });
    expect(mockExtractCurrentPdfFilePages).toHaveBeenCalledWith('/workspace-b/Sources/paper.pdf', {
      pages: [1],
      maxCharacters: 1_000_000,
    });
  });

  it('revalidates captured text and derives a bounded text span', async () => {
    const text = 'Methods\nAdapted from doi:10.1000/example.\n\nResults\nNo citation.';
    const textHash = await sha256(text);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        source_uri: `paper://sha256/${textHash.slice(7)}`,
        source_sha256: textHash.slice(7),
        edge_count: 1,
        identifiers: [
          { scheme: 'doi', value: '10.1000/example', node_id: 'publication:doi:10.1000/example' },
        ],
        replayed: false,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(createRecordPaperReferenceTraceTool(folders), {
      source: {
        sourceId: `text:${textHash.slice(7, 31)}`,
        kind: 'captured_text',
        title: 'Captured methods',
        mediaType: 'text/html',
        sha256: textHash,
        capturedAt: '2026-08-19T12:00:00.000Z',
        originalUrl: 'https://example.org/article',
        canonicalUrl: 'https://example.org/article',
        text,
      },
      traces: [
        {
          relationship: 'uses_method_from',
          target: { scheme: 'doi', value: 'https://doi.org/10.1000/EXAMPLE' },
          evidenceBlockIds: ['text-b1'],
        },
      ],
    });

    const requestBody = requestJson(fetchMock);
    expect(requestBody.source).toEqual({
      kind: 'captured_text',
      title: 'Captured methods',
      media_type: 'text/html',
    });
    expect(requestBody.traces[0]).toEqual({
      relationship: 'uses_method_from',
      target: { scheme: 'doi', value: '10.1000/example' },
      evidence: {
        block_ids: ['text-b1'],
        quote: 'Methods\nAdapted from doi:10.1000/example.',
        locator: { kind: 'text_span', start: 0, end: 41 },
      },
    });
  });

  it('rejects PDF evidence that spans pages because one trace has one exact locator', async () => {
    mockExtractCurrentPdfFilePages.mockResolvedValue({
      sourceSha256: sourceHash,
      pageCount: 2,
      pages: [
        {
          page: 1,
          text: 'PMCID PMC123',
          blocks: [
            {
              blockId: 'p1-b1',
              page: 1,
              text: 'PMCID PMC123',
              rect: { x: 0, y: 0, width: 1, height: 0.1 },
            },
          ],
        },
        {
          page: 2,
          text: 'continued',
          blocks: [
            {
              blockId: 'p2-b1',
              page: 2,
              text: 'continued',
              rect: { x: 0, y: 0, width: 1, height: 0.1 },
            },
          ],
        },
      ],
      truncated: false,
    });

    await expect(
      execTool(createRecordPaperReferenceTraceTool(folders), {
        source: { kind: 'pdf', path: 'Sources/paper.pdf' },
        traces: [
          {
            relationship: 'cites',
            target: { scheme: 'pmcid', value: 'PMC123' },
            evidenceBlockIds: ['p1-b1', 'p2-b1'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/one PDF page/i),
      stateChanged: false,
      partialEffects: [],
    });
  });
});

describe('get_paper_reference_graph', () => {
  it('hashes a current PDF and returns a bounded local graph', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        source_uri: `paper://sha256/${'a'.repeat(64)}`,
        nodes: [],
        edges: [],
        truncated: false,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ truncated: boolean }>(
      createGetPaperReferenceGraphTool(folders),
      { pdfPath: 'Sources/paper.pdf', depth: 2, maxNodes: 25 },
      {
        toolCallId: 'paper-graph-query',
        messages: [],
        grantedCapabilities: ['read-workspace'],
      }
    );

    assertMcpOutput(getPaperReferenceGraphOutputSchema, result);
    expect(result.truncated).toBe(false);
    expect(requestJson(fetchMock)).toEqual({
      workspace_id: 'workspace-scope-1',
      source_sha256: sourceHash,
      depth: 2,
      max_nodes: 25,
      granted_capabilities: ['read-workspace'],
    });
  });

  it('fails closed when no project is open', async () => {
    mockGetCurrentWorkspaceScope.mockReturnValue(null);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      execTool(createGetPaperReferenceGraphTool(folders), {
        sourceSha256: sourceHash,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/project must be open/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestJson(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
