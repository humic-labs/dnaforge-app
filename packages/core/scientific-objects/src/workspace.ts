import {
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  parseResourceId,
  parseWorkspacePath,
  pathCollisionKey,
  previewMutationRevision,
  validateMaterializedTree,
  type ResourceId,
  type ResourceRevisionId,
  type ResourceState,
  type Result,
  type RevisionGraph,
  type WorkspaceMutation,
  type WorkspacePath,
  type WorkspaceResourceSlotView,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { exportCanonicalClosure } from '@waypoint/workspace-revisions/codec';
import {
  defineScientificFile,
  type ScientificFileContent,
  type ScientificFileCodec,
} from './files';
import { canonicalPayload } from './json';
import { parseUniqueJson } from './unique-json';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid scientific workspace: ${JSON.stringify(result.error)}`);
  return result.value;
};
export const scientificIdentityPath = must(parseWorkspacePath('.dnaforge/scientific-objects.json'));
export const scientificIdentityResourceId = must(parseResourceId('dnaforge-scientific-identities'));

export type ScientificFileEntry = {
  readonly resourceId: ResourceId;
  readonly path: WorkspacePath;
} & ScientificFileContent;
export interface ScientificIdentityMap {
  readonly formatVersion: 1 | 2;
  readonly workspaceId: string;
  readonly entries: readonly {
    readonly resourceId: ResourceId;
    readonly path: WorkspacePath;
    readonly format?: string;
  }[];
}

export function parseScientificIdentityMap(
  text: string,
  workspaceId: string
): ScientificIdentityMap {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
    throw new TypeError('Scientific identity map exceeds 1 MiB.');
  const input = parseUniqueJson(text);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Invalid scientific identity map.');
  const value = input as Record<string, unknown>;
  exactKeys(value, ['formatVersion', 'workspaceId', 'entries']);
  if (
    (value.formatVersion !== 1 && value.formatVersion !== 2) ||
    value.workspaceId !== workspaceId ||
    !Array.isArray(value.entries)
  )
    throw new TypeError('Scientific identity map format or owning workspace does not match.');
  const entries = value.entries.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('Invalid scientific identity entry.');
    const row = raw as Record<string, unknown>;
    exactKeys(
      row,
      value.formatVersion === 1 ? ['resourceId', 'path'] : ['resourceId', 'path', 'format']
    );
    if (typeof row.resourceId !== 'string' || typeof row.path !== 'string')
      throw new TypeError('Invalid scientific identity entry.');
    if (
      value.formatVersion === 2 &&
      (typeof row.format !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(row.format))
    )
      throw new TypeError('Invalid scientific identity file format.');
    return {
      resourceId: must(parseResourceId(row.resourceId)),
      path: must(parseWorkspacePath(row.path)),
      ...(value.formatVersion === 2 ? { format: row.format as string } : {}),
    };
  });
  validateEntries(entries);
  return Object.freeze({
    formatVersion: value.formatVersion,
    workspaceId,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

export function compileScientificWorkspace(input: {
  readonly graph: RevisionGraph;
  readonly head: WorkspaceVersionId | null;
  readonly entries: readonly ScientificFileEntry[];
  readonly codecs?: readonly ScientificFileCodec[];

  readonly restores?: ReadonlyMap<ResourceId, ResourceRevisionId>;
}): { readonly mutations: readonly WorkspaceMutation[]; readonly blobs: readonly Uint8Array[] } {
  const entries = [...input.entries]
    .map((entry) => ({
      ...entry,
      resourceId: must(parseResourceId(entry.resourceId)),
      path: must(parseWorkspacePath(entry.path)),
    }))
    .sort((a, b) => compare(a.resourceId, b.resourceId));
  validateEntries(entries);
  const slots = input.head === null ? [] : must(listWorkspaceResources(input.graph, input.head));
  const previous = new Map(slots.map((slot) => [slot.resourceId, slot]));
  const blobs: Uint8Array[] = [];
  const mutations: WorkspaceMutation[] = [];
  const present = new Set(entries.map((entry) => entry.resourceId));
  for (const slot of slots) {
    if (!slot.path || slot.tombstone || slot.resourceId === scientificIdentityResourceId) continue;
    const state = resourceState(input.graph, slot);
    if (state.resourceKind.startsWith('dnaforge.scientific.') && !present.has(slot.resourceId))
      mutations.push({
        kind: 'delete-resource',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: slot.path,
      });
  }
  for (const entry of entries) {
    if (/\.(?:gb|gbk|genbank)$/iu.test(entry.path) && entry.representation?.format !== 'genbank-v1')
      throw new TypeError('GenBank paths require a native GenBank representation.');
    const defined = defineScientificFile(entry, input.codecs);
    if (defined.nativeResourceId !== undefined && defined.nativeResourceId !== entry.resourceId)
      throw new TypeError('Native scientific file identity does not match its receiving resource.');
    if (/\.primer\.json$/iu.test(entry.path) && entry.representation?.format !== 'primer-v2')
      throw new TypeError('Primer artifact paths require a native primer representation.');
    if (/\.entity\.json$/iu.test(entry.path) && entry.representation?.format !== 'strain-entity-v1')
      throw new TypeError('Strain artifact paths require a native strain representation.');
    if (/\.task\.json$/iu.test(entry.path) && entry.representation?.format !== 'work-task-v1')
      throw new TypeError('Task artifact paths require a native work task representation.');
    blobs.push(new TextEncoder().encode(defined.text));
    const old = previous.get(entry.resourceId);
    if (
      old &&
      !old.tombstone &&
      !resourceState(input.graph, old).resourceKind.startsWith('dnaforge.scientific.')
    )
      throw new TypeError('Scientific identity belongs to a different resource kind.');
    if (old && !old.tombstone) {
      const previousFormat = resourceState(input.graph, old).materialMetadata?.representation;
      if (previousFormat !== undefined && previousFormat !== entry.representation?.format)
        throw new TypeError(
          'A native scientific file requires its existing format; export conversion as a new resource.'
        );
    }
    const restoreFromRevision = input.restores?.get(entry.resourceId);
    if (restoreFromRevision) {
      const source = must(inspectResourceRevision(input.graph, restoreFromRevision));
      if (
        !old?.tombstone ||
        source.resourceId !== entry.resourceId ||
        source.tombstone ||
        previewMutationRevision(input.graph, {
          kind: 'edit-resource',
          resourceId: entry.resourceId,
          expectedRevision: source.id,
          state: defined.state,
        }) !== source.id
      )
        throw new TypeError(
          'Scientific restore requires exact live history owned by its tombstoned identity.'
        );
      mutations.push({
        kind: 'restore-resource',
        resourceId: entry.resourceId,
        expectedTombstoneRevision: old.revisionId,
        restoreFromRevision,
        destination: entry.path,
      });
    } else mutations.push(intent(old, entry.resourceId, entry.path, defined.state));
  }

  const native = entries.some((entry) => Object.hasOwn(entry, 'representation'));
  const map: ScientificIdentityMap = {
    formatVersion: native ? 2 : 1,
    workspaceId: exportCanonicalClosure(input.graph).workspaceId,
    entries: entries.map((entry) => ({
      resourceId: entry.resourceId,
      path: entry.path,
      ...(native ? { format: entry.representation?.format ?? 'scientific-json-v1' } : {}),
    })),
  };
  const bytes = new TextEncoder().encode(`${canonicalPayload(map)}\n`);
  if (bytes.byteLength > 1024 * 1024) throw new TypeError('Scientific identity map exceeds 1 MiB.');
  const state = must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'dnaforge.scientific-identity-map',
      mediaType: 'application/json',
      blob: defineBlob(bytes),
    })
  );
  const previousMap = previous.get(scientificIdentityResourceId);
  if (
    previousMap &&
    !previousMap.tombstone &&
    resourceState(input.graph, previousMap).resourceKind !== 'dnaforge.scientific-identity-map'
  )
    throw new TypeError('Scientific identity map belongs to a different resource kind.');
  blobs.push(bytes);
  mutations.push(intent(previousMap, scientificIdentityResourceId, scientificIdentityPath, state));
  return { mutations: Object.freeze(orderIntents(mutations, slots)), blobs: Object.freeze(blobs) };
}

function intent(
  old: WorkspaceResourceSlotView | undefined,
  resourceId: ResourceId,
  path: WorkspacePath,
  state: ResourceState
): WorkspaceMutation {
  if (!old)
    return { kind: 'create-resource', resourceId, path, state, origin: { kind: 'created' } };
  if (old.tombstone || !old.path)
    throw new TypeError('Removed scientific identities require an explicit history restore.');
  if (old.path === path)
    return { kind: 'edit-resource', resourceId, expectedRevision: old.revisionId, state };
  return {
    kind: 'edit-and-move-resource',
    resourceId,
    expectedRevision: old.revisionId,
    expectedPath: old.path,
    destination: path,
    state,
  };
}

function resourceState(graph: RevisionGraph, slot: WorkspaceResourceSlotView) {
  const revision = must(inspectResourceRevision(graph, slot.revisionId));
  if (!revision.stateHash) throw new TypeError('Scientific identity has no live content.');
  return must(inspectResourceState(graph, revision.stateHash));
}

function validateEntries(
  entries: readonly { resourceId: ResourceId; path: WorkspacePath }[]
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.resourceId) || entry.resourceId === scientificIdentityResourceId)
      throw new TypeError('Duplicate or reserved scientific resource identity.');
    ids.add(entry.resourceId);
    if (pathCollisionKey(entry.path).split('/')[0] === '.git')
      throw new TypeError('Scientific files cannot overwrite Git metadata.');
  }
  must(
    validateMaterializedTree(
      [...entries, { resourceId: scientificIdentityResourceId, path: scientificIdentityPath }].map(
        (entry) => ({ owner: entry.resourceId, path: entry.path, kind: 'file' })
      )
    )
  );
}

function orderIntents(
  intents: readonly WorkspaceMutation[],
  slots: readonly WorkspaceResourceSlotView[]
): WorkspaceMutation[] {
  const pending = [...intents];
  const occupied = new Map(
    slots
      .filter((slot) => slot.path !== null && !slot.tombstone)
      .map((slot) => [slot.resourceId, slot.path!])
  );
  const result: WorkspaceMutation[] = [];
  while (pending.length) {
    const index = pending.findIndex((mutation) => {
      if (mutation.kind === 'delete-resource' || mutation.kind === 'edit-resource') return true;
      const destination =
        mutation.kind === 'create-resource'
          ? mutation.path
          : mutation.kind === 'edit-and-move-resource' ||
              mutation.kind === 'restore-resource' ||
              mutation.kind === 'restore-and-edit-resource'
            ? mutation.destination
            : null;
      if (!destination) throw new Error('Unexpected compiled scientific intent.');
      return validateMaterializedTree(
        [...occupied]
          .filter(([id]) => id !== mutation.resourceId)
          .map(([owner, path]) => ({ owner, path, kind: 'file' as const }))
          .concat([{ owner: mutation.resourceId, path: destination, kind: 'file' }])
      ).ok;
    });
    if (index < 0)
      throw new TypeError(
        'Scientific path moves form a cycle or collide with another resource; accepted state is unchanged.'
      );
    const [mutation] = pending.splice(index, 1);
    result.push(mutation);
    if (mutation.kind === 'delete-resource') occupied.delete(mutation.resourceId);
    else if (mutation.kind === 'create-resource') occupied.set(mutation.resourceId, mutation.path);
    else if (
      mutation.kind === 'edit-and-move-resource' ||
      mutation.kind === 'restore-resource' ||
      mutation.kind === 'restore-and-edit-resource'
    )
      occupied.set(mutation.resourceId, mutation.destination);
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError('Scientific identity map has missing or unknown fields.');
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
