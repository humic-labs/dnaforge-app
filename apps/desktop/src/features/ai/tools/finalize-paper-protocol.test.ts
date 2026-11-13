import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import {
  finalizePaperProtocolOutputSchema,
  previewFinalizePaperProtocolOutputSchema,
  reopenPaperProtocolOutputSchema,
} from './paper-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  clearPaperProtocolFinalizationPreviewsForTests,
  createFinalizePaperProtocolTool,
  createPreviewFinalizePaperProtocolTool,
  createReopenPaperProtocolTool,
} from './finalize-paper-protocol';
import { execTool } from './test-helpers';

const { mockPlatform, mockSaveNativeScientificPackage } = vi.hoisted(() => ({
  mockSaveNativeScientificPackage: vi.fn(),
  mockPlatform: {
    fs: {
      readTextFile: vi.fn(),
      sha256File: vi.fn(),
    },
  },
}));

vi.mock('../../../platform', () => ({ platform: () => mockPlatform }));
vi.mock('../../scientific-document/native-package', () => ({
  saveNativeScientificPackage: mockSaveNativeScientificPackage,
}));

const WORKSPACE = '/home/user/lab';
const PROTOCOL_PATH = `${WORKSPACE}/Protocols/Paper/.forge/protocol.json`;
const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  clearPaperProtocolFinalizationPreviewsForTests();
  mockPlatform.fs.readTextFile.mockResolvedValue(JSON.stringify(paperProtocolDocument()));
  mockPlatform.fs.sha256File.mockResolvedValue(SOURCE_HASH);
  mockSaveNativeScientificPackage.mockResolvedValue('saved');
});

