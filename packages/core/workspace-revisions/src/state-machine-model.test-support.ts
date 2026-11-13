import fc, { type Arbitrary, type Command } from 'fast-check';

import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';
import {
  applyWorkspaceMutation,
  captureRecoveryCandidate,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectWorkspaceVersion,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type ApplyMutationInput,
  type ApplyMutationResult,
  type OperationId,
  type ResourceRevisionId,
  type ResourceState,
  type Result,
  type RevisionGraph,
  type WorkspacePath,
  type WorkspaceVersionId,
} from './index';

interface LiveHistoryEntry {
  readonly revisionId: ResourceRevisionId;
  readonly contents: string;
}

export interface RevisionReferenceModel {
  everCreated: boolean;
  status: 'absent' | 'live' | 'tombstone';
  contents: string | null;
  path: WorkspacePath | null;
  revisionId: ResourceRevisionId | null;
  history: LiveHistoryEntry[];
  acceptedHead: WorkspaceVersionId | null;
}

export interface RevisionRealSystem {
  graph: RevisionGraph;
  nextOperationIndex: number;
  lastRequest: Omit<ApplyMutationInput, 'graph'> | null;
  readonly immutableBodies: Map<string, string>;
}

type RevisionAction =
  | { readonly kind: 'create'; readonly contents: string; readonly path: string }
  | { readonly kind: 'edit'; readonly contents: string }
  | { readonly kind: 'move'; readonly path: string }
  | { readonly kind: 'delete' }
  | { readonly kind: 'restore'; readonly path: string }
  | { readonly kind: 'revert' }
  | { readonly kind: 'stale-edit'; readonly contents: string }
  | { readonly kind: 'recovery'; readonly byte: number }
  | { readonly kind: 'retry' }
  | { readonly kind: 'operation-misuse'; readonly contents: string };

export const STATE_MACHINE_COMMAND_KINDS = Object.freeze([
  'create',
  'edit',
  'move',
  'delete',
  'restore',
  'revert',
  'stale-edit',
  'recovery',
  'retry',
  'operation-misuse',
] satisfies readonly RevisionAction['kind'][]);

const executedCommandKinds = new Set<RevisionAction['kind']>();

const workspaceId = must(parseWorkspaceId('state-machine-workspace'));
const resourceId = must(parseResourceId('state-machine-resource'));
const MAIN_REF = must(parseRefName('main'));
const misuseResourceId = must(parseResourceId('state-machine-misuse-resource'));

export function stateMachineCommandArbitraries(): readonly Arbitrary<
  Command<RevisionReferenceModel, RevisionRealSystem>
>[] {
  const contents = fc.constantFrom('alpha', 'beta', 'gamma', 'delta');
  const path = fc.constantFrom(
    'notes/design.txt',
    'archive/design.txt',
    'design.txt',
    'results/final.txt'
  );
  return [
    fc
      .record({ contents, path })
      .map((value) => new RevisionStateCommand({ kind: 'create', ...value })),
    contents.map((value) => new RevisionStateCommand({ kind: 'edit', contents: value })),
    path.map((value) => new RevisionStateCommand({ kind: 'move', path: value })),
    fc.constant(new RevisionStateCommand({ kind: 'delete' })),
    path.map((value) => new RevisionStateCommand({ kind: 'restore', path: value })),
    fc.constant(new RevisionStateCommand({ kind: 'revert' })),
    contents.map((value) => new RevisionStateCommand({ kind: 'stale-edit', contents: value })),
    fc
      .integer({ min: 0, max: 255 })
      .map((byte) => new RevisionStateCommand({ kind: 'recovery', byte })),
    fc.constant(new RevisionStateCommand({ kind: 'retry' })),
    contents.map(
      (value) => new RevisionStateCommand({ kind: 'operation-misuse', contents: value })
    ),
  ];
}

