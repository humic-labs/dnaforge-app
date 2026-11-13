import { classifyImmutableReplay, decodeCanonicalRecord } from './codec-record';
import { decodeOperationReceipt } from './codec-receipt';
import { decodeResourceRevision, decodeResourceState } from './codec-resource';
import {
  collectRadixRecords,
  decodeWorkspaceVersion,
  rebuildWorkspaceIndexes,
} from './codec-workspace';
import { decodeRecoveryCandidate } from './codec-recovery';
import { validateImportedHistory } from './codec-history';
import { createWorkspaceIndexImporter } from './workspace-index';
import type {
  CanonicalGraphBundle,
  CanonicalImportError,
  CanonicalRef,
  DecodedCanonicalRecord,
  DecodedClosureInput,
  OpaqueCanonicalRecord,
  ValidatedClosure,
} from './codec-types';
import {
  makeRevisionGraph,
  requireGraphData,
  type OperationReceiptRecord,
  type RecoveryCandidateRecord,
  type ResourceRevisionRecord,
  type RevisionGraphData,
  type WorkspaceVersionRecord,
} from './graph';
import {
  parseRefName,
  parseWorkspaceId,
  parseWorkspaceVersionId,
  type OperationId,
  type RecoveryCandidateId,
  type Result,
  type WorkspaceVersionId,
} from './identity';
import type { ImmutableRecordKind, RevisionGraph } from './types';
import { revisionHistoryIndexesFrom } from './graph-history';
import type { ResourceStateRecord } from './resource-state';
import {
  immutableWorkspaceIndexClosure,
  listWorkspaceResourcesInIndexes,
  workspaceMaterializedPathRoot,
  workspaceResourceRoot,
} from './workspace-index';

export { classifyImmutableReplay, decodeCanonicalRecord } from './codec-record';
export type {
  CanonicalGraphBundle,
  CanonicalImportError,
  CanonicalRecordError,
  CanonicalRef,
  DecodedCanonicalRecord,
  ImmutableReplayClassification,
  OpaqueCanonicalRecord,
} from './codec-types';

export function exportCanonicalClosure(graph: RevisionGraph): CanonicalGraphBundle {
  const data = requireGraphData(graph);
  const records: OpaqueCanonicalRecord[] = [];
  for (const state of data.resourceStates.values()) {
    records.push({ kind: 'resource-state', id: state.hash, canonicalJson: state.canonicalJson });
  }
  for (const revision of data.resourceRevisions.values()) {
    records.push({
      kind: 'resource-revision',
      id: revision.view.id,
      canonicalJson: revision.canonicalJson,
    });
  }
  for (const version of data.workspaceVersions.values()) {
    for (const write of immutableWorkspaceIndexClosure(version.indexes)) {
      records.push({ kind: write.kind, id: write.id, canonicalJson: write.canonicalJson });
    }
    records.push({
      kind: 'workspace-version',
      id: version.view.id,
      canonicalJson: version.canonicalJson,
    });
  }
  for (const receipt of data.operationReceipts.values()) {
    const replayWrites =
      receipt.replay.outcome === 'changed'
        ? receipt.replay.publication.recordWrites
        : receipt.replay.recordWrites;
    for (const write of replayWrites) {
      records.push({ kind: write.kind, id: write.id, canonicalJson: write.canonicalJson });
    }
  }
  for (const candidate of data.recoveryCandidates.values()) {
    records.push({
      kind: 'recovery-candidate',
      id: candidate.view.id,
      canonicalJson: candidate.canonicalJson,
    });
  }
  const uniqueRecords = [
    ...new Map(records.map((record) => [`${record.kind}:${record.id}`, record])).values(),
  ];
  uniqueRecords.sort((left, right) => {
    const kindOrder = deterministicCompare(left.kind, right.kind);
    return kindOrder === 0 ? deterministicCompare(left.id, right.id) : kindOrder;
  });
  const refs = [...data.refs.entries()]
    .map(([name, head]) => Object.freeze({ name, head }))
    .sort((left, right) => deterministicCompare(left.name, right.name));
  return Object.freeze({
    formatVersion: 1,
    workspaceId: data.workspaceId,
    refs: Object.freeze(refs),
    records: Object.freeze(uniqueRecords.map((record) => Object.freeze(record))),
  });
}

