import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { reviseProtocolStepOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createReviseProtocolStepTool } from './revise-protocol-step';
import { execTool } from './test-helpers';

const { mockPlatform, mockSaveNativeScientificPackage } = vi.hoisted(() => ({
  mockSaveNativeScientificPackage: vi.fn(),
  mockPlatform: {
    fs: {
      readTextFile: vi.fn(),
      writeWorkspaceTextFileAtomic: vi.fn(),
    },
  },
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
}));
vi.mock('../../scientific-document/native-package', () => ({
  saveNativeScientificPackage: mockSaveNativeScientificPackage,
}));

const WORKSPACE = '/home/user/lab';
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.fs.readTextFile.mockResolvedValue(protocolDocument());
  mockPlatform.fs.writeWorkspaceTextFileAtomic.mockResolvedValue({
    path: `${WORKSPACE}/paper.dnaforge-protocol.json`,
    contentHash: 'b'.repeat(64),
  });
  mockSaveNativeScientificPackage.mockResolvedValue('saved');
});

describe('revise_protocol_step tool', () => {
  it('writes a reversible revision and invalidates edited source claims', async () => {
    const result = await execTool<{
      revisionId: string;
      sourceStatus: string;
      sourceSpanCount: number;
      contentText: string;
    }>(createReviseProtocolStepTool(folders), {
      path: 'paper.dnaforge-protocol.json',
      stepId: 'step-1',
      contentText: 'Mix reagents and inspect the sample.',
    });

    assertMcpOutput(reviseProtocolStepOutputSchema, result);
    expect(result).toMatchObject({
      revisionId: expect.stringMatching(/^protocol-revision-[a-f0-9]{20}$/),
      sourceStatus: 'edited',
      sourceSpanCount: 0,
      contentText: 'Mix reagents and inspect the sample.',
    });
    expect(mockPlatform.fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledOnce();
    const write = mockPlatform.fs.writeWorkspaceTextFileAtomic.mock.calls[0][0];
    expect(write).toMatchObject({
      workspaceRoot: WORKSPACE,
      path: `${WORKSPACE}/paper.dnaforge-protocol.json`,
      mode: 'replace',
      artifactNoun: 'protocol',
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const persisted = JSON.parse(write.content);
    expect(persisted.steps[0]).toMatchObject({
      sourceStatus: 'edited',
      sourceSpans: [],
    });
    expect(persisted.revisions[0]).toMatchObject({
      id: result.revisionId,
      actor: 'agent',
      stepId: 'step-1',
      before: expect.objectContaining({ sourceStatus: 'source' }),
      after: expect.objectContaining({ sourceStatus: 'edited', sourceSpans: [] }),
    });
  });

  it('refuses an empty revision instead of writing the file', async () => {
    await expect(
      execTool(createReviseProtocolStepTool(folders), {
        path: 'paper.dnaforge-protocol.json',
        stepId: 'step-1',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching('replacement title or replacement step content'),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockPlatform.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('saves a native package revision through the catalog-aware mutation boundary', async () => {
    await execTool(createReviseProtocolStepTool(folders), {
      path: 'Protocols/Paper/.forge/protocol.json',
      stepId: 'step-1',
      title: 'Prepare carefully',
    });

    expect(mockSaveNativeScientificPackage).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      metaPath: `${WORKSPACE}/Protocols/Paper/.forge/protocol.json`,
      document: expect.objectContaining({ kind: 'protocol' }),
      expectedText: expect.any(String),
    });
    expect(mockPlatform.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });
});

function protocolDocument(): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'paper-protocol-1',
    title: 'Paper protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'step-1',
        sourceStepId: 'source-1',
        ordinal: 1,
        title: 'Prepare',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mix reagents' }] }],
        },
        sourceStatus: 'source',
        sourceSpans: [
          {
            sourceId: 'paper:example',
            sectionId: 'methods',
            sectionTitle: 'Methods',
            start: 0,
            end: 12,
            sha256: 'a'.repeat(64),
          },
        ],
        puntId: null,
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: '10.1000/example',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-08-18T00:00:00.000Z',
    },
    provenance: { provider: 'literature' },
  });
}
