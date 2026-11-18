import type Database from 'better-sqlite3';
import { access, lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  fromPackageRelative,
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import {
  isNotebookPackageMetaPath,
  notebookPackageRootForMetaPath,
  notebookPackageWindowsDrivePathKey,
} from '../db/notebook-package';
import { readNotebookProjectionSource } from '../db/notebook-projection-source';
import { withNotebookPackageAuthorityLock } from '../db/notebook-package-migration';
import { readSequenceProductSummary } from '../db/entity-substrate/sequence-product-summary-runtime';
import type {
  EntityProjectionSourceKey,
  SettleEntityProjectionSourceInput,
} from '../shared/entity-projection-source';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  isEntityArtifactPath,
  parseEntityArtifact,
} from '../shared/entity-artifact';
import {
  entityArtifactProjectionFingerprint,
  entityArtifactProjectionContent,
} from '../shared/entity-artifact-projection';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { sequenceEntityProjectionContent } from '../shared/sequence-package-projection';
import { contentFingerprint } from '../shared/content-fingerprint';
import {
  MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD,
  managedSequenceProjectionVersionForExistingRecord,
  projectManagedSequenceRegistry,
} from '../shared/managed-sequence-registry-projection';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  parseMolecularDocument,
  validateMolecularDocumentCoordinates,
} from '../shared/molecular-document';
import { molecularDocumentProjectionFields } from '../shared/molecular-document-projection';
import { parseTrackViewDocument, TRACK_VIEW_SUFFIX } from '../shared/track-view';
import {
  trackViewProjectionFields,
  trackViewProjectionOwnership,
} from '../shared/track-view-projection';
import { limsEntityFromRow, type LimsEntityRow, type LimsRegistrationStatus } from '../shared/lims';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { resolveEntityArtifactAuthority } from './entity-artifact-mutations';
import { getLimsRegistryPreviewInDb } from './lims-registry-projection';
import {
  entitySchemaRevisionContent,
  type ProjectableEntitySchemaRevisionSnapshot,
} from '../shared/entity-schema';
import { findKnownWorkspaceRoot } from './workspace-sync-mutation-lease';
import { writeEntityProjectionReceiptInDb } from './entity-projection-receipt-store';

export { writeEntityProjectionReceiptInDb } from './entity-projection-receipt-store';

export const NATIVE_ENTITY_PROJECTION_VERSIONS = {
  notebook: 1,
  sequence: 2,
  'lims-entity': 1,
  'molecular-document': 1,
  'track-view': 1,
} as const;

type Workspace = { id: number; path: string; repo_uuid: string | null };
export interface NativeProjectionSourceOwner {
  key: EntityProjectionSourceKey;
  workspace: Workspace | null;
  sourcePath: string;
}

export interface NativeFileRegistryProjection {
  id: string;
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: LimsRegistrationStatus;
  domainStatus: string | null;
  workspaceId: number | null;
  archived: boolean;
  schemaSnapshot?: ProjectableEntitySchemaRevisionSnapshot;
}

function requireText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

export function resolveNativeProjectionSourceOwner(
  db: Database.Database,
  key: EntityProjectionSourceKey
): NativeProjectionSourceOwner {
  if (
    !key ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    Object.keys(key).some(
      (field) =>
        !['adapterKind', 'entityId', 'workspaceKey', 'relativePath', 'projectionVersion'].includes(
          field
        )
    ) ||
    !requireText(key.adapterKind) ||
    !requireText(key.entityId) ||
    !requireText(key.workspaceKey) ||
    !requireText(key.relativePath) ||
    !Object.hasOwn(NATIVE_ENTITY_PROJECTION_VERSIONS, key.adapterKind) ||
    NATIVE_ENTITY_PROJECTION_VERSIONS[
      key.adapterKind as keyof typeof NATIVE_ENTITY_PROJECTION_VERSIONS
    ] !== key.projectionVersion
  )
    throw new Error('Entity projection source kind, version, or identity is invalid.');
  const workspaces = db.prepare('SELECT id,path,repo_uuid FROM workspaces').all() as Workspace[];
  const matching = workspaces.filter(
    (workspace) =>
      key.workspaceKey === `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}` ||
      key.workspaceKey === `workspace:${workspace.id}` ||
      key.workspaceKey === `root:${workspace.path.replace(/\/+$/u, '')}`
  );
  if (matching.length !== 1 && key.workspaceKey !== 'unbound')
    throw new Error('Entity projection source has no exact workspace owner.');
  const workspace = matching[0] ?? null;
  if (
    !workspace &&
    (!['notebook', 'track-view', 'molecular-document'].includes(key.adapterKind) ||
      !isAbsolute(key.relativePath))
  )
    throw new Error('Entity projection source requires an owning workspace.');
  if (workspace && !isSafeWorkspaceRelativePath(key.relativePath))
    throw new Error('Entity projection source escapes its owning workspace.');
  const sourcePath = workspace ? resolve(workspace.path, key.relativePath) : key.relativePath;
  if (!workspace && findKnownWorkspaceRoot(db, sourcePath))
    throw new Error(
      'A file projection inside a registered project requires its exact workspace owner.'
    );
  if (isDeveloperImportSourcePath(sourcePath, developerImportSourceRootsInDb(db)))
    throw new Error('Developer import sources cannot acquire projection equality receipts.');
  return { key, workspace, sourcePath };
}