export function importCanonicalRecords(
  input: unknown
): Result<RevisionGraph, CanonicalImportError> {
  if (
    !isPlainRecord(input) ||
    input.formatVersion !== 1 ||
    typeof input.workspaceId !== 'string' ||
    !Array.isArray(input.refs) ||
    !Array.isArray(input.records)
  ) {
    return { ok: false, error: { kind: 'invalid-bundle' } };
  }
  const refs = decodeRefs(input.refs);
  if (!refs) return { ok: false, error: { kind: 'invalid-bundle' } };
  const records: DecodedCanonicalRecord[] = [];
  const firstById = new Map<string, OpaqueCanonicalRecord>();
  for (const candidate of input.records) {
    if (
      !isPlainRecord(candidate) ||
      !isImmutableRecordKind(candidate.kind) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.canonicalJson !== 'string'
    ) {
      return { ok: false, error: { kind: 'invalid-record-envelope' } };
    }
    const opaque: OpaqueCanonicalRecord = {
      kind: candidate.kind,
      id: candidate.id,
      canonicalJson: candidate.canonicalJson,
    };
    const first = firstById.get(candidate.id);
    if (first) {
      const classification = classifyImmutableReplay(first, opaque);
      if (classification.kind === 'corrupt') {
        return {
          ok: false,
          error: { kind: 'immutable-record-corruption', id: opaque.id },
        };
      }
      continue;
    }
    const decoded = decodeCanonicalRecord(candidate);
    if (!decoded.ok) return decoded;
    firstById.set(opaque.id, opaque);
    records.push(decoded.value);
  }
  const closure = validateDecodedClosure({
    workspaceId: input.workspaceId,
    refs,
    records,
  });
  if (!closure.ok) return closure;
  return { ok: true, value: makeRevisionGraph(closure.value.data) };
}

