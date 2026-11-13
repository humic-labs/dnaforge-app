import { describe, expect, it, vi } from 'vitest';
import type { SequencePackageHistoryIndex } from '../../../db/sequence-package-history-io';
import type { SequencePackageDocument } from '../../../db/sequence-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  applySequenceUserAttachmentMutationSchema,
  createApplySequenceUserAttachmentMutationTool as originalCreateApplySequenceUserAttachmentMutationTool,
  createPreviewSequenceUserAttachmentMutationTool as originalCreatePreviewSequenceUserAttachmentMutationTool,
  type SequenceUserAttachmentToolDependencies,
} from './sequence-user-attachment-mutation';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import {
  previewSequenceUserAttachmentMutationOutputSchema,
  applySequenceUserAttachmentMutationOutputSchema,
} from './sequence-output-schemas';
const createPreviewSequenceUserAttachmentMutationTool = checkedSequenceToolFactory(
  originalCreatePreviewSequenceUserAttachmentMutationTool,
  previewSequenceUserAttachmentMutationOutputSchema
);
const createApplySequenceUserAttachmentMutationTool = checkedSequenceToolFactory(
  originalCreateApplySequenceUserAttachmentMutationTool,
  applySequenceUserAttachmentMutationOutputSchema
);

   
                                                                                
                                                                             
                                                                               
                                                                              
                                                                                 
                                                                                
                                  
   
const SCENARIOS_V1 = {
  attach: { sourcePath: 'input.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
  changedSource: { sourcePath: 'input.bin', bytes: new Uint8Array([0, 1, 3, 255]) },
} as const;

const folders: WorkspaceFolder[] = [{ name: 'Lab', path: '/workspace', addedAt: 1 }];
const options = { toolCallId: 'test-call', messages: [] };
const markerSha256 = `sha256:${'a'.repeat(64)}`;
const productSha256 = `sha256:${'b'.repeat(64)}`;

function index(headId = 'head-one'): SequencePackageHistoryIndex {
  return {
    packageRoot: '/workspace/package-one',
    markerPath: '/workspace/package-one/.forge/plasmid.json',
    productPath: '/workspace/package-one/product.gb',
    currentProductStatus: 'verified',
    legacyCurrentHasNoSnapshot: false,
    document: {
      id: 'package-one',
      formatVersion: 8,
      userAttachments: {},
      members: [],
      versionHistory: { headId, revisions: [{ id: headId, operationId: headId }] },
    } as unknown as SequencePackageDocument,
  };
}

function indexWithAttachment(): SequencePackageHistoryIndex {
  const current = index();
  current.document.userAttachments['logical-one'] = {
    memberId: 'member-old',
    sha256: `sha256:${'d'.repeat(64)}`,
  };
  current.document.members.push({
    id: 'member-old',
    role: 'user',
    path: 'contents/user-attachment-old-input.bin',
    replaceable: false,
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return current;
}

function dependencies() {
  let currentIndex = index();
  let sourceBytes = SCENARIOS_V1.attach.bytes;
  let currentMarker = markerSha256;
  let dirty = false;
  const deps: SequenceUserAttachmentToolDependencies = {
    resolveIndex: vi.fn(async () => ({ index: currentIndex, workspaceRoot: '/workspace' })),
    captureBaseline: vi.fn(async () => ({ markerSha256: currentMarker, productSha256 })),
    stat: vi.fn(async (path: string) => ({
      canonicalPath: path,
      size: path === '/workspace' ? 0 : sourceBytes.byteLength,
      isFile: path !== '/workspace',
      isDirectory: path === '/workspace',
      mtime: 1,
      ctime: 1,
      mtimeNs: '1',
      ctimeNs: '1',
      device: '1',
      inode: '2',
    })),
    validateWorkspacePath: vi.fn(async () => true),
    readFileBounded: vi.fn(async () => new Uint8Array(sourceBytes)),
    assertEditorsSettled: vi.fn(() => {
      if (dirty) throw new Error('An editor has unsaved changes.');
    }),
    withMutation: vi.fn(async (_root, work) => work('lease-one')),
    publish: vi.fn(async () => ({
      revisionId: 'user-attachment:operation-one',
      alreadyPublished: false,
      snapshotPaths: ['/workspace/private-snapshot'],
      assetPaths: ['/workspace/private-asset'],
    })),
    uuid: vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333'),
    now: () => '2026-09-30T12:00:00.000Z',
  };
  return {
    deps,
    setIndex(value: SequencePackageHistoryIndex) {
      currentIndex = value;
    },
    setSourceBytes(value: Uint8Array) {
      sourceBytes = value;
    },
    setMarker(value: string) {
      currentMarker = value;
    },
    setDirty(value: boolean) {
      dirty = value;
    },
  };
}

async function preview(deps: SequenceUserAttachmentToolDependencies) {
  return createPreviewSequenceUserAttachmentMutationTool(folders, deps).execute!(
    { documentId: 'package-one', kind: 'attach', sourcePath: SCENARIOS_V1.attach.sourcePath },
    options
  );
}

function applyInput(review: Record<string, unknown>) {
  const { ok: _resultTag, ...intent } = review;
  return { ...intent, sourcePath: SCENARIOS_V1.attach.sourcePath };
}

describe('sequence user attachment agent mutation v1', () => {
  it('previews exact bytes, then publishes only that reviewed intent without returning paths', async () => {
    const state = dependencies();
    const reviewed = await preview(state.deps);
    expect(reviewed).toMatchObject({
      ok: true,
      documentId: 'package-one',
      kind: 'attach',
      currentHeadId: 'head-one',
      expectedMarkerSha256: markerSha256,
      expectedProductSha256: productSha256,
      sourceSizeBytes: 4,
      attachmentId: '11111111-1111-4111-8111-111111111111',
      memberId: '22222222-2222-4222-8222-222222222222',
      operationId: 'user-attachment:33333333-3333-4333-8333-333333333333',
      previewFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(reviewed)).not.toContain('/workspace');
    expect(applySequenceUserAttachmentMutationSchema.safeParse(applyInput(reviewed)).success).toBe(
      true
    );
    const applied = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(applied).toMatchObject({
      ok: true,
      documentId: 'package-one',
      kind: 'attach',
      attachmentId: reviewed.attachmentId,
      alreadyPublished: false,
    });
    expect(JSON.stringify(applied)).not.toContain('/workspace');
    expect(state.deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: reviewed.operationId,
        expectedMarkerSha256: markerSha256,
        expectedProductSha256: productSha256,
        mutation: expect.objectContaining({
          kind: 'attach',
          memberId: reviewed.memberId,
          attachmentId: reviewed.attachmentId,
          content: SCENARIOS_V1.attach.bytes,
        }),
        mutationToken: 'lease-one',
      })
    );
  });

  it('rejects a changed source byte before publication', async () => {
    const state = dependencies();
    const reviewed = await preview(state.deps);
    state.setSourceBytes(SCENARIOS_V1.changedSource.bytes);
    const result = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(result).toMatchObject({
      ok: false,
      code: 'ATTACHMENT_SOURCE_CHANGED',
      stateChanged: false,
    });
    expect(state.deps.publish).not.toHaveBeenCalled();
  });

  it('replaces one existing logical association while pinning its previous member', async () => {
    const state = dependencies();
    state.setIndex(indexWithAttachment());
    const reviewed = await createPreviewSequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(
      {
        documentId: 'package-one',
        kind: 'replace',
        attachmentId: 'logical-one',
        sourcePath: 'input.bin',
      },
      options
    );
    expect(reviewed).toMatchObject({
      ok: true,
      kind: 'replace',
      attachmentId: 'logical-one',
      previousMemberId: 'member-old',
      previousSha256: `sha256:${'d'.repeat(64)}`,
    });
    const applied = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(applied).toMatchObject({ ok: true, kind: 'replace', attachmentId: 'logical-one' });
    expect(state.deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ kind: 'replace', attachmentId: 'logical-one' }),
      })
    );
  });

  it('detaches an existing logical association without reading or deleting member bytes', async () => {
    const state = dependencies();
    state.setIndex(indexWithAttachment());
    const reviewed = await createPreviewSequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(
      { documentId: 'package-one', kind: 'detach', attachmentId: 'logical-one' },
      options
    );
    expect(reviewed).toMatchObject({
      ok: true,
      kind: 'detach',
      attachmentId: 'logical-one',
      previousMemberId: 'member-old',
    });
    const { ok: _resultTag, ...intent } = reviewed;
    const applied = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(intent, options);
    expect(applied).toMatchObject({ ok: true, kind: 'detach' });
    expect(state.deps.readFileBounded).not.toHaveBeenCalled();
    expect(state.deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: { kind: 'detach', attachmentId: 'logical-one', createdAt: reviewed.createdAt },
      })
    );
  });

  it('rejects a changed package head unless the same operation was already published', async () => {
    const state = dependencies();
    const reviewed = await preview(state.deps);
    state.setMarker(`sha256:${'c'.repeat(64)}`);
    state.setIndex(index('head-two'));
    const result = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(result).toMatchObject({
      ok: false,
      code: 'ATTACHMENT_STALE_PREVIEW',
      stateChanged: false,
    });
    expect(state.deps.publish).not.toHaveBeenCalled();
  });

  it('resends the same exact request after restart when its operation already appears in History', async () => {
    const state = dependencies();
    const reviewed = await preview(state.deps);
    const later = index('head-two');
    later.document.versionHistory.revisions.push({
      id: reviewed.operationId as string,
      operationId: reviewed.operationId as string,
      kind: 'member-update',
    } as SequencePackageDocument['versionHistory']['revisions'][number]);
    state.setIndex(later);
    state.setMarker(`sha256:${'c'.repeat(64)}`);
    vi.mocked(state.deps.publish).mockResolvedValueOnce({
      revisionId: reviewed.operationId as string,
      alreadyPublished: true,
      snapshotPaths: [],
      assetPaths: [],
    });
    const result = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(result).toMatchObject({ ok: true, alreadyPublished: true });
    expect(state.deps.publish).toHaveBeenCalledTimes(1);
  });

  it('does not claim no effect when an old operation exists but its source is now unavailable', async () => {
    const state = dependencies();
    const reviewed = await preview(state.deps);
    const later = index('head-two');
    later.document.versionHistory.revisions.push({
      id: reviewed.operationId as string,
      operationId: reviewed.operationId as string,
      kind: 'member-update',
    } as SequencePackageDocument['versionHistory']['revisions'][number]);
    state.setIndex(later);
    state.setMarker(`sha256:${'c'.repeat(64)}`);
    vi.mocked(state.deps.readFileBounded).mockRejectedValueOnce(new Error('source disappeared'));
    const result = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(result).toMatchObject({
      ok: false,
      code: 'ATTACHMENT_RETRY_UNVERIFIED',
      stateChanged: 'unknown',
    });
    expect(state.deps.publish).not.toHaveBeenCalled();
  });

  it('rejects source-path escapes, pinned roots, and dirty editors', async () => {
    const state = dependencies();
    const previewTool = createPreviewSequenceUserAttachmentMutationTool(folders, state.deps);
    const escaped = await previewTool.execute!(
      { documentId: 'package-one', kind: 'attach', sourcePath: '../outside.bin' },
      options
    );
    expect(escaped).toMatchObject({ ok: false, code: 'ATTACHMENT_SOURCE_UNAVAILABLE' });
    expect(state.deps.readFileBounded).not.toHaveBeenCalled();

    const reviewed = await preview(state.deps);
    state.setDirty(true);
    const blocked = await createApplySequenceUserAttachmentMutationTool(folders, state.deps)
      .execute!(applyInput(reviewed), options);
    expect(blocked).toMatchObject({
      ok: false,
      code: 'ATTACHMENT_DIRTY_EDITOR',
      stateChanged: false,
    });
    expect(state.deps.publish).not.toHaveBeenCalled();

    const pinned = await createPreviewSequenceUserAttachmentMutationTool(
      [{ ...folders[0], pinned: true }],
      state.deps
    ).execute!({ documentId: 'package-one', kind: 'attach', sourcePath: 'input.bin' }, options);
    expect(pinned).toMatchObject({ ok: false, code: 'ATTACHMENT_PACKAGE_UNAVAILABLE' });
  });

  it('rejects a source symlink even when the lexical path lies inside the workspace', async () => {
    const state = dependencies();
    vi.mocked(state.deps.validateWorkspacePath).mockResolvedValueOnce(false);
    const result = await preview(state.deps);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_SOURCE_UNAVAILABLE' });
    expect(state.deps.readFileBounded).not.toHaveBeenCalled();
  });
});