export async function readNativeProjectionSources(owner: NativeProjectionSourceOwner) {
  const sources = new Map<string, { bytes: string; mtime: number; size: number; inode: number }>();
  const missing = new Set<string>();
  const safePath = async (path: string, allowMissing = false) =>
    (
      await canonicalWorkspacePath({
        workspaceRoot:
          owner.workspace?.path ??
          notebookPackageRootForMetaPath(owner.sourcePath) ??
          dirname(owner.sourcePath),
        path,
        allowMissing,
        artifactNoun: 'entity projection source',
      })
    ).candidate;
  const read = async (path: string) => {
    const safe = await safePath(path);
    const before = await lstat(safe);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('Entity projection sources must be regular files.');
    const bytes = await readFile(safe, 'utf8');
    const after = await lstat(safe);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      throw new Error('Entity projection source changed during validation.');
    const previous = sources.get(path);
    if (previous && previous.bytes !== bytes)
      throw new Error('Entity projection source changed during validation.');
    sources.set(path, { bytes, mtime: after.mtimeMs, size: after.size, inode: after.ino });
    return bytes;
  };
  return {
    readTextFile: read,
    async exists(path: string) {
      try {
        await access(await safePath(path, true));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.add(path);
        return false;
      }
    },
    async assertUnchanged() {
      for (const [path, snapshot] of [...sources]) {
        const bytes = await read(path);
        const current = sources.get(path)!;
        if (
          bytes !== snapshot.bytes ||
          current.mtime !== snapshot.mtime ||
          current.size !== snapshot.size ||
          current.inode !== snapshot.inode
        )
          throw new Error('Entity projection source changed during validation.');
      }
      for (const path of missing) {
        try {
          await access(await safePath(path, true));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        throw new Error('Entity projection source changed during validation.');
      }
    },
    mtime: (path: string) => sources.get(path)?.mtime,
  };
}

function registryEntity(db: Database.Database, id: string) {
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as
    | LimsEntityRow
    | undefined;
  return row ? limsEntityFromRow(row) : null;
}

function matchesWindowsNotebookBindingSeparators(storedPath: string, requestedPath: string) {
  const path = notebookPackageWindowsDrivePathKey(requestedPath);
  return path !== null && storedPath.replaceAll('\\', '/') === path;
}

export function assertNativeProjectionBinding(
  db: Database.Database,
  owner: NativeProjectionSourceOwner,
  bindingPath = owner.sourcePath,
  fileKind?: string,
  pathPolicy?: 'workspace-notebook-projection'
): void {
  const rows = db
    .prepare(
      `SELECT f.path,f.file_kind,f.workspace_id,e.workspace_id AS entity_workspace_id,e.type AS entity_type
       FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
       WHERE f.entity_id=? AND f.status='current'`
    )
    .all(owner.key.entityId) as Array<{
    path: string;
    file_kind: string;
    workspace_id: number | null;
    entity_workspace_id: number | null;
    entity_type: string;
  }>;
  if (
    rows.length !== 1 ||
    (rows[0].path !== bindingPath &&
      !(
        pathPolicy === 'workspace-notebook-projection' &&
        process.platform === 'win32' &&
        owner.workspace &&
        owner.key.adapterKind === 'notebook' &&
        fileKind === 'waypoint-notebook' &&
        matchesWindowsNotebookBindingSeparators(rows[0].path, bindingPath)
      )) ||
    (fileKind && rows[0].file_kind !== fileKind) ||
    rows[0].workspace_id !== (owner.workspace?.id ?? null) ||
    rows[0].entity_workspace_id !== (owner.workspace?.id ?? null) ||
    rows[0].entity_type !== owner.key.adapterKind
  )
    throw new Error('Entity projection source does not match its exact current file binding.');
}

async function equalitySnapshot(
  db: Database.Database,
  owner: NativeProjectionSourceOwner,
  runDatabase: <T>(work: () => T) => T
) {
  const sources = await readNativeProjectionSources(owner);
  const { key, sourcePath, workspace } = owner;
  const bytes = await sources.readTextFile(sourcePath);
  if (key.adapterKind === 'notebook') {
    if (
      !isNotebookPackageMetaPath(sourcePath) &&
      !sourcePath.toLowerCase().endsWith('.wpnote.json')
    )
      throw new Error('Notebook projection source path is invalid.');
    const source = await readNotebookProjectionSource(sources, sourcePath);
    if (
      scopedProjectionId(
        workspaceScopeKey(workspace?.repo_uuid, workspace?.id),
        source.document.id
      ) !== key.entityId
    )
      throw new Error('Notebook source identity does not match its exact scoped projection.');
    const fingerprint = notebookProjectionFingerprint(
      source.document.title,
      source.document.content
    );
    const existingRegistry = runDatabase(() => registryEntity(db, key.entityId));
    return {
      sources,
      fingerprint,
      registryProjection: {
        id: key.entityId,
        kind: 'notebook',
        name: source.document.title,
        fields: {
          ...existingRegistry?.fields,
          packagePath: notebookPackageRootForMetaPath(sourcePath) ?? sourcePath,
        },
        registrationStatus: existingRegistry?.registrationStatus ?? 'registered',
        domainStatus: existingRegistry?.domainStatus ?? null,
        workspaceId: workspace?.id ?? null,
        archived: existingRegistry?.tombstone ?? false,
      } satisfies NativeFileRegistryProjection,
      projection: () => {
        assertNativeProjectionBinding(
          db,
          owner,
          notebookPackageRootForMetaPath(sourcePath) ?? sourcePath,
          'waypoint-notebook',
          'workspace-notebook-projection'
        );
        const row = db.prepare('SELECT title,content FROM pages WHERE id=?').get(key.entityId) as
          | { title: string; content: string }
          | undefined;
        return row &&
          row.title === source.document.title &&
          row.content === JSON.stringify(source.document.content)
          ? fingerprint
          : null;
      },
    };
  }
  if (key.adapterKind === 'sequence') {
    if (!isSequencePackageMetaPath(sourcePath))
      throw new Error('Sequence projection source path is invalid.');
    const document = parseSequencePackageDocument(bytes);
    if (document.id !== key.entityId)
      throw new Error('Sequence projection source identity does not match.');
    const packageRoot = sequencePackageRootForMetaPath(sourcePath)!;
    const product = await sources.readTextFile(
      fromPackageRelative(document.product.file, packageRoot)
    );
    const summary = await readSequenceProductSummary(product);
    const projectionVersion = managedSequenceProjectionVersionForExistingRecord(
      runDatabase(() => registryEntity(db, key.entityId))?.fields ?? {}
    );
    const projected = await projectManagedSequenceRegistry(
      document,
      summary,
      projectionVersion,
      bytes
    );
    const content = sequenceEntityProjectionContent(projected);
    const fingerprint = contentFingerprint(content);
    return {
      sources,
      fingerprint,
      registryProjection: {
        ...projected,
        fields: {
          ...projected.fields,
          [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
            kind: 'managed-sequence',
            packageId: document.id,
            packageRoot,
          },
        },
        workspaceId: workspace?.id ?? null,
        archived: false,
      } satisfies NativeFileRegistryProjection,
      projection: () => {
        const entity = registryEntity(db, key.entityId);
        const managed =
          entity && readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
        if (
          !entity ||
          entity.tombstone ||
          entity.workspaceId !== workspace?.id ||
          managed?.packageId !== document.id ||
          managed.packageRoot !== packageRoot ||
          entity.fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD] !== projectionVersion
        )
          return null;
        return sequenceEntityProjectionContent(entity) === content ? fingerprint : null;
      },
    };
  }
  if (key.adapterKind === 'lims-entity') {
    if (!isEntityArtifactPath(sourcePath))
      throw new Error('Registry projection source path is invalid.');
    const original = parseEntityArtifact(bytes);
    const entity = runDatabase(() => registryEntity(db, key.entityId));
    if (original.id !== key.entityId)
      throw new Error('Registry projection source identity does not match.');
    const preview = entity
      ? runDatabase(() => getLimsRegistryPreviewInDb(db, { entityId: key.entityId }))
      : null;
    if (
      original.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA &&
      (!entity || !preview || entity.kind !== original.kind)
    )
      throw new Error('Legacy Registry source has no authoritative frozen schema.');
    const document =
      original.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA
        ? original
        : {
            ...original,
            schemaRevisionId: preview!.schemaSnapshot.schemaRevisionId,
            schemaSnapshot: preview!.schemaSnapshot,
            archived: entity!.tombstone,
          };
    return {
      sources,
      fingerprint: entityArtifactProjectionFingerprint(document),
      registryProjection: {
        id: document.id,
        kind: document.kind,
        name: document.name,
        fields: document.fields,
        registrationStatus: document.registrationStatus,
        domainStatus: document.domainStatus,
        workspaceId: workspace?.id ?? null,
        archived: document.archived,
        schemaSnapshot: document.schemaSnapshot,
      } satisfies NativeFileRegistryProjection,
      projection: () => {
        const current = registryEntity(db, key.entityId);
        if (!current || current.workspaceId !== workspace?.id) return null;
        const currentPreview = getLimsRegistryPreviewInDb(db, { entityId: key.entityId });
        if (
          !currentPreview ||
          !isDeepStrictEqual(
            entitySchemaRevisionContent(document.schemaSnapshot),
            entitySchemaRevisionContent(currentPreview.schemaSnapshot)
          )
        )
          throw new Error('Registry file and projection have different frozen schema definitions.');
        const authority = resolveEntityArtifactAuthority(db, current);
        if (resolve(authority.workspacePath, authority.relativePath) !== sourcePath)
          throw new Error('Registry source does not match its native file authority.');
        return entityArtifactProjectionContent({ ...current, archived: current.tombstone }) ===
          entityArtifactProjectionContent(document)
          ? entityArtifactProjectionFingerprint(document)
          : null;
      },
    };
  }
  const fileWorkspaceId = workspace?.id ?? null;
  const registryWorkspaceId =
    key.adapterKind === 'track-view'
      ? trackViewProjectionOwnership(
          fileWorkspaceId,
          runDatabase(() => registryEntity(db, key.entityId))?.workspaceId
        ).registryWorkspaceId
      : fileWorkspaceId;
  const catalogProjection = () => {
    assertNativeProjectionBinding(db, owner);
    const entity = registryEntity(db, key.entityId);
    const catalog = db
      .prepare('SELECT type,name,metadata,workspace_id FROM catalog_entities WHERE id=?')
      .get(key.entityId) as
      | { type: string; name: string; metadata: string | null; workspace_id: number | null }
      | undefined;
    if (
      !entity ||
      !catalog ||
      entity.tombstone ||
      entity.kind !== key.adapterKind ||
      catalog.type !== key.adapterKind ||
      entity.name !== catalog.name ||
      entity.workspaceId !== registryWorkspaceId ||
      catalog.workspace_id !== fileWorkspaceId
    )
      return null;
    const metadata: unknown = JSON.parse(catalog.metadata ?? '{}');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    return { entity, metadata: metadata as Record<string, unknown> };
  };
  if (key.adapterKind === 'molecular-document') {
    if (!sourcePath.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX))
      throw new Error('Molecular projection source path is invalid.');
    const document = parseMolecularDocument(bytes);
    await validateMolecularDocumentCoordinates(document);
    if (
      scopedProjectionId(workspaceScopeKey(workspace?.repo_uuid, workspace?.id), document.id) !==
      key.entityId
    )
      throw new Error('Molecular projection source identity does not match its scoped projection.');
    const fields = molecularDocumentProjectionFields(document);
    return {
      sources,
      fingerprint: fields.artifactFingerprint as string,
      registryProjection: {
        id: key.entityId,
        kind: 'molecular-document',
        name: document.name,
        fields,
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: workspace?.id ?? null,
        archived: false,
      } satisfies NativeFileRegistryProjection,
      projection: () => {
        const state = catalogProjection();
        if (!state || state.entity.name !== document.name) return null;
        for (const field of [
          'artifactFingerprint',
          'currentReferenceId',
          'revisionCount',
          'sourceCount',
        ])
          if (
            state.entity.fields[field] !== state.metadata[field] ||
            state.entity.fields[field] !== fields[field]
          )
            return null;
        return typeof state.metadata.artifactFingerprint === 'string'
          ? state.metadata.artifactFingerprint
          : null;
      },
    };
  }
  if (!sourcePath.endsWith(TRACK_VIEW_SUFFIX))
    throw new Error('Track-view projection source path is invalid.');
  const document = parseTrackViewDocument(bytes);
  if (document.id !== key.entityId)
    throw new Error('Track-view source identity does not match its projection.');
  const fields = trackViewProjectionFields(document);
  return {
    sources,
    fingerprint: fields.artifactFingerprint as string,
    registryProjection: {
      id: document.id,
      kind: 'track-view',
      name: document.name,
      fields,
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: registryWorkspaceId,
      archived: false,
    } satisfies NativeFileRegistryProjection,
    projection: () => {
      const state = catalogProjection();
      if (
        !state ||
        state.entity.name !== document.name ||
        Object.entries(fields).some(([field, value]) => state.entity.fields[field] !== value) ||
        state.entity.fields.artifactFingerprint !== state.metadata.fingerprint ||
        state.entity.fields.referenceAssemblyId !== state.metadata.referenceId ||
        state.entity.fields.referenceName !== state.metadata.referenceName ||
        state.entity.fields.trackCount !== state.metadata.trackCount
      )
        return null;
      return typeof state.metadata.fingerprint === 'string' ? state.metadata.fingerprint : null;
    },
  };
}

