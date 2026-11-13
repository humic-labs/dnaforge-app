import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { capturePaperUrlOutputSchema } from './paper-output-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { capturePaperUrlSchema, createCapturePaperUrlTool } from './capture-paper-url';
import { execTool } from './test-helpers';

const mockFs = vi.hoisted(() => ({
  exists: vi.fn(),
  sha256File: vi.fn(),
  writeWorkspaceBinaryFileAtomic: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: mockFs }),
}));

const folders = [{ path: '/workspace', name: 'workspace', addedAt: 0 }];
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:8122');
  (globalThis as unknown as { electronAPI: object }).electronAPI = {};
  mockFs.exists.mockReset().mockResolvedValue(false);
  mockFs.sha256File.mockReset();
  mockFs.writeWorkspaceBinaryFileAtomic.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as { electronAPI?: object }).electronAPI;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('capture_paper_url', () => {
  it('retains a confirmed PDF write when receipt verification fails afterward', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
    const hash = await sha256(bytes);
    mockFs.writeWorkspaceBinaryFileAtomic.mockResolvedValue({
      path: '/workspace/Sources/paper.pdf',
      contentHash: 'f'.repeat(64),
    });
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({
          kind: 'pdf',
          original_url: 'https://example.org/paper',
          canonical_url: 'https://example.org/paper.pdf',
          media_type: 'application/pdf',
          response_sha256: hash,
          byte_count: bytes.byteLength,
          title: 'Paper',
          captured_at: '2026-08-19T12:00:00.000Z',
          pdf_base64: base64(bytes),
        })
      );
    const result = await execTool(createCapturePaperUrlTool(folders), {
      url: 'https://example.org/paper',
      pdfOutputPath: 'Sources/paper.pdf',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'CAPTURE_PAPER_URL_FAILED',
      stateChanged: true,
      partialEffects: [{ kind: 'pdf-saved', path: 'Sources/paper.pdf' }],
    });
  });

  it('rejects unsafe model input before reaching the sidecar', () => {
    expect(
      capturePaperUrlSchema.safeParse({
        url: 'https://user:secret@example.org/paper',
        pdfOutputPath: 'Sources/paper.pdf',
      }).success
    ).toBe(false);
    expect(
      capturePaperUrlSchema.safeParse({
        url: 'file:///tmp/paper.pdf',
        pdfOutputPath: 'Sources/paper.pdf',
      }).success
    ).toBe(false);
  });

  it('returns exact stable blocks for captured web text without writing a file', async () => {
    const text = 'Protocol\nAdd buffer.\n\nWash\nWash twice.';
    const textHash = await sha256(new TextEncoder().encode(text));
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: 'captured_text',
        original_url: 'https://example.org/article',
        canonical_url: 'https://example.org/article/1',
        media_type: 'text/html',
        response_sha256: `sha256:${'a'.repeat(64)}`,
        byte_count: 200,
        title: 'Paper methods',
        captured_at: '2026-08-19T12:00:00.123456Z',
        captured_text: text,
        captured_text_sha256: textHash,
      })
    ) as unknown as typeof fetch;

    const result = await execTool<{
      kind: string;
      source: { sha256: string; text: string; capturedAt: string };
      blocks: Array<{ blockId: string }>;
    }>(createCapturePaperUrlTool(folders), {
      url: 'https://example.org/article',
      pdfOutputPath: 'Sources/paper.pdf',
    });

    assertMcpOutput(capturePaperUrlOutputSchema, result);
    expect(result).toMatchObject({
      kind: 'captured_text',
      source: { sha256: textHash, text, capturedAt: '2026-08-19T12:00:00.123Z' },
      blocks: [{ blockId: 'text-b1' }, { blockId: 'text-b2' }],
    });
    expect(mockFs.writeWorkspaceBinaryFileAtomic).not.toHaveBeenCalled();
  });

  it('atomically saves exact PDF bytes and returns URL provenance for protocol creation', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    const hash = await sha256(bytes);
    mockFs.writeWorkspaceBinaryFileAtomic.mockResolvedValue({
      path: '/workspace/Sources/paper.pdf',
      contentHash: hash.replace('sha256:', ''),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: 'pdf',
        original_url: 'https://example.org/download?id=1',
        canonical_url: 'https://cdn.example.org/paper.pdf',
        media_type: 'application/pdf',
        response_sha256: hash,
        byte_count: bytes.byteLength,
        title: 'Paper title',
        captured_at: '2026-08-19T12:00:00.123456Z',
        pdf_base64: base64(bytes),
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{
      kind: string;
      pdfPath: string;
      remoteSource: { canonicalUrl: string; capturedAt: string };
    }>(
      createCapturePaperUrlTool(folders),
      { url: 'https://example.org/download?id=1', pdfOutputPath: 'Sources/paper.pdf' },
      {
        toolCallId: 'paper-action',
        messages: [],
        grantedCapabilities: ['external-fetch:paper'],
      }
    );

    assertMcpOutput(capturePaperUrlOutputSchema, result);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'pdf',
        pdfPath: 'Sources/paper.pdf',
        remoteSource: {
          originalUrl: 'https://example.org/download?id=1',
          canonicalUrl: 'https://cdn.example.org/paper.pdf',
          mediaType: 'application/pdf',
          capturedAt: '2026-08-19T12:00:00.123Z',
          title: 'Paper title',
        },
      })
    );
    expect(mockFs.writeWorkspaceBinaryFileAtomic).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      path: '/workspace/Sources/paper.pdf',
      content: bytes,
      artifactNoun: 'paper source',
    });
    const requestBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(requestBody.granted_capabilities).toEqual(['external-fetch:paper']);
  });

  it('rejects an invalid capture timestamp before writing PDF bytes', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
    const hash = await sha256(bytes);
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: 'pdf',
        original_url: 'https://example.org/paper.pdf',
        canonical_url: 'https://example.org/paper.pdf',
        media_type: 'application/pdf',
        response_sha256: hash,
        byte_count: bytes.byteLength,
        title: 'Paper',
        captured_at: 'not-a-timestamp',
        pdf_base64: base64(bytes),
      })
    ) as unknown as typeof fetch;

    await expect(
      execTool(createCapturePaperUrlTool(folders), {
        url: 'https://example.org/paper.pdf',
        pdfOutputPath: 'Sources/paper.pdf',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid capture time/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockFs.writeWorkspaceBinaryFileAtomic).not.toHaveBeenCalled();
  });

  it('reuses an identical existing PDF and rejects a different collision', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9]);
    const hash = await sha256(bytes);
    const responseBody = {
      kind: 'pdf',
      original_url: 'https://example.org/paper.pdf',
      canonical_url: 'https://example.org/paper.pdf',
      media_type: 'application/pdf',
      response_sha256: hash,
      byte_count: bytes.byteLength,
      title: 'Paper',
      captured_at: '2026-08-19T12:00:00.000Z',
      pdf_base64: base64(bytes),
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(responseBody)) as unknown as typeof fetch;
    mockFs.exists.mockResolvedValue(true);
    mockFs.sha256File.mockResolvedValue(hash);

    await expect(
      execTool(createCapturePaperUrlTool(folders), {
        url: 'https://example.org/paper.pdf',
        pdfOutputPath: 'Sources/paper.pdf',
      })
    ).resolves.toMatchObject({ reusedExisting: true });
    expect(mockFs.writeWorkspaceBinaryFileAtomic).not.toHaveBeenCalled();

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(responseBody)) as unknown as typeof fetch;
    mockFs.sha256File.mockResolvedValue(`sha256:${'f'.repeat(64)}`);
    await expect(
      execTool(createCapturePaperUrlTool(folders), {
        url: 'https://example.org/paper.pdf',
        pdfOutputPath: 'Sources/paper.pdf',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/different file already exists/i),
      stateChanged: false,
      partialEffects: [],
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64(bytes: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
