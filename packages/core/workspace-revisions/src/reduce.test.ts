import { describe, expect, it } from 'vitest';

import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';

import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectWorkspaceVersion,
  listWorkspaceResources,
  parseMemberId,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseResourcePath,
  parseWorkspaceId,
  parseWorkspacePath,
  type ResourceState,
  type ApplyMutationResult,
  type Result,
} from './index';

type Changed = Extract<ApplyMutationResult, { readonly kind: 'changed' }>;
const MAIN_REF = must(parseRefName('main'));

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}

function versionResources(result: Changed) {
  return must(listWorkspaceResources(result.graph, result.version.id));
}

function fileState(contents: string): ResourceState {
  return must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode(contents)),
      materialMetadata: { alphabet: 'utf-8' },
    })
  );
}

function packageState(memberPath = 'product.gb'): ResourceState {
  return must(
    defineResourceState({
      layout: 'directory',
      resourceKind: 'dnaforge.sequence-package',
      format: 'dnaforge.sequence-package/6',
      members: [
        {
          memberId: must(parseMemberId('member-product')),
          relativePath: must(parseResourcePath(memberPath)),
          mediaType: 'application/vnd.dnaforge.genbank',
          blob: defineBlob(new TextEncoder().encode('LOCUS       PRODUCT')),
        },
        {
          memberId: must(parseMemberId('member-manifest')),
          relativePath: must(parseResourcePath('.forge/plasmid.json')),
          mediaType: 'application/json',
          blob: defineBlob(new TextEncoder().encode('{"formatVersion":6}')),
        },
      ],
      materialMetadata: { topology: 'circular' },
    })
  );
}

function emptyGraph() {
  return createRevisionGraph({
    workspaceId: must(parseWorkspaceId('workspace-alpha')),
    acceptedRef: MAIN_REF,
  });
}

describe('resource state definition', () => {
  it('supports file resources and compound directory resources through one constructor', () => {
    expect(fileState('hello')).toBeDefined();
    expect(packageState()).toBeDefined();
  });

  it('rejects non-scalar and oversized canonical text fields', () => {
    for (const mediaType of ['text/\ud800', `text/${'a'.repeat(257)}`]) {
      expect(
        defineResourceState({
          layout: 'file',
          resourceKind: 'text.note',
          mediaType,
          blob: defineBlob(new Uint8Array([1])),
        })
      ).toEqual({ ok: false, error: { kind: 'invalid-field', field: 'mediaType' } });
    }
  });

  it('normalizes blob references to their exact protocol shape before hashing', () => {
    const blob = defineBlob(new TextEncoder().encode('normalized'));
    const blobWithCallerMetadata = { ...blob, callerTrace: 'ignored' };
    const state = must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob: blobWithCallerMetadata,
      })
    );
    const cleanState = must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob,
      })
    );
    expect(state).toEqual(cleanState);
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('normalized-blob-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('normalized-blob-resource')),
        path: must(parseWorkspacePath('normalized.txt')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected normalized blob create.');
    expect(importCanonicalRecords(exportCanonicalClosure(created.graph)).ok).toBe(true);
  });

  it('makes member ordering immaterial without discarding untrusted duplicates', () => {
    const product = {
      memberId: must(parseMemberId('product')),
      relativePath: must(parseResourcePath('product.gb')),
      mediaType: 'application/vnd.dnaforge.genbank',
      blob: defineBlob(new TextEncoder().encode('LOCUS')),
    };
    const manifest = {
      memberId: must(parseMemberId('manifest')),
      relativePath: must(parseResourcePath('.forge/plasmid.json')),
      mediaType: 'application/json',
      blob: defineBlob(new TextEncoder().encode('{}')),
    };
    const left = must(
      defineResourceState({
        layout: 'directory',
        resourceKind: 'dnaforge.sequence-package',
        format: 'dnaforge.sequence-package/6',
        members: [product, manifest],
      })
    );
    const right = must(
      defineResourceState({
        layout: 'directory',
        resourceKind: 'dnaforge.sequence-package',
        format: 'dnaforge.sequence-package/6',
        members: [manifest, product],
      })
    );
    expect(left).toEqual(right);
    expect(
      defineResourceState({
        layout: 'directory',
        resourceKind: 'dnaforge.sequence-package',
        format: 'dnaforge.sequence-package/6',
        members: [product, product],
      })
    ).toEqual({ ok: false, error: { kind: 'duplicate-member-id', memberId: 'product' } });
  });

  it('rejects an interleaved file-ancestor collision without quadratic pair scanning', () => {
    const member = (memberId: string, relativePath: string) => ({
      memberId: must(parseMemberId(memberId)),
      relativePath: must(parseResourcePath(relativePath)),
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode(memberId)),
    });
    expect(
      defineResourceState({
        layout: 'directory',
        resourceKind: 'directory.fixture',
        format: 'directory.fixture/1',
        members: [member('ancestor', 'a'), member('interleaved', 'a!'), member('child', 'a/b')],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'member-path-conflict', paths: ['a', 'a/b'] },
    });
  });
});

