import { describe, expect, it } from 'vitest';

import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';
import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  mergeWorkspaceVersions,
  listWorkspaceResources,
  parseMemberId,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseResourcePath,
  parseWorkspaceId,
  parseWorkspacePath,
  type ApplyMutationResult,
  type ResourceState,
  type Result,
  type RevisionGraph,
  type WorkspaceMutation,
} from './index';

type Changed = Extract<ApplyMutationResult, { readonly kind: 'changed' }>;
const MAIN_REF = must(parseRefName('main'));

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}

function mustChange(result: ApplyMutationResult): Changed {
  if (result.kind !== 'changed') {
    throw new Error(`Expected changed result, received ${result.kind}`);
  }
  return result;
}

function fileState(contents: string): ResourceState {
  return must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode(contents)),
    })
  );
}

function packageState(relativePath: string): ResourceState {
  return must(
    defineResourceState({
      layout: 'directory',
      resourceKind: 'dnaforge.sequence-package',
      format: 'dnaforge.sequence-package/6',
      members: [
        {
          memberId: must(parseMemberId('overflow-member')),
          relativePath: must(parseResourcePath(relativePath)),
          mediaType: 'application/octet-stream',
          blob: defineBlob(new Uint8Array([1])),
        },
      ],
    })
  );
}

function baseWithResources(
  resources: readonly { readonly id: string; readonly path: string; readonly contents: string }[]
): Changed {
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('merge-workspace')),
    acceptedRef: MAIN_REF,
  });
  let head: Changed | null = null;
  for (const [index, resource] of resources.entries()) {
    head = mustChange(
      applyWorkspaceMutation({
        graph,
        refName: MAIN_REF,
        expectedHead: head?.version.id ?? null,
        operationId: must(parseOperationId(`base-create-${index}`)),
        mutation: {
          kind: 'create-resource',
          resourceId: must(parseResourceId(resource.id)),
          path: must(parseWorkspacePath(resource.path)),
          state: fileState(resource.contents),
          origin: { kind: 'created' },
        },
      })
    );
    graph = head.graph;
  }
  if (!head) throw new Error('A merge base requires at least one resource.');
  return head;
}

function branch(base: Changed, operationId: string, mutation: WorkspaceMutation): Changed {
  return mustChange(
    applyWorkspaceMutation({
      graph: base.graph,
      refName: MAIN_REF,
      expectedHead: base.version.id,
      operationId: must(parseOperationId(operationId)),
      mutation,
    })
  );
}

function branchSequence(
  base: Changed,
  mutations: readonly { readonly operationId: string; readonly mutation: WorkspaceMutation }[]
): Changed {
  let current = base;
  for (const step of mutations) {
    current = mustChange(
      applyWorkspaceMutation({
        graph: current.graph,
        refName: MAIN_REF,
        expectedHead: current.version.id,
        operationId: must(parseOperationId(step.operationId)),
        mutation: step.mutation,
      })
    );
  }
  return current;
}

function graphWithBranches(left: Changed, right: Changed): RevisionGraph {
  const leftBundle = exportCanonicalClosure(left.graph);
  const rightBundle = exportCanonicalClosure(right.graph);
  return must(
    importCanonicalRecords({
      formatVersion: 1,
      workspaceId: leftBundle.workspaceId,
      refs: [{ name: 'main', head: left.version.id }],
      records: [...leftBundle.records, ...rightBundle.records],
    })
  );
}

function slot(result: Changed, resourceId: string) {
  const found = versionResources(result).find((candidate) => candidate.resourceId === resourceId);
  if (!found) throw new Error(`Expected resource slot ${resourceId}.`);
  return found;
}

function versionResources(result: Changed) {
  return must(listWorkspaceResources(result.graph, result.version.id));
}