export function initialStateMachine(): {
  readonly model: RevisionReferenceModel;
  readonly real: RevisionRealSystem;
} {
  return {
    model: {
      everCreated: false,
      status: 'absent',
      contents: null,
      path: null,
      revisionId: null,
      history: [],
      acceptedHead: null,
    },
    real: {
      graph: createRevisionGraph({ workspaceId, acceptedRef: MAIN_REF }),
      nextOperationIndex: 0,
      lastRequest: null,
      immutableBodies: new Map(),
    },
  };
}

export function resetStateMachineCommandCoverage(): void {
  executedCommandKinds.clear();
}

export function readStateMachineCommandCoverage(): readonly RevisionAction['kind'][] {
  return Object.freeze([...executedCommandKinds].sort());
}

class RevisionStateCommand implements Command<RevisionReferenceModel, RevisionRealSystem> {
  public constructor(private readonly action: RevisionAction) {}

  public check(model: Readonly<RevisionReferenceModel>): boolean {
    switch (this.action.kind) {
      case 'create':
        return !model.everCreated;
      case 'edit':
      case 'move':
      case 'delete':
        return model.status === 'live';
      case 'restore':
        return model.status === 'tombstone' && model.history.length > 0;
      case 'revert':
        return model.status === 'live' && model.history.length > 1;
      case 'stale-edit':
        return (
          model.status === 'live' &&
          model.revisionId !== null &&
          model.history.some((entry) => entry.revisionId !== model.revisionId)
        );
      case 'recovery':
        return true;
      case 'retry':
      case 'operation-misuse':
        return model.everCreated;
    }
  }

  public run(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    executedCommandKinds.add(this.action.kind);
    switch (this.action.kind) {
      case 'create':
        this.runCreate(model, real);
        break;
      case 'edit':
        this.runEdit(model, real);
        break;
      case 'move':
        this.runMove(model, real);
        break;
      case 'delete':
        this.runDelete(model, real);
        break;
      case 'restore':
        this.runRestore(model, real);
        break;
      case 'revert':
        this.runRevert(model, real);
        break;
      case 'stale-edit':
        this.runStaleEdit(model, real);
        break;
      case 'recovery':
        this.runRecovery(model, real);
        break;
      case 'retry':
        this.runRetry(real);
        break;
      case 'operation-misuse':
        this.runOperationMisuse(real);
        break;
    }
    assertTenInvariants(model, real);
  }

  public toString(): string {
    switch (this.action.kind) {
      case 'create':
        return `create(${this.action.path},${this.action.contents})`;
      case 'edit':
        return `edit(${this.action.contents})`;
      case 'move':
        return `move(${this.action.path})`;
      case 'restore':
        return `restore(${this.action.path})`;
      case 'stale-edit':
        return `stale-edit(${this.action.contents})`;
      case 'recovery':
        return `recovery(${this.action.byte})`;
      case 'operation-misuse':
        return `operation-misuse(${this.action.contents})`;
      default:
        return this.action.kind;
    }
  }

