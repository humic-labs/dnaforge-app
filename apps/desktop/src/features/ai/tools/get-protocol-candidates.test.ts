import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { getProtocolCandidatesOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createGetProtocolCandidatesTool } from './get-protocol-candidates';
import { execTool } from './test-helpers';

const { mockGetCatalogFilesUnderPath, mockPlatform } = vi.hoisted(() => ({
  mockGetCatalogFilesUnderPath: vi.fn(),
  mockPlatform: { fs: { readTextFile: vi.fn() } },
}));

vi.mock('../../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/workspace-catalog')>()),
  getCatalogFilesUnderPath: mockGetCatalogFilesUnderPath,
}));
vi.mock('../../../platform', () => ({ platform: () => mockPlatform }));

const WORKSPACE = '/home/user/lab';
const HASH = `sha256:${'a'.repeat(64)}`;
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCatalogFilesUnderPath.mockResolvedValue([
    {
      path: `${WORKSPACE}/Protocols/Lysis/.forge/protocol.json`,
      relative_path: 'Protocols/Lysis/.forge/protocol.json',
      file_kind: 'waypoint-protocol',
      status: 'current',
    },
    {
      path: `${WORKSPACE}/Protocols/Ordinary/.forge/protocol.json`,
      relative_path: 'Protocols/Ordinary/.forge/protocol.json',
      file_kind: 'waypoint-protocol',
      status: 'current',
    },
  ]);
  mockPlatform.fs.readTextFile.mockImplementation(async (path: string) =>
    path.includes('/Lysis/') ? JSON.stringify(paperProtocol()) : JSON.stringify(ordinaryProtocol())
  );
});

describe('get_protocol_candidates tool', () => {
  it('keeps an empty candidate list successful and validates its MCP contract', async () => {
    mockGetCatalogFilesUnderPath.mockResolvedValue([]);
    const result = await execTool(createGetProtocolCandidatesTool(folders), {});
    expect(result).toEqual({ ok: true, candidates: [] });
    assertMcpOutput(getProtocolCandidatesOutputSchema, result);
  });

  it('returns compact paper candidate metadata without captured source payloads', async () => {
    const result = await execTool<{
      candidates: Array<Record<string, unknown>>;
    }>(createGetProtocolCandidatesTool(folders), { sourceSha256: HASH });

    assertMcpOutput(getProtocolCandidatesOutputSchema, result);
    expect(result.candidates).toEqual([
      {
        protocolPath: 'Protocols/Lysis/.forge/protocol.json',
        title: 'Cell lysis',
        candidateSetId: 'paper-set-1',
        candidateId: 'paper-candidate-1',
        ordinal: 1,
        status: 'selected',
        sourceKinds: ['captured_text'],
        sourceHashes: [HASH],
        draftRevision: 2,
        draftState: 'draft',
        stepCount: 1,
        gapCount: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('Full captured article text');
  });
});

function ordinaryProtocol(): Record<string, unknown> {
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'ordinary',
    title: 'Ordinary',
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'step-1',
        ordinal: 1,
        title: 'Step',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [],
    outputs: [],
    version: { sourceVersionId: 'v1' },
  };
}

function paperProtocol(): Record<string, unknown> {
  return {
    ...ordinaryProtocol(),
    id: 'paper',
    title: 'Cell lysis',
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'paper-set-1',
        candidateId: 'paper-candidate-1',
        ordinal: 1,
        label: 'Cell lysis',
        status: 'selected',
      },
      draft: { revision: 2, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'text:source',
          kind: 'captured_text',
          title: 'Article',
          mediaType: 'text/html',
          sha256: HASH,
          capturedAt: '2026-08-19T03:00:00.000Z',
          originalUrl: 'https://example.org/paper',
          canonicalUrl: 'https://example.org/paper',
          text: 'Full captured article text',
        },
      ],
      evidence: [],
      gaps: [
        {
          gapId: 'gap-1',
          stepId: 'step-1',
          missing: 'Missing supplement',
          attemptedResolution: ['Checked source'],
        },
      ],
      acceptedVersions: [],
    },
  };
}
