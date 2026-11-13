import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';
import type { WorkspaceVersionView } from './index';
import {
  applyWorkspaceMutation,
  captureRecoveryCandidate,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  listWorkspaceResources,
  mergeWorkspaceVersions,
  parseMemberId,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseResourcePath,
  parseWorkspacePath,
  type ApplyMutationInput,
  type ApplyMutationResult,
  type ResourceId,
  type ResourceOrigin,
  type ResourceState,
  type Result,
  type RevisionGraph,
  type WorkspaceMutation,
  type WorkspaceResourceSlotView,
} from './index';
import type {
  MatrixAcceptedRefEffect,
  MatrixIdentityEffect,
  MatrixOutcome,
  MutationMatrixCase,
  MutationMatrixFixture,
} from './testing-public';

type Changed = Extract<ApplyMutationResult, { readonly kind: 'changed' }>;
type FixedInputs = MutationMatrixFixture['fixedInputs'];
const MAIN_REF = must(parseRefName('main'));

export interface MatrixObservation {
  readonly outcome: MatrixOutcome;
  readonly resourceId: MatrixIdentityEffect;
  readonly revisionId: MatrixIdentityEffect;
  readonly workspaceVersionId: MatrixIdentityEffect;
  readonly acceptedRef: MatrixAcceptedRefEffect;
  readonly classification: string;
}

export function executeMutationMatrixCase(
  row: MutationMatrixCase,
  fixed: FixedInputs
): MatrixObservation {
  if (row.execution === 'adapter-classification') return classifyAdapterCase(row);
  if (row.execution === 'external-authority') return classifyExternalAuthority(row);
  if (row.execution === 'codec') return executeBackupRestore(row, fixed);

  if (row.intent === 'create') return executeCreate(row, fixed);
  if (row.intent === 'edit' || row.intent.startsWith('client-')) {
    return executeEdit(row, fixed, row.intent.startsWith('client-') ? 'client-neutral' : 'none');
  }
  if (row.intent === 'edit-equal') return executeEqualEdit(row, fixed);
  if (row.intent === 'revert') return executeRevert(row, fixed);
  if (row.intent === 'move' || row.intent === 'move-case-only' || row.intent === 'move-root') {
    return executeMove(row, fixed);
  }
  if (row.intent === 'edit-and-move') return executeEditAndMove(row, fixed);
  if (row.intent === 'merge-disjoint') return executeDisjointMerge(row, fixed);
  if (row.intent.startsWith('derived-')) return executeDerivedCreate(row, fixed);
  if (row.intent === 'embedded-id-tamper' || row.intent === 'recovery-invalid') {
    return executeRecovery(row, fixed);
  }
  if (row.intent.startsWith('member-')) return executeMemberMutation(row, fixed);
  if (row.intent === 'delete') return executeDelete(row, fixed);
  if (row.intent === 'restore' || row.intent === 'reuse-deleted-path') {
    return executeAfterDelete(row, fixed);
  }
  if (row.intent === 'remove-membership') return executeMembershipRemoval(row, fixed);
  if (row.intent.startsWith('conflict-')) return executeConflict(row, fixed);
  if (row.intent === 'same-bytes-two-ids') return executeSharedState(row, fixed);
  if (row.intent === 'receipt-exact-retry') return executeExactRetry(row, fixed);
  if (row.intent === 'receipt-operation-misuse') return executeOperationMisuse(row, fixed);
  throw new Error(`Unknown executable matrix intent: ${row.intent}`);
}

function executeCreate(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'empty');
  const graph = emptyGraph(fixed);
  const result = applyWorkspaceMutation({
    graph,
    refName: MAIN_REF,
    expectedHead: null,
    operationId: row.operationId,
    mutation: {
      kind: 'create-resource',
      resourceId: fixed.primaryResourceId,
      path: must(parseWorkspacePath('notes/design.txt')),
      state: fileState('v1'),
      origin: { kind: 'created' },
    },
  });
  return observeMutation(null, null, fixed.primaryResourceId, result, 'none');
}

function executeEdit(
  row: MutationMatrixCase,
  fixed: FixedInputs,
  classification: string
): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      state: fileState('v2'),
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, classification);
}

function executeEqualEdit(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const state = fileState('same-state');
  const base = createFile(row, fixed, state);
  const before = primarySlot(base, fixed);
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      state,
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'state-unchanged');
}