  private runCreate(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'create') throw new Error('Command/action mismatch.');
    const path = must(parseWorkspacePath(this.action.path));
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: null,
      operationId: nextOperation(real),
      mutation: {
        kind: 'create-resource',
        resourceId,
        path,
        state: fileState(this.action.contents),
        origin: { kind: 'created' },
      },
    };
    const result = applyTracked(real, request);
    const changed = requireChanged(result, 'create');
    const slot = requireSlot(changed);
    model.everCreated = true;
    model.status = 'live';
    model.contents = this.action.contents;
    model.path = path;
    model.revisionId = slot.revisionId;
    model.history.push({ revisionId: slot.revisionId, contents: this.action.contents });
    model.acceptedHead = changed.version.id;
  }

  private runEdit(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'edit' || model.revisionId === null) {
      throw new Error('Command/model mismatch.');
    }
    const previousRevision = model.revisionId;
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'edit-resource',
        resourceId,
        expectedRevision: previousRevision,
        state: fileState(this.action.contents),
      },
    };
    const result = applyTracked(real, request);
    if (this.action.contents === model.contents) {
      requireNoOp(result, 'state-unchanged');
      if (model.revisionId !== previousRevision) throw new Error('Equal edit changed revision.');
      return;
    }
    const changed = requireChanged(result, 'edit');
    const slot = requireSlot(changed);
    if (slot.revisionId === previousRevision) throw new Error('Material edit reused revision ID.');
    model.contents = this.action.contents;
    model.revisionId = slot.revisionId;
    model.history.push({ revisionId: slot.revisionId, contents: this.action.contents });
    model.acceptedHead = changed.version.id;
  }

  private runMove(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'move' || model.path === null || model.revisionId === null) {
      throw new Error('Command/model mismatch.');
    }
    const destination = must(parseWorkspacePath(this.action.path));
    const previousRevision = model.revisionId;
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'move-resource',
        resourceId,
        expectedPath: model.path,
        destination,
      },
    };
    const result = applyTracked(real, request);
    if (destination === model.path) {
      requireNoOp(result, 'already-at-destination');
      return;
    }
    const changed = requireChanged(result, 'move');
    const slot = requireSlot(changed);
    if (slot.revisionId !== previousRevision) throw new Error('Path-only move changed revision.');
    model.path = destination;
    model.acceptedHead = changed.version.id;
  }

  private runDelete(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (model.path === null || model.revisionId === null)
      throw new Error('Command/model mismatch.');
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'delete-resource',
        resourceId,
        expectedRevision: model.revisionId,
        expectedPath: model.path,
      },
    };
    const changed = requireChanged(applyTracked(real, request), 'delete');
    const slot = requireSlot(changed);
    if (!slot.tombstone || slot.path !== null) throw new Error('Delete did not create tombstone.');
    model.status = 'tombstone';
    model.path = null;
    model.revisionId = slot.revisionId;
    model.acceptedHead = changed.version.id;
  }

  private runRestore(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'restore' || model.revisionId === null) {
      throw new Error('Command/model mismatch.');
    }
    const restoreFrom = model.history.at(-1);
    if (!restoreFrom) throw new Error('Restore requires live history.');
    const destination = must(parseWorkspacePath(this.action.path));
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'restore-resource',
        resourceId,
        expectedTombstoneRevision: model.revisionId,
        restoreFromRevision: restoreFrom.revisionId,
        destination,
      },
    };
    const changed = requireChanged(applyTracked(real, request), 'restore');
    const slot = requireSlot(changed);
    model.status = 'live';
    model.contents = restoreFrom.contents;
    model.path = destination;
    model.revisionId = slot.revisionId;
    model.history.push({ revisionId: slot.revisionId, contents: restoreFrom.contents });
    model.acceptedHead = changed.version.id;
  }

  private runRevert(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (model.revisionId === null) throw new Error('Command/model mismatch.');
    const target = model.history[0];
    if (!target) throw new Error('Revert requires prior live history.');
    const previousRevision = model.revisionId;
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'revert-resource',
        resourceId,
        expectedRevision: previousRevision,
        restoreFromRevision: target.revisionId,
      },
    };
    const changed = requireChanged(applyTracked(real, request), 'revert');
    const slot = requireSlot(changed);
    if (slot.revisionId === previousRevision || slot.revisionId === target.revisionId) {
      throw new Error('Explicit revert failed to create new history.');
    }
    const targetRecord = must(inspectResourceRevision(changed.graph, target.revisionId));
    const revertedRecord = must(inspectResourceRevision(changed.graph, slot.revisionId));
    if (targetRecord.stateHash !== revertedRecord.stateHash) {
      throw new Error('Explicit revert did not reuse target state.');
    }
    model.contents = target.contents;
    model.revisionId = slot.revisionId;
    model.history.push({ revisionId: slot.revisionId, contents: target.contents });
    model.acceptedHead = changed.version.id;
  }

  private runStaleEdit(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'stale-edit' || model.revisionId === null) {
      throw new Error('Command/model mismatch.');
    }
    const stale = model.history.find((entry) => entry.revisionId !== model.revisionId);
    if (!stale) throw new Error('Stale edit requires an old revision.');
    const beforeRefs = exportCanonicalClosure(real.graph).refs;
    const request: Omit<ApplyMutationInput, 'graph'> = {
      refName: MAIN_REF,
      expectedHead: model.acceptedHead,
      operationId: nextOperation(real),
      mutation: {
        kind: 'edit-resource',
        resourceId,
        expectedRevision: stale.revisionId,
        state: fileState(this.action.contents),
      },
    };
    const result = applyTracked(real, request);
    if (result.kind !== 'rejected') throw new Error('Stale edit was not rejected.');
    assertRefsEqual(beforeRefs, exportCanonicalClosure(result.graph).refs, 'stale edit');
  }

  private runRecovery(model: RevisionReferenceModel, real: RevisionRealSystem): void {
    if (this.action.kind !== 'recovery') throw new Error('Command/action mismatch.');
    const beforeRefs = exportCanonicalClosure(real.graph).refs;
    const result = captureRecoveryCandidate({
      graph: real.graph,
      operationId: nextOperation(real),
      candidate: {
        kind: 'invalid-working-state',
        workspaceId,
        claimedResourceId: model.everCreated ? resourceId : null,
        baseRevisionId: model.revisionId,
        observedPath: must(parseWorkspacePath('recovery/observed.bin')),
        payloads: [
          {
            role: 'observed-bytes',
            mediaType: 'application/octet-stream',
            blob: defineBlob(new Uint8Array([this.action.byte, 0, 255])),
          },
        ],
        failure: { kind: 'parse-failed', code: 'GENERATED_INVALID_BYTES' },
        expiresAtEpochMs: 1700000000000,
      },
    });
    if (result.kind !== 'captured') throw new Error('Recovery candidate was not captured.');
    real.graph = result.graph;
    assertRefsEqual(beforeRefs, exportCanonicalClosure(real.graph).refs, 'recovery');
  }

  private runRetry(real: RevisionRealSystem): void {
    const request = real.lastRequest;
    if (!request) throw new Error('Retry requires a prior mutation request.');
    const before = exportCanonicalClosure(real.graph);
    const result = applyWorkspaceMutation({ graph: real.graph, ...request });
    if (result.kind !== 'replay') throw new Error('Exact retry did not replay.');
    real.graph = result.graph;
    const after = exportCanonicalClosure(real.graph);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Exact retry created immutable records or changed refs.');
    }
  }

  private runOperationMisuse(real: RevisionRealSystem): void {
    if (this.action.kind !== 'operation-misuse') throw new Error('Command/action mismatch.');
    const prior = real.lastRequest;
    if (!prior) throw new Error('Operation misuse requires a prior mutation request.');
    const beforeRefs = exportCanonicalClosure(real.graph).refs;
    const result = applyWorkspaceMutation({
      graph: real.graph,
      refName: prior.refName,
      expectedHead: prior.expectedHead,
      operationId: prior.operationId,
      mutation: {
        kind: 'create-resource',
        resourceId: misuseResourceId,
        path: must(parseWorkspacePath('misuse/other.txt')),
        state: fileState(this.action.contents),
        origin: { kind: 'created' },
      },
    });
    if (result.kind !== 'rejected' || result.error.kind !== 'operation-id-reused') {
      throw new Error('Operation ID misuse was not rejected.');
    }
    real.graph = result.graph;
    assertRefsEqual(beforeRefs, exportCanonicalClosure(real.graph).refs, 'operation misuse');
  }
}