export function validateDecodedClosure(
  input: DecodedClosureInput
): Result<ValidatedClosure, CanonicalImportError> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!workspaceId.ok) return { ok: false, error: { kind: 'invalid-bundle' } };

  const resourceStates = new Map<string, ResourceStateRecord>();
  for (const decoded of input.records.filter((record) => record.kind === 'resource-state')) {
    const state = decodeResourceState(decoded);
    if (!state.ok) return state;
    resourceStates.set(state.value.hash, state.value);
  }

  const resourceRevisions = new Map<string, ResourceRevisionRecord>();
  for (const decoded of input.records.filter((record) => record.kind === 'resource-revision')) {
    const revision = decodeResourceRevision(decoded);
    if (!revision.ok) return revision;
    resourceRevisions.set(revision.value.view.id, revision.value);
  }
  for (const revision of resourceRevisions.values()) {
    if (revision.view.stateHash !== null && !resourceStates.has(revision.view.stateHash)) {
      return {
        ok: false,
        error: {
          kind: 'missing-resource-state',
          revisionId: revision.view.id,
          stateHash: revision.view.stateHash,
        },
      };
    }
    for (const parentId of revision.view.parentIds) {
      const parent = resourceRevisions.get(parentId);
      if (!parent) {
        return {
          ok: false,
          error: { kind: 'missing-resource-parent', revisionId: revision.view.id, parentId },
        };
      }
      if (parent.view.resourceId !== revision.view.resourceId) {
        return {
          ok: false,
          error: { kind: 'cross-resource-parent', revisionId: revision.view.id, parentId },
        };
      }
    }
  }
  const revisionCycle = findParentCycle(resourceRevisions, (record) => record.view.parentIds);
  if (revisionCycle) {
    return {
      ok: false,
      error: { kind: 'resource-parent-cycle', revisionId: revisionCycle },
    };
  }

  const resourceNodeRecords = collectRadixRecords(input.records, 'workspace-resource-map-node');
  if (!resourceNodeRecords.ok) return resourceNodeRecords;
  const pathNodeRecords = collectRadixRecords(input.records, 'workspace-path-map-node');
  if (!pathNodeRecords.ok) return pathNodeRecords;
  const importIndexes = createWorkspaceIndexImporter({
    resourceRecords: resourceNodeRecords.value,
    materializedPathRecords: pathNodeRecords.value,
  });
  const workspaceVersions = new Map<string, WorkspaceVersionRecord>();
  for (const decoded of input.records.filter((record) => record.kind === 'workspace-version')) {
    const version = decodeWorkspaceVersion(decoded, importIndexes);
    if (!version.ok) return version;
    if (version.value.workspaceId !== workspaceId.value) {
      return {
        ok: false,
        error: { kind: 'workspace-id-mismatch', versionId: version.value.record.view.id },
      };
    }
    workspaceVersions.set(version.value.record.view.id, version.value.record);
  }
  for (const version of workspaceVersions.values()) {
    for (const parentId of version.view.parentIds) {
      if (!workspaceVersions.has(parentId)) {
        return {
          ok: false,
          error: { kind: 'missing-workspace-parent', versionId: version.view.id, parentId },
        };
      }
    }
    for (const slot of listWorkspaceResourcesInIndexes(version.indexes)) {
      const revision = resourceRevisions.get(slot.revisionId);
      if (
        !revision ||
        revision.view.resourceId !== slot.resourceId ||
        revision.view.tombstone !== slot.tombstone
      ) {
        return {
          ok: false,
          error: {
            kind: 'incomplete-workspace-slot',
            versionId: version.view.id,
            revisionId: slot.revisionId,
          },
        };
      }
    }
  }
  const versionCycle = findParentCycle(workspaceVersions, (record) => record.view.parentIds);
  if (versionCycle) {
    return {
      ok: false,
      error: { kind: 'workspace-parent-cycle', versionId: versionCycle },
    };
  }

  const typedStates = new Map([...resourceStates.values()].map((state) => [state.hash, state]));
  const typedRevisions = new Map(
    [...resourceRevisions.values()].map((revision) => [revision.view.id, revision])
  );
  const typedVersions = new Map(
    [...workspaceVersions.values()].map((version) => [version.view.id, version])
  );
  const materializationData: RevisionGraphData = {
    ...revisionHistoryIndexesFrom({
      resourceStates: typedStates,
      resourceRevisions: typedRevisions,
      workspaceVersions: typedVersions,
      operationReceipts: [],
      recoveryCandidates: [],
    }),
    workspaceId: workspaceId.value,
    refs: new Map(),
  };
  for (const version of workspaceVersions.values()) {
    const rebuilt = rebuildWorkspaceIndexes(version, materializationData);
    if (
      !rebuilt.ok ||
      workspaceResourceRoot(rebuilt.value) !== version.view.resourceRoot ||
      workspaceMaterializedPathRoot(rebuilt.value) !== version.view.materializedPathRoot
    ) {
      return {
        ok: false,
        error: { kind: 'invalid-materialized-tree', versionId: version.view.id },
      };
    }
  }
  const historyValidation = validateImportedHistory(materializationData);
  if (!historyValidation.ok) return historyValidation;

  const recoveryCandidates = new Map<RecoveryCandidateId, RecoveryCandidateRecord>();
  for (const decoded of input.records.filter((record) => record.kind === 'recovery-candidate')) {
    const candidate = decodeRecoveryCandidate(decoded, {
      workspaceId: workspaceId.value,
      resourceRevisions: typedRevisions,
      workspaceVersions: typedVersions,
    });
    if (!candidate.ok) return candidate;
    recoveryCandidates.set(candidate.value.view.id, candidate.value);
  }

  const operationReceipts = new Map<OperationId, OperationReceiptRecord>();
  const availableRecordKeys = new Set(input.records.map((record) => `${record.kind}:${record.id}`));
  for (const decoded of input.records.filter((record) => record.kind === 'operation-receipt')) {
    const receipt = decodeOperationReceipt(decoded, {
      workspaceId: workspaceId.value,
      workspaceVersions: typedVersions,
      recoveryCandidates,
      availableRecordKeys,
    });
    if (!receipt.ok) return receipt;
    if (operationReceipts.has(receipt.value.operationId)) {
      return {
        ok: false,
        error: {
          kind: 'duplicate-operation-receipt',
          operationId: receipt.value.operationId,
        },
      };
    }
    operationReceipts.set(receipt.value.operationId, receipt.value);
  }

  const refs = new Map<import('./identity').RefName, WorkspaceVersionId | null>();
  for (const ref of input.refs) {
    const refName = parseRefName(ref.name);
    if (!refName.ok || refs.has(refName.value)) {
      return { ok: false, error: { kind: 'invalid-ref', refName: ref.name } };
    }
    if (ref.head === null) {
      refs.set(refName.value, null);
      continue;
    }
    const head = parseWorkspaceVersionId(ref.head);
    if (!head.ok || !workspaceVersions.has(head.value)) {
      return {
        ok: false,
        error: { kind: 'incomplete-accepted-ref', refName: ref.name, head: ref.head },
      };
    }
    refs.set(refName.value, head.value);
  }

  return {
    ok: true,
    value: {
      data: {
        ...revisionHistoryIndexesFrom({
          resourceStates: typedStates,
          resourceRevisions: typedRevisions,
          workspaceVersions: typedVersions,
          operationReceipts,
          recoveryCandidates,
        }),
        workspaceId: workspaceId.value,
        refs,
      },
    },
  };
}

