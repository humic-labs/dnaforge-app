import { posix } from 'node:path';
import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import type { NativeWorkspaceManifest } from '../../shared/native-workspace-manifest';
import type { NativeWorkspaceMaterializationPlan } from '../native-workspace-materializer';
import { collectionDestinationId } from './collection-projection';
import { safeDestinationSegment } from './destination-name-allocator';
import { localBenchlingExportDescendantFolderId } from './local-export-hierarchy';
import { isSafeWorkspaceRelativePath } from './safe-workspace-path';
import { isProtectedImportReplacementPath } from '../../shared/benchling-import-decision';
import type { WorkspaceAppendHierarchyCapture } from './workspace-append-hierarchy-capture';

type SourceFolderMembership = Readonly<{ sourceFolderId: string; relativePath: string }>;

export function captureNativeSourceFolderMemberships(
  scopeId: string,
  canonicalPaths: readonly string[]
): SourceFolderMembership[] {
  return [
    ...new Set(canonicalPaths.map((path) => posix.dirname(path)).filter((path) => path !== '.')),
  ]
    .sort()
    .map((relativePath) => {
      if (
        !isSafeWorkspaceRelativePath(relativePath) ||
        isProtectedImportReplacementPath(relativePath)
      )
        throw new Error('Native source membership path is unsafe.');
      return { sourceFolderId: folderSourceId(scopeId, relativePath), relativePath };
    });
}

export function addNativeSourceFolderMemberships(input: {
  scopeId: string;
  plan: NativeWorkspaceMaterializationPlan;
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  currentManifest: NativeWorkspaceManifest;
  incomingFolderHierarchy?: ReadonlySet<string>;
}): NativeWorkspaceMaterializationPlan {
  const entities = [...input.plan.entities];
  const existingFolders = new Set(
    input.currentManifest.entities
      .filter((entity) => entity.type === 'folder')
      .map((entity) => entity.id)
  );
  const existingHierarchy = new Set(
    input.currentManifest.links
      .filter((link) => link.relation === 'contains')
      .map((link) => `${link.sourceId}\0${link.targetId}`)
  );
  const mayAddHierarchy = (source: string, target: string) =>
    input.incomingFolderHierarchy === undefined ||
    !existingFolders.has(target) ||
    existingHierarchy.has(`${source}\0${target}`) ||
    input.incomingFolderHierarchy.has(`${source}\0${target}`);
  const links = input.plan.links.filter(
    (link) =>
      link.relation !== 'contains' ||
      !existingFolders.has(link.targetRawId) ||
      mayAddHierarchy(link.sourceRawId, link.targetRawId)
  );
  const receiptBySource = new Map(
    input.receipts.map((receipt) => [receipt.sourceObjectId, receipt])
  );
  const currentIds = new Set(input.currentManifest.entities.map((entity) => entity.id));
  const folderIdByPath = new Map<string, string>();
  const physicalPathBySourceFolderId = new Map<string, string>();
  for (const entity of input.currentManifest.entities) {
    if (entity.type !== 'folder') continue;
    const path =
      'placement' in entity
        ? entity.placement.kind === 'file'
          ? entity.placement.relativePath
          : null
        : entity.path;
    if (path) folderIdByPath.set(path, entity.id);
    if (path && typeof entity.metadata?.sourceFolderIdentity === 'string')
      physicalPathBySourceFolderId.set(entity.metadata.sourceFolderIdentity, path);
  }
  for (const entity of entities) {
    if (entity.type === 'folder' && entity.placement?.kind === 'file')
      folderIdByPath.set(entity.placement.relativePath, entity.rawId);
  }
  const relocatedParents = new Map<string, string>();
  for (const source of input.sourceObjects) {
    const receipt = receiptBySource.get(source.id);
    if (
      !receipt?.destination ||
      receipt.retainedDestination ||
      currentIds.has(receipt.destinationObjectId)
    )
      continue;
    const original = source.sourcePath ? posix.dirname(source.sourcePath) : '.';
    const destination = receipt.destination;
    const parent =
      destination.kind === 'catalog-record'
        ? destination.parentRelativePath
        : posix.dirname(
            destination.kind === 'file' ? destination.relativePath : destination.rootRelativePath
          );
    if (original !== '.' && parent !== '.' && parent) {
      relocatedParents.set(original, parent);
      const sourceSegments = original.split('/');
      const physicalSegments = parent.split('/');
      if (sourceSegments.length === physicalSegments.length) {
        for (let depth = 1; depth < sourceSegments.length; depth += 1) {
          relocatedParents.set(
            sourceSegments.slice(0, depth).join('/'),
            physicalSegments.slice(0, depth).join('/')
          );
        }
      }
    }
  }
  const linkKeys = new Set([
    ...links.map((link) => `${link.sourceRawId}\0${link.relation}\0${link.targetRawId}`),
    ...input.currentManifest.links.map(
      (link) => `${link.sourceId}\0${link.relation}\0${link.targetId}`
    ),
  ]);
  const addLink = (source: string, target: string, kind: string): void => {
    if (kind === 'folder_hierarchy' && !mayAddHierarchy(source, target)) return;
    const key = `${source}\0contains\0${target}`;
    if (linkKeys.has(key)) return;
    links.push({
      sourceRawId: source,
      relation: 'contains',
      targetRawId: target,
      evidence: { kind },
    });
    linkKeys.add(key);
  };
  const ensureFolder = (originalPath: string): string => {
    const segments = originalPath.split('/');
    let physical = '';
    let parentId: string | null = null;
    for (let length = 1; length <= segments.length; length += 1) {
      const original = segments.slice(0, length).join('/');
      physical =
        physicalPathBySourceFolderId.get(folderSourceId(input.scopeId, original)) ??
        relocatedParents.get(original) ??
        [physical, safeDestinationSegment(segments[length - 1], 'Imported folder')]
          .filter(Boolean)
          .join('/');
      if (isProtectedImportReplacementPath(physical))
        throw new Error('Native membership uses a protected root.');
      let id = folderIdByPath.get(physical);
      if (!id) {
        const sourceId = folderSourceId(input.scopeId, original);
        id = collectionDestinationId(sourceId);
        entities.push({
          rawId: id,
          type: 'folder',
          name: segments[length - 1],
          locator: { kind: 'file' },
          storageType: 'file',
          placement: { kind: 'file', relativePath: physical, fileKind: 'folder' },
          metadata: { imported: true, sourceProvider: 'benchling', sourceFolderIdentity: sourceId },
        });
        folderIdByPath.set(physical, id);
      }
      if (parentId) addLink(parentId, id, 'folder_hierarchy');
      parentId = id;
    }
    if (!parentId) throw new Error('Native source membership has no folder.');
    return parentId;
  };
  for (const source of input.sourceObjects) {
    const receipt = receiptBySource.get(source.id);
    if (!receipt) continue;
    for (const { relativePath } of readNativeSourceFolderMemberships(source, input.scopeId)) {
      addLink(ensureFolder(relativePath), receipt.destinationObjectId, 'folder_membership');
    }
  }
  return { ...input.plan, entities, links };
}