function executeRevert(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-edited');
  const created = createFile(row, fixed, fileState('v1'));
  const original = primarySlot(created, fixed);
  const edited = mustChange(
    applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: setupOperation(row, 'edit'),
      mutation: {
        kind: 'edit-resource',
        resourceId: original.resourceId,
        expectedRevision: original.revisionId,
        state: fileState('v2'),
      },
    })
  );
  const before = primarySlot(edited, fixed);
  const result = applyWorkspaceMutation({
    graph: edited.graph,
    refName: MAIN_REF,
    expectedHead: edited.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'revert-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      restoreFromRevision: original.revisionId,
    },
  });
  if (result.kind !== 'changed') throw new Error('Expected explicit revert to change.');
  const reverted = primarySlot(result, fixed);
  const originalRevision = must(inspectResourceRevision(result.graph, original.revisionId));
  const revertedRevision = must(inspectResourceRevision(result.graph, reverted.revisionId));
  if (revertedRevision.stateHash !== originalRevision.stateHash) {
    throw new Error('Explicit revert did not reuse the selected old state.');
  }
  return observeMutation(
    edited.version,
    before,
    before.resourceId,
    result,
    'old-state-new-history'
  );
}

function executeMove(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const initialPath = row.intent === 'move-case-only' ? 'Notes/Design.txt' : 'notes/design.txt';
  const destination =
    row.intent === 'move-case-only'
      ? 'notes/Design.txt'
      : row.intent === 'move-root'
        ? 'design.txt'
        : 'archive/design.txt';
  const base = createFile(row, fixed, fileState('v1'), initialPath);
  const before = primarySlot(base, fixed);
  if (before.path === null) throw new Error('Expected live path.');
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'move-resource',
      resourceId: before.resourceId,
      expectedPath: before.path,
      destination: must(parseWorkspacePath(destination)),
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'path-only');
}

function executeEditAndMove(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  if (before.path === null) throw new Error('Expected live path.');
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-and-move-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      expectedPath: before.path,
      state: fileState('v2'),
      destination: must(parseWorkspacePath('archive/design.txt')),
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'atomic');
}

function executeDerivedCreate(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const state = fileState('shared-derived-state');
  const base = createFile(row, fixed, state);
  const source = primarySlot(base, fixed);
  const relation = derivedRelation(row.intent);
  const targetId = must(parseResourceId(`matrix-${row.id}`));
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'create-resource',
      resourceId: targetId,
      path: must(parseWorkspacePath(`derived/${row.id}.txt`)),
      state,
      origin: { kind: 'derived', relation, sources: [source.revisionId] },
    },
  });
  if (result.kind !== 'changed') throw new Error('Expected derived creation to change.');
  const target = slotById(result, targetId);
  const revision = must(inspectResourceRevision(result.graph, target.revisionId));
  if (revision.origin?.kind !== 'derived' || revision.origin.relation !== relation) {
    throw new Error('Derived creation lost its explicit lineage relation.');
  }
  return observeMutation(base.version, null, targetId, result, relation);
}

function executeMemberMutation(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-package');
  const base = createPackage(row, fixed, packageState('base'));
  const before = primarySlot(base, fixed);
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      state: packageState(row.intent),
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'member-state-change');
}

function executeDelete(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  if (before.path === null) throw new Error('Expected live path.');
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'delete-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      expectedPath: before.path,
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'tombstone');
}

function executeAfterDelete(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-tombstone');
  const created = createFile(row, fixed);
  const live = primarySlot(created, fixed);
  if (live.path === null) throw new Error('Expected live path.');
  const deleted = mustChange(
    applyWorkspaceMutation({
      graph: created.graph,
      refName: MAIN_REF,
      expectedHead: created.version.id,
      operationId: setupOperation(row, 'delete'),
      mutation: {
        kind: 'delete-resource',
        resourceId: live.resourceId,
        expectedRevision: live.revisionId,
        expectedPath: live.path,
      },
    })
  );
  const tombstone = primarySlot(deleted, fixed);
  const targetId = row.intent === 'restore' ? fixed.primaryResourceId : fixed.secondaryResourceId;
  const mutation: WorkspaceMutation =
    row.intent === 'restore'
      ? {
          kind: 'restore-resource',
          resourceId: fixed.primaryResourceId,
          expectedTombstoneRevision: tombstone.revisionId,
          restoreFromRevision: live.revisionId,
          destination: must(parseWorkspacePath('notes/design.txt')),
        }
      : {
          kind: 'create-resource',
          resourceId: targetId,
          path: must(parseWorkspacePath('notes/design.txt')),
          state: fileState('replacement'),
          origin: { kind: 'created' },
        };
  const result = applyWorkspaceMutation({
    graph: deleted.graph,
    refName: MAIN_REF,
    expectedHead: deleted.version.id,
    operationId: row.operationId,
    mutation,
  });
  return observeMutation(
    deleted.version,
    row.intent === 'restore' ? tombstone : null,
    targetId,
    result,
    row.intent === 'restore' ? 'restore' : 'path-released'
  );
}

