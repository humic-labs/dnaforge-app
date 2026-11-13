import { describe, expect, it } from 'vitest';
import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';
import {
  applyWorkspaceBatch,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  inspectWorkspaceResource,
  listWorkspaceResources,
  inspectResourceRevision,
  previewMutationRevision,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type ApplyMutationResult,
  type Result,
  type WorkspaceMutation,
} from './index';

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const refName = must(parseRefName('accepted'));
const workspaceId = must(parseWorkspaceId('workspace-batch'));
const resourceA = must(parseResourceId('sequence-a'));
const resourceB = must(parseResourceId('primer-b'));
const pathA = must(parseWorkspacePath('sequences/a.json'));
const pathB = must(parseWorkspacePath('primers/b.json'));
const state = (text: string) =>
  must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'scientific.test',
      mediaType: 'application/json',
      blob: defineBlob(new TextEncoder().encode(text)),
    })
  );

it('restores and edits owned tombstoned history in one final intent, retaining the exact source and replay', () => {
  const created = changed(
    applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('restore-edit-create')),
      mutations,
    })
  );
  const original = must(inspectWorkspaceResource(created.graph, created.version.id, resourceA))!;
  const deleted = changed(
    applyWorkspaceBatch({
      graph: created.graph,
      refName,
      expectedHead: created.version.id,
      operationId: must(parseOperationId('restore-edit-delete')),
      mutations: [
        {
          kind: 'delete-resource',
          resourceId: resourceA,
          expectedRevision: original.revisionId,
          expectedPath: pathA,
        },
      ],
    })
  );
  const tombstone = must(inspectWorkspaceResource(deleted.graph, deleted.version.id, resourceA))!;
  const intent: WorkspaceMutation = {
    kind: 'restore-and-edit-resource',
    resourceId: resourceA,
    expectedTombstoneRevision: tombstone.revisionId,
    restoreFromRevision: original.revisionId,
    destination: pathA,
    state: state('derived cache repaired'),
  };
  const expected = previewMutationRevision(deleted.graph, intent);
  const request = {
    graph: deleted.graph,
    refName,
    expectedHead: deleted.version.id,
    operationId: must(parseOperationId('restore-edit-final')),
    mutations: [intent],
  };
  const restored = changed(applyWorkspaceBatch(request));
  const live = must(inspectWorkspaceResource(restored.graph, restored.version.id, resourceA))!;
  expect(live).toMatchObject({ revisionId: expected, path: pathA, tombstone: false });
  expect(must(inspectResourceRevision(restored.graph, live.revisionId)).parentIds).toEqual([
    tombstone.revisionId,
  ]);
  expect(must(inspectResourceRevision(restored.graph, original.revisionId))).toEqual(
    must(inspectResourceRevision(created.graph, original.revisionId))
  );
  const imported = must(importCanonicalRecords(exportCanonicalClosure(restored.graph)));
  expect(applyWorkspaceBatch({ ...request, graph: imported }).kind).toBe('replay');
  expect(
    applyWorkspaceBatch({
      ...request,
      operationId: must(parseOperationId('wrong-source')),
      mutations: [{ ...intent, restoreFromRevision: tombstone.revisionId }],
    }).kind
  ).toBe('rejected');
});
const mutations: readonly WorkspaceMutation[] = [
  {
    kind: 'create-resource',
    resourceId: resourceA,
    path: pathA,
    state: state('AAA'),
    origin: { kind: 'created' },
  },
  {
    kind: 'create-resource',
    resourceId: resourceB,
    path: pathB,
    state: state('CCC'),
    origin: { kind: 'created' },
  },
];
const empty = () => createRevisionGraph({ workspaceId, acceptedRef: refName });
const create = () =>
  applyWorkspaceBatch({
    graph: empty(),
    refName,
    expectedHead: null,
    operationId: must(parseOperationId('create-both')),
    mutations,
  });
function changed(result: ApplyMutationResult) {
  if (result.kind !== 'changed') throw new Error(`Expected changed: ${JSON.stringify(result)}`);
  return result;
}

