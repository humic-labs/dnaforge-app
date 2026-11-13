import type {
  MemberId,
  ResourceId,
  Result,
  WorkspacePath,
  WorkspacePathRootId,
  WorkspaceResourceRootId,
} from './identity';
import {
  parseMemberId,
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspacePathRootId,
  parseWorkspaceResourceRootId,
} from './identity';
import type { NonEmpty, WorkspaceResourceSlotView } from './types';
import { parseWorkspacePath, pathCollisionKey, type PathError } from './path';
import {
  deleteRadixValue,
  decodeRadixNode,
  emptyMerkleRadixMap,
  firstRadixEntryWithPrefix,
  getRadixValue,
  createMerkleRadixMapImporter,
  inspectRadixWrites,
  listRadixEntries,
  setRadixValue,
  type MerkleRadixMap,
  type RadixDecodeError,
  type RadixDomain,
  type RadixMutation,
  type RadixNodeWrite,
} from './radix-map';
import type { ResourceStateRecord } from './resource-state';
import { canonicalRecordByteLength } from './record-budgets';

export interface MaterializedPathValue {
  readonly resourceId: ResourceId;
  readonly memberId: MemberId | null;
  readonly kind: 'file' | 'directory';
  readonly displayPath: WorkspacePath;
}

export interface WorkspaceIndexes {
  readonly resources: MerkleRadixMap<WorkspaceResourceSlotView>;
  readonly materializedPaths: MerkleRadixMap<MaterializedPathValue>;
}

export interface WorkspaceIndexUpdate {
  readonly indexes: WorkspaceIndexes;
  readonly writes: readonly RadixNodeWrite[];
  readonly metrics: WorkspaceIndexUpdateMetrics;
}

export interface WorkspaceIndexUpdateMetrics {
  readonly nodeReads: number;
  readonly nodeWrites: number;
  readonly canonicalWriteBytes: number;
}

export type WorkspaceIndexError =
  | { readonly kind: 'invalid-materialized-path'; readonly error: PathError }
  | { readonly kind: 'path-conflict'; readonly paths: NonEmpty<WorkspacePath> }
  | { readonly kind: 'invalid-index-transition'; readonly reason: string };

interface MaterializedOutput extends MaterializedPathValue {
  readonly collisionKey: string;
}

const RESOURCE_DOMAIN: RadixDomain<WorkspaceResourceSlotView> = Object.freeze({
  name: 'workspace-resource',
  hashDomain: 'dnaforge:workspace-resource-map-node:v1\0',
  idPrefix: 'wrn',
  encodeValue: (value: WorkspaceResourceSlotView) => value,
  decodeValue: decodeResourceSlot,
});

const MATERIALIZED_PATH_DOMAIN: RadixDomain<MaterializedPathValue> = Object.freeze({
  name: 'workspace-materialized-path',
  hashDomain: 'dnaforge:workspace-materialized-path-map-node:v1\0',
  idPrefix: 'wpn',

  encodeValue: (value: MaterializedPathValue) => ({
    resourceId: value.resourceId,
    memberId: value.memberId,
    kind: value.kind,
    displayPath: value.displayPath,
    collisionKey: pathCollisionKey(value.displayPath),
  }),
  decodeValue: decodeMaterializedPathValue,
});

export function emptyWorkspaceIndexes(): WorkspaceIndexes {
  return freezeIndexes(emptyMerkleRadixMap(), emptyMerkleRadixMap());
}

export function inspectWorkspaceResourceInIndexes(
  indexes: WorkspaceIndexes,
  resourceId: ResourceId
): WorkspaceResourceSlotView | undefined {
  return getRadixValue(indexes.resources, resourceId);
}

export function listWorkspaceResourcesInIndexes(
  indexes: WorkspaceIndexes
): readonly WorkspaceResourceSlotView[] {
  return Object.freeze(listRadixEntries(indexes.resources).map(([, slot]) => slot));
}

export function workspaceResourceRoot(indexes: WorkspaceIndexes): WorkspaceResourceRootId | null {
  if (indexes.resources.rootId === null) return null;
  const parsed = parseWorkspaceResourceRootId(indexes.resources.rootId);
  if (!parsed.ok) throw new Error('Resource map produced an invalid root ID.');
  return parsed.value;
}