function executeMembershipRemoval(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  if (before.path === null) throw new Error('Expected live path.');
  const result = applyWorkspaceMutation({
    graph: base.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'remove-membership',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      expectedPath: before.path,
    },
  });
  return observeMutation(base.version, before, before.resourceId, result, 'membership-only');
}

function executeRecovery(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  const priorRefs = exportCanonicalClosure(base.graph).refs;
  const result = captureRecoveryCandidate({
    graph: base.graph,
    operationId: row.operationId,
    candidate: {
      kind: 'invalid-working-state',
      workspaceId: fixed.workspaceId,
      claimedResourceId: before.resourceId,
      baseRevisionId: before.revisionId,
      observedPath: must(parseWorkspacePath('notes/design.txt')),
      payloads: [
        {
          role: 'observed-bytes',
          mediaType: 'application/octet-stream',
          blob: defineBlob(new Uint8Array([0, 255, 0, 255])),
        },
      ],
      failure:
        row.intent === 'embedded-id-tamper'
          ? { kind: 'identity-conflict', code: 'EMBEDDED_ID_MISMATCH' }
          : { kind: 'parse-failed', code: 'INVALID_BYTES' },
      expiresAtEpochMs: fixed.epochMs,
    },
  });
  if (result.kind !== 'captured') throw new Error('Expected isolated recovery candidate.');
  if (!sameRefs(priorRefs, exportCanonicalClosure(result.graph).refs)) {
    throw new Error('Recovery candidate changed the accepted ref.');
  }
  return {
    outcome: 'recovery-candidate',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'unchanged',
    classification: row.intent === 'embedded-id-tamper' ? 'identity-conflict' : 'parse-failed',
  };
}

function executeSharedState(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'empty');
  const state = fileState('shared-matrix-bytes');
  const blobHash = defineBlob(new TextEncoder().encode('shared-matrix-bytes')).hash;
  if (blobHash !== fixed.sharedBlobHash) throw new Error('Pinned fixture blob hash drifted.');
  const first = createFile(row, fixed, state);
  const result = applyWorkspaceMutation({
    graph: first.graph,
    refName: MAIN_REF,
    expectedHead: first.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'create-resource',
      resourceId: fixed.secondaryResourceId,
      path: must(parseWorkspacePath('notes/second.txt')),
      state,
      origin: { kind: 'created' },
    },
  });
  if (result.kind !== 'changed') throw new Error('Expected second resource creation.');
  const firstRevision = must(
    inspectResourceRevision(result.graph, primarySlot(first, fixed).revisionId)
  );
  const secondRevision = must(
    inspectResourceRevision(result.graph, slotById(result, fixed.secondaryResourceId).revisionId)
  );
  if (
    firstRevision.stateHash !== secondRevision.stateHash ||
    firstRevision.id === secondRevision.id
  ) {
    throw new Error('Shared state must not collapse logical resource revisions.');
  }
  return observeMutation(
    first.version,
    null,
    fixed.secondaryResourceId,
    result,
    'shared-state-distinct-revision'
  );
}

function executeExactRetry(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  const request: Omit<ApplyMutationInput, 'graph'> = {
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      state: fileState('retried'),
    },
  };
  const first = mustChange(applyWorkspaceMutation({ graph: base.graph, ...request }));
  const beforeRetry = exportCanonicalClosure(first.graph);
  const replay = applyWorkspaceMutation({ graph: first.graph, ...request });
  if (replay.kind !== 'replay') throw new Error('Expected exact operation replay.');
  const afterRetry = exportCanonicalClosure(replay.graph);
  if (JSON.stringify(beforeRetry) !== JSON.stringify(afterRetry)) {
    throw new Error('Exact retry created records or changed refs.');
  }
  return {
    outcome: 'replay',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'replayed',
    classification: 'same-intent',
  };
}