describe('complete workspace batches', () => {
  it('runs semantic validation against the complete candidate before publication', () => {
    let checked = 0;
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('validated-batch')),
      mutations,
      validation: {
        version: 'scientific-v1',
        validate: ({ graph, head }) => {
          checked++;
          expect(head).not.toBeNull();
          expect(must(listWorkspaceResources(graph, head!))).toHaveLength(2);
          return 'scientific relation is invalid';
        },
      },
    });
    expect(checked).toBe(1);
    expect(result).toMatchObject({
      kind: 'rejected',
      error: { kind: 'invalid-mutation', reason: 'scientific relation is invalid' },
    });
    const closure = exportCanonicalClosure(result.graph);
    expect(closure.refs[0]?.head).toBeNull();
    expect(closure.records.map((r) => r.kind)).toEqual(['operation-receipt']);
    expect(importCanonicalRecords(closure).ok).toBe(true);
  });

  it('freezes a validated outcome and fingerprints the validator version for retries', () => {
    let checked = 0;
    const operationId = must(parseOperationId('valid-retry'));
    const validation = {
      version: 'scientific-v1',
      validate: () => {
        checked++;
        return null;
      },
    };
    const initial = changed(
      applyWorkspaceBatch({
        graph: empty(),
        refName,
        expectedHead: null,
        operationId,
        mutations,
        validation,
      })
    );
    const graph = must(importCanonicalRecords(exportCanonicalClosure(initial.graph)));
    const retry = applyWorkspaceBatch({
      graph,
      refName,
      expectedHead: null,
      operationId,
      mutations,
      validation,
    });
    expect(retry.kind).toBe('replay');
    expect(checked).toBe(1);
    const changedPolicy = applyWorkspaceBatch({
      graph,
      refName,
      expectedHead: null,
      operationId,
      mutations,
      validation: { ...validation, version: 'scientific-v2' },
    });
    expect(changedPolicy).toMatchObject({
      kind: 'rejected',
      error: { kind: 'operation-id-reused' },
      recordWrites: [],
    });
    expect(checked).toBe(1);
  });

  it('does not turn an unavailable validator into a successful publication', () => {
    const graph = empty();
    expect(() =>
      applyWorkspaceBatch({
        graph,
        refName,
        expectedHead: null,
        operationId: must(parseOperationId('validator-unavailable')),
        mutations,
        validation: {
          version: 'scientific-v1',
          validate: () => {
            throw Error('blob read unavailable');
          },
        },
      })
    ).toThrow('blob read unavailable');
    expect(exportCanonicalClosure(graph).records).toEqual([]);
  });

  it('publishes one version and one receipt for several scientific resources', () => {
    const result = changed(create());
    const closure = exportCanonicalClosure(result.graph);
    expect(must(listWorkspaceResources(result.graph, result.version.id))).toHaveLength(2);
    expect(closure.records.filter((r) => r.kind === 'workspace-version')).toHaveLength(1);
    expect(closure.records.filter((r) => r.kind === 'operation-receipt')).toHaveLength(1);
    expect(result.publication.refAdvance).toEqual({
      workspaceId,
      refName,
      expected: null,
      next: result.version.id,
    });
    expect(importCanonicalRecords(closure).ok).toBe(true);
  });

  it('retains the old snapshot while publishing an edit and move together', () => {
    const initial = changed(create());
    const oldA = must(inspectWorkspaceResource(initial.graph, initial.version.id, resourceA));
    const result = changed(
      applyWorkspaceBatch({
        graph: initial.graph,
        refName,
        expectedHead: initial.version.id,
        operationId: must(parseOperationId('edit-and-move')),
        mutations: [
          {
            kind: 'edit-resource',
            resourceId: resourceA,
            expectedRevision: oldA.revisionId,
            state: state('AAT'),
          },
          {
            kind: 'move-resource',
            resourceId: resourceB,
            expectedPath: pathB,
            destination: must(parseWorkspacePath('archive/b.json')),
          },
        ],
      })
    );
    expect(result.version.parentIds).toEqual([initial.version.id]);
    expect(must(inspectWorkspaceResource(result.graph, initial.version.id, resourceA))).toEqual(
      oldA
    );
    expect(
      must(inspectWorkspaceResource(result.graph, result.version.id, resourceA)).revisionId
    ).not.toBe(oldA.revisionId);
    const oldB = must(inspectWorkspaceResource(initial.graph, initial.version.id, resourceB));
    expect(
      must(inspectWorkspaceResource(result.graph, result.version.id, resourceB))
    ).toMatchObject({
      revisionId: oldB.revisionId,
      path: 'archive/b.json',
    });
    expect(
      exportCanonicalClosure(result.graph).records.filter((r) => r.kind === 'workspace-version')
    ).toHaveLength(2);
    expect(importCanonicalRecords(exportCanonicalClosure(result.graph)).ok).toBe(true);
  });

  it('discards earlier candidates when a later item fails', () => {
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('bad-tail')),
      mutations: [
        mutations[0]!,
        {
          kind: 'move-resource',
          resourceId: resourceB,
          expectedPath: pathB,
          destination: must(parseWorkspacePath('other.json')),
        },
      ],
    });
    expect(result.kind).toBe('rejected');
    const closure = exportCanonicalClosure(result.graph);
    expect(closure.refs).toEqual([{ name: refName, head: null }]);
    expect(closure.records.map((r) => r.kind)).toEqual(['operation-receipt']);
    expect(importCanonicalRecords(closure).ok).toBe(true);
  });

  it('reopens an unchanged path tree after a content-only edit to one of several resources', () => {
    const first = must(parseResourceId('first')),
      second = must(parseResourceId('second'));
    const initial = changed(
      applyWorkspaceBatch({
        graph: empty(),
        refName,
        expectedHead: null,
        operationId: must(parseOperationId('create-siblings')),
        mutations: [
          {
            kind: 'create-resource',
            resourceId: first,
            path: must(parseWorkspacePath('primers/first.json')),
            state: state('AAA'),
            origin: { kind: 'created' },
          },
          {
            kind: 'create-resource',
            resourceId: second,
            path: must(parseWorkspacePath('primers/second.json')),
            state: state('CCC'),
            origin: { kind: 'created' },
          },
        ],
      })
    );
    const reopened = must(importCanonicalRecords(exportCanonicalClosure(initial.graph)));
    const prior = must(inspectWorkspaceResource(reopened, initial.version.id, first));
    const edited = changed(
      applyWorkspaceBatch({
        graph: reopened,
        refName,
        expectedHead: initial.version.id,
        operationId: must(parseOperationId('edit-sibling')),
        mutations: [
          {
            kind: 'edit-resource',
            resourceId: first,
            expectedRevision: prior.revisionId,
            state: state('AAT'),
          },
        ],
      })
    );
    const roundTrip = importCanonicalRecords(exportCanonicalClosure(edited.graph));
    expect(edited.version.materializedPathRoot).toBe(initial.version.materializedPathRoot);
    expect(roundTrip, JSON.stringify(roundTrip)).toMatchObject({ ok: true });
    if (!roundTrip.ok) throw Error(JSON.stringify(roundTrip.error));
    expect(must(inspectWorkspaceResource(roundTrip.value, initial.version.id, first))).toEqual(
      prior
    );
    expect(must(listWorkspaceResources(roundTrip.value, edited.version.id))).toHaveLength(2);
  });

  it('does not publish any candidate when paths collide', () => {
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('collision')),
      mutations: [mutations[0]!, { ...mutations[1]!, path: pathA } as WorkspaceMutation],
    });
    expect(result.kind).toBe('conflict');
    expect(exportCanonicalClosure(result.graph).records.map((r) => r.kind)).toEqual([
      'operation-receipt',
    ]);
  });

  it('checks the submitted base once and records the conflict', () => {
    const initial = changed(create());
    const result = applyWorkspaceBatch({
      graph: initial.graph,
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('stale-base')),
      mutations,
    });
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('Expected conflict');
    expect(result.conflicts).toEqual([
      { kind: 'ref-head-mismatch', expected: null, actual: initial.version.id },
    ]);
    expect(exportCanonicalClosure(result.graph).refs[0]?.head).toBe(initial.version.id);
  });

  it('replays the entire frozen result after a canonical storage round trip', () => {
    const initial = changed(create());
    const graph = must(importCanonicalRecords(exportCanonicalClosure(initial.graph)));
    const result = applyWorkspaceBatch({
      graph,
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('create-both')),
      mutations,
    });
    expect(result.kind).toBe('replay');
    if (result.kind !== 'replay') throw new Error('Expected replay');
    expect(result.original).toMatchObject({ outcome: 'changed', version: initial.version });
    expect(exportCanonicalClosure(result.graph)).toEqual(exportCanonicalClosure(graph));
    const misuse = applyWorkspaceBatch({
      graph,
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('create-both')),
      mutations: [mutations[0]!],
    });
    expect(misuse).toMatchObject({
      kind: 'rejected',
      error: { kind: 'operation-id-reused' },
      recordWrites: [],
    });
  });

  it('rejects repeated resource IDs rather than accepting a hidden intermediate revision', () => {
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('duplicate')),
      mutations: [mutations[0]!, mutations[0]!],
    });
    expect(result.kind).toBe('rejected');
    expect(exportCanonicalClosure(result.graph).records.map((r) => r.kind)).toEqual([
      'operation-receipt',
    ]);
  });

  it('records a no-op without creating workspace or scientific history', () => {
    const initial = changed(create());
    const oldA = must(inspectWorkspaceResource(initial.graph, initial.version.id, resourceA));
    const result = applyWorkspaceBatch({
      graph: initial.graph,
      refName,
      expectedHead: initial.version.id,
      operationId: must(parseOperationId('same-state')),
      mutations: [
        {
          kind: 'edit-resource',
          resourceId: resourceA,
          expectedRevision: oldA.revisionId,
          state: state('AAA'),
        },
      ],
    });
    expect(result.kind).toBe('no-op');
    const closure = exportCanonicalClosure(result.graph);
    expect(closure.records.filter((r) => r.kind === 'workspace-version')).toHaveLength(1);
    expect(closure.records.filter((r) => r.kind === 'resource-revision')).toHaveLength(2);
    expect(importCanonicalRecords(closure).ok).toBe(true);
  });

  it('rejects an empty batch and preserves a replayable receipt', () => {
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('empty-batch')),
      mutations: [],
    });
    expect(result).toMatchObject({ kind: 'rejected', error: { reason: 'batch is empty' } });
    expect(importCanonicalRecords(exportCanonicalClosure(result.graph)).ok).toBe(true);
  });

  it('rejects an oversized publication without leaking objects or throwing', () => {
    const result = applyWorkspaceBatch({
      graph: empty(),
      refName,
      expectedHead: null,
      operationId: must(parseOperationId('large-batch')),
      mutations: Array.from({ length: 24 }, (_, i) => ({
        kind: 'create-resource',
        resourceId: must(parseResourceId(`large-${i}`)),
        path: must(parseWorkspacePath(`large-${i}.txt`)),
        state: must(
          defineResourceState({
            layout: 'file',
            resourceKind: 'test',
            mediaType: 'text/plain',
            blob: defineBlob(new Uint8Array([i])),
            materialMetadata: { description: 'x'.repeat(50_000) },
          })
        ),
        origin: { kind: 'created' },
      })),
    });
    expect(result).toMatchObject({
      kind: 'rejected',
      error: { reason: 'batch publication exceeds canonical receipt limits' },
    });
    expect(exportCanonicalClosure(result.graph).records.map((r) => r.kind)).toEqual([
      'operation-receipt',
    ]);
    expect(importCanonicalRecords(exportCanonicalClosure(result.graph)).ok).toBe(true);
  });
});
