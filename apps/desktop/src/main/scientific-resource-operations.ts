import {
  createScientificReader,
  type ScientificFileEntry,
  scientificIdentityResourceId,
} from '@waypoint/scientific-objects';
import {
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceVersion,
  defineResourceState,
  defineBlob,
  parseResourceId,
  listWorkspaceResources,
  parseWorkspacePath,
  type BlobHash,
  type RevisionGraph,
  type ResourceId,
  type ResourceRevisionId,
  type WorkspaceMutation,
  type WorkspacePath,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { basename, dirname } from 'node:path';
import { readAcceptedSequencePackage } from './scientific-sequence-package';
import { scientificSequencePackageResourceId } from './scientific-sequence-package';
import { parseNativeStrainRelationships } from './scientific-native-references';
import { parseEntityArtifact } from '../shared/entity-artifact';
import { parsePrimerArtifact, serializePrimerArtifact } from '../shared/primers/primer-artifact';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { nativeRecord, parseNativeJson } from './scientific-native-json';
import type { ScientificObjectStore } from './scientific-object-store';

const atOrUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

export function scientificCopyResourceId(operationId: string, sourceId: string): ResourceId {
  const hash = defineBlob(
    new TextEncoder().encode(JSON.stringify([operationId, sourceId]))
  ).hash.slice('sha256:'.length);
  const id = parseResourceId(`scientific-copy:${hash}`);
  if (!id.ok) throw new Error('Scientific copy identity is invalid.');
  return id.value;
}

export function prepareScientificCopy(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  operationId: string;
  resourceId: ResourceId;
  destinationPath: WorkspacePath;
  copiedAt: string;
  catalogNumber?: string;
}): {
  entries: readonly ScientificFileEntry[];
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
  originals: ReadonlyMap<ResourceId, ResourceRevisionId>;
  observed: ReadonlyMap<WorkspacePath, BlobHash>;
  sourcePath: WorkspacePath;
  sourcePaths: ReadonlySet<WorkspacePath>;
} {
  if (!input.head) throw new Error('Only an enrolled project can copy accepted records.');
  const listed = listWorkspaceResources(input.graph, input.head);
  if (!listed.ok) throw new Error('The accepted copy namespace is unavailable.');
  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const primary = reader.current(input.resourceId);
  const primaryPath = listed.value.find((slot) => slot.resourceId === input.resourceId)?.path;
  if (!primary || !primaryPath)
    throw new Error('The copied identity is not a current primer, sequence or strain.');
  const primaryDocument = primary.document;
  if (
    primaryDocument.kind !== 'primer' &&
    primaryDocument.kind !== 'sequence' &&
    primaryDocument.kind !== 'strain'
  )
    throw new Error('The copied identity is not a current primer, sequence or strain.');
  const packageMetadata =
    primary.representation?.format === 'genbank-v1'
      ? readAcceptedSequencePackage({
          store: input.store,
          graph: input.graph,
          head: input.head,
          sequenceId: input.resourceId,
          productPath: primaryPath,
          productText: primary.representation.text,
        })
      : null;
  const sourcePath = packageMetadata
    ? parseWorkspacePath(dirname(primaryPath))
    : { ok: true as const, value: primaryPath };
  if (!sourcePath.ok) throw new Error('The copied package root is invalid.');
  if (atOrUnder(input.destinationPath, sourcePath.value))
    throw new Error('A record cannot be copied inside itself.');
  const newId = scientificCopyResourceId(input.operationId, input.resourceId);
  const originals = new Map<ResourceId, ResourceRevisionId>([[newId, primary.revisionId]]);
  const observed = new Map<WorkspacePath, BlobHash>();
  const sourcePaths = new Set<WorkspacePath>();
  const entries: ScientificFileEntry[] = [];
  const mutations: WorkspaceMutation[] = [];
  const blobs: Uint8Array[] = [];
  const destination = (path: WorkspacePath): WorkspacePath => {
    const result = parseWorkspacePath(
      `${input.destinationPath}${path.slice(sourcePath.value.length)}`
    );
    if (!result.ok) throw new Error('Copied native member destination is invalid.');
    return result.value;
  };
  for (const slot of listed.value) {
    if (slot.tombstone || !slot.path || slot.resourceId === scientificIdentityResourceId) continue;
    const snapshot = reader.current(slot.resourceId);
    if (snapshot)
      entries.push({
        resourceId: slot.resourceId,
        path: slot.path,
        ...(snapshot.representation
          ? { representation: snapshot.representation }
          : { document: snapshot.document }),
      });
    if (!atOrUnder(slot.path, sourcePath.value)) continue;
    const revision = inspectResourceRevision(input.graph, slot.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(input.graph, revision.value.stateHash)
        : null;
    if (!state?.ok || state.value.layout !== 'file')
      throw new Error('Copied native member state is unavailable.');
    observed.set(slot.path, state.value.blob.hash);
    sourcePaths.add(slot.path);
    if (slot.resourceId === input.resourceId) continue;
    if (snapshot)
      throw new Error('Duplicate one scientific record or native sequence package at a time.');
    const id =
      slot.resourceId === packageMetadata?.resourceId
        ? scientificSequencePackageResourceId(newId)
        : scientificCopyResourceId(input.operationId, slot.resourceId);
    let bytes = input.store.readBlob(state.value.blob);
    if (!bytes) throw new Error('Copied native member bytes are unavailable.');
    if (slot.resourceId === packageMetadata?.resourceId) {
      const raw = JSON.parse(packageMetadata.text);
      raw.id = newId;
      raw.name = basename(input.destinationPath);
      raw.copySource = {
        resourceId: input.resourceId,
        revisionId: primary.revisionId,
        copiedAt: input.copiedAt,
      };
      bytes = new TextEncoder().encode(`${JSON.stringify(raw, null, 2)}\n`);
    }
    const copiedState = defineResourceState({ ...state.value, blob: defineBlob(bytes) });
    if (!copiedState.ok) throw new Error('Copied native member state is invalid.');
    mutations.push({
      kind: 'create-resource',
      resourceId: id,
      path: destination(slot.path),
      state: copiedState.value,
      origin: { kind: 'derived', relation: 'copy', sources: [slot.revisionId] },
    });
    blobs.push(bytes);
  }
  const provenance = {
    resourceId: input.resourceId,
    revisionId: primary.revisionId,
    copiedAt: input.copiedAt,
  };
  if (primary.representation?.format === 'primer-v2') {
    const artifact = parsePrimerArtifact(primary.representation.text);
    if (!input.catalogNumber || input.catalogNumber === artifact.catalogNumber)
      throw new Error('A copied native primer requires a new catalog number.');
    artifact.id = newId;
    artifact.registry.entityId = newId;
    artifact.name += ' copy';
    artifact.catalogNumber = input.catalogNumber;
    artifact.artifactRevision = 1;
    artifact.metadata.createdAt = input.copiedAt;
    artifact.metadata.updatedAt = input.copiedAt;
    artifact.file.workspaceRelativePath = input.destinationPath;
    Object.assign(artifact, { copySource: provenance });
    for (const binding of artifact.bindings) {
      const oldId = binding.id;
      const parsed = parseResourceId(oldId);
      const old = parsed.ok ? reader.current(parsed.value) : null;
      if (old?.document.kind !== 'primer-binding')
        throw new Error('Copied primer binding history is unavailable.');
      const id = scientificCopyResourceId(input.operationId, oldId);
      binding.id = id;
      originals.set(id, old.revisionId);
      entries.push({
        resourceId: id,
        path: parseRelationshipPath(id),
        document: { ...old.document, primerId: newId },
      });
    }
    entries.push({
      resourceId: newId,
      path: input.destinationPath,
      representation: { format: 'primer-v2', text: serializePrimerArtifact(artifact) },
    });
  } else if (primary.representation?.format === 'strain-entity-v1') {
    const artifact = parseEntityArtifact(primary.representation.text);
    const raw = parseNativeJson(primary.representation.text);
    const source = nativeRecord(raw.source);
    const originalClaims = parseNativeStrainRelationships(primary.representation.text);
    const text = `${JSON.stringify(
      {
        ...raw,
        id: newId,
        name: `${artifact.name} copy`,
        source: { ...source, values: { ...nativeRecord(source.values), copySource: provenance } },
        relationships: artifact.relationships.map((link, index) => ({
          ...nativeRecord(Array.isArray(raw.relationships) ? raw.relationships[index] : undefined),
          fromEntityId: link.fromEntityId === input.resourceId ? newId : link.fromEntityId,
          toEntityId: link.toEntityId === input.resourceId ? newId : link.toEntityId,
        })),
      },
      null,
      2
    )}\n`;
    const claims = parseNativeStrainRelationships(text);
    for (let index = 0; index < claims.length; index++) {
      const original = reader.current(originalClaims[index].resourceId);
      if (
        !original ||
        (original.document.kind !== 'strain-sequence' &&
          original.document.kind !== 'strain-descent')
      )
        throw new Error('Copied strain relationship history is unavailable.');
      originals.set(claims[index].resourceId, original.revisionId);
      entries.push({
        resourceId: claims[index].resourceId,
        path: parseRelationshipPath(claims[index].resourceId),
        document: { ...original.document, strainId: newId, fields: claims[index].fields },
      });
    }
    entries.push({
      resourceId: newId,
      path: input.destinationPath,
      representation: { format: 'strain-entity-v1', text },
    });
  } else if (primary.representation) {
    entries.push({
      resourceId: newId,
      path: destination(primaryPath),
      representation: primary.representation,
    });
  } else {
    entries.push({
      resourceId: newId,
      path: input.destinationPath,
      document: {
        ...primaryDocument,
        name: `${primaryDocument.name} copy`,
        fields: { ...primaryDocument.fields, copySource: provenance },
      },
    });
  }
  return {
    entries,
    mutations,
    blobs,
    originals,
    observed,
    sourcePath: sourcePath.value,
    sourcePaths,
  };
}

function parseRelationshipPath(id: ResourceId): WorkspacePath {
  const hash = defineBlob(new TextEncoder().encode(id)).hash.slice('sha256:'.length);
  const path = parseWorkspacePath(`.dnaforge/relationships/${hash}.json`);
  if (!path.ok) throw new Error('Copied relationship path is invalid.');
  return path.value;
}

export function prepareScientificDeletion(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  sourcePath: WorkspacePath;
}): {
  sourcePath: WorkspacePath;
  entries: readonly ScientificFileEntry[];
  mutations: readonly WorkspaceMutation[];
  observed: ReadonlyMap<WorkspacePath, BlobHash>;
  removedPaths: ReadonlySet<WorkspacePath>;
} {
  if (!input.head) throw new Error('Only an enrolled project can remove accepted records.');
  const listed = listWorkspaceResources(input.graph, input.head);
  if (!listed.ok) throw new Error('The accepted namespace is unavailable.');
  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const removedIds = new Set<ResourceId>();
  for (const slot of listed.value) {
    if (slot.tombstone || !slot.path || !atOrUnder(slot.path, input.sourcePath)) continue;
    const snapshot = reader.current(slot.resourceId);
    if (
      slot.resourceId === scientificIdentityResourceId ||
      snapshot?.document.kind === 'accepted-assembly'
    )
      throw new Error('Accepted identity and assembly history cannot be deleted.');
    removedIds.add(slot.resourceId);
  }
  if (
    ![...removedIds].some((id) =>
      ['primer', 'sequence', 'strain'].includes(reader.current(id)?.document.kind ?? '')
    )
  )
    throw new Error('No accepted primer, sequence or strain belongs to the removed path.');
  for (const snapshot of reader.listCurrent()) {
    const document = snapshot.document;
    if (
      (document.kind === 'primer-binding' && removedIds.has(document.primerId)) ||
      ((document.kind === 'strain-sequence' || document.kind === 'strain-descent') &&
        removedIds.has(document.strainId))
    )
      removedIds.add(snapshot.resourceId);
  }
  const entries: ScientificFileEntry[] = [];
  const mutations: WorkspaceMutation[] = [];
  const observed = new Map<WorkspacePath, BlobHash>();
  const removedPaths = new Set<WorkspacePath>();
  for (const slot of listed.value) {
    if (slot.tombstone || !slot.path || slot.resourceId === scientificIdentityResourceId) continue;
    const snapshot = reader.current(slot.resourceId);
    if (removedIds.has(slot.resourceId)) {
      const revision = inspectResourceRevision(input.graph, slot.revisionId);
      const state =
        revision.ok && revision.value.stateHash
          ? inspectResourceState(input.graph, revision.value.stateHash)
          : null;
      if (!state?.ok || state.value.layout !== 'file')
        throw new Error('Removed accepted file state is unavailable.');
      observed.set(slot.path, state.value.blob.hash);
      removedPaths.add(slot.path);
      if (!snapshot)
        mutations.push({
          kind: 'delete-resource',
          resourceId: slot.resourceId,
          expectedRevision: slot.revisionId,
          expectedPath: slot.path,
        });
    } else if (snapshot)
      entries.push({
        resourceId: slot.resourceId,
        path: slot.path,
        ...(snapshot.representation
          ? { representation: snapshot.representation }
          : { document: snapshot.document }),
      });
  }
  return { sourcePath: input.sourcePath, entries, mutations, observed, removedPaths };
}