function executeOperationMisuse(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const before = primarySlot(base, fixed);
  const first = mustChange(
    applyWorkspaceMutation({
      graph: base.graph,
      refName: MAIN_REF,
      expectedHead: base.version.id,
      operationId: row.operationId,
      mutation: {
        kind: 'edit-resource',
        resourceId: before.resourceId,
        expectedRevision: before.revisionId,
        state: fileState('first-intent'),
      },
    })
  );
  const rejected = applyWorkspaceMutation({
    graph: first.graph,
    refName: MAIN_REF,
    expectedHead: base.version.id,
    operationId: row.operationId,
    mutation: {
      kind: 'edit-resource',
      resourceId: before.resourceId,
      expectedRevision: before.revisionId,
      state: fileState('different-intent'),
    },
  });
  if (rejected.kind !== 'rejected' || rejected.error.kind !== 'operation-id-reused') {
    throw new Error('Expected operation ID misuse rejection.');
  }
  return {
    outcome: 'rejected',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'unchanged',
    classification: 'operation-id-reused',
  };
}

function executeBackupRestore(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const bundle = exportCanonicalClosure(base.graph);
  const restored = must(importCanonicalRecords(bundle));
  if (JSON.stringify(exportCanonicalClosure(restored)) !== JSON.stringify(bundle)) {
    throw new Error('Strict backup restore changed canonical graph bytes.');
  }
  return {
    outcome: 'imported',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'unchanged',
    classification: 'strict-import',
  };
}

function classifyAdapterCase(row: MutationMatrixCase): MatrixObservation {
  const classification =
    row.intent === 'adapter-unconfirmed-disappearance'
      ? 'no-inferred-mutation'
      : row.intent === 'adapter-hardlink' || row.intent === 'adapter-symlink'
        ? 'link-policy-required'
        : row.intent.startsWith('adapter-git-')
          ? 'local-projection'
          : null;
  if (!classification) throw new Error(`Unknown adapter classification: ${row.intent}`);
  return {
    outcome: 'adapter-only',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'unchanged',
    classification,
  };
}

function classifyExternalAuthority(row: MutationMatrixCase): MatrixObservation {
  if (row.intent !== 'external-ownership-transfer') {
    throw new Error(`Unknown external authority case: ${row.intent}`);
  }
  return {
    outcome: 'external-authority-only',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'external-only',
    classification: 'ownership-not-identity',
  };
}

function observeMutation(
  beforeVersion: WorkspaceVersionView | null,
  beforeSlot: WorkspaceResourceSlotView | null,
  targetId: ResourceId,
  result: ApplyMutationResult,
  classification: string
): MatrixObservation {
  if (result.kind !== 'changed' && result.kind !== 'no-op') {
    throw new Error(`Expected mutation result, received ${result.kind}.`);
  }
  const afterSlot =
    result.kind === 'changed'
      ? (must(listWorkspaceResources(result.graph, result.version.id)).find(
          (candidate) => candidate.resourceId === targetId
        ) ?? null)
      : beforeSlot;
  return {
    outcome: result.kind,
    resourceId: beforeSlot === null && afterSlot !== null ? 'new' : 'stable',
    revisionId:
      beforeSlot !== null && (afterSlot === null || afterSlot.revisionId === beforeSlot.revisionId)
        ? 'stable'
        : result.kind === 'no-op'
          ? 'stable'
          : 'new',
    workspaceVersionId:
      result.kind === 'changed' && result.version.id !== beforeVersion?.id ? 'new' : 'stable',
    acceptedRef: result.kind === 'changed' ? 'advanced' : 'unchanged',
    classification,
  };
}

function executeDisjointMerge(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'two-live');
  const base = createTwoFiles(row, fixed);
  const a = slotById(base, fixed.primaryResourceId);
  const b = slotById(base, fixed.secondaryResourceId);
  const left = branch(base, setupOperation(row, 'left'), {
    kind: 'edit-resource',
    resourceId: a.resourceId,
    expectedRevision: a.revisionId,
    state: fileState('left'),
  });
  const right = branch(base, setupOperation(row, 'right'), {
    kind: 'edit-resource',
    resourceId: b.resourceId,
    expectedRevision: b.revisionId,
    state: fileState('right'),
  });
  const result = mergeWorkspaceVersions({
    graph: combineBranches(left, right),
    refName: MAIN_REF,
    expectedHead: left.version.id,
    operationId: row.operationId,
    leftVersionId: left.version.id,
    rightVersionId: right.version.id,
  });
  if (result.kind !== 'changed' || result.version.parentIds.length !== 2) {
    throw new Error('Expected a two-parent disjoint merge.');
  }
  return {
    outcome: 'changed',
    resourceId: 'stable',
    revisionId: 'new',
    workspaceVersionId: 'new',
    acceptedRef: 'advanced',
    classification: 'two-parent',
  };
}