function findParentCycle<RecordValue>(
  records: ReadonlyMap<string, RecordValue>,
  parents: (record: RecordValue) => readonly string[]
): string | null {
  const status = new Map<string, 'visiting' | 'complete'>();
  for (const start of [...records.keys()].sort(deterministicCompare)) {
    if (status.has(start)) continue;
    const first = records.get(start);
    if (!first) continue;
    status.set(start, 'visiting');
    const stack: Array<{
      readonly id: string;
      readonly parents: readonly string[];
      index: number;
    }> = [{ id: start, parents: parents(first), index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const parentId = frame.parents[frame.index];
      if (parentId === undefined) {
        status.set(frame.id, 'complete');
        stack.pop();
        continue;
      }
      frame.index += 1;
      const parentStatus = status.get(parentId);
      if (parentStatus === 'visiting') return parentId;
      if (parentStatus === 'complete') continue;
      const parent = records.get(parentId);
      if (!parent) continue;
      status.set(parentId, 'visiting');
      stack.push({ id: parentId, parents: parents(parent), index: 0 });
    }
  }
  return null;
}

function decodeRefs(values: readonly unknown[]): CanonicalRef[] | null {
  const refs: CanonicalRef[] = [];
  for (const value of values) {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['name', 'head']) ||
      typeof value.name !== 'string' ||
      (value.head !== null && typeof value.head !== 'string')
    ) {
      return null;
    }
    refs.push({ name: value.name, head: value.head });
  }
  return refs;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort(deterministicCompare);
  const sortedExpected = [...expected].sort(deterministicCompare);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isImmutableRecordKind(value: unknown): value is ImmutableRecordKind {
  return (
    value === 'resource-state' ||
    value === 'resource-revision' ||
    value === 'workspace-version' ||
    value === 'operation-receipt' ||
    value === 'recovery-candidate' ||
    value === 'workspace-resource-map-node' ||
    value === 'workspace-path-map-node'
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