export async function readCanonicalFileRegistryProjection(
  db: Database.Database,
  owner: NativeProjectionSourceOwner,
  runDatabase: <T>(work: () => T) => T
): Promise<{
  canonical: NativeFileRegistryProjection;
  assertSourcesUnchanged: () => Promise<void>;
}> {
  const snapshot = await equalitySnapshot(db, owner, runDatabase);
  if (!('registryProjection' in snapshot) || !snapshot.registryProjection)
    throw new Error('This file source has no Registry semantic projection.');
  return {
    canonical: snapshot.registryProjection,
    assertSourcesUnchanged: snapshot.sources.assertUnchanged,
  };
}

export async function settleEntityProjectionSourceInMain(
  db: Database.Database,
  input: SettleEntityProjectionSourceInput,
  runDatabase: <T>(work: () => T) => T = (work) => work()
): Promise<void> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((field) => !['key', 'fingerprint'].includes(field)) ||
    !requireText(input.fingerprint)
  )
    throw new Error('Entity projection equality request is invalid.');
  const owner = runDatabase(() => resolveNativeProjectionSourceOwner(db, input.key));
  const settle = async () => {
    const snapshot = await equalitySnapshot(db, owner, runDatabase);
    if (input.fingerprint !== snapshot.fingerprint)
      throw new Error('Entity projection equality fingerprint does not match its canonical file.');
    await snapshot.sources.assertUnchanged();
    runDatabase(() =>
      db.transaction(() => {
        const currentOwner = resolveNativeProjectionSourceOwner(db, input.key);
        if (
          currentOwner.sourcePath !== owner.sourcePath ||
          currentOwner.workspace?.id !== owner.workspace?.id
        )
          throw new Error('Entity projection source owner changed during validation.');
        if (snapshot.projection() !== snapshot.fingerprint)
          throw new Error('Entity projection differs from its canonical file.');
        writeEntityProjectionReceiptInDb(db, input.key, snapshot.fingerprint);
      })()
    );
  };
  const packageRoot =
    input.key.adapterKind === 'notebook' ? notebookPackageRootForMetaPath(owner.sourcePath) : null;
  return packageRoot ? withNotebookPackageAuthorityLock(packageRoot, settle) : settle();
}
