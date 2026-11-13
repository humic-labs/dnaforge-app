import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsRegistryPreview } from '../../shared/lims';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  folders: [{ path: '/project', pinned: false }],
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('../workspace-loader/public/project-edit-folders', () => ({
  listProjectEditFolders: async () => mocks.folders,
  mergeProjectEditFolders: (folders: unknown) => folders,
}));
beforeEach(() => {
  mocks.update.mockClear();
  mocks.folders = [{ path: '/project', pinned: false }];
});
vi.mock('../../db/workspace-catalog', () => ({ getCurrentCatalogFileForEntity: async () => null }));
vi.mock('../../services/lims-entity-mutations', () => ({ updateLimsEntity: mocks.update }));
import { prepareRegistryMetadataEdit } from './registry-metadata-edit';

function preview(): LimsRegistryPreview {
  const schemaSnapshot = {
    schemaId: 'specimen',
    schemaRevisionId: 'specimen-v1',
    name: 'specimen',
    displayName: 'Specimen',
    baseKind: 'record' as const,
    version: 1,
    fields: [
      { key: 'parent', label: 'Parent entity', type: 'record_relationship' as const },
      { key: 'notes', label: 'Notes', type: 'text' as const },
    ],
  };
  const fields = {
    parent: {
      origin: 'native',
      destinationEntityId: 'parent-1',
      relationType: 'references',
      label: 'Old parent',
      resolution: 'exact',
    },
    notes: 'Saved',
  };
  const entity = {
    id: 'record-1',
    kind: 'specimen',
    schemaId: schemaSnapshot.schemaId,
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    name: 'Specimen',
    registryId: 's1',
    fields,
    registrationStatus: 'registered' as const,
    domainStatus: null,
    workspaceId: 1,
    actor: 'local-user',
    eventSeq: 7,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
  return {
    entity,
    schemaSnapshot,
    summary: {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      registryId: entity.registryId,
      registrationStatus: entity.registrationStatus,
      domainStatus: null,
      schemaSnapshot,
      fieldValues: fields,
      schemaDisplayName: 'Specimen',
      representation: { kind: 'none', label: 'Record', canOpen: false },
      summary: '',
      linkSummary: { outgoingCount: 0, incomingCount: 0, notable: [] },
      searchableText: entity.name,
      updatedAt: 1,
      archived: false,
    },
    outgoingLinks: [],
    incomingLinks: [],
  };
}

describe('shared Registry metadata writes', () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(preview().entity);
  });

  it('retains the exact audited request when a save response is unconfirmed', async () => {
    mocks.update.mockRejectedValueOnce(new Error('response lost'));
    const editor = await prepareRegistryMetadataEdit(preview());
    let failure: unknown;
    try {
      await editor.save({ name: 'Specimen', fields: { notes: 'Pending' } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ saveConfirmed: false, complete: expect.any(Function) });
    if (!(failure instanceof SavedDocumentCompletionError))
      throw new Error('Expected an exact save continuation');
    const request = structuredClone(mocks.update.mock.calls[0][0]);
    await failure.complete();
    expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([request, request]);
  });

  it('sends selected relationship identities through the checked native relationship command', async () => {
    const editor = await prepareRegistryMetadataEdit(preview());
    await editor.save({
      name: 'Specimen',
      fields: {
        parent: {
          origin: 'native',
          destinationEntityId: 'parent-2',
          relationType: 'references',
          label: 'Untrusted label',
          resolution: 'exact',
        },
        notes: 'Updated',
      },
    });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      id: 'record-1',
      expectedEventSeq: 7,
      operationId: expect.any(String),
      fields: { notes: 'Updated' },
      relationshipTargets: { parent: 'parent-2' },
    });
  });

  it('clears only the selected schema link while retaining unrelated metadata', async () => {
    const editor = await prepareRegistryMetadataEdit(preview());
    await editor.save({ name: 'Specimen', fields: { parent: null, notes: 'Retained' } });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: { notes: 'Retained' },
        relationshipTargets: { parent: null },
      })
    );
  });
});

function scientificPreview(): LimsRegistryPreview {
  return {
    ...preview(),
    entity: { ...preview().entity, id: 'strain-1', name: 'Saved strain', fields: {} },
    nativeRecord: {
      scientificAuthority: {
        workspaceId: 'workspace-1',
        workspaceRoot: '/project',
        artifactPath: '/project/strain.entity.json',
        revision: {
          kind: 'accepted-object',
          resourceId: 'strain-1',
          resourceRevisionId: `rr_${'a'.repeat(64)}`,
          workspaceVersionId: `wv_${'b'.repeat(64)}`,
          contentSha256: 'c'.repeat(64),
          sequenceEditParentEventId: null,
        },
      },
    },
  } as LimsRegistryPreview;
}

describe('shared Registry metadata save authority', () => {
  beforeEach(() => {
    mocks.update.mockResolvedValue({ id: 'strain-1', workspaceId: 1 });
  });
  it('carries the captured native strain revision to its scientific save owner', async () => {
    const record = scientificPreview();
    const session = await prepareRegistryMetadataEdit(record);
    await session.save({ name: 'Edited strain', fields: { description: 'Edited metadata' } });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'strain-1',
        name: 'Edited strain',
        expectedEventSeq: 7,
        operationId: expect.any(String),
        fields: { description: 'Edited metadata' },
      },
      { scientificAuthority: record.nativeRecord!.scientificAuthority }
    );
  });

  it('refuses a save when the owning project becomes a reference after editing starts', async () => {
    const session = await prepareRegistryMetadataEdit(scientificPreview());
    mocks.folders = [{ path: '/project', pinned: true }];
    await expect(session.save({ name: 'Edited strain', fields: {} })).rejects.toThrow('reference');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
