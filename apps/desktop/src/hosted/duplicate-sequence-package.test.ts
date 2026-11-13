// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { copySequencePackageDocument } from '../db/sequence-package-copy';
vi.mock('./controller', () => ({ hostedDurableSync: {}, hostedWorkspaceSessionController: {} }));
import { duplicateHostedSequencePackage } from './duplicate-sequence-package';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const root = 'sequences/source';
const document = buildSequencePackageDocument({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'Source',
  product: { file: 'source.gb', topology: 'circular' },
  members: [
    {
      id: 'source-read',
      role: 'sequencing-read',
      path: 'contents/read.ab1',
      replaceable: false,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
});

async function fixture(extraPaths: string[] = []) {
  const data = new Map<string, Uint8Array>([
    [
      `${root}/.forge/plasmid.json`,
      new TextEncoder().encode(serializeSequencePackageDocument(document)),
    ],
    [`${root}/source.gb`, new TextEncoder().encode('LOCUS SOURCE\nORIGIN\n        1 atgc\n//\n')],
    [`${root}/contents/read.ab1`, new Uint8Array([0, 255, 13, 128])],
    [`${root}/assets/user-notes.txt`, new TextEncoder().encode('User-owned attachment\n')],
    ...extraPaths.map((path): [string, Uint8Array] => [path, new Uint8Array([10])]),
  ]);
  let snapshot: WorkspaceSessionSnapshot = {
    workspaceId,
    revisionId: 'accepted',
    revisionNumber: 1,
    files: [...data].map(([path, bytes], index) => ({
      path,
      resourceId: `source-${index}`,
      contentRevision: `revision-${index}`,
      contentSha256: null,
      sizeBytes: bytes.byteLength,
      contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    })),
  };
  const read = vi.fn(async ({ file }: Parameters<WorkspaceSessionAdapter['readFile']>[0]) => {
    const bytes = data.get(file.path);
    if (!bytes) throw new Error('missing bytes');
    return bytes;
  });
  const commit = vi.fn(async ({ writes }: Parameters<WorkspaceSessionAdapter['commit']>[0]) => {
    for (const write of writes) data.set(write.path, write.bytes);
    snapshot = {
      ...snapshot,
      revisionId: 'copy-accepted',
      revisionNumber: 2,
      files: [
        ...snapshot.files,
        ...writes.map((write) => ({
          path: write.path,
          resourceId: write.resourceId ?? null,
          contentRevision: 'copied',
          contentSha256: null,
          sizeBytes: write.bytes.byteLength,
          contentType: write.contentType,
        })),
      ],
    };
    return snapshot;
  });
  const adapter: WorkspaceSessionAdapter = {
    descriptor: {
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: {
        createWorkspace: false,
        multiFile: true,
        write: true,
        rename: true,
        move: true,
        delete: true,
        watch: true,
        history: false,
        restore: false,
      },
    },
    createWorkspace: async () => {
      throw new Error('not part of copy');
    },
    listWorkspaces: async () => ({
      principal: { id: actorId, label: 'Actor' },
      workspaces: [
        {
          workspaceId,
          clientWorkspaceId: workspaceId,
          displayName: 'Project',
          latestRevisionId: 'accepted',
          latestRevisionNumber: 1,
        },
      ],
    }),
    loadWorkspace: async () => snapshot,
    readFile: read,
    commit,
  };
  const controller = new WorkspaceSessionController(adapter);
  await controller.initialize();
  const port = {
    getState: controller.getState,
    commit: controller.commit.bind(controller),
    readFile: read,
  };
  return { data, read, commit, controller, port };
}

describe('whole hosted sequence package copy', () => {
  it('commits every package byte once through the real controller and rekeys package, member and file IDs', async () => {
    const f = await fixture();
    expect(await duplicateHostedSequencePackage(`/hosted/${workspaceId}/${root}`, f.port)).toBe(
      `/hosted/${workspaceId}/sequences/source copy`
    );
    expect(f.commit).toHaveBeenCalledOnce();
    const writes = f.commit.mock.calls[0][0].writes;
    expect(writes).toHaveLength(4);
    const copied = parseSequencePackageDocument(
      new TextDecoder().decode(
        writes.find((write) => write.path.endsWith('/.forge/plasmid.json'))!.bytes
      )
    );
    expect(copied.id).not.toBe(document.id);
    expect(copied.name).toBe('Source copy');
    expect(copied.product).toEqual(document.product);
    expect(copied.entity).toEqual({
      ...document.entity,
      relationships: [
        {
          type: 'derived_from',
          fromEntityId: copied.id,
          toEntityId: document.id,
          payload: { operation: 'duplicate' },
        },
      ],
    });
    expect(copied.members[0]).toEqual({ ...document.members[0], id: expect.any(String) });
    expect(copied.members[0].id).not.toBe(document.members[0].id);
    expect(new Set(writes.map((write) => write.resourceId)).size).toBe(4);
    for (const write of writes) {
      expect(write.resourceId).not.toMatch(/^source-/);
      if (!write.path.endsWith('/.forge/plasmid.json'))
        expect(write.bytes).toEqual(f.data.get(write.path.replace('source copy/', 'source/')));
    }
    expect(
      parseSequencePackageDocument(
        new TextDecoder().decode(f.data.get(`${root}/.forge/plasmid.json`)!)
      )
    ).toEqual(document);
  });

  it('records a copy-of-copy immediate source without changing either source package', async () => {
    const f = await fixture();
    const originalBytes = f.data.get(`${root}/.forge/plasmid.json`)!.slice();
    const firstPath = await duplicateHostedSequencePackage(
      `/hosted/${workspaceId}/${root}`,
      f.port
    );
    const firstMarkerPath = `${firstPath.replace(`/hosted/${workspaceId}/`, '')}/.forge/plasmid.json`;
    const firstBytes = f.data.get(firstMarkerPath)!.slice();
    const first = parseSequencePackageDocument(new TextDecoder().decode(firstBytes));

    const secondPath = await duplicateHostedSequencePackage(firstPath, f.port);
    const secondMarkerPath = `${secondPath.replace(`/hosted/${workspaceId}/`, '')}/.forge/plasmid.json`;
    const second = parseSequencePackageDocument(
      new TextDecoder().decode(f.data.get(secondMarkerPath)!)
    );

    expect(new Set([document.id, first.id, second.id]).size).toBe(3);
    expect(second.entity.relationships).toEqual([
      {
        type: 'derived_from',
        fromEntityId: second.id,
        toEntityId: document.id,
        payload: { operation: 'duplicate' },
      },
      {
        type: 'derived_from',
        fromEntityId: second.id,
        toEntityId: first.id,
        payload: { operation: 'duplicate' },
      },
    ]);
    expect(f.data.get(firstMarkerPath)).toEqual(firstBytes);
    expect(f.data.get(`${root}/.forge/plasmid.json`)).toEqual(originalBytes);
    expect(f.commit).toHaveBeenCalledTimes(2);
  });

  it('chooses a case-insensitive collision-safe package root without replacing any member', async () => {
    const f = await fixture(['sequences/SOURCE COPY/existing.txt']);
    await duplicateHostedSequencePackage(`/hosted/${workspaceId}/${root}`, f.port);
    expect(
      f.commit.mock.calls[0][0].writes.every((write) =>
        write.path.startsWith('sequences/source copy 2/')
      )
    ).toBe(true);
    expect(f.data.get('sequences/SOURCE COPY/existing.txt')).toEqual(new Uint8Array([10]));
  });

  it('fails before commit when a declared member is missing', async () => {
    const f = await fixture();
    const state = f.controller.getState();
    const port = {
      ...f.port,
      getState: () => ({
        ...state,
        snapshot: {
          ...state.snapshot!,
          files: state.snapshot!.files.filter((file) => !file.path.endsWith('/read.ab1')),
        },
      }),
    };
    await expect(
      duplicateHostedSequencePackage(`/hosted/${workspaceId}/${root}`, port)
    ).rejects.toThrow('missing contents/read.ab1');
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('publishes nothing after a byte read fails', async () => {
    const f = await fixture();
    f.read.mockRejectedValueOnce(new Error('download failed'));
    await expect(
      duplicateHostedSequencePackage(`/hosted/${workspaceId}/${root}`, f.port)
    ).rejects.toThrow('download failed');
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['account', 'project', 'capture'] as const)(
    'refuses a %s change during immutable reads',
    async (change) => {
      const f = await fixture();
      const state = f.controller.getState();
      let calls = 0;
      const port = {
        ...f.port,
        getState: () => {
          if (calls++ === 0) return state;
          return {
            ...state,
            ...(change === 'account' ? { principal: { ...state.principal!, id: 'other' } } : {}),
            ...(change === 'project' ? { activeWorkspaceId: 'other' } : {}),
            ...(change === 'capture'
              ? { snapshot: { ...state.snapshot!, localRevisionId: 'newer-draft' } }
              : {}),
          };
        },
      };
      await expect(
        duplicateHostedSequencePackage(`/hosted/${workspaceId}/${root}`, port)
      ).rejects.toThrow('changed while copying');
      expect(f.commit).not.toHaveBeenCalled();
    }
  );

  it('does not duplicate a Registry registration and rebinds only self-relationships', () => {
    const source = {
      ...document,
      futureMetadata: { nested: ['preserved'] },
      entity: {
        ...document.entity,
        futureEntityMetadata: { nested: ['preserved'] },
        registryId: 'registry-original',
        registrationStatus: 'registered' as const,
        fields: { description: 'Original metadata' },
        relationships: [
          {
            type: 'source',
            fromEntityId: document.id,
            toEntityId: 'external',
            payload: { note: 'kept' },
            futureRelationshipMetadata: { nested: ['preserved'] },
          },
        ],
      },
    };
    const original = structuredClone(source);
    const ids = ['new-package', 'new-member'];
    const copied = copySequencePackageDocument(source, 'Copy', () => ids.shift()!);
    expect(copied.entity).toMatchObject({
      registrationStatus: 'tracked',
      registryId: null,
      fields: source.entity.fields,
      relationships: [
        { ...source.entity.relationships[0], fromEntityId: 'new-package' },
        {
          type: 'derived_from',
          fromEntityId: 'new-package',
          toEntityId: source.id,
          payload: { operation: 'duplicate' },
        },
      ],
    });
    const persisted = parseSequencePackageDocument(serializeSequencePackageDocument(copied));
    expect(persisted.futureMetadata).toEqual(source.futureMetadata);
    expect(persisted.entity).toMatchObject({
      futureEntityMetadata: source.entity.futureEntityMetadata,
      relationships: copied.entity.relationships,
    });
    copied.entity.fields.description = 'Changed copy';
    copied.entity.relationships[0].payload.note = 'Changed copy';
    expect(source).toEqual(original);
  });
});