function executeConflict(row: MutationMatrixCase, fixed: FixedInputs): MatrixObservation {
  requireBase(row, 'single-live');
  const base = createFile(row, fixed);
  const current = primarySlot(base, fixed);
  if (current.path === null) throw new Error('Expected live path.');
  const [leftMutation, rightMutation, reason] = conflictMutations(row.intent, current);
  const left = branch(base, setupOperation(row, 'left'), leftMutation);
  const right = branch(base, setupOperation(row, 'right'), rightMutation);
  const graph = combineBranches(left, right);
  const beforeRefs = exportCanonicalClosure(graph).refs;
  const result = mergeWorkspaceVersions({
    graph,
    refName: MAIN_REF,
    expectedHead: left.version.id,
    operationId: row.operationId,
    leftVersionId: left.version.id,
    rightVersionId: right.version.id,
  });
  if (
    result.kind !== 'conflict' ||
    result.conflicts[0]?.kind !== 'resource-conflict' ||
    result.conflicts[0].reason !== reason
  ) {
    throw new Error(`Expected ${reason} merge conflict.`);
  }
  if (!sameRefs(beforeRefs, exportCanonicalClosure(result.graph).refs))
    throw new Error('Conflict advanced accepted ref.');
  return {
    outcome: 'conflict',
    resourceId: 'stable',
    revisionId: 'stable',
    workspaceVersionId: 'stable',
    acceptedRef: 'unchanged',
    classification: reason,
  };
}

function conflictMutations(
  intent: string,
  slot: WorkspaceResourceSlotView
): readonly [WorkspaceMutation, WorkspaceMutation, string] {
  if (slot.path === null) throw new Error('Expected live slot.');
  const edit = (contents: string): WorkspaceMutation => ({
    kind: 'edit-resource',
    resourceId: slot.resourceId,
    expectedRevision: slot.revisionId,
    state: fileState(contents),
  });
  const move = (destination: string): WorkspaceMutation => ({
    kind: 'move-resource',
    resourceId: slot.resourceId,
    expectedPath: slot.path ?? must(parseWorkspacePath('unreachable')),
    destination: must(parseWorkspacePath(destination)),
  });
  const remove: WorkspaceMutation = {
    kind: 'delete-resource',
    resourceId: slot.resourceId,
    expectedRevision: slot.revisionId,
    expectedPath: slot.path,
  };
  if (intent === 'conflict-edit-edit') return [edit('left'), edit('right'), 'edit-edit'];
  if (intent === 'conflict-rename-rename')
    return [move('left/design.txt'), move('right/design.txt'), 'rename-rename'];
  if (intent === 'conflict-delete-edit') return [remove, edit('right'), 'delete-edit'];
  if (intent === 'conflict-move-delete') return [move('moved/design.txt'), remove, 'move-delete'];
  throw new Error(`Unknown conflict intent: ${intent}`);
}

function createFile(
  row: MutationMatrixCase,
  fixed: FixedInputs,
  state = fileState('v1'),
  path = 'notes/design.txt'
): Changed {
  return createResource(
    emptyGraph(fixed),
    null,
    setupOperation(row, 'create'),
    fixed.primaryResourceId,
    path,
    state,
    { kind: 'created' }
  );
}

function createPackage(row: MutationMatrixCase, fixed: FixedInputs, state: ResourceState): Changed {
  return createResource(
    emptyGraph(fixed),
    null,
    setupOperation(row, 'create-package'),
    fixed.primaryResourceId,
    'designs/package',
    state,
    { kind: 'created' }
  );
}

function createTwoFiles(row: MutationMatrixCase, fixed: FixedInputs): Changed {
  const first = createFile(row, fixed);
  return createResource(
    first.graph,
    first.version.id,
    setupOperation(row, 'create-second'),
    fixed.secondaryResourceId,
    'notes/second.txt',
    fileState('second'),
    { kind: 'created' }
  );
}

