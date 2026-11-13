import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { createProtocolCandidateOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createProtocolCandidateTool } from './create-protocol-candidate';
import { execTool } from './test-helpers';

const { mockCreateNativePaperProtocolPackage } = vi.hoisted(() => ({
  mockCreateNativePaperProtocolPackage: vi.fn(),
}));

vi.mock('../../scientific-document/native-package', () => ({
  createNativePaperProtocolPackage: mockCreateNativePaperProtocolPackage,
}));

const WORKSPACE = '/home/user/lab';
const TEXT = 'Protocol A\nLyse cells.\n\nProtocol B\nWash cells.';
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateNativePaperProtocolPackage.mockImplementation(
    async (input: { workspaceRoot: string; packagePath: string; document: unknown }) => ({
      rawId: 'paper-protocol-test',
      entityId: 'catalog-paper-protocol-test',
      metaPath: `${input.workspaceRoot}/${input.packagePath}/.forge/protocol.json`,
      document: input.document,
    })
  );
});

describe('create_protocol_candidate tool', () => {
  it('creates one selected native candidate grounded in exact captured-text blocks', async () => {
    const source = await capturedSource();
    const result = await execTool<{
      candidateSetId: string;
      candidateId: string;
      protocolPath: string;
    }>(createProtocolCandidateTool(folders), {
      outputPath: 'Protocols/Lysis',
      title: 'Cell lysis',
      overview: 'Extracted from the publisher methods.',
      candidateOrdinal: 1,
      candidateStatus: 'selected',
      source,
      steps: [
        {
          title: 'Lyse cells',
          instructions: 'Lyse cells.',
          sourceStatus: 'source',
          evidenceBlockIds: ['text-b1'],
        },
      ],
    });

    assertMcpOutput(createProtocolCandidateOutputSchema, result);
    expect(result).toMatchObject({
      candidateSetId: expect.stringMatching(/^paper-set-[a-f0-9]{24}$/),
      candidateId: expect.stringMatching(/^paper-candidate-[a-f0-9]{24}$/),
      protocolPath: 'Protocols/Lysis/.forge/protocol.json',
    });
    const document = mockCreateNativePaperProtocolPackage.mock.calls[0][0].document;
    expect(document.paperProtocol).toMatchObject({
      candidate: { ordinal: 1, status: 'selected' },
      sources: [{ kind: 'captured_text', text: TEXT }],
      evidence: [
        {
          stepId: 'paper-step-1',
          quote: 'Protocol A\nLyse cells.',
          locator: { kind: 'text_span', start: 0, end: 22 },
        },
      ],
    });
  });

  it('keeps multiple agent-discovered protocols in one source set but gives each a stable identity', async () => {
    const source = await capturedSource();
    const tool = createProtocolCandidateTool(folders);
    const base = {
      overview: '',
      candidateStatus: 'proposed',
      source,
      steps: [
        {
          title: 'Wash cells',
          instructions: 'Wash cells.',
          sourceStatus: 'source',
          evidenceBlockIds: ['text-b2'],
        },
      ],
    };
    const first = await execTool<{ candidateSetId: string; candidateId: string }>(tool, {
      ...base,
      outputPath: 'Protocols/First',
      title: 'First protocol',
      candidateOrdinal: 1,
    });
    const second = await execTool<{ candidateSetId: string; candidateId: string }>(tool, {
      ...base,
      outputPath: 'Protocols/Second',
      title: 'Second protocol',
      candidateOrdinal: 2,
    });

    expect(second.candidateSetId).toBe(first.candidateSetId);
    expect(second.candidateId).not.toBe(first.candidateId);
  });

  it('rejects unknown blocks and changed captured text before native package creation', async () => {
    const source = await capturedSource();
    await expect(
      execTool(createProtocolCandidateTool(folders), {
        outputPath: 'Protocols/Invalid',
        title: 'Invalid protocol',
        overview: '',
        candidateOrdinal: 1,
        candidateStatus: 'proposed',
        source: { ...source, text: `${source.text} changed` },
        steps: [
          {
            title: 'Invented',
            instructions: 'Invented.',
            sourceStatus: 'source',
            evidenceBlockIds: ['text-b99'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/hash does not match/i),
      stateChanged: false,
      partialEffects: [],
    });
    await expect(
      execTool(createProtocolCandidateTool(folders), {
        outputPath: 'Protocols/Wrong-source-id',
        title: 'Wrong source ID',
        overview: '',
        candidateOrdinal: 1,
        candidateStatus: 'proposed',
        source: { ...source, sourceId: 'text:000000000000000000000000' },
        steps: [
          {
            title: 'Lyse cells',
            instructions: 'Lyse cells.',
            sourceStatus: 'source',
            evidenceBlockIds: ['text-b1'],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/source ID does not match/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockCreateNativePaperProtocolPackage).not.toHaveBeenCalled();
  });
});

async function capturedSource() {
  const contentHash = await sha256(TEXT);
  return {
    sourceId: `text:${contentHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    kind: 'captured_text' as const,
    title: 'Publisher methods',
    mediaType: 'text/html' as const,
    sha256: contentHash,
    capturedAt: '2026-08-19T03:00:00.000Z',
    originalUrl: 'https://example.org/paper',
    canonicalUrl: 'https://example.org/paper',
    text: TEXT,
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