describe('first workspace revision reducer slice', () => {
  it('rejects joined-path overflow during create without throwing or publishing', () => {
    const result = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('overflow-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('overflow-create-resource')),
        path: longPortableRoot(),
        state: packageState('e'.repeat(250)),
        origin: { kind: 'created' },
      },
    });
    expect(result).toMatchObject({
      kind: 'rejected',
      error: {
        kind: 'invalid-mutation',
        reason: 'invalid materialized path: path-too-long',
      },
    });
    expect('publication' in result).toBe(false);
  });

  it('rejects joined-path overflow during move without changing the accepted version', () => {
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('overflow-move-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('overflow-move-resource')),
        path: must(parseWorkspacePath('x')),
        state: packageState('e'.repeat(250)),
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected overflow move fixture.');
    const moved = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('overflow-move-apply')),
      mutation: {
        kind: 'move-resource',
        resourceId: must(parseResourceId('overflow-move-resource')),
        expectedPath: must(parseWorkspacePath('x')),
        destination: longPortableRoot(),
      },
    });
    expect(moved).toMatchObject({
      kind: 'rejected',
      error: {
        kind: 'invalid-mutation',
        reason: 'invalid materialized path: path-too-long',
      },
    });
    expect('publication' in moved).toBe(false);
  });

  it('creates one resource revision and one workspace version', () => {
    const graph = emptyGraph();
    const resourceId = must(parseResourceId('resource-alpha'));
    const result = applyWorkspaceMutation({
      graph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('create-alpha')),
      mutation: {
        kind: 'create-resource',
        resourceId,
        path: must(parseWorkspacePath('notes/alpha.txt')),
        state: fileState('alpha'),
        origin: { kind: 'created' },
      },
    });

    expect(result.kind).toBe('changed');
    if (result.kind !== 'changed') throw new Error('Expected changed result.');
    expect(result.effects).toEqual({
      resourceState: 'created',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    });
    expect(result.version.parentIds).toEqual([]);
    expect(versionResources(result)).toHaveLength(1);
    expect(versionResources(result)[0]).toMatchObject({
      resourceId,
      path: 'notes/alpha.txt',
      lastPath: 'notes/alpha.txt',
      tombstone: false,
    });
    expect(result.publication.refAdvance).toEqual({
      workspaceId: 'workspace-alpha',
      refName: MAIN_REF,
      expected: null,
      next: result.version.id,
    });
    expect(result.publication.recordWrites.map((write) => write.kind).sort()).toEqual([
      'operation-receipt',
      'resource-revision',
      'resource-state',
      'workspace-path-map-node',
      'workspace-resource-map-node',
      'workspace-version',
    ]);
    const inspected = inspectWorkspaceVersion(result.graph, result.version.id);
    expect(inspected).toEqual({ ok: true, value: result.version });
  });

  it('shares identical material state while keeping logical resource revisions distinct', () => {
    const first = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('create-first')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-first')),
        path: must(parseWorkspacePath('notes/first.txt')),
        state: fileState('shared bytes'),
        origin: { kind: 'created' },
      },
    });
    if (first.kind !== 'changed') throw new Error('Expected first create to change.');
    const second = applyWorkspaceMutation({
      graph: first.graph,
      refName: MAIN_REF,
      expectedHead: first.version.id,
      operationId: must(parseOperationId('create-second')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-second')),
        path: must(parseWorkspacePath('notes/second.txt')),
        state: fileState('shared bytes'),
        origin: { kind: 'created' },
      },
    });
    if (second.kind !== 'changed') throw new Error('Expected second create to change.');

    const firstRevisionId = versionResources(first)[0]?.revisionId;
    const secondRevisionId = versionResources(second).find(
      (slot) => slot.resourceId === 'resource-second'
    )?.revisionId;
    if (!firstRevisionId || !secondRevisionId) throw new Error('Expected both revisions.');
    const firstRevision = must(inspectResourceRevision(second.graph, firstRevisionId));
    const secondRevision = must(inspectResourceRevision(second.graph, secondRevisionId));
    expect(firstRevision.stateHash).toBe(secondRevision.stateHash);
    expect(firstRevision.id).not.toBe(secondRevision.id);
    expect(second.effects.resourceState).toBe('reused');
    expect(second.publication.recordWrites.map((write) => write.kind)).not.toContain(
      'resource-state'
    );
  });

  it('treats an equal-state edit as a no-op', () => {
    const state = fileState('same');
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('create-for-edit')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-edit')),
        path: must(parseWorkspacePath('notes/edit.txt')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected create to change.');
    const revisionId = versionResources(created)[0]?.revisionId;
    if (!revisionId) throw new Error('Expected created revision.');

    const edited = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('edit-with-same-state')),
      mutation: {
        kind: 'edit-resource',
        resourceId: must(parseResourceId('resource-edit')),
        expectedRevision: revisionId,
        state: fileState('same'),
      },
    });

    expect(edited.kind).toBe('no-op');
    if (edited.kind !== 'no-op') throw new Error('Expected no-op edit.');
    expect(edited.reason).toBe('state-unchanged');
    expect(edited.head).toBe(created.version.id);
    expect(edited.recordWrites.map((write) => write.kind)).toEqual(['operation-receipt']);
  });

  it('moves a resource by creating only a workspace version', () => {
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('create-for-move')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-move')),
        path: must(parseWorkspacePath('notes/old.txt')),
        state: fileState('move me'),
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected create to change.');
    const priorRevision = versionResources(created)[0]?.revisionId;
    if (!priorRevision) throw new Error('Expected created revision.');

    const moved = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('move-resource')),
      mutation: {
        kind: 'move-resource',
        resourceId: must(parseResourceId('resource-move')),
        expectedPath: must(parseWorkspacePath('notes/old.txt')),
        destination: must(parseWorkspacePath('archive/new.txt')),
      },
    });

    expect(moved.kind).toBe('changed');
    if (moved.kind !== 'changed') throw new Error('Expected move to change.');
    expect(moved.effects).toEqual({
      resourceState: 'reused',
      resourceRevision: 'reused',
      workspaceVersion: 'created',
    });
    expect(versionResources(moved)[0]).toMatchObject({
      revisionId: priorRevision,
      path: 'archive/new.txt',
      lastPath: 'archive/new.txt',
    });
    expect(moved.publication.recordWrites.map((write) => write.kind).sort()).toEqual([
      'operation-receipt',
      'workspace-path-map-node',
      'workspace-resource-map-node',
      'workspace-version',
    ]);
  });

  it('rejects expanded compound-member collisions without admitting a partial revision', () => {
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('create-package')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-package')),
        path: must(parseWorkspacePath('constructs/pUC19')),
        state: packageState(),
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected package create to change.');

    const collided = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('colliding-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('resource-collision')),
        path: must(parseWorkspacePath('constructs/puc19/.FORGE/PLASMID.JSON')),
        state: fileState('collision'),
        origin: { kind: 'created' },
      },
    });

    expect(collided.kind).toBe('conflict');
    if (collided.kind !== 'conflict') throw new Error('Expected path conflict.');
    expect(collided.conflicts[0]).toMatchObject({ kind: 'path-conflict' });
    expect(must(inspectWorkspaceVersion(collided.graph, created.version.id))).toEqual(
      created.version
    );
    expect(collided.recordWrites.map((write) => write.kind)).toEqual(['operation-receipt']);
  });
});

