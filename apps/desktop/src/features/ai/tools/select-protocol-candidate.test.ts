import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { selectProtocolCandidateOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createSelectProtocolCandidateTool } from './select-protocol-candidate';
import { execTool } from './test-helpers';

const { mockPlatform, mockSaveNativeScientificPackage } = vi.hoisted(() => ({
  mockSaveNativeScientificPackage: vi.fn(),
  mockPlatform: { fs: { readTextFile: vi.fn() } },
}));

vi.mock('../../../platform', () => ({ platform: () => mockPlatform }));
vi.mock('../../scientific-document/native-package', () => ({
  saveNativeScientificPackage: mockSaveNativeScientificPackage,
}));

const WORKSPACE = '/home/user/lab';
const RELATIVE_PATH = 'Protocols/Paper/.forge/protocol.json';
const ABSOLUTE_PATH = `${WORKSPACE}/${RELATIVE_PATH}`;
const CANDIDATE_ID = 'paper-candidate-1';
const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveNativeScientificPackage.mockResolvedValue('saved');
});

describe('select_protocol_candidate tool', () => {
  it('reports uncertain effects when native persistence fails after admission', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValue(
      JSON.stringify(paperProtocolDocument('proposed', 3))
    );
    mockSaveNativeScientificPackage.mockRejectedValue(new Error('Native save interrupted.'));
    const result = await execTool(createSelectProtocolCandidateTool(folders), {
      path: RELATIVE_PATH,
      expectedCandidateId: CANDIDATE_ID,
      expectedRevision: 3,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'SELECT_PROTOCOL_CANDIDATE_FAILED',
      error: 'Native save interrupted.',
      retriable: false,
      stateChanged: 'unknown',
      partialEffects: [],
    });
  });

  it('promotes the exact proposed candidate and advances the reviewed revision', async () => {
    const original = JSON.stringify(paperProtocolDocument('proposed', 3));
    mockPlatform.fs.readTextFile.mockResolvedValue(original);

    const result = await execTool<Record<string, unknown>>(
      createSelectProtocolCandidateTool(folders),
      {
        path: RELATIVE_PATH,
        expectedCandidateId: CANDIDATE_ID,
        expectedRevision: 3,
      }
    );

    assertMcpOutput(selectProtocolCandidateOutputSchema, result);
    expect(result).toMatchObject({
      path: RELATIVE_PATH,
      candidateId: CANDIDATE_ID,
      candidateStatus: 'selected',
      draftRevision: 4,
      replayed: false,
    });
    expect(mockSaveNativeScientificPackage).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      metaPath: ABSOLUTE_PATH,
      document: expect.objectContaining({
        kind: 'protocol',
        paperProtocol: expect.objectContaining({
          candidate: expect.objectContaining({ status: 'selected' }),
          draft: expect.objectContaining({ revision: 4, state: 'draft' }),
        }),
      }),
      expectedText: original,
    });
  });

  it('replays the exact selected revision without another write', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValue(
      JSON.stringify(paperProtocolDocument('selected', 4))
    );

    const result = await execTool<Record<string, unknown>>(
      createSelectProtocolCandidateTool(folders),
      {
        path: RELATIVE_PATH,
        expectedCandidateId: CANDIDATE_ID,
        expectedRevision: 4,
      }
    );

    expect(result).toMatchObject({ draftRevision: 4, replayed: true });
    expect(mockSaveNativeScientificPackage).not.toHaveBeenCalled();
  });

  it('refuses stale candidate identity before writing', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValue(
      JSON.stringify(paperProtocolDocument('proposed', 3))
    );

    await expect(
      execTool(createSelectProtocolCandidateTool(folders), {
        path: RELATIVE_PATH,
        expectedCandidateId: 'paper-candidate-stale',
        expectedRevision: 3,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/identity changed/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockSaveNativeScientificPackage).not.toHaveBeenCalled();
  });
});

function paperProtocolDocument(status: 'proposed' | 'selected', revision: number) {
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'paper-protocol-1',
    title: 'Paper protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'paper-step-1',
        sourceStepId: 'paper-step-1',
        ordinal: 1,
        title: 'Lyse cells',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: SOURCE_HASH,
      pinnedVersionHash: SOURCE_HASH,
      immutable: true,
      importedAt: '2026-08-19T00:00:00.000Z',
    },
    provenance: { provider: 'local-pdf', capturedAt: '2026-08-19T00:00:00.000Z' },
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'paper-set-1',
        candidateId: CANDIDATE_ID,
        ordinal: 1,
        label: 'Paper protocol',
        status,
      },
      draft: { revision, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'pdf:source',
          kind: 'pdf',
          title: 'Paper',
          mediaType: 'application/pdf',
          sha256: SOURCE_HASH,
          capturedAt: '2026-08-19T00:00:00.000Z',
          workspacePath: 'papers/source.pdf',
          pageCount: 1,
        },
      ],
      evidence: [],
      gaps: [],
      acceptedVersions: [],
    },
  };
}