export function workspaceMaterializedPathRoot(
  indexes: WorkspaceIndexes
): WorkspacePathRootId | null {
  if (indexes.materializedPaths.rootId === null) return null;
  const parsed = parseWorkspacePathRootId(indexes.materializedPaths.rootId);
  if (!parsed.ok) throw new Error('Materialized-path map produced an invalid root ID.');
  return parsed.value;
}

export function immutableWorkspaceIndexWrites(
  writes: readonly RadixNodeWrite[]
): readonly import('./types').ImmutableRecordWrite[] {
  return Object.freeze(
    writes.map((write) => {
      if (write.id.startsWith('wrn_')) {
        const parsed = parseWorkspaceResourceRootId(write.id);
        if (!parsed.ok) throw new Error('Resource map produced an invalid node ID.');
        return Object.freeze({
          kind: 'workspace-resource-map-node' as const,
          id: parsed.value,
          canonicalJson: write.canonicalJson,
        });
      }
      if (write.id.startsWith('wpn_')) {
        const parsed = parseWorkspacePathRootId(write.id);
        if (!parsed.ok) throw new Error('Materialized-path map produced an invalid node ID.');
        return Object.freeze({
          kind: 'workspace-path-map-node' as const,
          id: parsed.value,
          canonicalJson: write.canonicalJson,
        });
      }
      throw new Error(`Unexpected workspace index node domain: ${write.id}`);
    })
  );
}

export function immutableWorkspaceIndexClosure(
  indexes: WorkspaceIndexes
): readonly import('./types').ImmutableRecordWrite[] {
  return immutableWorkspaceIndexWrites([
    ...inspectRadixWrites(indexes.resources),
    ...inspectRadixWrites(indexes.materializedPaths),
  ]);
}

export function decodeWorkspaceIndexNode(
  kind: 'workspace-resource-map-node' | 'workspace-path-map-node',
  id: string,
  canonicalJson: string
): Result<RadixNodeWrite, RadixDecodeError> {
  return kind === 'workspace-resource-map-node'
    ? decodeRadixNode(id, canonicalJson, RESOURCE_DOMAIN)
    : decodeRadixNode(id, canonicalJson, MATERIALIZED_PATH_DOMAIN);
}

export function importWorkspaceIndexes(input: {
  readonly resourceRoot: WorkspaceResourceRootId | null;
  readonly materializedPathRoot: WorkspacePathRootId | null;
  readonly resourceCount: number;
  readonly materializedPathCount: number;
  readonly resourceRecords: readonly RadixNodeWrite[];
  readonly materializedPathRecords: readonly RadixNodeWrite[];
}): Result<WorkspaceIndexes, RadixDecodeError> {
  return createWorkspaceIndexImporter(input)(input);
}

export type WorkspaceIndexImporter = (input: {
  readonly resourceRoot: WorkspaceResourceRootId | null;
  readonly materializedPathRoot: WorkspacePathRootId | null;
  readonly resourceCount: number;
  readonly materializedPathCount: number;
}) => Result<WorkspaceIndexes, RadixDecodeError>;

export function createWorkspaceIndexImporter(input: {
  readonly resourceRecords: readonly RadixNodeWrite[];
  readonly materializedPathRecords: readonly RadixNodeWrite[];
}): WorkspaceIndexImporter {
  const importResources = createMerkleRadixMapImporter({
    records: input.resourceRecords,
    domain: RESOURCE_DOMAIN,
  });
  const importPaths = createMerkleRadixMapImporter({
    records: input.materializedPathRecords,
    domain: MATERIALIZED_PATH_DOMAIN,
  });
  return (roots) => {
    const resources = importResources({ rootId: roots.resourceRoot, size: roots.resourceCount });
    if (!resources.ok) return resources;
    const materializedPaths = importPaths({
      rootId: roots.materializedPathRoot,
      size: roots.materializedPathCount,
    });
    return materializedPaths.ok
      ? { ok: true, value: freezeIndexes(resources.value, materializedPaths.value) }
      : materializedPaths;
  };
}