export function prepareScientificReversion(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  resourceId: ResourceId;
}): {
  deletion: ReturnType<typeof prepareScientificDeletion> | null;
  restoration: ReturnType<typeof prepareScientificRestoration> | null;
} {
  if (!input.head) throw new Error('Only an enrolled project can revert accepted history.');
  const current = listWorkspaceResources(input.graph, input.head);
  const version = inspectWorkspaceVersion(input.graph, input.head);
  if (!current.ok || !version.ok) throw new Error('The accepted record history is unavailable.');
  const slot = current.value.find((entry) => entry.resourceId === input.resourceId);
  if (!slot) throw new Error('The reverted record is not owned by this project.');
  const pending = [...version.value.parentIds];
  const visited = new Set<WorkspaceVersionId>();
  let prior = input.head;
  let removed = false;
  for (let index = 0; index < pending.length; index++) {
    const head = pending[index];
    if (visited.has(head)) continue;
    visited.add(head);
    const resources = listWorkspaceResources(input.graph, head);
    const historical = inspectWorkspaceVersion(input.graph, head);
    if (!resources.ok || !historical.ok)
      throw new Error('The accepted record ancestry is unavailable.');
    const previous = resources.value.find((entry) => entry.resourceId === input.resourceId);
    if (previous && (previous.revisionId !== slot.revisionId || previous.path !== slot.path)) {
      prior = head;
      removed = previous.tombstone;
      break;
    }
    pending.push(...historical.value.parentIds);
  }
  if (removed) {
    if (!slot.path || slot.tombstone)
      throw new Error('The current reverted record is unavailable.');
    const reader = createScientificReader({
      graph: input.graph,
      head: input.head,
      readBlob: (blob) => input.store.readBlob(blob),
      codecs: scientificNativeCodecs,
    });
    const snapshot = reader.current(input.resourceId);
    const managed =
      snapshot?.representation?.format === 'genbank-v1' &&
      readAcceptedSequencePackage({
        store: input.store,
        graph: input.graph,
        head: input.head,
        sequenceId: input.resourceId,
        productPath: slot.path,
        productText: snapshot.representation.text,
      });
    const path = managed
      ? parseWorkspacePath(dirname(slot.path))
      : { ok: true as const, value: slot.path };
    if (!path.ok) throw new Error('The reverted package root is invalid.');
    return {
      deletion: prepareScientificDeletion({ ...input, sourcePath: path.value }),
      restoration: null,
    };
  }
  return {
    deletion: null,
    restoration: prepareScientificRestoration({ ...input, version: prior }),
  };
}