describe('finalize_paper_protocol tool', () => {
  it('returns a blocked preview as a successful read with a concrete MCP contract', async () => {
    mockPlatform.fs.sha256File.mockResolvedValue(`sha256:${'b'.repeat(64)}`);
    const result = await execTool(createPreviewFinalizePaperProtocolTool(folders), {
      path: 'Protocols/Paper/.forge/protocol.json',
      expectedRevision: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      canFinalize: false,
      blockers: [
        { code: 'preview_rejected', message: expect.stringMatching(/PDF hash does not match/i) },
      ],
    });
    assertMcpOutput(previewFinalizePaperProtocolOutputSchema, result);
    expect(mockSaveNativeScientificPackage).not.toHaveBeenCalled();
  });

  it('accepts the exact reviewed revision and persists one immutable version', async () => {
    const preview = await execTool<{
      canFinalize: boolean;
      previewFingerprint: string;
      unresolvedGaps: unknown[];
    }>(createPreviewFinalizePaperProtocolTool(folders), {
      path: 'Protocols/Paper/.forge/protocol.json',
      expectedRevision: 1,
    });
    assertMcpOutput(previewFinalizePaperProtocolOutputSchema, preview);
    expect(preview).toMatchObject({
      canFinalize: true,
      previewFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      unresolvedGaps: [],
    });

    const result = await execTool<{
      state: string;
      draftRevision: number;
      acceptedVersionId: string;
      replayed: boolean;
    }>(createFinalizePaperProtocolTool(folders), {
      path: 'Protocols/Paper/.forge/protocol.json',
      expectedRevision: 1,
      previewFingerprint: preview.previewFingerprint,
      idempotencyKey: 'accept-paper-protocol-v1',
    });

    assertMcpOutput(finalizePaperProtocolOutputSchema, result);
    expect(result).toMatchObject({
      state: 'finalized',
      draftRevision: 1,
      acceptedVersionId: expect.stringMatching(/^accepted-[a-f0-9]{24}$/),
      replayed: false,
    });
    expect(mockPlatform.fs.sha256File).toHaveBeenCalledWith(`${WORKSPACE}/papers/source.pdf`);
    expect(mockSaveNativeScientificPackage).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      metaPath: PROTOCOL_PATH,
      document: expect.objectContaining({ kind: 'protocol', mutable: false }),
      expectedText: expect.any(String),
    });
  });

  it('refuses finalization when a pinned PDF no longer has the reviewed bytes', async () => {
    const preview = await execTool<{ previewFingerprint: string }>(
      createPreviewFinalizePaperProtocolTool(folders),
      { path: 'Protocols/Paper/.forge/protocol.json', expectedRevision: 1 }
    );
    mockPlatform.fs.sha256File.mockResolvedValue(`sha256:${'b'.repeat(64)}`);

    await expect(
      execTool(createFinalizePaperProtocolTool(folders), {
        path: 'Protocols/Paper/.forge/protocol.json',
        expectedRevision: 1,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: 'accept-stale-source',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/PDF hash does not match/i),
      stateChanged: false,
      partialEffects: [],
    });
    expect(mockSaveNativeScientificPackage).not.toHaveBeenCalled();
  });

  it('replays an exact accepted finalization without depending on the later PDF location', async () => {
    const preview = await execTool<{ previewFingerprint: string }>(
      createPreviewFinalizePaperProtocolTool(folders),
      { path: 'Protocols/Paper/.forge/protocol.json', expectedRevision: 1 }
    );
    const input = {
      path: 'Protocols/Paper/.forge/protocol.json',
      expectedRevision: 1,
      previewFingerprint: preview.previewFingerprint,
      idempotencyKey: 'accept-then-replay',
    };
    await execTool(createFinalizePaperProtocolTool(folders), input);

    const finalizedDocument = mockSaveNativeScientificPackage.mock.calls[0][0].document;
    mockPlatform.fs.readTextFile.mockResolvedValue(JSON.stringify(finalizedDocument.raw));
    const hashReadsBeforeReplay = mockPlatform.fs.sha256File.mock.calls.length;
    mockPlatform.fs.sha256File.mockRejectedValue(new Error('ENOENT: source PDF moved'));

    await expect(execTool(createFinalizePaperProtocolTool(folders), input)).resolves.toMatchObject({
      state: 'finalized',
      replayed: true,
    });
    expect(mockPlatform.fs.sha256File).toHaveBeenCalledTimes(hashReadsBeforeReplay);
    expect(mockSaveNativeScientificPackage).toHaveBeenCalledTimes(1);

    await expect(
      execTool(createFinalizePaperProtocolTool(folders), {
        ...input,
        idempotencyKey: 'different-acceptance-intent',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/idempotency|accepted|finalized/i),
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('rejects flat compatibility documents as a finalization target', async () => {
    await expect(
      execTool(createFinalizePaperProtocolTool(folders), {
        path: 'paper.dnaforge-protocol.json',
        expectedRevision: 1,
        previewFingerprint: `sha256:${'c'.repeat(64)}`,
        idempotencyKey: 'reject-flat-protocol',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/native Protocol package/i),
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('requires preview and reopens an exact accepted version as the next draft', async () => {
    await expect(
      execTool(createFinalizePaperProtocolTool(folders), {
        path: 'Protocols/Paper/.forge/protocol.json',
        expectedRevision: 1,
        previewFingerprint: `sha256:${'c'.repeat(64)}`,
        idempotencyKey: 'missing-preview',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/missing or expired/i),
      stateChanged: false,
      partialEffects: [],
    });

    const preview = await execTool<{ previewFingerprint: string }>(
      createPreviewFinalizePaperProtocolTool(folders),
      { path: 'Protocols/Paper/.forge/protocol.json', expectedRevision: 1 }
    );
    const finalized = await execTool<{ acceptedVersionId: string }>(
      createFinalizePaperProtocolTool(folders),
      {
        path: 'Protocols/Paper/.forge/protocol.json',
        expectedRevision: 1,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: 'accept-before-reopen',
      }
    );
    const finalizedDocument = mockSaveNativeScientificPackage.mock.calls[0][0].document;
    mockPlatform.fs.readTextFile.mockResolvedValue(JSON.stringify(finalizedDocument.raw));

    const reopened = await execTool<{ state: string; draftRevision: number; replayed: boolean }>(
      createReopenPaperProtocolTool(folders),
      {
        path: 'Protocols/Paper/.forge/protocol.json',
        acceptedVersionId: finalized.acceptedVersionId,
        idempotencyKey: 'reopen-accepted-paper',
      }
    );
    assertMcpOutput(reopenPaperProtocolOutputSchema, reopened);
    expect(reopened).toMatchObject({ state: 'draft', draftRevision: 2, replayed: false });
    expect(mockSaveNativeScientificPackage).toHaveBeenCalledTimes(2);
  });
});

function paperProtocolDocument(): Record<string, unknown> {
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
        candidateId: 'paper-candidate-1',
        ordinal: 1,
        label: 'Paper protocol',
        status: 'selected',
      },
      draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'source-pdf',
          kind: 'pdf',
          title: 'Paper PDF',
          mediaType: 'application/pdf',
          sha256: SOURCE_HASH,
          capturedAt: '2026-08-19T00:00:00.000Z',
          workspacePath: 'papers/source.pdf',
          pageCount: 1,
        },
      ],
      evidence: [
        {
          evidenceId: 'evidence-1',
          stepId: 'paper-step-1',
          sourceId: 'source-pdf',
          sourceSha256: SOURCE_HASH,
          evidenceClass: 'direct',
          quote: 'Lyse cells.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }],
          },
        },
      ],
      gaps: [],
      acceptedVersions: [],
    },
  };
}
