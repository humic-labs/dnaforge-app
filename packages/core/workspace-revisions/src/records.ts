import { canonicalize } from './canonical-json';
import type { ResourceRevisionRecord, WorkspaceVersionRecord } from './graph';
import { hashCanonicalRecord } from './hash';
import type {
  CanonicalJson,
  ResourceId,
  ResourceRevisionId,
  ResourceStateHash,
  WorkspaceId,
  WorkspaceVersionId,
} from './identity';
import type { ImmutableRecordWrite, NonEmpty, ResourceOrigin } from './types';
import type { ResourceStateRecord } from './resource-state';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';
import type { WorkspaceIndexes } from './workspace-index';
import { workspaceMaterializedPathRoot, workspaceResourceRoot } from './workspace-index';

export const MAX_DERIVED_ORIGIN_SOURCES = 4_096;

export function defineResourceRevision(input: {
  readonly resourceId: ResourceId;
  readonly stateHash: ResourceStateHash | null;
  readonly parentIds: readonly ResourceRevisionId[];
  readonly origin: ResourceOrigin | null;
  readonly tombstone: boolean;
}): ResourceRevisionRecord {
  if (input.tombstone !== (input.stateHash === null)) {
    throw new TypeError('A tombstone must have no state; a live revision must have state.');
  }
  const origin = input.origin === null ? null : normalizeOrigin(input.origin);
  const parentIds = sortUnique(input.parentIds, 'resource revision parent');
  const canonicalJson = mustCanonicalize('resource-revision', {
    formatVersion: 1,
    resourceId: input.resourceId,
    stateHash: input.stateHash,
    parentIds,
    origin,
    tombstone: input.tombstone,
  });
  const id = hashCanonicalRecord('resource-revision', canonicalJson);
  return Object.freeze({
    canonicalJson,
    view: Object.freeze({
      id,
      resourceId: input.resourceId,
      stateHash: input.stateHash,
      parentIds,
      origin,
      tombstone: input.tombstone,
    }),
  });
}

export function defineWorkspaceVersion(input: {
  readonly workspaceId: WorkspaceId;
  readonly parentIds: readonly WorkspaceVersionId[];
  readonly indexes: WorkspaceIndexes;
}): WorkspaceVersionRecord {
  const parentIds = sortUnique(input.parentIds, 'workspace version parent');
  const resourceRoot = workspaceResourceRoot(input.indexes);
  const materializedPathRoot = workspaceMaterializedPathRoot(input.indexes);
  const canonicalJson = mustCanonicalize('workspace-version', {
    formatVersion: 2,
    workspaceId: input.workspaceId,
    parentIds,
    resourceRoot,
    materializedPathRoot,
    resourceCount: input.indexes.resources.size,
    materializedPathCount: input.indexes.materializedPaths.size,
  });
  const id = hashCanonicalRecord('workspace-version', canonicalJson);
  return Object.freeze({
    canonicalJson,
    indexes: input.indexes,
    view: Object.freeze({
      id,
      parentIds,
      resourceRoot,
      materializedPathRoot,
      resourceCount: input.indexes.resources.size,
      materializedPathCount: input.indexes.materializedPaths.size,
    }),
  });
}

export function immutableRecordWrite(
  kind: 'resource-state',
  record: ResourceStateRecord
): ImmutableRecordWrite;
export function immutableRecordWrite(
  kind: 'resource-revision',
  record: ResourceRevisionRecord
): ImmutableRecordWrite;
export function immutableRecordWrite(
  kind: 'workspace-version',
  record: WorkspaceVersionRecord
): ImmutableRecordWrite;
export function immutableRecordWrite(
  kind: 'resource-state' | 'resource-revision' | 'workspace-version',
  record: ResourceStateRecord | ResourceRevisionRecord | WorkspaceVersionRecord
): ImmutableRecordWrite {
  const id = 'hash' in record ? record.hash : record.view.id;
  return Object.freeze({ kind, id, canonicalJson: record.canonicalJson });
}

export function normalizeOrigin(origin: ResourceOrigin): ResourceOrigin {
  if (origin.kind === 'created') return Object.freeze({ kind: 'created' });
  if (origin.sources.length > MAX_DERIVED_ORIGIN_SOURCES) {
    throw new TypeError(`Derived resource origin exceeds ${MAX_DERIVED_ORIGIN_SOURCES} sources.`);
  }
  const sources = sortUnique(origin.sources, 'derived resource source');
  const first = sources[0];
  if (!first) throw new TypeError('Derived resource origin requires at least one source.');
  const nonEmptySources: NonEmpty<ResourceRevisionId> = [first, ...sources.slice(1)];
  return Object.freeze({
    kind: 'derived',
    relation: origin.relation,
    sources: Object.freeze(nonEmptySources),
  });
}

function sortUnique<Value extends string>(
  input: readonly Value[],
  label: string
): readonly Value[] {
  const sorted = [...input].sort(deterministicCompare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new TypeError(`Duplicate ${label}.`);
    }
  }
  return Object.freeze(sorted);
}

function mustCanonicalize(
  kind: 'resource-revision' | 'workspace-version',
  value: unknown
): CanonicalJson {
  const result = canonicalize(value);
  if (!result.ok) throw new Error(`Internal canonical record failed: ${result.error.kind}`);
  if (!isCanonicalRecordWithinByteLimit(kind, result.value)) {
    throw new Error(`Internal ${kind} exceeded its canonical byte budget.`);
  }
  return result.value;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