describe('operation receipts', () => {
  it('returns deeply immutable result, publication, and replay trees', () => {
    const created = createFileResource({
      resourceId: 'immutable-result-resource',
      path: 'notes/immutable.txt',
      contents: 'sealed',
      operationId: 'immutable-result-create',
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.publication)).toBe(true);
    expect(Object.isFrozen(created.publication.recordWrites)).toBe(true);
    expect(Object.isFrozen(created.publication.refAdvance)).toBe(true);
    expect(Object.isFrozen(created.effects)).toBe(true);
    expect(Reflect.set(created.publication.refAdvance, 'next', created.version.id)).toBe(false);

    const replay = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('immutable-result-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('immutable-result-resource')),
        path: must(parseWorkspacePath('notes/immutable.txt')),
        state: fileState('sealed'),
        origin: { kind: 'created' },
      },
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('Expected an immutable replay result.');
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.original)).toBe(true);
  });

  it('replays an exact changed operation without creating another object or ref advance', () => {
    const graph = emptyGraph();
    const operationId = must(parseOperationId('retry-create'));
    const mutation = {
      kind: 'create-resource' as const,
      resourceId: must(parseResourceId('retry-resource')),
      path: must(parseWorkspacePath('notes/retry.txt')),
      state: fileState('retry'),
      origin: { kind: 'created' as const },
    };
    const first = applyWorkspaceMutation({
      graph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId,
      mutation,
    });
    if (first.kind !== 'changed') throw new Error('Expected first operation to change.');

    const replay = applyWorkspaceMutation({
      graph: first.graph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId,
      mutation,
    });
    expect(replay).toEqual({
      kind: 'replay',
      graph: first.graph,
      original: {
        operationId,
        outcome: 'changed',
        version: first.version,
        effects: first.effects,
        publication: first.publication,
      },
    });
  });

  it('ignores caller-only fields when fingerprinting semantic mutation intent', () => {
    const created = createFileResource({
      resourceId: 'semantic-move-resource',
      path: 'before.txt',
      contents: 'move',
      operationId: 'semantic-move-create',
    });
    const operationId = must(parseOperationId('semantic-move'));
    const mutationWithCallerMetadata = {
      kind: 'move-resource' as const,
      resourceId: must(parseResourceId('semantic-move-resource')),
      expectedPath: must(parseWorkspacePath('before.txt')),
      destination: must(parseWorkspacePath('after.txt')),
      callerTrace: 'ignored',
    };
    const moved = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation: mutationWithCallerMetadata,
    });
    if (moved.kind !== 'changed') throw new Error('Expected semantic move.');
    const replay = applyWorkspaceMutation({
      graph: moved.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation: {
        kind: 'move-resource',
        resourceId: mutationWithCallerMetadata.resourceId,
        expectedPath: mutationWithCallerMetadata.expectedPath,
        destination: mutationWithCallerMetadata.destination,
      },
    });
    expect(replay.kind).toBe('replay');
  });

  it('rejects duplicate derived-origin sources without throwing', () => {
    const source = createFileResource({
      resourceId: 'origin-source',
      path: 'source.txt',
      contents: 'source',
      operationId: 'origin-source-create',
    });
    const sourceRevision = versionResources(source)[0]?.revisionId;
    if (!sourceRevision) throw new Error('Expected source revision.');
    const result = applyWorkspaceMutation({
      graph: source.graph,
      refName: MAIN_REF,
      expectedHead: source.version.id,
      operationId: must(parseOperationId('duplicate-origin-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('duplicate-origin-resource')),
        path: must(parseWorkspacePath('derived.txt')),
        state: fileState('derived'),
        origin: {
          kind: 'derived',
          relation: 'copy',
          sources: [sourceRevision, sourceRevision],
        },
      },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected duplicate-origin rejection.');
    expect(result.error).toEqual({
      kind: 'invalid-mutation',
      reason: 'derived origin contains duplicate sources',
    });
  });

  it('rejects an oversized derived origin before canonical request hashing', () => {
    const source = createFileResource({
      resourceId: 'large-origin-source',
      path: 'source.txt',
      contents: 'source',
      operationId: 'large-origin-source-create',
    });
    const sourceRevision = versionResources(source)[0]?.revisionId;
    if (!sourceRevision) throw new Error('Expected source revision.');
    const result = applyWorkspaceMutation({
      graph: source.graph,
      refName: MAIN_REF,
      expectedHead: source.version.id,
      operationId: must(parseOperationId('large-origin-create')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('large-origin-resource')),
        path: must(parseWorkspacePath('derived.txt')),
        state: fileState('derived'),
        origin: {
          kind: 'derived',
          relation: 'merge',
          sources: [sourceRevision, ...Array.from({ length: 4_096 }, () => sourceRevision)],
        },
      },
    });
    expect(result).toMatchObject({
      kind: 'rejected',
      error: { kind: 'invalid-mutation', reason: 'derived origin exceeds 4096 sources' },
    });
  });

  it('exports, imports, and replays a no-op receipt in a fresh graph', () => {
    const state = fileState('stable');
    const created = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('receipt-base')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('receipt-resource')),
        path: must(parseWorkspacePath('notes/stable.txt')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected base create to change.');
    const revisionId = versionResources(created)[0]?.revisionId;
    if (!revisionId) throw new Error('Expected base revision.');
    const operationId = must(parseOperationId('receipt-no-op'));
    const mutation = {
      kind: 'edit-resource' as const,
      resourceId: must(parseResourceId('receipt-resource')),
      expectedRevision: revisionId,
      state,
    };
    const noOp = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    if (noOp.kind !== 'no-op') throw new Error('Expected no-op.');
    expect(noOp.recordWrites).toHaveLength(1);

    const imported = must(importCanonicalRecords(exportCanonicalClosure(noOp.graph)));
    const replay = applyWorkspaceMutation({
      graph: imported,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('Expected imported receipt replay.');
    expect(replay.original).toEqual({
      operationId,
      outcome: 'no-op',
      head: created.version.id,
      reason: 'state-unchanged',
      recordWrites: noOp.recordWrites,
    });
  });

  it('exports, imports, and replays an exact conflict receipt in a fresh graph', () => {
    const created = createFileResource({
      resourceId: 'receipt-conflict-base-resource',
      path: 'notes/occupied.txt',
      contents: 'occupied',
      operationId: 'receipt-conflict-base',
    });
    const operationId = must(parseOperationId('receipt-conflict'));
    const mutation = {
      kind: 'create-resource' as const,
      resourceId: must(parseResourceId('receipt-conflict-resource')),
      path: must(parseWorkspacePath('notes/occupied.txt')),
      state: fileState('conflicting contents'),
      origin: { kind: 'created' as const },
    };
    const conflict = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    if (conflict.kind !== 'conflict') throw new Error('Expected a path conflict.');

    const imported = must(importCanonicalRecords(exportCanonicalClosure(conflict.graph)));
    const replay = applyWorkspaceMutation({
      graph: imported,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    expect(replay).toEqual({
      kind: 'replay',
      graph: imported,
      original: {
        operationId,
        outcome: 'conflict',
        conflicts: conflict.conflicts,
        recordWrites: conflict.recordWrites,
      },
    });
  });

  it('exports, imports, and replays an exact rejection receipt in a fresh graph', () => {
    const created = createFileResource({
      resourceId: 'receipt-rejection-resource',
      path: 'notes/original.txt',
      contents: 'original',
      operationId: 'receipt-rejection-base',
    });
    const operationId = must(parseOperationId('receipt-rejection'));
    const mutation = {
      kind: 'create-resource' as const,
      resourceId: must(parseResourceId('receipt-rejection-resource')),
      path: must(parseWorkspacePath('notes/replacement.txt')),
      state: fileState('replacement'),
      origin: { kind: 'created' as const },
    };
    const rejected = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    if (rejected.kind !== 'rejected') throw new Error('Expected duplicate-resource rejection.');

    const imported = must(importCanonicalRecords(exportCanonicalClosure(rejected.graph)));
    const replay = applyWorkspaceMutation({
      graph: imported,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId,
      mutation,
    });
    expect(replay).toEqual({
      kind: 'replay',
      graph: imported,
      original: {
        operationId,
        outcome: 'rejected',
        error: rejected.error,
        recordWrites: rejected.recordWrites,
      },
    });
  });

  it('rejects operation-ID reuse with different intent before and after export/import', () => {
    const operationId = must(parseOperationId('reused-operation'));
    const resourceId = must(parseResourceId('reused-resource'));
    const state = fileState('original');
    const first = applyWorkspaceMutation({
      graph: emptyGraph(),
      refName: MAIN_REF,
      expectedHead: null,
      operationId,
      mutation: {
        kind: 'create-resource',
        resourceId,
        path: must(parseWorkspacePath('notes/original.txt')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (first.kind !== 'changed') throw new Error('Expected first operation to change.');
    const differentIntent = {
      graph: first.graph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId,
      mutation: {
        kind: 'create-resource' as const,
        resourceId,
        path: must(parseWorkspacePath('notes/different.txt')),
        state,
        origin: { kind: 'created' as const },
      },
    };

    const local = applyWorkspaceMutation(differentIntent);
    expect(local).toMatchObject({
      kind: 'rejected',
      error: { kind: 'operation-id-reused', operationId },
      recordWrites: [],
    });
    const imported = must(importCanonicalRecords(exportCanonicalClosure(first.graph)));
    const afterImport = applyWorkspaceMutation({ ...differentIntent, graph: imported });
    expect(afterImport).toMatchObject({
      kind: 'rejected',
      error: { kind: 'operation-id-reused', operationId },
      recordWrites: [],
    });
  });
});

describe('resource lifecycle mutations', () => {
  it('edits and moves in one atomic workspace version', () => {
    const created = createFileResource({
      resourceId: 'lifecycle-edit-move',
      path: 'drafts/design.txt',
      contents: 'draft',
      operationId: 'lifecycle-edit-move-create',
    });
    const slot = versionResources(created)[0];
    if (!slot) throw new Error('Expected created slot.');

    const result = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('lifecycle-edit-move-apply')),
      mutation: {
        kind: 'edit-and-move-resource',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: must(parseWorkspacePath('drafts/design.txt')),
        state: fileState('final'),
        destination: must(parseWorkspacePath('archive/design.txt')),
      },
    });

    expect(result.kind).toBe('changed');
    if (result.kind !== 'changed') throw new Error('Expected edit-and-move to change.');
    const next = versionResources(result)[0];
    expect(next).toMatchObject({
      resourceId: slot.resourceId,
      path: 'archive/design.txt',
      lastPath: 'archive/design.txt',
      tombstone: false,
    });
    expect(next?.revisionId).not.toBe(slot.revisionId);
    expect(result.effects).toEqual({
      resourceState: 'created',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    });
  });

  it('removes workspace membership without creating a tombstone revision', () => {
    const created = createFileResource({
      resourceId: 'lifecycle-membership',
      path: 'notes/member.txt',
      contents: 'member',
      operationId: 'lifecycle-membership-create',
    });
    const slot = versionResources(created)[0];
    if (!slot) throw new Error('Expected created slot.');

    const removed = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('lifecycle-membership-remove')),
      mutation: {
        kind: 'remove-membership',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: must(parseWorkspacePath('notes/member.txt')),
      },
    });

    expect(removed.kind).toBe('changed');
    if (removed.kind !== 'changed') throw new Error('Expected membership removal to change.');
    expect(versionResources(removed)).toEqual([]);
    expect(removed.effects).toEqual({
      resourceState: 'none',
      resourceRevision: 'reused',
      workspaceVersion: 'created',
    });
    expect(must(inspectResourceRevision(removed.graph, slot.revisionId)).tombstone).toBe(false);

    const reused = applyWorkspaceMutation({
      graph: removed.graph,
      refName: MAIN_REF,
      expectedHead: removed.version.id,
      operationId: must(parseOperationId('lifecycle-membership-reuse-id')),
      mutation: {
        kind: 'create-resource',
        resourceId: slot.resourceId,
        path: must(parseWorkspacePath('notes/recreated.txt')),
        state: fileState('unrelated replacement'),
        origin: { kind: 'created' },
      },
    });
    expect(reused).toMatchObject({
      kind: 'rejected',
      error: {
        kind: 'invalid-mutation',
        reason: 'resource already exists in this workspace',
      },
    });
  });

  it.each(['\ud800', 'a'.repeat(257)])('rejects invalid accepted ref %j', (acceptedRef) => {
    expect(() =>
      Reflect.apply(createRevisionGraph, undefined, [
        {
          workspaceId: must(parseWorkspaceId('invalid-ref-workspace')),
          acceptedRef,
        },
      ])
    ).toThrow(TypeError);
  });

  it('deletes to a tombstone, retains the last path, and releases that path', () => {
    const created = createFileResource({
      resourceId: 'lifecycle-delete',
      path: 'notes/reusable.txt',
      contents: 'old',
      operationId: 'lifecycle-delete-create',
    });
    const slot = versionResources(created)[0];
    if (!slot) throw new Error('Expected created slot.');

    const deleted = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('lifecycle-delete-apply')),
      mutation: {
        kind: 'delete-resource',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: must(parseWorkspacePath('notes/reusable.txt')),
      },
    });
    expect(deleted.kind).toBe('changed');
    if (deleted.kind !== 'changed') throw new Error('Expected delete to change.');
    const tombstoneSlot = versionResources(deleted)[0];
    expect(tombstoneSlot).toMatchObject({
      resourceId: slot.resourceId,
      path: null,
      lastPath: 'notes/reusable.txt',
      tombstone: true,
    });
    if (!tombstoneSlot) throw new Error('Expected tombstone slot.');
    const tombstone = must(inspectResourceRevision(deleted.graph, tombstoneSlot.revisionId));
    expect(tombstone).toMatchObject({
      resourceId: slot.resourceId,
      stateHash: null,
      parentIds: [slot.revisionId],
      tombstone: true,
    });
    const importedDeleted = must(importCanonicalRecords(exportCanonicalClosure(deleted.graph)));
    expect(must(inspectResourceRevision(importedDeleted, tombstoneSlot.revisionId))).toEqual(
      tombstone
    );

    const reused = applyWorkspaceMutation({
      graph: deleted.graph,
      refName: MAIN_REF,
      expectedHead: deleted.version.id,
      operationId: must(parseOperationId('lifecycle-reuse-path')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('lifecycle-replacement')),
        path: must(parseWorkspacePath('notes/reusable.txt')),
        state: fileState('replacement'),
        origin: { kind: 'created' },
      },
    });
    expect(reused.kind).toBe('changed');
  });

  it('restores a tombstone from a live ancestor as a new revision', () => {
    const created = createFileResource({
      resourceId: 'lifecycle-restore',
      path: 'notes/restore.txt',
      contents: 'restore me',
      operationId: 'lifecycle-restore-create',
    });
    const liveSlot = versionResources(created)[0];
    if (!liveSlot) throw new Error('Expected live slot.');
    const deleted = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('lifecycle-restore-delete')),
      mutation: {
        kind: 'delete-resource',
        resourceId: liveSlot.resourceId,
        expectedRevision: liveSlot.revisionId,
        expectedPath: must(parseWorkspacePath('notes/restore.txt')),
      },
    });
    if (deleted.kind !== 'changed') throw new Error('Expected delete before restore.');
    const tombstoneSlot = versionResources(deleted)[0];
    if (!tombstoneSlot) throw new Error('Expected tombstone slot.');

    const restored = applyWorkspaceMutation({
      graph: deleted.graph,
      refName: MAIN_REF,
      expectedHead: deleted.version.id,
      operationId: must(parseOperationId('lifecycle-restore-apply')),
      mutation: {
        kind: 'restore-resource',
        resourceId: liveSlot.resourceId,
        expectedTombstoneRevision: tombstoneSlot.revisionId,
        restoreFromRevision: liveSlot.revisionId,
        destination: must(parseWorkspacePath('restored/restore.txt')),
      },
    });

    expect(restored.kind).toBe('changed');
    if (restored.kind !== 'changed') throw new Error('Expected restore to change.');
    const restoredSlot = versionResources(restored)[0];
    if (!restoredSlot) throw new Error('Expected restored slot.');
    expect(restoredSlot).toMatchObject({
      resourceId: liveSlot.resourceId,
      path: 'restored/restore.txt',
      lastPath: 'restored/restore.txt',
      tombstone: false,
    });
    expect(restoredSlot.revisionId).not.toBe(liveSlot.revisionId);
    expect(restoredSlot.revisionId).not.toBe(tombstoneSlot.revisionId);
    const liveRevision = must(inspectResourceRevision(restored.graph, liveSlot.revisionId));
    const restoredRevision = must(inspectResourceRevision(restored.graph, restoredSlot.revisionId));
    expect(restoredRevision.stateHash).toBe(liveRevision.stateHash);
    expect(restoredRevision.parentIds).toEqual([tombstoneSlot.revisionId]);
  });

  it('explicitly reverts to old material as a new child revision', () => {
    const created = createFileResource({
      resourceId: 'lifecycle-revert',
      path: 'notes/revert.txt',
      contents: 'v1',
      operationId: 'lifecycle-revert-create',
    });
    const v1Slot = versionResources(created)[0];
    if (!v1Slot) throw new Error('Expected v1 slot.');
    const edited = applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('lifecycle-revert-edit')),
      mutation: {
        kind: 'edit-resource',
        resourceId: v1Slot.resourceId,
        expectedRevision: v1Slot.revisionId,
        state: fileState('v2'),
      },
    });
    if (edited.kind !== 'changed') throw new Error('Expected edit before revert.');
    const v2Slot = versionResources(edited)[0];
    if (!v2Slot) throw new Error('Expected v2 slot.');

    const reverted = applyWorkspaceMutation({
      graph: edited.graph,
      refName: MAIN_REF,
      expectedHead: edited.version.id,
      operationId: must(parseOperationId('lifecycle-revert-apply')),
      mutation: {
        kind: 'revert-resource',
        resourceId: v1Slot.resourceId,
        expectedRevision: v2Slot.revisionId,
        restoreFromRevision: v1Slot.revisionId,
      },
    });

    expect(reverted.kind).toBe('changed');
    if (reverted.kind !== 'changed') throw new Error('Expected revert to change.');
    const revertedSlot = versionResources(reverted)[0];
    if (!revertedSlot) throw new Error('Expected reverted slot.');
    expect(revertedSlot.revisionId).not.toBe(v1Slot.revisionId);
    expect(revertedSlot.revisionId).not.toBe(v2Slot.revisionId);
    const v1 = must(inspectResourceRevision(reverted.graph, v1Slot.revisionId));
    const revertedRevision = must(inspectResourceRevision(reverted.graph, revertedSlot.revisionId));
    expect(revertedRevision.stateHash).toBe(v1.stateHash);
    expect(revertedRevision.parentIds).toEqual([v2Slot.revisionId]);
  });
});

function createFileResource(input: {
  readonly resourceId: string;
  readonly path: string;
  readonly contents: string;
  readonly operationId: string;
}) {
  const result = applyWorkspaceMutation({
    graph: emptyGraph(),
    refName: MAIN_REF,
    expectedHead: null,
    operationId: must(parseOperationId(input.operationId)),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId(input.resourceId)),
      path: must(parseWorkspacePath(input.path)),
      state: fileState(input.contents),
      origin: { kind: 'created' },
    },
  });
  if (result.kind !== 'changed') throw new Error('Expected resource create to change.');
  return result;
}

function longPortableRoot() {
  return must(
    parseWorkspacePath(
      `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}`
    )
  );
}