function createResource(
  graph: RevisionGraph,
  head: WorkspaceVersionView['id'] | null,
  operationId: ReturnType<typeof mustOperation>,
  resourceId: FixedInputs['primaryResourceId'],
  path: string,
  state: ResourceState,
  origin: ResourceOrigin
): Changed {
  return mustChange(
    applyWorkspaceMutation({
      graph,
      refName: MAIN_REF,
      expectedHead: head,
      operationId,
      mutation: {
        kind: 'create-resource',
        resourceId,
        path: must(parseWorkspacePath(path)),
        state,
        origin,
      },
    })
  );
}

function branch(
  base: Changed,
  operationId: ReturnType<typeof mustOperation>,
  mutation: WorkspaceMutation
): Changed {
  return mustChange(
    applyWorkspaceMutation({
      graph: base.graph,
      refName: MAIN_REF,
      expectedHead: base.version.id,
      operationId,
      mutation,
    })
  );
}

function combineBranches(left: Changed, right: Changed): RevisionGraph {
  const a = exportCanonicalClosure(left.graph);
  const b = exportCanonicalClosure(right.graph);
  return must(
    importCanonicalRecords({
      formatVersion: 1,
      workspaceId: a.workspaceId,
      refs: [{ name: 'main', head: left.version.id }],
      records: [...a.records, ...b.records],
    })
  );
}

function emptyGraph(fixed: FixedInputs): RevisionGraph {
  return createRevisionGraph({ workspaceId: fixed.workspaceId, acceptedRef: MAIN_REF });
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

function packageState(variant: string): ResourceState {
  const members =
    variant === 'member-remove'
      ? []
      : [
          {
            memberId: must(parseMemberId('product')),
            relativePath: must(
              parseResourcePath(variant === 'member-rename' ? 'renamed.gb' : 'product.gb')
            ),
            mediaType: 'application/vnd.dnaforge.genbank',
            blob: defineBlob(
              new TextEncoder().encode(variant === 'member-edit' ? 'LOCUS EDITED' : 'LOCUS BASE')
            ),
          },
        ];
  if (variant === 'member-add')
    members.push({
      memberId: must(parseMemberId('manifest')),
      relativePath: must(parseResourcePath('.forge/plasmid.json')),
      mediaType: 'application/json',
      blob: defineBlob(new TextEncoder().encode('{"formatVersion":6}')),
    });
  return must(
    defineResourceState({
      layout: 'directory',
      resourceKind: 'dnaforge.sequence-package',
      format: 'dnaforge.sequence-package/6',
      members,
    })
  );
}

function primarySlot(result: Changed, fixed: FixedInputs): WorkspaceResourceSlotView {
  return slotById(result, fixed.primaryResourceId);
}
function slotById(
  result: Changed,
  resourceId: FixedInputs['primaryResourceId']
): WorkspaceResourceSlotView {
  const slot = must(listWorkspaceResources(result.graph, result.version.id)).find(
    (candidate) => candidate.resourceId === resourceId
  );
  if (!slot) throw new Error(`Expected resource slot ${resourceId}.`);
  return slot;
}

function derivedRelation(
  intent: string
): Extract<ResourceOrigin, { readonly kind: 'derived' }>['relation'] {
  if (intent === 'derived-copy' || intent === 'derived-save-as') return 'copy';
  if (intent === 'derived-fork') return 'fork';
  if (intent === 'derived-template') return 'template';
  if (intent === 'derived-split') return 'split';
  if (intent === 'derived-conversion') return 'lossy-conversion';
  throw new Error(`Unknown derived intent: ${intent}`);
}

function requireBase(row: MutationMatrixCase, expected: string): void {
  if (row.baseGraph !== expected)
    throw new Error(`${row.id} requires base ${expected}, received ${row.baseGraph}.`);
}
function setupOperation(row: MutationMatrixCase, suffix: string): ReturnType<typeof mustOperation> {
  return mustOperation(`setup-${row.id}-${suffix}`);
}
function mustOperation(value: string) {
  return must(parseOperationId(value));
}
function mustChange(result: ApplyMutationResult): Changed {
  if (result.kind !== 'changed') throw new Error(`Expected changed, received ${result.kind}.`);
  return result;
}
function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}
function sameRefs(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