export function capturedNativeFolderHierarchy(
  scopeId: string,
  memberships: readonly SourceFolderMembership[],
  captures: readonly WorkspaceAppendHierarchyCapture[]
): Set<string> {
  const links = new Set<string>();
  for (const { relativePath } of memberships) {
    const segments = relativePath.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = collectionDestinationId(
        folderSourceId(scopeId, segments.slice(0, depth).join('/'))
      );
      const child = collectionDestinationId(
        folderSourceId(scopeId, segments.slice(0, depth + 1).join('/'))
      );
      links.add(`${parent}\0${child}`);
    }
  }
  for (const capture of captures)
    for (const folder of capture.folders)
      if (folder.parentSourceId)
        links.add(
          `${collectionDestinationId(folder.parentSourceId)}\0${collectionDestinationId(folder.sourceId)}`
        );
  return links;
}

export function readNativeSourceFolderMemberships(
  source: SourceObject,
  scopeId: string
): SourceFolderMembership[] {
  const metadata = source.metadata?.workspaceAppend;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const memberships = (metadata as Record<string, unknown>).sourceFolderMemberships;
  return validateNativeSourceFolderMemberships(memberships, scopeId);
}

export function validateNativeSourceFolderMemberships(
  memberships: unknown,
  scopeId: string
): SourceFolderMembership[] {
  if (memberships === undefined) return [];
  if (!Array.isArray(memberships)) throw new Error('Native source memberships are invalid.');
  return memberships
    .map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Native source membership is invalid.');
      const { relativePath, sourceFolderId } = value as Record<string, unknown>;
      if (
        typeof relativePath !== 'string' ||
        !isSafeWorkspaceRelativePath(relativePath) ||
        isProtectedImportReplacementPath(relativePath) ||
        sourceFolderId !== folderSourceId(scopeId, relativePath)
      )
        throw new Error('Native source membership does not match its captured path.');
      return { sourceFolderId, relativePath };
    })
    .sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
    );
}

function folderSourceId(scopeId: string, relativePath: string): string {
  return localBenchlingExportDescendantFolderId(scopeId, `workspace/${relativePath}`);
}