export function prepareScientificRestoration(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  version?: WorkspaceVersionId;
  resourceId?: ResourceId;
}): {
  entries: readonly ScientificFileEntry[];
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
  restores: ReadonlyMap<ResourceId, ResourceRevisionId>;
  observed: ReadonlyMap<WorkspacePath, BlobHash>;
  paths: readonly WorkspacePath[];
} {
  if (!input.head) throw new Error('Only an enrolled project can restore accepted history.');
  const current = listWorkspaceResources(input.graph, input.head);
  if (!current.ok) throw new Error('The current accepted workspace is unavailable.');
  let version = input.version;
  if (input.resourceId && !version) {
    const slot = current.value.find((candidate) => candidate.resourceId === input.resourceId);
    if (!slot?.tombstone) throw new Error('Only a removed scientific identity can be restored.');
    const pending = [input.head];
    const visited = new Set<WorkspaceVersionId>();
    for (let index = 0; index < pending.length; index++) {
      const head = pending[index];
      if (visited.has(head)) continue;
      visited.add(head);
      const resources = listWorkspaceResources(input.graph, head);
      if (!resources.ok) throw new Error('The accepted restoration ancestry is unavailable.');
      if (
        resources.value.some(
          (candidate) =>
            candidate.resourceId === input.resourceId && !candidate.tombstone && candidate.path
        )
      ) {
        version = head;
        break;
      }
      const found = inspectWorkspaceVersion(input.graph, head);
      if (!found.ok) throw new Error('The accepted restoration ancestry is unavailable.');
      pending.push(...found.value.parentIds);
    }
  }
  if (!version) throw new Error('No live accepted history exists for the requested restoration.');
  const selected = listWorkspaceResources(input.graph, version);
  if (!selected.ok || !current.ok)
    throw new Error('The selected accepted workspace is unavailable.');
  const reader = createScientificReader({
    graph: input.graph,
    head: version,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const before = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const selectedIds = new Set<ResourceId>();
  if (input.resourceId) {
    selectedIds.add(input.resourceId);
    const primary = reader.current(input.resourceId);
    const path = selected.value.find((slot) => slot.resourceId === input.resourceId)?.path;
    if (!primary || !path || !['primer', 'sequence', 'strain'].includes(primary.document.kind))
      throw new Error('The restored identity is not a primer, sequence or strain.');
    const packageRoot =
      primary.representation?.format === 'genbank-v1' &&
      readAcceptedSequencePackage({
        store: input.store,
        graph: input.graph,
        head: version,
        sequenceId: input.resourceId,
        productPath: path,
        productText: primary.representation.text,

        verifyProductChecksum: false,
      })
        ? dirname(path)
        : null;
    for (const slot of selected.value) {
      if (slot.tombstone || !slot.path) continue;
      const document = reader.current(slot.resourceId)?.document;
      if (
        (packageRoot && packageRoot !== '.' && atOrUnder(slot.path, packageRoot)) ||
        (document?.kind === 'primer-binding' && document.primerId === input.resourceId) ||
        ((document?.kind === 'strain-descent' || document?.kind === 'strain-sequence') &&
          document.strainId === input.resourceId)
      )
        selectedIds.add(slot.resourceId);
    }
  }
  const live = new Map(
    (input.resourceId ? current.value : selected.value)
      .filter((slot) => !slot.tombstone && slot.path)
      .map((slot) => [slot.resourceId, slot])
  );
  if (input.resourceId)
    for (const slot of current.value) {
      const document = before.current(slot.resourceId)?.document;
      if (
        (document?.kind === 'primer-binding' && document.primerId === input.resourceId) ||
        ((document?.kind === 'strain-descent' || document?.kind === 'strain-sequence') &&
          document.strainId === input.resourceId)
      )
        live.delete(slot.resourceId);
    }
  if (input.resourceId)
    for (const slot of selected.value)
      if (selectedIds.has(slot.resourceId) && !slot.tombstone && slot.path)
        live.set(slot.resourceId, slot);

  for (const slot of current.value)
    if (
      !slot.tombstone &&
      slot.path &&
      before.current(slot.resourceId)?.document.kind === 'accepted-assembly'
    )
      live.set(slot.resourceId, slot);
  const old = new Map(current.value.map((slot) => [slot.resourceId, slot]));
  const entries: ScientificFileEntry[] = [];
  const mutations: WorkspaceMutation[] = [];
  const blobs: Uint8Array[] = [];
  const restores = new Map<ResourceId, ResourceRevisionId>();
  const observed = new Map<WorkspacePath, BlobHash>();
  for (const slot of current.value) {
    if (slot.tombstone || !slot.path || slot.resourceId === scientificIdentityResourceId) continue;
    const target = live.get(slot.resourceId);
    if (target?.revisionId === slot.revisionId && target.path === slot.path) continue;
    const revision = inspectResourceRevision(input.graph, slot.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(input.graph, revision.value.stateHash)
        : null;
    if (!state?.ok || state.value.layout !== 'file')
      throw new Error('Accepted restore input has no file state.');
    observed.set(slot.path, state.value.blob.hash);
    if (!target && !state.value.resourceKind.startsWith('dnaforge.scientific.'))
      mutations.push({
        kind: 'delete-resource',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: slot.path,
      });
  }
  for (const slot of live.values()) {
    if (slot.resourceId === scientificIdentityResourceId || !slot.path) continue;
    const previous = old.get(slot.resourceId);
    if (!previous) throw new Error('Accepted history identity is absent from the current graph.');
    const snapshot = reader.revision(slot);
    if (snapshot) {
      entries.push({
        resourceId: slot.resourceId,
        path: slot.path,
        ...(snapshot.representation
          ? { representation: snapshot.representation }
          : { document: snapshot.document }),
      });
      if (previous.tombstone) restores.set(slot.resourceId, slot.revisionId);
      continue;
    }
    const revision = inspectResourceRevision(input.graph, slot.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(input.graph, revision.value.stateHash)
        : null;
    if (!state?.ok || state.value.layout !== 'file')
      throw new Error('Accepted package history is unavailable.');
    let projected = state.value;
    if (state.value.resourceKind === 'dnaforge.sequence-package.v6') {
      const rawBytes = input.store.readBlob(state.value.blob);
      if (!rawBytes) throw new Error('Historical sequence package bytes are unavailable.');
      const raw = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
      const id = typeof raw.id === 'string' ? parseResourceId(raw.id) : null;
      const primary = id?.ok ? reader.current(id.value) : null;
      const product = nativeRecord(raw.product);
      if (
        !primary ||
        primary.document.kind !== 'sequence' ||
        primary.representation?.format !== 'genbank-v1'
      )
        throw new Error('Historical sequence package scientific owner is unavailable.');
      const expected = defineBlob(new TextEncoder().encode(primary.representation.text)).hash;
      if (product.genBankChecksum !== expected) {
        const bytes = new TextEncoder().encode(
          `${JSON.stringify(
            { ...raw, product: { ...product, genBankChecksum: expected } },
            null,
            2
          )}\n`
        );
        blobs.push(bytes);
        projected = { ...state.value, blob: defineBlob(bytes) };
      }
    }
    const defined = defineResourceState(projected);
    if (!defined.ok) throw new Error('Accepted package state is invalid.');
    if (previous.tombstone) {
      const restoration = {
        resourceId: slot.resourceId,
        expectedTombstoneRevision: previous.revisionId,
        restoreFromRevision: slot.revisionId,
        destination: slot.path,
      };
      mutations.push(
        projected === state.value
          ? { kind: 'restore-resource', ...restoration }
          : { kind: 'restore-and-edit-resource', ...restoration, state: defined.value }
      );
    } else if (previous.path === slot.path)
      mutations.push({
        kind: 'edit-resource',
        resourceId: slot.resourceId,
        expectedRevision: previous.revisionId,
        state: defined.value,
      });
    else if (previous.path)
      mutations.push({
        kind: 'edit-and-move-resource',
        resourceId: slot.resourceId,
        expectedRevision: previous.revisionId,
        expectedPath: previous.path,
        destination: slot.path,
        state: defined.value,
      });
    else throw new Error('Accepted package locator is unavailable.');
  }

  mutations.sort(
    (a, b) => Number(b.kind === 'delete-resource') - Number(a.kind === 'delete-resource')
  );
  return {
    entries,
    mutations,
    blobs,
    restores,
    observed,
    paths: [...live.values()].flatMap((slot) => (slot.path ? [slot.path] : [])),
  };
}

export function prepareScientificRelocation(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  sourcePath: WorkspacePath;
  destinationPath: WorkspacePath;
}): {
  entries: readonly ScientificFileEntry[];
  mutations: readonly WorkspaceMutation[];
  observed: ReadonlyMap<WorkspacePath, BlobHash>;
  movedPaths: ReadonlySet<WorkspacePath>;
} {
  if (!input.head) throw new Error('Only an enrolled project can move accepted records.');
  if (atOrUnder(input.destinationPath, input.sourcePath))
    throw new Error('An accepted record cannot be moved inside itself.');
  const listed = listWorkspaceResources(input.graph, input.head);
  if (!listed.ok) throw new Error('The accepted namespace is unavailable.');
  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const rebase = (path: string): string =>
    atOrUnder(path, input.sourcePath)
      ? `${input.destinationPath}${path.slice(input.sourcePath.length)}`
      : path;
  const entries: ScientificFileEntry[] = [];
  const mutations: WorkspaceMutation[] = [];
  const observed = new Map<WorkspacePath, BlobHash>();
  const movedPaths = new Set<WorkspacePath>();
  let movedScientificRecord = false;
  for (const slot of listed.value) {
    if (slot.tombstone || !slot.path) continue;
    if (slot.resourceId === scientificIdentityResourceId) {
      if (atOrUnder(slot.path, input.sourcePath))
        throw new Error('The accepted identity map cannot be moved.');
      continue;
    }
    const revision = inspectResourceRevision(input.graph, slot.revisionId);
    if (!revision.ok || !revision.value.stateHash)
      throw new Error('The accepted record has no live state.');
    const state = inspectResourceState(input.graph, revision.value.stateHash);
    if (!state.ok || state.value.layout !== 'file')
      throw new Error('The accepted record has no file representation.');
    const destination = parseWorkspacePath(rebase(slot.path));
    if (!destination.ok) throw new Error('The record destination is invalid.');
    const moved = destination.value !== slot.path;
    if (moved) {
      observed.set(slot.path, state.value.blob.hash);
      movedPaths.add(slot.path);
    }
    if (!state.value.resourceKind.startsWith('dnaforge.scientific.')) {
      if (moved)
        mutations.push({
          kind: 'move-resource',
          resourceId: slot.resourceId,
          expectedPath: slot.path,
          destination: destination.value,
        });
      continue;
    }
    const snapshot = reader.current(slot.resourceId);
    if (!snapshot) throw new Error('The accepted scientific record is unavailable.');
    let representation = snapshot.representation;
    if (representation?.format === 'primer-v2') {
      const artifact = parsePrimerArtifact(representation.text);
      let changed = false;
      const self = artifact.file?.workspaceRelativePath;
      if (self && rebase(self) !== self) {
        artifact.file!.workspaceRelativePath = rebase(self);
        changed = true;
      }
      for (const binding of artifact.bindings) {
        const target = binding.target.legacyWorkspaceRelativePath;
        if (target && rebase(target) !== target) {
          binding.target.legacyWorkspaceRelativePath = rebase(target);
          changed = true;
        }
      }
      if (changed) {
        artifact.artifactRevision += 1;
        representation = { format: 'primer-v2', text: serializePrimerArtifact(artifact) };
        observed.set(slot.path, state.value.blob.hash);
      }
    }
    entries.push({
      resourceId: slot.resourceId,
      path: destination.value,
      ...(representation ? { representation } : { document: snapshot.document }),
    });
    if (moved && ['primer', 'sequence', 'strain'].includes(snapshot.document.kind))
      movedScientificRecord = true;
  }
  if (!movedScientificRecord)
    throw new Error('No accepted primer, sequence or strain belongs to the moved path.');
  return { entries, mutations, observed, movedPaths };
}
