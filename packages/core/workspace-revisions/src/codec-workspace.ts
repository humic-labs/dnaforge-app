import type { CanonicalImportError, DecodedCanonicalRecord } from './codec-types';
import type { RevisionGraphData, WorkspaceVersionRecord } from './graph';
import {
  parseWorkspaceId,
  parseWorkspacePathRootId,
  parseWorkspaceResourceRootId,
  parseWorkspaceVersionId,
  type Result,
  type WorkspaceVersionId,
} from './identity';
import type { ImmutableRecordKind, WorkspaceVersionView } from './types';
import type { RadixNodeWrite } from './radix-map';
import {
  decodeWorkspaceIndexNode,
  emptyWorkspaceIndexes,
  listWorkspaceResourcesInIndexes,
  updateWorkspaceResourceIndexes,
  type WorkspaceIndexError,
  type WorkspaceIndexes,
  type WorkspaceIndexImporter,
} from './workspace-index';

export function decodeWorkspaceVersion(
  decoded: DecodedCanonicalRecord,
  importIndexes: WorkspaceIndexImporter
): Result<
  { readonly workspaceId: string; readonly record: WorkspaceVersionRecord },
  CanonicalImportError
> {
  const body = decoded.body;
  if (
    !hasExactKeys(body, [
      'formatVersion',
      'workspaceId',
      'parentIds',
      'resourceRoot',
      'materializedPathRoot',
      'resourceCount',
      'materializedPathCount',
    ]) ||
    typeof body.workspaceId !== 'string' ||
    !Array.isArray(body.parentIds) ||
    (body.resourceRoot !== null && typeof body.resourceRoot !== 'string') ||
    (body.materializedPathRoot !== null && typeof body.materializedPathRoot !== 'string') ||
    typeof body.resourceCount !== 'number' ||
    !Number.isSafeInteger(body.resourceCount) ||
    body.resourceCount < 0 ||
    typeof body.materializedPathCount !== 'number' ||
    !Number.isSafeInteger(body.materializedPathCount) ||
    body.materializedPathCount < 0
  ) {
    return invalidBody('workspace-version');
  }
  const parsedWorkspaceId = parseWorkspaceId(body.workspaceId);
  const parentIds = decodeWorkspaceVersionIds(body.parentIds);
  const id = parseWorkspaceVersionId(decoded.id);
  const resourceRoot =
    body.resourceRoot === null
      ? { ok: true as const, value: null }
      : parseWorkspaceResourceRootId(body.resourceRoot);
  const materializedPathRoot =
    body.materializedPathRoot === null
      ? { ok: true as const, value: null }
      : parseWorkspacePathRootId(body.materializedPathRoot);
  if (
    !parsedWorkspaceId.ok ||
    !parentIds ||
    !id.ok ||
    !resourceRoot.ok ||
    !materializedPathRoot.ok
  ) {
    return invalidBody('workspace-version');
  }
  const indexes = importIndexes({
    resourceRoot: resourceRoot.value,
    materializedPathRoot: materializedPathRoot.value,
    resourceCount: body.resourceCount,
    materializedPathCount: body.materializedPathCount,
  });
  if (!indexes.ok) return invalidBody('workspace-version');
  const view: WorkspaceVersionView = Object.freeze({
    id: id.value,
    parentIds: Object.freeze(parentIds),
    resourceRoot: resourceRoot.value,
    materializedPathRoot: materializedPathRoot.value,
    resourceCount: body.resourceCount,
    materializedPathCount: body.materializedPathCount,
  });
  return {
    ok: true,
    value: {
      workspaceId: parsedWorkspaceId.value,
      record: Object.freeze({ view, canonicalJson: decoded.canonicalJson, indexes: indexes.value }),
    },
  };
}

function decodeWorkspaceVersionIds(values: readonly unknown[]): WorkspaceVersionId[] | null {
  const result: WorkspaceVersionId[] = [];
  let prior: string | null = null;
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const parsed = parseWorkspaceVersionId(value);
    if (!parsed.ok || (prior !== null && deterministicCompare(prior, parsed.value) >= 0)) {
      return null;
    }
    prior = parsed.value;
    result.push(parsed.value);
  }
  return result;
}

export function collectRadixRecords(
  records: readonly DecodedCanonicalRecord[],
  kind: 'workspace-resource-map-node' | 'workspace-path-map-node'
): Result<readonly RadixNodeWrite[], CanonicalImportError> {
  const writes: RadixNodeWrite[] = [];
  for (const record of records) {
    if (record.kind !== kind) continue;
    const decoded = decodeWorkspaceIndexNode(kind, record.id, record.canonicalJson);
    if (!decoded.ok) return invalidBody(kind);
    writes.push(decoded.value);
  }
  return { ok: true, value: Object.freeze(writes) };
}

export function rebuildWorkspaceIndexes(
  version: WorkspaceVersionRecord,
  data: RevisionGraphData
): Result<WorkspaceIndexes, WorkspaceIndexError> {
  let indexes = emptyWorkspaceIndexes();
  for (const slot of listWorkspaceResourcesInIndexes(version.indexes)) {
    const revision = data.resourceRevisions.get(slot.revisionId);
    const state =
      revision?.view.stateHash === null || revision === undefined
        ? null
        : (data.resourceStates.get(revision.view.stateHash) ?? null);
    const updated = updateWorkspaceResourceIndexes({
      indexes,
      resourceId: slot.resourceId,
      nextSlot: slot,
      previousState: null,
      nextState: state,
    });
    if (!updated.ok) return updated;
    indexes = updated.value.indexes;
  }
  return { ok: true, value: indexes };
}

function invalidBody(recordKind: ImmutableRecordKind): Result<never, CanonicalImportError> {
  return { ok: false, error: { kind: 'invalid-record-body', recordKind } };
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

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