function applyTracked(
  real: RevisionRealSystem,
  request: Omit<ApplyMutationInput, 'graph'>
): ApplyMutationResult {
  const beforeRefs = exportCanonicalClosure(real.graph).refs;
  const result = applyWorkspaceMutation({ graph: real.graph, ...request });
  real.graph = result.graph;
  real.lastRequest = request;
  if (result.kind !== 'changed') {
    assertRefsEqual(beforeRefs, exportCanonicalClosure(real.graph).refs, result.kind);
  }
  return result;
}

function assertTenInvariants(model: RevisionReferenceModel, real: RevisionRealSystem): void {
  const bundle = exportCanonicalClosure(real.graph);

  for (const record of bundle.records) {
    const key = `${record.kind}:${record.id}`;
    const first = real.immutableBodies.get(key);
    if (first !== undefined && first !== record.canonicalJson) {
      throw new Error(`Immutable ID reused with different bytes: ${key}`);
    }
    real.immutableBodies.set(key, record.canonicalJson);
  }

  const imported = must(importCanonicalRecords(bundle));
  const reexported = exportCanonicalClosure(imported);
  if (JSON.stringify(reexported) !== JSON.stringify(bundle)) {
    throw new Error('Canonical export/import/re-export changed bytes or IDs.');
  }

  const mainRef = bundle.refs.find((ref) => ref.name === 'main');
  if (!mainRef || mainRef.head !== model.acceptedHead) {
    throw new Error('Accepted ref diverged from the reference model.');
  }
  if (model.acceptedHead !== null) {
    const version = must(inspectWorkspaceVersion(real.graph, model.acceptedHead));
    const slot =
      must(listWorkspaceResources(real.graph, version.id)).find(
        (candidate) => candidate.resourceId === resourceId
      ) ?? null;
    if (model.status === 'absent' && slot !== null)
      throw new Error('Absent resource is materialized.');
    if (model.status !== 'absent' && slot === null) throw new Error('Known resource is absent.');
    if (slot) {
      if (slot.revisionId !== model.revisionId || slot.path !== model.path) {
        throw new Error('Accepted slot differs from the reference model.');
      }
      if (slot.tombstone !== (model.status === 'tombstone')) {
        throw new Error('Tombstone status differs from the reference model.');
      }
    }
  }

  const candidateIds = bundle.records
    .filter((record) => record.kind === 'recovery-candidate')
    .map((record) => record.id);
  for (const version of bundle.records.filter((record) => record.kind === 'workspace-version')) {
    if (candidateIds.some((candidateId) => version.canonicalJson.includes(candidateId))) {
      throw new Error('Recovery candidate became reachable from workspace history.');
    }
  }
}

function requireChanged(
  result: ApplyMutationResult,
  action: string
): Extract<ApplyMutationResult, { readonly kind: 'changed' }> {
  if (result.kind !== 'changed')
    throw new Error(`${action} expected changed, received ${result.kind}.`);
  return result;
}

function requireNoOp(result: ApplyMutationResult, reason: string): void {
  if (result.kind !== 'no-op' || result.reason !== reason) {
    throw new Error(`Expected ${reason} no-op, received ${result.kind}.`);
  }
}

function requireSlot(result: Extract<ApplyMutationResult, { readonly kind: 'changed' }>) {
  const slot = must(listWorkspaceResources(result.graph, result.version.id)).find(
    (candidate) => candidate.resourceId === resourceId
  );
  if (!slot) throw new Error('Accepted version is missing the generated resource.');
  return slot;
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

function nextOperation(real: RevisionRealSystem): OperationId {
  const operationId = must(parseOperationId(`state-machine-${real.nextOperationIndex}`));
  real.nextOperationIndex += 1;
  return operationId;
}

function assertRefsEqual(
  left: readonly unknown[],
  right: readonly unknown[],
  action: string
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Non-accepted ${action} changed the accepted ref.`);
  }
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}
