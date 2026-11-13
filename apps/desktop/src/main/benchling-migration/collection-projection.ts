import { createHash } from 'node:crypto';
import type {
  BenchlingSourceRef,
  MigrationScope,
  RelationshipResolution,
  SourceObject,
} from '../../shared/benchling-migration';
import {
  isLocalExportFolderSourceRef,
  isLocalExportNamespaceUrl,
  localExportNamespacedUrl,
} from '../../shared/benchling-migration';
import {
  benchlingOrganizationBaseUrlFromSourceUrl,
  isUrlWithinBenchlingOrganization,
} from './source-identity';
import { exactRelationshipResolutionCaptureConflict } from './relationship-resolver';
import type { WorkspaceAppendHierarchyCapture } from './workspace-append-hierarchy-capture';

export const NATIVE_COLLECTION_SCHEMA = 'dnaforge.collection.v1' as const;
export const COLLECTION_PROJECTION_SCHEMA = 'dnaforge.collection-projection.v1' as const;

export type ScopedFolderMetadata = {
  ref: BenchlingSourceRef;
  name: string;
  parentFolderId: string | null;
  childrenEnumerated: boolean;
  sourceAccountHash: string;
};

export type ExcludedSourceFolder = {
  sourceFolderId: string;
  name: string;
  sourceUrl: string;
  reason: 'non_recursive_scope';
};

export type NativeCollectionDocument = {
  schema: typeof NATIVE_COLLECTION_SCHEMA;
  kind: 'collection';
  id: string;
  title: string;
  editable: true;
  parentCollectionId: string | null;
  childCollectionIds: string[];
  memberObjectIds: string[];
  excludedChildFolders: ExcludedSourceFolder[];
  provenance: {
    immutableSource: true;
    provider: 'benchling';
    sourceAccountHash: string;
    sourceFolderId: string;
    sourceUrl: string;
    sourceParentFolderId: string | null;
    selectedRoot: boolean;
    capturedAt: string;
  };
};

export type CanonicalObjectMembership = {
  sourceObjectId: string;
  destinationObjectId: string;
  sourceMembershipIds: string[];
  destinationCollectionIds: string[];
  omittedSourceMembershipIds: string[];
  scopeRole: 'selected' | 'one_hop_dependency';
};

export type CollectionProjection = {
  schema: typeof COLLECTION_PROJECTION_SCHEMA;
  scopeKind: MigrationScope['kind'];
  sourceAccountHash: string;
  selectedRootSourceIds: string[];
  selectedSourceObjectIds: string[];
  oneHopDependencySourceObjectIds: string[];
  collections: NativeCollectionDocument[];
  objectMemberships: CanonicalObjectMembership[];
  nativeFolderPaths?: Readonly<Record<string, string>>;
};

export type BuildCollectionProjectionInput = {
  scope: MigrationScope;
  sourceAccountHash: string;
  capturedAt: string;
  folders: readonly ScopedFolderMetadata[];
  workspaceAppendHierarchyCaptures?: readonly WorkspaceAppendHierarchyCapture[];
  materializedSourceIds?: ReadonlySet<string>;
  sourceObjects: readonly SourceObject[];
  relationshipResolutions?: readonly RelationshipResolution[];
  selectedSnapshotStableIdsAreAuthoritative?: boolean;
  relationshipBenchlingOrigin?: string;
  destinationCollectionIds: Readonly<Record<string, string>>;
  destinationObjectIds: Readonly<Record<string, string>>;
};

export type MergedWorkspaceAppendFolderAuthority = Readonly<{
  folders: readonly ScopedFolderMetadata[];
  appendedFolderIds: ReadonlySet<string>;
}>;

