import type Database from 'better-sqlite3';
import { parseEntityArtifact } from '../shared/entity-artifact';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isNotebookPackageMetaPath,
  notebookPackagePaths,
  notebookPackageRootForMetaPath,
} from '../db/notebook-package';
import {
  isSequencePackageFileKind,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import {
  limsEntityFromRow,
  type LimsEntity,
  type LimsEntityActionInput,
  type LimsEntityRow,
  type LimsRegisterEntityInput,
  type LimsUpdateEntityInput,
  type LimsReplaceOutgoingRelationshipsInput,
  type LimsReplaceOutgoingRelationshipsResult,
} from '../shared/lims';
import { canonicalEntityArtifactValue } from '../shared/entity-artifact-projection';
import { entitySchemaRevisionContent } from '../shared/entity-schema';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import type { EntityProjectionSourceKey } from '../shared/entity-projection-source';
import {
  assertNativeProjectionBinding,
  NATIVE_ENTITY_PROJECTION_VERSIONS,
  readCanonicalFileRegistryProjection,
  readNativeProjectionSources,
  resolveNativeProjectionSourceOwner,
  type NativeProjectionSourceOwner,
} from './entity-projection-receipts';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';
import { resolveEntityArtifactAuthority } from './entity-artifact-mutations';
import {
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import { replaceLimsOutgoingRelationshipsInsideTx } from './lims-relationship-projection';
import { readAcceptedScientificStrain } from './scientific-strain-authority';
import { repairLimsEntityFromVerifiedAuditInDb } from './lims-projection-rebuild';

export type FileBackedRegistryMutationAction =
  | 'register'
  | 'update'
  | 'archive'
  | 'restore'
  | 'revert';
type MutationInput = LimsRegisterEntityInput | LimsUpdateEntityInput | LimsEntityActionInput;
type Workspace = { id: number; path: string; repo_uuid: string | null };
type CurrentBinding = {
  path: string;
  file_kind: string;
  workspace_id: number | null;
  type: string;
  entity_workspace_id: number | null;
};

function requireText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function currentEntity(db: Database.Database, id: string): LimsEntity | null {
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as
    | LimsEntityRow
    | undefined;
  return row ? limsEntityFromRow(row) : null;
}

function workspaceForId(db: Database.Database, id: number | null | undefined): Workspace | null {
  if (id == null) return null;
  const workspace = db.prepare('SELECT id,path,repo_uuid FROM workspaces WHERE id=?').get(id) as
    | Workspace
    | undefined;
  if (!workspace) throw new Error('File-backed Registry projection has no native project owner.');
  return workspace;
}

function sourceOwner(
  db: Database.Database,
  kind: keyof typeof NATIVE_ENTITY_PROJECTION_VERSIONS,
  id: string,
  path: string,
  workspace: Workspace | null
): NativeProjectionSourceOwner {
  const relative = workspace ? pathRelativeToBoundary(path, workspace.path) : path;
  if (!relative) throw new Error('Registry source escapes its exact native project owner.');
  return resolveNativeProjectionSourceOwner(db, {
    adapterKind: kind,
    entityId: id,
    workspaceKey: workspace
      ? `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}`
      : 'unbound',
    relativePath: relative.replace(/\\/gu, '/'),
    projectionVersion: NATIVE_ENTITY_PROJECTION_VERSIONS[kind],
  });
}

async function existingSequenceSource(packageRoot: string): Promise<string | null> {
  const matches: string[] = [];
  for (const path of sequencePackageMetaPaths(packageRoot)) {
    try {
      await access(path);
      matches.push(path);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  if (matches.length > 1)
    throw new Error('Managed sequence projection requires one exact current package marker.');
  return matches[0] ?? null;
}

async function resolveRegistrySource(
  db: Database.Database,
  action: FileBackedRegistryMutationAction,
  input: MutationInput,
  runDatabase: <T>(work: () => T) => T
): Promise<NativeProjectionSourceOwner | null> {
  const register = action === 'register' ? (input as LimsRegisterEntityInput) : null;
  const update = action === 'update' ? (input as LimsUpdateEntityInput) : null;
  const requestedFields = register?.fields ?? update?.fields;
  const existing = requireText(input.id) ? runDatabase(() => currentEntity(db, input.id!)) : null;
  const fields = existing?.fields ?? requestedFields ?? {};
  if (requireText(input.id)) {
    const bindings = runDatabase(() =>
      db
        .prepare(
          `SELECT f.path,f.file_kind,f.workspace_id,e.type,e.workspace_id AS entity_workspace_id
       FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
       WHERE f.entity_id=? AND f.status='current'`
        )
        .all(input.id)
    ) as CurrentBinding[];
    if (bindings.length > 1)
      throw new Error('Registry projection has ambiguous current file authority.');
    const binding = bindings[0];
    if (binding && ['molecular-document', 'track-view'].includes(binding.type)) {
      if (binding.workspace_id !== binding.entity_workspace_id)
        throw new Error('Registry projection file and catalog ownership disagree.');
      return runDatabase(() =>
        sourceOwner(
          db,
          binding.type as 'molecular-document' | 'track-view',
          input.id!,
          binding.path,
          workspaceForId(db, binding.workspace_id)
        )
      );
    }
    if (binding?.type === 'notebook' && binding.file_kind === 'waypoint-notebook') {
      const path =
        isNotebookPackageMetaPath(binding.path) ||
        binding.path.toLowerCase().endsWith('.wpnote.json')
          ? binding.path
          : notebookPackagePaths(binding.path).metaPath;
      return runDatabase(() =>
        sourceOwner(db, 'notebook', input.id!, path, workspaceForId(db, binding.workspace_id))
      );
    }
    if (binding && isSequencePackageFileKind(binding.file_kind)) {
      const knownRoot = sequencePackageRootForMetaPath(binding.path);
      const path = knownRoot
        ? await existingSequenceSource(knownRoot)
        : ((await existingSequenceSource(binding.path)) ??
          (await existingSequenceSource(dirname(binding.path))));
      if (!path) throw new Error('The current managed sequence package marker is missing.');
      return runDatabase(() =>
        sourceOwner(db, 'sequence', input.id!, path, workspaceForId(db, binding.workspace_id))
      );
    }
  }
  const currentRef = readManagedSequenceDocumentRef(fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
  const requestedRef = readManagedSequenceDocumentRef(
    requestedFields?.[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  const ref = currentRef;
  if (ref) {
    if (!requireText(input.id) || ref.packageId !== input.id)
      throw new Error('Managed sequence projection requires its exact explicit package identity.');
    const workspace = runDatabase(() =>
      workspaceForId(db, existing?.workspaceId ?? update?.workspaceId ?? register?.workspaceId)
    );
    if (!workspace)
      throw new Error('Managed sequence projection requires its actual project owner.');
    let path = await existingSequenceSource(ref.packageRoot);
    if (!path && requestedRef?.packageId === input.id)
      path = await existingSequenceSource(requestedRef.packageRoot);
    if (!path) throw new Error('Managed sequence projection source is missing.');
    return runDatabase(() => sourceOwner(db, 'sequence', input.id!, path!, workspace));
  }
  if (
    Object.hasOwn(fields, MANAGED_SEQUENCE_DOCUMENT_FIELD) ||
    (requestedFields &&
      Object.hasOwn(requestedFields, MANAGED_SEQUENCE_DOCUMENT_FIELD) &&
      !requestedRef)
  )
    throw new Error('Managed sequence authority reference is invalid.');
  const artifactFields = isEntityRecordArtifactProjection(fields) ? fields : requestedFields;
  if (artifactFields && isEntityRecordArtifactProjection(artifactFields)) {
    if (!requireText(input.id))
      throw new Error('Registry file projection requires its exact explicit file identity.');
    const artifact = artifactFields.artifact as { relativePath?: unknown };
    if (
      typeof artifact.relativePath !== 'string' ||
      !isSafeWorkspaceRelativePath(artifact.relativePath)
    )
      throw new Error('Registry file authority requires a safe project-relative source path.');
    const id = input.id;
    return runDatabase(() => {
      const authority = resolveEntityArtifactAuthority(db, {
        id,
        workspaceId: update?.workspaceId ?? register?.workspaceId ?? existing?.workspaceId ?? null,
        fields: artifactFields,
      });
      return sourceOwner(
        db,
        'lims-entity',
        id,
        `${authority.workspacePath.replace(/\/+$/u, '')}/${authority.relativePath}`,
        workspaceForId(db, authority.workspaceId)
      );
    });
  }
  if (requireText(input.id)) {
    const keys = runDatabase(() =>
      db
        .prepare(
          `SELECT adapter_kind AS adapterKind,entity_id AS entityId,workspace_key AS workspaceKey,
       relative_path AS relativePath,projection_version AS projectionVersion FROM entity_projection_sources
       WHERE entity_id=? AND adapter_kind IN ('sequence','molecular-document','track-view')`
        )
        .all(input.id)
    ) as EntityProjectionSourceKey[];
    if (keys.length > 0) {
      const owners = new Map<string, NativeProjectionSourceOwner>();
      for (const key of keys) {
        const owner = runDatabase(() => resolveNativeProjectionSourceOwner(db, key));
        try {
          await access(owner.sourcePath);
          owners.set(owner.sourcePath, owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (owners.size > 1 || (owners.size === 0 && !requestedRef))
        throw new Error('Registry equality history has no unique current file source.');
      if (owners.size === 1) return [...owners.values()][0];
    }
  }
  if (['molecular-document', 'track-view'].includes(existing?.kind ?? register?.kind ?? ''))
    throw new Error('This Registry visualization requires its actual current file binding.');
  if (requestedRef) {
    if (!requireText(input.id) || requestedRef.packageId !== input.id)
      throw new Error('Managed sequence projection requires its exact explicit package identity.');
    const workspace = runDatabase(() =>
      workspaceForId(db, existing?.workspaceId ?? update?.workspaceId ?? register?.workspaceId)
    );
    if (!workspace)
      throw new Error('Managed sequence projection requires its actual project owner.');
    const path = await existingSequenceSource(requestedRef.packageRoot);
    if (!path) throw new Error('Managed sequence projection source is missing.');
    return runDatabase(() => sourceOwner(db, 'sequence', input.id!, path, workspace));
  }
  return null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalEntityArtifactValue(JSON.parse(JSON.stringify(value))));
}

export async function assertFileBackedRegistryMutation(
  db: Database.Database,
  action: FileBackedRegistryMutationAction,
  input: MutationInput,
  runDatabase: <T>(work: () => T) => T = (work) => work()
): Promise<boolean> {
  if (
    !['register', 'update', 'archive', 'restore', 'revert'].includes(action) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    throw new Error('Registry source validation request is invalid.');
  const owner = await resolveRegistrySource(db, action, input, runDatabase);
  if (!owner) return false;
  if (
    action === 'revert' ||
    (action === 'archive' && owner.key.adapterKind !== 'notebook') ||
    (owner.key.adapterKind === 'lims-entity' && action !== 'register')
  )
    throw new Error('File-backed Registry lifecycle changes require the owning file operation.');
  const snapshot = await readCanonicalFileRegistryProjection(db, owner, runDatabase);
  const expected = snapshot.canonical;
  const current = runDatabase(() => currentEntity(db, expected.id));
  if (current?.workspaceId != null && current.workspaceId !== expected.workspaceId)
    throw new Error('Registry projection cannot change its owning project through a source claim.');
  const register = action === 'register' ? (input as LimsRegisterEntityInput) : null;
  const update = action === 'update' ? (input as LimsUpdateEntityInput) : null;
  if (!register && !current)
    throw new Error('Registry projection is missing; rebuild it from its owning file.');
  const candidate = register
    ? {
        id: register.id,
        kind: register.kind,
        name: register.name,
        fields: register.fields,
        registrationStatus: register.registrationStatus ?? 'registered',
        domainStatus: register.domainStatus ?? null,
        workspaceId: register.workspaceId ?? null,
      }
    : {
        id: input.id,
        kind: update?.projectionSchema?.kind ?? current!.kind,
        name: update?.name ?? current!.name,
        fields: update?.fields
          ? update.replaceFields
            ? update.fields
            : { ...current!.fields, ...update.fields }
          : current!.fields,
        registrationStatus: update?.registrationStatus ?? current!.registrationStatus,
        domainStatus:
          update?.domainStatus === undefined ? current!.domainStatus : update.domainStatus,
        workspaceId: update?.workspaceId === undefined ? current!.workspaceId : update.workspaceId,
      };
  const semantic = {
    id: expected.id,
    kind: expected.kind,
    name: expected.name,
    fields: expected.fields,
    registrationStatus: expected.registrationStatus,
    domainStatus: expected.domainStatus,
    workspaceId: expected.workspaceId,
  };
  if (canonicalJson(candidate) !== canonicalJson(semantic))
    throw new Error('Registry mutation differs from its actual canonical file projection.');
  if (expected.schemaSnapshot) {
    const supplied =
      register?.schemaSnapshot ??
      update?.projectionSchema?.schemaSnapshot ??
      (current ? runDatabase(() => readEntitySchemaSnapshotInDb(db, current.id)) : undefined);
    const revision =
      register?.schemaRevisionId ??
      update?.projectionSchema?.schemaRevisionId ??
      current?.schemaRevisionId;
    if (
      revision !== expected.schemaSnapshot.schemaRevisionId ||
      !supplied ||
      !isDeepStrictEqual(
        entitySchemaRevisionContent(supplied),
        entitySchemaRevisionContent(expected.schemaSnapshot)
      )
    )
      throw new Error('Registry mutation differs from its canonical frozen schema.');
  } else if (register?.schemaSnapshot || register?.schemaRevisionId || update?.projectionSchema) {
    throw new Error('A visualization Registry projection cannot acquire a separate schema owner.');
  }
  await snapshot.assertSourcesUnchanged();
  runDatabase(() => {
    const latest = resolveNativeProjectionSourceOwner(db, owner.key);
    if (latest.sourcePath !== owner.sourcePath || latest.workspace?.id !== owner.workspace?.id)
      throw new Error('Registry file source owner changed during candidate validation.');
    if (owner.key.adapterKind === 'notebook')
      assertNativeProjectionBinding(
        db,
        latest,
        notebookPackageRootForMetaPath(latest.sourcePath) ?? latest.sourcePath,
        'waypoint-notebook'
      );
    else if (['molecular-document', 'track-view'].includes(owner.key.adapterKind))
      assertNativeProjectionBinding(db, latest);
  });
  return true;
}

export async function assertFileBackedRegistryRelationships(
  db: Database.Database,
  input: LimsReplaceOutgoingRelationshipsInput,
  runDatabase: <T>(work: () => T) => T,
  registration?: LimsRegisterEntityInput
): Promise<boolean> {
  const owner = await resolveRegistrySource(
    db,
    registration ? 'register' : 'update',
    registration ?? { id: input.entityId },
    runDatabase
  );
  if (!owner || !['sequence', 'lims-entity'].includes(owner.key.adapterKind)) return false;
  const sources = await readNativeProjectionSources(owner);
  const bytes = await sources.readTextFile(owner.sourcePath);
  const document =
    owner.key.adapterKind === 'sequence'
      ? parseSequencePackageDocument(bytes)
      : parseEntityArtifact(bytes);
  const relationships =
    'entity' in document ? document.entity.relationships : document.relationships;
  const schemaSnapshots = 'entity' in document ? [] : (document.relationshipSchemaSnapshots ?? []);
  if (
    input.schemaSnapshots !== undefined &&
    canonicalJson(input.schemaSnapshots) !== canonicalJson(schemaSnapshots)
  )
    throw new Error(
      'Registry relationship schema projection differs from its authoritative file source.'
    );
  const normalize = (values: LimsReplaceOutgoingRelationshipsInput['relationships']) =>
    values
      .map((value) => ({
        type: value.type,
        toEntityId: value.toEntityId,
        payload: value.payload ?? {},
      }))
      .sort((left, right) =>
        `${left.type}\0${left.toEntityId}`.localeCompare(`${right.type}\0${right.toEntityId}`)
      );
  if (
    document.id !== input.entityId ||
    relationships.some((value) => value.fromEntityId !== document.id) ||
    (input.workspaceId !== undefined && input.workspaceId !== owner.workspace?.id) ||
    canonicalJson(normalize(relationships)) !== canonicalJson(normalize(input.relationships))
  )
    throw new Error('Registry relationship projection differs from its authoritative file source.');
  await sources.assertUnchanged();
  runDatabase(() => {
    const latest = resolveNativeProjectionSourceOwner(db, owner.key);
    if (latest.sourcePath !== owner.sourcePath || latest.workspace?.id !== owner.workspace?.id)
      throw new Error('Registry relationship source owner changed during validation.');
  });
  return true;
}

export async function reconstructFileBackedRegistryEntity(
  db: Database.Database,
  operation:
    | { action: 'register'; input: LimsRegisterEntityInput }
    | { action: 'update'; input: LimsUpdateEntityInput },
  runDatabase: <T>(work: () => T) => T
): Promise<LimsEntity | null> {
  if (!(await assertFileBackedRegistryMutation(db, operation.action, operation.input, runDatabase)))
    return null;
  return runDatabase(() => {
    seedLimsBuiltinsInDb(db);
    return db.transaction(() => {
      if (
        operation.action === 'register' &&
        operation.input.id &&
        !currentEntity(db, operation.input.id)
      )
        repairLimsEntityFromVerifiedAuditInDb(db, operation.input.id);
      return operation.action === 'register'
        ? registerLimsEntityInsideTx(db, operation.input)
        : updateLimsEntityInsideTx(db, operation.input);
    })();
  });
}

export async function reconstructFileBackedRegistryRelationships(
  db: Database.Database,
  input: LimsReplaceOutgoingRelationshipsInput,
  runDatabase: <T>(work: () => T) => T
): Promise<LimsReplaceOutgoingRelationshipsResult | null> {
  const assertMutable = () => {
    if (readAcceptedScientificStrain(db, input.entityId))
      throw new Error('Open the strain and save its captured relationships.');
  };
  runDatabase(assertMutable);
  if (!(await assertFileBackedRegistryRelationships(db, input, runDatabase))) return null;
  return runDatabase(() => {
    assertMutable();
    seedLimsBuiltinsInDb(db);
    return db.transaction(() => replaceLimsOutgoingRelationshipsInsideTx(db, input))();
  });
}