export function updateWorkspaceResourceIndexes(input: {
  readonly indexes: WorkspaceIndexes;
  readonly resourceId: ResourceId;
  readonly nextSlot: WorkspaceResourceSlotView | null;
  readonly previousState: ResourceStateRecord | null;
  readonly nextState: ResourceStateRecord | null;
}): Result<WorkspaceIndexUpdate, WorkspaceIndexError> {
  const access = { nodeReads: 0 };
  const previousSlot = getRadixValue(input.indexes.resources, input.resourceId, access) ?? null;
  if (previousSlot && previousSlot.resourceId !== input.resourceId) {
    return invalidTransition('resource index returned a slot for a different stable ID');
  }
  const previousOutputs = outputsForSlot(previousSlot, input.previousState);
  if (!previousOutputs.ok) return previousOutputs;
  const nextOutputs = outputsForSlot(input.nextSlot, input.nextState);
  if (!nextOutputs.ok) return nextOutputs;

  let materializedPaths = input.indexes.materializedPaths;
  const emittedWrites: RadixNodeWrite[] = [];
  for (const output of previousOutputs.value) {
    const stored = getRadixValue(materializedPaths, output.collisionKey, access);
    if (!stored || !sameOwner(stored, output)) {
      return invalidTransition('materialized-path index does not match the prior resource state');
    }
    const deletion = deleteRadixValue(
      materializedPaths,
      output.collisionKey,
      MATERIALIZED_PATH_DOMAIN,
      access
    );
    materializedPaths = deletion.map;
    emittedWrites.push(...deletion.writes);
  }

  for (const output of nextOutputs.value) {
    const collision = findPathConflict(materializedPaths, output, access);
    if (collision) return { ok: false, error: collision };
    const insertion = setRadixValue(
      materializedPaths,
      output.collisionKey,
      freezePathValue(output),
      MATERIALIZED_PATH_DOMAIN,
      access
    );
    materializedPaths = insertion.map;
    emittedWrites.push(...insertion.writes);
  }

  const resourceMutation: RadixMutation<WorkspaceResourceSlotView> = input.nextSlot
    ? setRadixValue(
        input.indexes.resources,
        input.resourceId,
        freezeSlot(input.nextSlot),
        RESOURCE_DOMAIN,
        access
      )
    : deleteRadixValue(input.indexes.resources, input.resourceId, RESOURCE_DOMAIN, access);
  const indexes = freezeIndexes(resourceMutation.map, materializedPaths);
  emittedWrites.push(...resourceMutation.writes);
  const writes = uniqueRadixWrites(emittedWrites);
  return {
    ok: true,
    value: Object.freeze({
      indexes,
      writes,
      metrics: Object.freeze({
        nodeReads: access.nodeReads,
        nodeWrites: writes.length,
        canonicalWriteBytes: writes.reduce(
          (total, write) => total + canonicalRecordByteLength(write.canonicalJson),
          0
        ),
      }),
    }),
  };
}