export function mergeWorkspaceAppendFolderAuthority(input: {
  scope: MigrationScope;
  sourceAccountHash: string;
  scopedFolders: readonly ScopedFolderMetadata[];
  captures: readonly WorkspaceAppendHierarchyCapture[];
}): MergedWorkspaceAppendFolderAuthority {
  if (input.scope.kind === 'file') {
    if (input.captures.length > 0) {
      throw new Error('File scope cannot accept appended folder hierarchy authority.');
    }
    return { folders: [...input.scopedFolders], appendedFolderIds: new Set() };
  }
  const roots = input.scope.kind === 'folder' ? [input.scope.folder] : input.scope.roots;
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const folderById = new Map(input.scopedFolders.map((folder) => [folder.ref.id, folder]));
  const appendedFolderIds = new Set<string>();
  for (const capture of [...input.captures].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId)
  )) {
    const root = rootById.get(capture.destinationRootSourceId);
    if (!root) {
      throw new Error(
        `Workspace append hierarchy ${capture.id} targets a root outside the original scope.`
      );
    }
    for (const appended of capture.folders) {
      const candidate: ScopedFolderMetadata = {
        ref: {
          id: appended.sourceId,
          url: appendedFolderSourceUrl(root, appended.sourceId),
          objectType: 'folder',
        },
        name: appended.name,
        parentFolderId: appended.parentSourceId,
        childrenEnumerated: true,
        sourceAccountHash: input.sourceAccountHash,
      };
      const existing = folderById.get(candidate.ref.id);
      if (
        existing &&
        (existing.name !== candidate.name ||
          existing.parentFolderId !== candidate.parentFolderId ||
          existing.sourceAccountHash !== candidate.sourceAccountHash)
      ) {
        throw new Error(
          `Workspace append folder ${candidate.ref.id} conflicts with persisted folder authority.`
        );
      }
      if (!existing) folderById.set(candidate.ref.id, candidate);
      appendedFolderIds.add(candidate.ref.id);
    }
  }

  for (const folderId of appendedFolderIds) {
    let current = folderById.get(folderId);
    const visited = new Set<string>();
    while (current && !rootById.has(current.ref.id)) {
      if (visited.has(current.ref.id)) {
        throw new Error(`Workspace append folder hierarchy cycles at ${current.ref.id}.`);
      }
      visited.add(current.ref.id);
      current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
    }
    if (!current || !rootById.has(current.ref.id)) {
      throw new Error(`Workspace append folder ${folderId} is orphaned from its destination root.`);
    }
  }
  return {
    folders: [...folderById.values()].sort((left, right) =>
      left.ref.id.localeCompare(right.ref.id)
    ),
    appendedFolderIds,
  };
}