describe('deterministic workspace merge', () => {
  it('composes disjoint edits with sorted two-parent lineage and symmetric intent', () => {
    const base = baseWithResources([
      { id: 'resource-a', path: 'notes/a.txt', contents: 'a0' },
      { id: 'resource-b', path: 'notes/b.txt', contents: 'b0' },
    ]);
    const baseA = slot(base, 'resource-a');
    const baseB = slot(base, 'resource-b');
    const left = branch(base, 'left-edit-a', {
      kind: 'edit-resource',
      resourceId: baseA.resourceId,
      expectedRevision: baseA.revisionId,
      state: fileState('a1'),
    });
    const right = branch(base, 'right-edit-b', {
      kind: 'edit-resource',
      resourceId: baseB.resourceId,
      expectedRevision: baseB.revisionId,
      state: fileState('b1'),
    });
    const graph = graphWithBranches(left, right);
    const operationId = must(parseOperationId('merge-disjoint'));
    const merged = mergeWorkspaceVersions({
      graph,
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId,
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });

    expect(merged.kind).toBe('changed');
    if (merged.kind !== 'changed') throw new Error('Expected disjoint merge to change.');
    expect(merged.version.parentIds).toEqual(
      [left.version.id, right.version.id].sort((a, b) => a.localeCompare(b))
    );
    expect(versionResources(merged)).toEqual([slot(left, 'resource-a'), slot(right, 'resource-b')]);
    expect(merged.publication.refAdvance).toEqual({
      workspaceId: 'merge-workspace',
      refName: MAIN_REF,
      expected: left.version.id,
      next: merged.version.id,
    });

    const replay = mergeWorkspaceVersions({
      graph: merged.graph,
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId,
      leftVersionId: right.version.id,
      rightVersionId: left.version.id,
    });
    expect(replay).toMatchObject({
      kind: 'replay',
      original: {
        operationId,
        outcome: 'changed',
        version: merged.version,
        effects: merged.effects,
        publication: merged.publication,
      },
    });
  });

  it('composes an edit with a move without synthesizing a resource revision', () => {
    const base = baseWithResources([
      { id: 'resource-edit-move', path: 'drafts/design.txt', contents: 'draft' },
    ]);
    const baseSlot = slot(base, 'resource-edit-move');
    const left = branch(base, 'left-edit', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: fileState('final'),
    });
    const right = branch(base, 'right-move', {
      kind: 'move-resource',
      resourceId: baseSlot.resourceId,
      expectedPath: must(parseWorkspacePath('drafts/design.txt')),
      destination: must(parseWorkspacePath('archive/design.txt')),
    });
    const merged = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('merge-edit-move')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });

    expect(merged.kind).toBe('changed');
    if (merged.kind !== 'changed') throw new Error('Expected edit plus move to change.');
    expect(versionResources(merged)[0]).toMatchObject({
      revisionId: slot(left, 'resource-edit-move').revisionId,
      path: 'archive/design.txt',
      lastPath: 'archive/design.txt',
    });
    expect(merged.effects).toEqual({
      resourceState: 'none',
      resourceRevision: 'reused',
      workspaceVersion: 'created',
    });
    expect(merged.publication.recordWrites.map((write) => write.kind).sort()).toEqual([
      'operation-receipt',
      'workspace-path-map-node',
      'workspace-resource-map-node',
      'workspace-version',
    ]);
  });

  it('computes the newest merge base internally instead of trusting caller input', () => {
    const base = baseWithResources([
      { id: 'stale-base-resource', path: 'a.txt', contents: 'base' },
    ]);
    const baseSlot = slot(base, 'stale-base-resource');
    const shared = branch(base, 'shared-move', {
      kind: 'move-resource',
      resourceId: baseSlot.resourceId,
      expectedPath: must(parseWorkspacePath('a.txt')),
      destination: must(parseWorkspacePath('b.txt')),
    });
    const sharedSlot = slot(shared, 'stale-base-resource');
    const left = branch(shared, 'left-move-back', {
      kind: 'move-resource',
      resourceId: sharedSlot.resourceId,
      expectedPath: must(parseWorkspacePath('b.txt')),
      destination: must(parseWorkspacePath('a.txt')),
    });
    const right = branch(shared, 'right-edit-after-shared-move', {
      kind: 'edit-resource',
      resourceId: sharedSlot.resourceId,
      expectedRevision: sharedSlot.revisionId,
      state: fileState('edited'),
    });

    const merged = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('merge-with-stale-base')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });

    expect(merged.kind).toBe('changed');
    if (merged.kind !== 'changed') throw new Error('Expected internal-base merge to change.');
    expect(versionResources(merged)[0]).toMatchObject({
      revisionId: slot(right, 'stale-base-resource').revisionId,
      path: 'a.txt',
    });
  });

  it('records a no-op when both branches converged on the same immutable version', () => {
    const base = baseWithResources([
      { id: 'resource-converged', path: 'notes/converged.txt', contents: 'v0' },
    ]);
    const baseSlot = slot(base, 'resource-converged');
    const left = branch(base, 'left-identical', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: fileState('same-v1'),
    });
    const right = branch(base, 'right-identical', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: fileState('same-v1'),
    });
    expect(right.version.id).toBe(left.version.id);

    const merged = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('merge-converged')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });
    expect(merged).toMatchObject({
      kind: 'no-op',
      head: left.version.id,
      reason: 'sources-already-converged',
    });
    if (merged.kind !== 'no-op') throw new Error('Expected converged merge to be a no-op.');
    expect(merged.recordWrites.map((write) => write.kind)).toEqual(['operation-receipt']);
  });

  it('classifies concurrent edits and concurrent moves as resource conflicts', () => {
    const base = baseWithResources([
      { id: 'resource-conflict', path: 'notes/conflict.txt', contents: 'v0' },
    ]);
    const baseSlot = slot(base, 'resource-conflict');
    const editLeft = branch(base, 'edit-left', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: fileState('left'),
    });
    const editRight = branch(base, 'edit-right', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: fileState('right'),
    });
    const editConflict = mergeWorkspaceVersions({
      graph: graphWithBranches(editLeft, editRight),
      refName: MAIN_REF,
      expectedHead: editLeft.version.id,
      operationId: must(parseOperationId('merge-edit-conflict')),
      leftVersionId: editLeft.version.id,
      rightVersionId: editRight.version.id,
    });
    expect(editConflict).toMatchObject({
      kind: 'conflict',
      conflicts: [
        { kind: 'resource-conflict', resourceId: baseSlot.resourceId, reason: 'edit-edit' },
      ],
    });

    const moveLeft = branch(base, 'move-left', {
      kind: 'move-resource',
      resourceId: baseSlot.resourceId,
      expectedPath: baseSlot.path ?? must(parseWorkspacePath('unreachable')),
      destination: must(parseWorkspacePath('left/conflict.txt')),
    });
    const moveRight = branch(base, 'move-right', {
      kind: 'move-resource',
      resourceId: baseSlot.resourceId,
      expectedPath: baseSlot.path ?? must(parseWorkspacePath('unreachable')),
      destination: must(parseWorkspacePath('right/conflict.txt')),
    });
    const moveConflict = mergeWorkspaceVersions({
      graph: graphWithBranches(moveLeft, moveRight),
      refName: MAIN_REF,
      expectedHead: moveLeft.version.id,
      operationId: must(parseOperationId('merge-move-conflict')),
      leftVersionId: moveLeft.version.id,
      rightVersionId: moveRight.version.id,
    });
    expect(moveConflict).toMatchObject({
      kind: 'conflict',
      conflicts: [
        { kind: 'resource-conflict', resourceId: baseSlot.resourceId, reason: 'rename-rename' },
      ],
    });
  });

  it.each([
    { name: 'delete/edit', left: 'delete-resource', right: 'edit-resource', reason: 'delete-edit' },
    { name: 'move/delete', left: 'move-resource', right: 'delete-resource', reason: 'move-delete' },
    {
      name: 'membership-remove/edit',
      left: 'remove-membership',
      right: 'edit-resource',
      reason: 'membership-remove-edit',
    },
  ] as const)('classifies $name without ref authority', ({ left, right, reason }) => {
    const base = baseWithResources([
      { id: `resource-${reason}`, path: `notes/${reason}.txt`, contents: 'v0' },
    ]);
    const baseSlot = versionResources(base)[0];
    if (!baseSlot || baseSlot.path === null) throw new Error('Expected active base slot.');
    const basePath = baseSlot.path;
    const mutation = (kind: typeof left | typeof right): WorkspaceMutation => {
      switch (kind) {
        case 'delete-resource':
          return {
            kind,
            resourceId: baseSlot.resourceId,
            expectedRevision: baseSlot.revisionId,
            expectedPath: basePath,
          };
        case 'remove-membership':
          return {
            kind,
            resourceId: baseSlot.resourceId,
            expectedRevision: baseSlot.revisionId,
            expectedPath: basePath,
          };
        case 'edit-resource':
          return {
            kind,
            resourceId: baseSlot.resourceId,
            expectedRevision: baseSlot.revisionId,
            state: fileState('edited'),
          };
        case 'move-resource':
          return {
            kind,
            resourceId: baseSlot.resourceId,
            expectedPath: basePath,
            destination: must(parseWorkspacePath('moved/resource.txt')),
          };
      }
    };
    const leftBranch = branch(base, `${reason}-left`, mutation(left));
    const rightBranch = branch(base, `${reason}-right`, mutation(right));
    const result = mergeWorkspaceVersions({
      graph: graphWithBranches(leftBranch, rightBranch),
      refName: MAIN_REF,
      expectedHead: leftBranch.version.id,
      operationId: must(parseOperationId(`merge-${reason}`)),
      leftVersionId: leftBranch.version.id,
      rightVersionId: rightBranch.version.id,
    });

    expect(result).toMatchObject({
      kind: 'conflict',
      conflicts: [{ kind: 'resource-conflict', resourceId: baseSlot.resourceId, reason }],
    });
    if (result.kind !== 'conflict') throw new Error('Expected resource conflict.');
    expect(result.recordWrites.map((write) => write.kind)).toEqual(['operation-receipt']);
    expect('publication' in result).toBe(false);
    expect(exportCanonicalClosure(result.graph).refs).toEqual([
      { name: 'main', head: leftBranch.version.id },
    ]);
  });

  it('sorts multiple conflicts deterministically by resource identity', () => {
    const base = baseWithResources([
      { id: 'resource-z', path: 'notes/z.txt', contents: 'z0' },
      { id: 'resource-a', path: 'notes/a.txt', contents: 'a0' },
    ]);
    const z = slot(base, 'resource-z');
    const a = slot(base, 'resource-a');
    const edits = (suffix: string) => [
      {
        operationId: `${suffix}-z`,
        mutation: {
          kind: 'edit-resource' as const,
          resourceId: z.resourceId,
          expectedRevision: z.revisionId,
          state: fileState(`${suffix}-z`),
        },
      },
      {
        operationId: `${suffix}-a`,
        mutation: {
          kind: 'edit-resource' as const,
          resourceId: a.resourceId,
          expectedRevision: a.revisionId,
          state: fileState(`${suffix}-a`),
        },
      },
    ];
    const left = branchSequence(base, edits('left'));
    const right = branchSequence(base, edits('right'));
    const result = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('merge-sorted-conflicts')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('Expected multiple conflicts.');
    expect(
      result.conflicts.map((conflict) =>
        conflict.kind === 'resource-conflict' ? conflict.resourceId : conflict.kind
      )
    ).toEqual(['resource-a', 'resource-z']);
  });

  it('rejects a path collision created only by composing individually valid branches', () => {
    const base = baseWithResources([
      { id: 'resource-left', path: 'notes/left.txt', contents: 'left' },
      { id: 'resource-right', path: 'notes/right.txt', contents: 'right' },
    ]);
    const leftSlot = slot(base, 'resource-left');
    const rightSlot = slot(base, 'resource-right');
    const destination = must(parseWorkspacePath('shared/result.txt'));
    const left = branch(base, 'path-left', {
      kind: 'move-resource',
      resourceId: leftSlot.resourceId,
      expectedPath: leftSlot.path ?? must(parseWorkspacePath('unreachable')),
      destination,
    });
    const right = branch(base, 'path-right', {
      kind: 'move-resource',
      resourceId: rightSlot.resourceId,
      expectedPath: rightSlot.path ?? must(parseWorkspacePath('unreachable')),
      destination,
    });
    const result = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('merge-path-conflict')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
    });

    expect(result).toMatchObject({
      kind: 'conflict',
      conflicts: [{ kind: 'path-conflict', paths: ['shared/result.txt', 'shared/result.txt'] }],
    });
    if (result.kind !== 'conflict') throw new Error('Expected path conflict.');
    expect('publication' in result).toBe(false);
  });

  it('rejects a joined-path overflow created only by composing valid branches', () => {
    const base = baseWithResources([{ id: 'overflow-merge', path: 'x', contents: 'base' }]);
    const baseSlot = slot(base, 'overflow-merge');
    const longPath = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}`;
    const left = branch(base, 'overflow-merge-state', {
      kind: 'edit-resource',
      resourceId: baseSlot.resourceId,
      expectedRevision: baseSlot.revisionId,
      state: packageState(longPath),
    });
    const right = branch(base, 'overflow-merge-path', {
      kind: 'move-resource',
      resourceId: baseSlot.resourceId,
      expectedPath: must(parseWorkspacePath('x')),
      destination: must(parseWorkspacePath(longPath)),
    });
    const result = mergeWorkspaceVersions({
      graph: graphWithBranches(left, right),
      refName: MAIN_REF,
      expectedHead: left.version.id,
      operationId: must(parseOperationId('overflow-merge-apply')),
      leftVersionId: left.version.id,
      rightVersionId: right.version.id,
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

  it('rejects criss-cross history with two incomparable maximal merge bases', () => {
    const base = baseWithResources([
      { id: 'criss-a', path: 'criss/a.txt', contents: 'a0' },
      { id: 'criss-b', path: 'criss/b.txt', contents: 'b0' },
      { id: 'criss-c', path: 'criss/c.txt', contents: 'c0' },
      { id: 'criss-d', path: 'criss/d.txt', contents: 'd0' },
    ]);
    const a = slot(base, 'criss-a');
    const b = slot(base, 'criss-b');
    const c = slot(base, 'criss-c');
    const d = slot(base, 'criss-d');
    const a1 = branch(base, 'criss-a1', {
      kind: 'edit-resource',
      resourceId: a.resourceId,
      expectedRevision: a.revisionId,
      state: fileState('a1'),
    });
    const b1 = branch(base, 'criss-b1', {
      kind: 'edit-resource',
      resourceId: b.resourceId,
      expectedRevision: b.revisionId,
      state: fileState('b1'),
    });
    const aPre = branch(a1, 'criss-a-pre', {
      kind: 'edit-resource',
      resourceId: c.resourceId,
      expectedRevision: c.revisionId,
      state: fileState('c1'),
    });
    const bPre = branch(b1, 'criss-b-pre', {
      kind: 'edit-resource',
      resourceId: d.resourceId,
      expectedRevision: d.revisionId,
      state: fileState('d1'),
    });
    const a2 = mergeWorkspaceVersions({
      graph: graphWithBranches(aPre, b1),
      refName: MAIN_REF,
      expectedHead: aPre.version.id,
      operationId: must(parseOperationId('criss-merge-a2')),
      leftVersionId: aPre.version.id,
      rightVersionId: b1.version.id,
    });
    if (a2.kind !== 'changed') throw new Error('Expected first criss-cross merge.');
    const b2 = mergeWorkspaceVersions({
      graph: graphWithBranches(bPre, a1),
      refName: MAIN_REF,
      expectedHead: bPre.version.id,
      operationId: must(parseOperationId('criss-merge-b2')),
      leftVersionId: bPre.version.id,
      rightVersionId: a1.version.id,
    });
    if (b2.kind !== 'changed') throw new Error('Expected second criss-cross merge.');

    const result = mergeWorkspaceVersions({
      graph: graphWithBranches(a2, b2),
      refName: MAIN_REF,
      expectedHead: a2.version.id,
      operationId: must(parseOperationId('criss-ambiguous-final')),
      leftVersionId: a2.version.id,
      rightVersionId: b2.version.id,
    });
    expect(result).toMatchObject({
      kind: 'rejected',
      error: {
        kind: 'invalid-mutation',
        reason: 'merge sources have ambiguous maximal merge bases',
      },
    });
    expect('publication' in result).toBe(false);
  });
});