function uniqueRadixWrites(writes: readonly RadixNodeWrite[]): readonly RadixNodeWrite[] {
  return Object.freeze(
    [...new Map(writes.map((write) => [write.id, write])).values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  );
}

function outputsForSlot(
  slot: WorkspaceResourceSlotView | null,
  state: ResourceStateRecord | null
): Result<readonly MaterializedOutput[], WorkspaceIndexError> {
  if (!slot || slot.path === null || slot.tombstone) {
    return { ok: true, value: Object.freeze([]) };
  }
  if (!state) return invalidTransition('active resource slot requires a resource state');
  const outputs: MaterializedOutput[] = [
    freezeOutput({
      resourceId: slot.resourceId,
      memberId: null,
      kind: state.layout === 'file' ? 'file' : 'directory',
      displayPath: slot.path,
      collisionKey: pathCollisionKey(slot.path),
    }),
  ];
  if (state.layout === 'directory') {
    for (const member of state.members) {
      const joined = parseWorkspacePath(`${slot.path}/${member.relativePath}`);
      if (!joined.ok) {
        return {
          ok: false,
          error: { kind: 'invalid-materialized-path', error: joined.error },
        };
      }
      outputs.push(
        freezeOutput({
          resourceId: slot.resourceId,
          memberId: member.memberId,
          kind: 'file',
          displayPath: joined.value,
          collisionKey: pathCollisionKey(joined.value),
        })
      );
    }
  }
  return { ok: true, value: Object.freeze(outputs) };
}

function findPathConflict(
  paths: MerkleRadixMap<MaterializedPathValue>,
  candidate: MaterializedOutput,
  access: import('./radix-map').RadixAccessCounter
): WorkspaceIndexError | null {
  const exact = getRadixValue(paths, candidate.collisionKey, access);
  if (exact) return pathConflict(exact.displayPath, candidate.displayPath);

  let separator = candidate.collisionKey.indexOf('/');
  while (separator >= 0) {
    const ancestor = getRadixValue(paths, candidate.collisionKey.slice(0, separator), access);
    if (ancestor?.kind === 'file') {
      return pathConflict(ancestor.displayPath, candidate.displayPath);
    }
    separator = candidate.collisionKey.indexOf('/', separator + 1);
  }

  if (candidate.kind === 'file') {
    const descendant = firstRadixEntryWithPrefix(paths, `${candidate.collisionKey}/`, access);
    if (descendant) return pathConflict(candidate.displayPath, descendant[1].displayPath);
  }
  return null;
}

function decodeResourceSlot(value: unknown): Result<WorkspaceResourceSlotView, RadixDecodeError> {
  if (
    !isRecord(value) ||
    typeof value.resourceId !== 'string' ||
    typeof value.revisionId !== 'string'
  ) {
    return invalidNodeValue();
  }
  const resourceId = parseResourceId(value.resourceId);
  const revisionId = parseResourceRevisionId(value.revisionId);
  const path = decodeNullablePath(value.path);
  const lastPath = decodeNullablePath(value.lastPath);
  if (
    !resourceId.ok ||
    !revisionId.ok ||
    !path.ok ||
    !lastPath.ok ||
    typeof value.tombstone !== 'boolean' ||
    value.tombstone !== (path.value === null)
  ) {
    return invalidNodeValue();
  }
  return {
    ok: true,
    value: freezeSlot({
      resourceId: resourceId.value,
      revisionId: revisionId.value,
      path: path.value,
      lastPath: lastPath.value,
      tombstone: value.tombstone,
    }),
  };
}

function decodeMaterializedPathValue(
  value: unknown
): Result<MaterializedPathValue, RadixDecodeError> {
  if (
    !isRecord(value) ||
    typeof value.resourceId !== 'string' ||
    (value.memberId !== null && typeof value.memberId !== 'string') ||
    (value.kind !== 'file' && value.kind !== 'directory') ||
    typeof value.displayPath !== 'string'
  ) {
    return invalidNodeValue();
  }
  const resourceId = parseResourceId(value.resourceId);
  const memberId = value.memberId === null ? null : parseMemberId(value.memberId);
  const displayPath = parseWorkspacePath(value.displayPath);
  if (
    !resourceId.ok ||
    (memberId !== null && !memberId.ok) ||
    !displayPath.ok ||
    value.collisionKey !== pathCollisionKey(displayPath.value)
  ) {
    return invalidNodeValue();
  }
  return {
    ok: true,
    value: Object.freeze({
      resourceId: resourceId.value,
      memberId: memberId === null ? null : memberId.value,
      kind: value.kind,
      displayPath: displayPath.value,
    }),
  };
}

function decodeNullablePath(value: unknown): Result<WorkspacePath | null, RadixDecodeError> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return invalidNodeValue();
  const parsed = parseWorkspacePath(value);
  return parsed.ok ? parsed : invalidNodeValue();
}

function freezeIndexes(
  resources: MerkleRadixMap<WorkspaceResourceSlotView>,
  materializedPaths: MerkleRadixMap<MaterializedPathValue>
): WorkspaceIndexes {
  return Object.freeze({ resources, materializedPaths });
}

function freezeSlot(slot: WorkspaceResourceSlotView): WorkspaceResourceSlotView {
  return Object.freeze({ ...slot });
}

function freezePathValue(value: MaterializedPathValue): MaterializedPathValue {
  return Object.freeze({
    resourceId: value.resourceId,
    memberId: value.memberId,
    kind: value.kind,
    displayPath: value.displayPath,
  });
}

function freezeOutput(output: MaterializedOutput): MaterializedOutput {
  return Object.freeze({ ...output });
}

function sameOwner(left: MaterializedPathValue, right: MaterializedPathValue): boolean {
  return left.resourceId === right.resourceId && left.memberId === right.memberId;
}

function pathConflict(left: WorkspacePath, right: WorkspacePath): WorkspaceIndexError {
  return { kind: 'path-conflict', paths: [left, right] };
}

function invalidTransition(reason: string): Result<never, WorkspaceIndexError> {
  return { ok: false, error: { kind: 'invalid-index-transition', reason } };
}

function invalidNodeValue(): Result<never, RadixDecodeError> {
  return { ok: false, error: { kind: 'invalid-node-value' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