export function buildCollectionProjection(
  input: BuildCollectionProjectionInput
): CollectionProjection {
  const accountHash = requireText(input.sourceAccountHash, 'Source account hash');
  const capturedAt = requireTimestamp(input.capturedAt, 'Collection capture timestamp');
  const scopeRefs = refsForScope(input.scope);
  const folderAuthority = mergeWorkspaceAppendFolderAuthority({
    scope: input.scope,
    sourceAccountHash: accountHash,
    scopedFolders: input.folders,
    captures: input.workspaceAppendHierarchyCaptures ?? [],
  });
  const sourceOrigin = requireSingleSourceOrigin(scopeRefs, [
    ...folderAuthority.folders.map((folder) => folder.ref.url),
    ...input.sourceObjects.map((object) => object.sourceUrl),
  ]);
  const folders = indexFolders(folderAuthority.folders, accountHash, sourceOrigin);
  const selectedRootIds = scopeRefsForCollections(input.scope)
    .map((ref) => ref.id)
    .sort();

  assertFolderGraphAcyclic(folders);
  const { includedFolderIds, excludedChildrenByParent } = classifyFolders(
    input.scope,
    folders,
    new Set(input.folders.map((folder) => folder.ref.id)),
    folderAuthority.appendedFolderIds
  );
  assertScopeRefsMatchFolders(input.scope, folders);
  const objects = indexSourceObjects(input.sourceObjects, sourceOrigin);
  const { selectedObjectIds, dependencyObjectIds } = classifySourceObjects(
    input.scope,
    includedFolderIds,
    objects,
    input.relationshipResolutions,
    input.relationshipBenchlingOrigin ?? sourceOrigin,
    input.selectedSnapshotStableIdsAreAuthoritative,
    input.materializedSourceIds
  );

  const destinationCollectionIds = validateDestinationIds(
    input.destinationCollectionIds,
    includedFolderIds,
    'collection'
  );
  const destinationObjectIds = validateDestinationIds(
    input.destinationObjectIds,
    new Set(objects.keys()),
    'object'
  );
  assertDestinationDomainsDoNotOverlap(destinationCollectionIds, destinationObjectIds);

  const membersByFolder = new Map<string, Set<string>>();
  const objectMemberships = [...objects.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((sourceObject): CanonicalObjectMembership => {
      const sourceMembershipIds = sortedUnique(sourceObject.memberships);
      const selectedMembershipIds = sourceMembershipIds.filter((id) => includedFolderIds.has(id));
      const destinationMembershipIds = selectedMembershipIds
        .map((id) => requiredDestination(destinationCollectionIds, id, 'collection'))
        .sort();
      const destinationObjectId = requiredDestination(
        destinationObjectIds,
        sourceObject.id,
        'object'
      );

      for (const folderId of selectedMembershipIds) {
        const members = membersByFolder.get(folderId) ?? new Set<string>();
        members.add(destinationObjectId);
        membersByFolder.set(folderId, members);
      }

      return {
        sourceObjectId: sourceObject.id,
        destinationObjectId,
        sourceMembershipIds,
        destinationCollectionIds: destinationMembershipIds,
        omittedSourceMembershipIds: sourceMembershipIds.filter((id) => !includedFolderIds.has(id)),
        scopeRole: selectedObjectIds.has(sourceObject.id) ? 'selected' : 'one_hop_dependency',
      };
    });

  const collections = [...includedFolderIds]
    .sort()
    .map((sourceFolderId): NativeCollectionDocument => {
      const folder = requireFolder(folders, sourceFolderId);
      const parentCollectionId =
        folder.parentFolderId && includedFolderIds.has(folder.parentFolderId)
          ? requiredDestination(destinationCollectionIds, folder.parentFolderId, 'collection')
          : null;
      const childCollectionIds = [...folders.values()]
        .filter(
          (candidate) =>
            candidate.parentFolderId === sourceFolderId && includedFolderIds.has(candidate.ref.id)
        )
        .map((candidate) =>
          requiredDestination(destinationCollectionIds, candidate.ref.id, 'collection')
        )
        .sort();
      const excludedChildFolders = (excludedChildrenByParent.get(sourceFolderId) ?? [])
        .map(
          (child): ExcludedSourceFolder => ({
            sourceFolderId: child.ref.id,
            name: child.name,
            sourceUrl: child.ref.url,
            reason: 'non_recursive_scope',
          })
        )
        .sort((left, right) => left.sourceFolderId.localeCompare(right.sourceFolderId));

      return {
        schema: NATIVE_COLLECTION_SCHEMA,
        kind: 'collection',
        id: requiredDestination(destinationCollectionIds, sourceFolderId, 'collection'),
        title: folder.name,
        editable: true,
        parentCollectionId,
        childCollectionIds,
        memberObjectIds: [...(membersByFolder.get(sourceFolderId) ?? [])].sort(),
        excludedChildFolders,
        provenance: {
          immutableSource: true,
          provider: 'benchling',
          sourceAccountHash: accountHash,
          sourceFolderId,
          sourceUrl: folder.ref.url,
          sourceParentFolderId: folder.parentFolderId,
          selectedRoot: selectedRootIds.includes(sourceFolderId),
          capturedAt,
        },
      };
    });

  return {
    schema: COLLECTION_PROJECTION_SCHEMA,
    scopeKind: input.scope.kind,
    sourceAccountHash: accountHash,
    selectedRootSourceIds: selectedRootIds,
    selectedSourceObjectIds: [...selectedObjectIds].sort(),
    oneHopDependencySourceObjectIds: [...dependencyObjectIds].sort(),
    collections,
    objectMemberships,
  };
}

export function serializeCollectionProjection(projection: CollectionProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

export function collectionDestinationId(sourceFolderId: string): string {
  const sourceId = requireText(sourceFolderId, 'Source folder ID');
  const digest = createHash('sha256').update(sourceId).digest('hex').slice(0, 24);
  return `folder-${digest}`;
}

export type AssertScopedFolderBoundaryInput = {
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
  capturedAt: string;
  folders: readonly ScopedFolderMetadata[];
};

export function assertScopedFolderBoundary(input: AssertScopedFolderBoundaryInput): void {
  const includedFolderIds =
    input.scope.kind === 'folder'
      ? [input.scope.folder.id]
      : input.folders.map((folder) => folder.ref.id);
  void buildCollectionProjection({
    ...input,
    sourceObjects: [],
    destinationCollectionIds: Object.fromEntries(
      includedFolderIds.map((sourceFolderId) => [
        sourceFolderId,
        collectionDestinationId(sourceFolderId),
      ])
    ),
    destinationObjectIds: {},
  });
}

function refsForScope(scope: MigrationScope): BenchlingSourceRef[] {
  if (scope.kind === 'file') return [scope.source];
  if (scope.kind === 'folder') return [scope.folder];
  const ids = new Set<string>();
  return scope.roots.map((root) => {
    const id = requireText(root.id, 'Selected root ID');
    if (ids.has(id)) throw new Error(`Selected root ${id} is duplicated.`);
    ids.add(id);
    return root;
  });
}

function scopeRefsForCollections(scope: MigrationScope): BenchlingSourceRef[] {
  return scope.kind === 'file' ? [] : refsForScope(scope);
}

function indexFolders(
  folderList: readonly ScopedFolderMetadata[],
  accountHash: string,
  sourceOrigin: string
): Map<string, ScopedFolderMetadata> {
  const folders = new Map<string, ScopedFolderMetadata>();
  for (const candidate of folderList) {
    const id = requireText(candidate.ref.id, 'Source folder ID');
    if (folders.has(id)) throw new Error(`Source folder ${id} is duplicated.`);
    if (
      requireText(candidate.sourceAccountHash, `Source folder ${id} account hash`) !== accountHash
    ) {
      throw new Error(`Source folder ${id} belongs to a different source account.`);
    }
    const ref = {
      ...candidate.ref,
      id,
      url: requireSourceUrl(candidate.ref.url, sourceOrigin, `Source folder ${id}`),
    };
    folders.set(id, {
      ...candidate,
      ref,
      name: requireText(candidate.name, `Source folder ${id} name`),
      parentFolderId: optionalText(candidate.parentFolderId, `Source folder ${id} parent ID`),
    });
  }
  return folders;
}

function indexSourceObjects(
  objectList: readonly SourceObject[],
  sourceOrigin: string
): Map<string, SourceObject> {
  const objects = new Map<string, SourceObject>();
  const identities = new Map<string, string>();
  for (const candidate of objectList) {
    const id = requireText(candidate.id, 'Source object ID');
    const stableId = requireText(candidate.stableId, `Source object ${id} stable ID`);
    if (objects.has(id)) throw new Error(`Source object ${id} is duplicated.`);
    for (const identity of new Set([id, stableId])) {
      const owner = identities.get(identity);
      if (owner && owner !== id) {
        throw new Error(`Source identity ${identity} belongs to multiple source objects.`);
      }
      identities.set(identity, id);
    }
    for (const relationship of candidate.relationships) {
      if (![id, stableId].includes(relationship.sourceObjectId)) {
        throw new Error(`Relationship ${relationship.id} is attached to the wrong source object.`);
      }
    }
    objects.set(id, {
      ...candidate,
      id,
      stableId,
      sourceUrl: requireSourceUrl(candidate.sourceUrl, sourceOrigin, `Source object ${id}`),
    });
  }
  return objects;
}

function classifyFolders(
  scope: MigrationScope,
  folders: Map<string, ScopedFolderMetadata>,
  originalFolderIds: ReadonlySet<string>,
  appendedFolderIds: ReadonlySet<string>
): {
  includedFolderIds: Set<string>;
  excludedChildrenByParent: Map<string, ScopedFolderMetadata[]>;
} {
  const originalFolders = new Map(
    [...folders].filter(([folderId]) => originalFolderIds.has(folderId))
  );
  const original = classifyOriginalFolders(scope, originalFolders);
  const includedFolderIds = new Set([...original.includedFolderIds, ...appendedFolderIds]);
  const excludedChildrenByParent = new Map(
    [...original.excludedChildrenByParent].map(([parentId, children]) => [
      parentId,
      children.filter((child) => !includedFolderIds.has(child.ref.id)),
    ])
  );
  return { includedFolderIds, excludedChildrenByParent };
}

function classifyOriginalFolders(
  scope: MigrationScope,
  folders: Map<string, ScopedFolderMetadata>
): {
  includedFolderIds: Set<string>;
  excludedChildrenByParent: Map<string, ScopedFolderMetadata[]>;
} {
  if (scope.kind === 'file') {
    if (folders.size > 0) throw new Error('File scope cannot project discovered folders.');
    return { includedFolderIds: new Set(), excludedChildrenByParent: new Map() };
  }

  const roots = scope.kind === 'folder' ? [scope.folder] : scope.roots;
  const rootIds = new Set(roots.map((root) => root.id));
  for (const rootId of rootIds) {
    const root = requireFolder(folders, rootId);
    if (!root.childrenEnumerated) {
      throw new Error(`Source folder ${rootId} does not have a complete child enumeration.`);
    }
  }

  if (scope.kind === 'folder') {
    const rootId = scope.folder.id;
    const excluded = [...folders.values()].filter((folder) => folder.ref.id !== rootId);
    for (const child of excluded) {
      if (child.parentFolderId !== rootId) {
        throw new Error(
          `Source folder ${child.ref.id} is outside the direct-only selected hierarchy.`
        );
      }
    }
    return {
      includedFolderIds: new Set([rootId]),
      excludedChildrenByParent: new Map([[rootId, excluded]]),
    };
  }

  for (const folder of folders.values()) {
    if (!folder.childrenEnumerated) {
      throw new Error(`Source folder ${folder.ref.id} does not have a complete child enumeration.`);
    }
    if (rootIds.has(folder.ref.id)) continue;
    let cursor: ScopedFolderMetadata | undefined = folder;
    const visited = new Set<string>();
    while (cursor && !rootIds.has(cursor.ref.id)) {
      if (visited.has(cursor.ref.id)) {
        throw new Error(`Source folder hierarchy contains a cycle at ${cursor.ref.id}.`);
      }
      visited.add(cursor.ref.id);
      if (!cursor.parentFolderId) {
        throw new Error(`Source folder ${folder.ref.id} is outside the selected folder tree.`);
      }
      cursor = folders.get(cursor.parentFolderId);
      if (!cursor) {
        throw new Error(
          `Source folder ${folder.ref.id} has orphan parent membership ${folder.parentFolderId}.`
        );
      }
    }
  }
  return { includedFolderIds: new Set(folders.keys()), excludedChildrenByParent: new Map() };
}

export function classifySourceObjects(
  scope: MigrationScope,
  includedFolderIds: Set<string>,
  objects: Map<string, SourceObject>,
  relationshipResolutions?: readonly RelationshipResolution[],
  benchlingOrigin?: string,
  selectedSnapshotStableIdsAreAuthoritative = false,
  materializedSourceIds: ReadonlySet<string> = new Set()
): { selectedObjectIds: Set<string>; dependencyObjectIds: Set<string> } {
  const selectedObjectIds = new Set<string>();
  if (scope.kind === 'file') {
    const matches = [...objects.values()].filter(
      (object) => object.id === scope.source.id || object.stableId === scope.source.id
    );
    if (matches.length !== 1) {
      throw new Error(`File scope source ${scope.source.id} must match exactly one source object.`);
    }
    if (matches[0].sourceUrl !== canonicalSourceUrl(scope.source.url, 'File scope source')) {
      throw new Error(`File scope source ${scope.source.id} has a conflicting source URL.`);
    }
    selectedObjectIds.add(matches[0].id);
  } else {
    for (const object of objects.values()) {
      if (
        materializedSourceIds.has(object.id) ||
        object.memberships.some((id) => includedFolderIds.has(id))
      ) {
        selectedObjectIds.add(object.id);
      }
    }
  }

  const directlyReferencedIdentities = new Set<string>();
  if (relationshipResolutions === undefined) {
    for (const id of selectedObjectIds) {
      const object = objects.get(id);
      if (!object) continue;
      for (const relationship of object.relationships) {
        if (relationship.targetSourceId?.trim()) {
          directlyReferencedIdentities.add(relationship.targetSourceId.trim());
        }
      }
    }
  } else {
    const selectedRelationships = new Map<string, SourceObject['relationships'][number]>();
    for (const id of selectedObjectIds) {
      const object = objects.get(id);
      if (!object) continue;
      for (const relationship of object.relationships) {
        if (selectedRelationships.has(relationship.id)) {
          throw new Error(`Selected relationship ${relationship.id} is duplicated.`);
        }
        selectedRelationships.set(relationship.id, relationship);
      }
    }
    const seenResolutionIds = new Set<string>();
    for (const resolution of relationshipResolutions) {
      if (seenResolutionIds.has(resolution.relationshipId)) {
        throw new Error(`Relationship resolution ${resolution.relationshipId} is duplicated.`);
      }
      seenResolutionIds.add(resolution.relationshipId);
      const selectedRelationship = selectedRelationships.get(resolution.relationshipId);
      if (!selectedRelationship) continue;
      if (resolution.sourceObjectId !== selectedRelationship.sourceObjectId) {
        throw new Error(
          `Relationship resolution ${resolution.relationshipId} has a conflicting source object.`
        );
      }
      const captureConflict = exactRelationshipResolutionCaptureConflict({
        relationship: selectedRelationship,
        resolution,
        sourceObjects: [...objects.values()],
        benchlingOrigin,
        selectedSnapshotStableIdsAreAuthoritative,
      });
      if (captureConflict) {
        throw new Error(
          `Relationship resolution ${resolution.relationshipId} conflicts with its captured relationship: ${captureConflict}.`
        );
      }
      if (
        resolution.classification === 'exact' &&
        !resolution.requiresTargetedRead &&
        resolution.targetSourceId?.trim()
      ) {
        directlyReferencedIdentities.add(resolution.targetSourceId.trim());
      }
    }
  }

  const dependencyObjectIds = new Set<string>();
  for (const object of objects.values()) {
    if (selectedObjectIds.has(object.id)) continue;
    if (
      directlyReferencedIdentities.has(object.id) ||
      directlyReferencedIdentities.has(object.stableId)
    ) {
      dependencyObjectIds.add(object.id);
      continue;
    }
    throw new Error(
      `Source object ${object.id} is outside the selected scope and is not an outbound one-hop dependency.`
    );
  }
  return { selectedObjectIds, dependencyObjectIds };
}

function assertScopeRefsMatchFolders(
  scope: MigrationScope,
  folders: Map<string, ScopedFolderMetadata>
): void {
  for (const ref of scopeRefsForCollections(scope)) {
    const folder = requireFolder(folders, ref.id);
    if (folder.ref.url !== canonicalSourceUrl(ref.url, `Selected folder ${ref.id}`)) {
      throw new Error(`Selected folder ${ref.id} has a conflicting source URL.`);
    }
  }
}

function assertFolderGraphAcyclic(folders: Map<string, ScopedFolderMetadata>): void {
  for (const start of folders.values()) {
    const visited = new Set<string>();
    let cursor: ScopedFolderMetadata | undefined = start;
    while (cursor) {
      if (visited.has(cursor.ref.id)) {
        throw new Error(`Source folder hierarchy contains a cycle at ${cursor.ref.id}.`);
      }
      visited.add(cursor.ref.id);
      cursor = cursor.parentFolderId ? folders.get(cursor.parentFolderId) : undefined;
    }
  }
}

function validateDestinationIds(
  values: Readonly<Record<string, string>>,
  expectedSourceIds: Set<string>,
  kind: 'collection' | 'object'
): Map<string, string> {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  const providedSourceIds = new Set(entries.map(([sourceId]) => sourceId));
  for (const sourceId of expectedSourceIds) {
    if (!providedSourceIds.has(sourceId)) {
      throw new Error(`Source ${kind} ${sourceId} has no deterministic destination ID.`);
    }
  }
  for (const sourceId of providedSourceIds) {
    if (!expectedSourceIds.has(sourceId)) {
      throw new Error(`Destination ${kind} map contains out-of-scope source ID ${sourceId}.`);
    }
  }
  const destinations = new Set<string>();
  const result = new Map<string, string>();
  for (const [sourceId, rawDestinationId] of entries) {
    const destinationId = requireText(rawDestinationId, `Destination ${kind} ID for ${sourceId}`);
    if (destinations.has(destinationId)) {
      throw new Error(`Destination ${kind} ID ${destinationId} is not unique.`);
    }
    destinations.add(destinationId);
    result.set(sourceId, destinationId);
  }
  return result;
}

function assertDestinationDomainsDoNotOverlap(
  collections: Map<string, string>,
  objects: Map<string, string>
): void {
  const collectionIds = new Set(collections.values());
  for (const objectId of objects.values()) {
    if (collectionIds.has(objectId)) {
      throw new Error(`Destination ID ${objectId} is used by both a collection and an object.`);
    }
  }
}

function requireSingleSourceOrigin(
  refs: readonly BenchlingSourceRef[],
  observedSourceUrls: readonly string[]
): string {
  if (refs.length === 0) throw new Error('Migration scope must select at least one source.');
  const addressableRefs = refs.filter((ref) => !isLocalExportFolderSourceRef(ref));
  if (addressableRefs.length > 0) {
    const scopeBasis = addressableRefs.map((ref) =>
      canonicalSourceUrl(ref.url, `Source ${ref.id}`)
    );
    return singleOrganizationBase(scopeBasis);
  }
  const basis: string[] = [];
  for (const url of observedSourceUrls) {
    try {
      basis.push(canonicalSourceUrl(url, 'Local export source'));
    } catch {
      continue;
    }
  }
  if (basis.length === 0) {
    throw new Error('The local Benchling export contains no addressable source objects.');
  }
  return singleOrganizationBase(basis);
}

function singleOrganizationBase(canonicalUrls: readonly string[]): string {
  const organizationBases = new Set(canonicalUrls.map(benchlingOrganizationBaseUrlFromSourceUrl));
  if (organizationBases.size !== 1) {
    throw new Error('Selected sources span multiple Benchling organizations.');
  }
  return [...organizationBases][0];
}

function requireSourceUrl(value: string, origin: string, label: string): string {
  const canonical = canonicalSourceUrl(value, `${label} URL`);
  if (!isUrlWithinBenchlingOrganization(canonical, origin)) {
    throw new Error(`${label} belongs to a different Benchling organization.`);
  }
  return canonical;
}

function canonicalSourceUrl(value: string, label: string): string {
  const text = requireText(value, label);
  if (isLocalExportNamespaceUrl(text)) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment.`);
  }
  return parsed.toString();
}

function appendedFolderSourceUrl(root: BenchlingSourceRef, sourceId: string): string {
  if (isLocalExportNamespaceUrl(root.url)) {
    return localExportNamespacedUrl(root.url, `append-folder-${sourceId}`);
  }
  const url = new URL(root.url);
  url.search = '';
  url.hash = '';
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}_dnaforge-local-export/${encodeURIComponent(sourceId)}`;
  return url.toString();
}

function requireFolder(
  folders: Map<string, ScopedFolderMetadata>,
  sourceFolderId: string
): ScopedFolderMetadata {
  const folder = folders.get(sourceFolderId);
  if (!folder) throw new Error(`Selected source folder ${sourceFolderId} was not enumerated.`);
  return folder;
}

function requiredDestination(
  destinations: Map<string, string>,
  sourceId: string,
  kind: string
): string {
  const destination = destinations.get(sourceId);
  if (!destination) throw new Error(`Source ${kind} ${sourceId} has no destination ID.`);
  return destination;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requireText(value, 'Source membership ID')))].sort();
}

function optionalText(value: string | null, label: string): string | null {
  return value === null ? null : requireText(value, label);
}

function requireTimestamp(value: string, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}
