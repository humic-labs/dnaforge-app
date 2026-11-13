import { createRegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../db/sequence-package';
import {
  buildLegacyAcceptedPlasmidReconstruction,
  legacyAcceptedPlasmidProjectionId,
  matchesLegacyAcceptedPlasmidProjection,
  needsLegacyAcceptedPlasmidReconstruction,
  MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD,
  type LegacyAcceptedPlasmidReconstructionInput,
  type LegacyAcceptedPlasmidReconstructionResult,
} from '../shared/legacy-accepted-plasmid-reconstruction';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import {
  limsEntityFromRow,
  parseLimsSchemaFields,
  type LimsEntityRow,
  type LimsSchemaRow,
} from '../shared/lims';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../shared/path-boundary';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { withRecoveredSequencePackageMutationInMain } from './sequence-package-revision-publication';
import { assertLegacySequenceMetadataTransactionSettledInMain } from './sequence-package-legacy-metadata-journal';

interface WorkspaceRow {
  id: number;
  path: string;
  repo_uuid: string | null;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
}

interface BindingRow {
  id: string;
  entity_id: string;
  workspace_id: number | null;
  path: string;
  file_kind: string;
}

interface CatalogRow {
  id: string;
  type: string;
  workspace_id: number | null;
  locator: string;
  storage_type: string;
  status: string;
}

type FileWitness = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;

function sameFile(left: FileWitness, right: FileWitness): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertFileCurrent(path: string, expected: FileWitness): void {
  const current = lstatSync(path);
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, expected))
    throw new Error('Legacy Plasmid source generation changed before publication.');
}

async function readStableSource(path: string, limit: number) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('Legacy Plasmid reconstruction requires regular source files.');
  const bytes = await readFileBoundedFromHandle(path, limit);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || !sameFile(before, after))
    throw new Error('Legacy Plasmid source changed while it was read.');
  return { bytes, witness: after, hash: createHash('sha256').update(bytes).digest('hex') };
}

function checkedWorkspace(db: Database.Database, input: LegacyAcceptedPlasmidReconstructionInput) {
  assertCommittedDatabaseReadAllowed(db);
  assertLimsSafetyNotQuarantined(db);
  const workspace = db
    .prepare<
      [number],
      WorkspaceRow
    >('SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?')
    .get(input.workspaceId);
  const knownRoot = findKnownWorkspaceRoot(db, input.metadataPath);
  if (
    !workspace ||
    workspace.access_mode !== 'writable' ||
    workspace.archived_at != null ||
    workspace.trashed_at != null ||
    !isAbsolute(input.metadataPath) ||
    !knownRoot ||
    workspaceMutationRootIdentity(knownRoot) !== workspaceMutationRootIdentity(workspace.path)
  )
    throw new Error('The legacy Plasmid has no matching active owning project.');
  const configuredRoots = developerImportSourceRootsInDb(db);
  const roots = [
    ...new Set([...configuredRoots, ...configuredRoots.map(workspaceMutationRootIdentity)]),
  ];
  if (
    isDeveloperImportSourcePath(workspace.path, roots) ||
    isDeveloperImportSourcePath(input.metadataPath, roots)
  )
    throw new Error('Legacy Plasmid import-source files cannot be reconstructed.');
  return { workspace, roots, rootIdentity: workspaceMutationRootIdentity(workspace.path) };
}

function readRecord(db: Database.Database, id: string) {
  const row = db.prepare<[string], LimsEntityRow>('SELECT * FROM lims_entity WHERE id=?').get(id);
  return row ? { row, entity: limsEntityFromRow(row) } : null;
}

function readSchema(db: Database.Database) {
  const rows = db
    .prepare<
      [],
      LimsSchemaRow
    >("SELECT * FROM lims_schema WHERE kind='entity' AND name='plasmid' AND tombstone=0 LIMIT 2")
    .all();
  if (rows.length !== 1) throw new Error('The current Plasmid sequence schema is unavailable.');
  const row = rows[0];
  const definition = parseLimsSchemaFields(row.fields);
  if (definition.baseKind !== 'sequence')
    throw new Error('The current Plasmid schema is not sequence-backed.');
  return {
    schemaId: row.id,
    currentRevisionId: row.current_revision_id ?? `${row.id}-v${row.version}`,
    entityKind: row.name,
    baseKind: definition.baseKind,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    fields: definition.fields,
  };
}

function checkedRecordLocation(
  db: Database.Database,
  record: NonNullable<ReturnType<typeof readRecord>>,
  input: LegacyAcceptedPlasmidReconstructionInput,
  packageRoot: string,
  productPath: string,
  requireSourceOwner: boolean
) {
  const bindings = db
    .prepare<
      [string],
      BindingRow
    >("SELECT id,entity_id,workspace_id,path,file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current' LIMIT 3")
    .all(record.entity.id);
  const catalog = db
    .prepare<
      [string],
      CatalogRow
    >('SELECT id,type,workspace_id,locator,storage_type,status FROM catalog_entities WHERE id=?')
    .get(record.entity.id);
  const matchesPath = (path: string) =>
    isAbsolute(path) &&
    [packageRoot, productPath, input.metadataPath].some(
      (candidate) =>
        workspaceMutationRootIdentity(candidate) === workspaceMutationRootIdentity(path)
    );
  if (record.entity.workspaceId != null && record.entity.workspaceId !== input.workspaceId)
    throw new Error('The legacy Plasmid Registry owner belongs to another project.');
  if (
    catalog &&
    (catalog.type !== 'sequence' ||
      (catalog.workspace_id != null && catalog.workspace_id !== input.workspaceId) ||
      !['active', 'archived'].includes(catalog.status))
  )
    throw new Error('The legacy Plasmid native catalog owner does not match.');
  if (
    bindings.length > 1 ||
    bindings.some(
      (binding) => binding.workspace_id !== input.workspaceId || !matchesPath(binding.path)
    )
  )
    throw new Error('The legacy Plasmid has no unique matching current file owner.');
  const managed = readManagedSequenceDocumentRef(
    record.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  if (
    Object.hasOwn(record.entity.fields, MANAGED_SEQUENCE_DOCUMENT_FIELD) &&
    (!managed ||
      managed.packageId !== input.packageId ||
      !isAbsolute(managed.packageRoot) ||
      workspaceMutationRootIdentity(managed.packageRoot) !==
        workspaceMutationRootIdentity(packageRoot))
  )
    throw new Error('The legacy Plasmid managed locator does not match the source.');
  const sequence = record.entity.fields.sequence;
  const historicalPathMatches =
    sequence &&
    typeof sequence === 'object' &&
    'mode' in sequence &&
    sequence.mode === 'file' &&
    'relPath' in sequence &&
    typeof sequence.relPath === 'string' &&
    isAbsolute(sequence.relPath) &&
    workspaceMutationRootIdentity(sequence.relPath) === workspaceMutationRootIdentity(productPath);
  const catalogPathMatches =
    catalog?.storage_type === 'file' &&
    catalog.workspace_id === input.workspaceId &&
    matchesPath(catalog.locator);
  if (
    requireSourceOwner &&
    bindings.length === 0 &&
    !catalogPathMatches &&
    !historicalPathMatches &&
    !(managed && record.entity.workspaceId === input.workspaceId)
  )
    throw new Error('The legacy Plasmid has no checked source-backed owner.');
  return { bindings, catalog };
}

function checkedAuthority(
  db: Database.Database,
  input: LegacyAcceptedPlasmidReconstructionInput,
  document: SequencePackageDocument,
  packageRoot: string,
  productPath: string
) {
  const project = checkedWorkspace(db, input);
  const productOwnerRoot = findKnownWorkspaceRoot(db, productPath);
  if (!productOwnerRoot || workspaceMutationRootIdentity(productOwnerRoot) !== project.rootIdentity)
    throw new Error('The legacy Plasmid product belongs to a different project.');
  const current = readRecord(db, document.id);
  const legacyId = legacyAcceptedPlasmidProjectionId(document);
  const legacyRecord = legacyId ? readRecord(db, legacyId) : null;
  const legacy =
    legacyRecord &&
    matchesLegacyAcceptedPlasmidProjection(document, packageRoot, legacyRecord.entity)
      ? legacyRecord
      : null;
  const source = legacy ?? current;
  if (!source || !needsLegacyAcceptedPlasmidReconstruction(document, source.entity)) return null;
  const schema = readSchema(db);
  const sourceLocation = checkedRecordLocation(db, source, input, packageRoot, productPath, true);
  const currentLocation =
    current && current !== source
      ? checkedRecordLocation(db, current, input, packageRoot, productPath, false)
      : null;
  const keys = new Set([
    ...schema.fields.map((field) => field.key),
    'acceptedAssemblyVersionId',
    'sequence',
    MANAGED_SEQUENCE_DOCUMENT_FIELD,
    MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD,
  ]);
  const recordIdentity = (record: NonNullable<ReturnType<typeof readRecord>> | null) =>
    record && {
      id: record.row.id,
      kind: record.row.kind,
      schemaId: record.row.schema_id,
      schemaRevisionId: record.row.schema_revision_id,
      workspaceId: record.row.workspace_id,
      registryId: record.entity.registryId,
      registrationStatus: record.entity.registrationStatus,
      domainStatus: record.entity.domainStatus,
      tombstone: record.row.tombstone,
      archivedAt: record.row.archived_at,
      fields: Object.fromEntries(
        Object.entries(record.entity.fields).filter(([key]) => keys.has(key))
      ),
    };
  const scope = db
    .prepare<
      [number],
      {
        workspace_uuid: string;
        owner_account_id: string;
        owner_org_id: string | null;
        remote_workspace_id: string | null;
      }
    >(
      'SELECT workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id FROM workspace_sync_bindings WHERE workspace_id=?'
    )
    .get(input.workspaceId);
  return {
    project,
    source: source.entity,
    schema,
    registryId: current?.entity.registryId ?? null,
    snapshot: {
      project,
      source: recordIdentity(source),
      current: recordIdentity(current),
      sourceLocation,
      currentLocation,
      schema,
      scope,
    },
  };
}

export async function reconstructLegacyAcceptedPlasmidInMain(request: {
  db: Database.Database;
  runDatabase: <T>(operation: () => T) => T;
  input: LegacyAcceptedPlasmidReconstructionInput;
}): Promise<LegacyAcceptedPlasmidReconstructionResult> {
  const { db, runDatabase, input } = request;
  const project = runDatabase(() => checkedWorkspace(db, input));
  const relativePath =
    pathRelativeToBoundary(input.metadataPath, project.workspace.path) ??
    pathRelativeToBoundary(input.metadataPath, project.rootIdentity);
  if (!relativePath || !isSafeWorkspaceRelativePath(relativePath))
    throw new Error('The legacy Plasmid metadata has no checked project-relative path.');
  const marker = await canonicalWorkspacePath({
    workspaceRoot: project.rootIdentity,
    path: resolve(project.rootIdentity, relativePath),
    artifactNoun: 'legacy Plasmid metadata',
  });
  const packageRoot = sequencePackageRootForMetaPath(marker.candidate);
  const recordedPackageRoot = sequencePackageRootForMetaPath(input.metadataPath);
  if (!packageRoot || !recordedPackageRoot)
    throw new Error('The legacy Plasmid metadata path is invalid.');
  const metadata = await readStableSource(marker.candidate, MAX_WORKSPACE_BINARY_WRITE_BYTES);
  if (metadata.hash !== input.expectedMetadataSha256)
    throw new Error('The legacy Plasmid metadata changed after it was read.');
  const document = parseSequencePackageDocument(
    new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes)
  );
  if (document.id !== input.packageId)
    throw new Error('The legacy Plasmid package identity does not match.');
  const product = await canonicalWorkspacePath({
    workspaceRoot: marker.root,
    path: fromPackageRelative(document.product.file, packageRoot),
    artifactNoun: 'legacy Plasmid product',
  });
  const recordedProductPath = fromPackageRelative(document.product.file, recordedPackageRoot);
  const authority = runDatabase(() =>
    checkedAuthority(db, input, document, recordedPackageRoot, recordedProductPath)
  );
  if (!authority) return { kind: 'not-applicable' };
  if (!isDeepStrictEqual(project, authority.project))
    throw new Error('The legacy Plasmid project changed while reading its source.');
  if (
    isDeveloperImportSourcePath(marker.candidate, authority.project.roots) ||
    isDeveloperImportSourcePath(product.candidate, authority.project.roots)
  )
    throw new Error('Legacy Plasmid import-source files cannot be reconstructed.');
  const productSource = await readStableSource(product.candidate, HARD_CAP_BYTES);
  if (productSource.hash !== input.expectedProductSha256)
    throw new Error('The legacy Plasmid product changed after its summary was read.');
  return withRecoveredSequencePackageMutationInMain(
    marker.root,
    packageRoot,
    async () => {
      await assertLegacySequenceMetadataTransactionSettledInMain(marker.root, packageRoot);
      const assertCurrent = () => {
        const current = runDatabase(() =>
          checkedAuthority(db, input, document, recordedPackageRoot, recordedProductPath)
        );
        if (!current || !isDeepStrictEqual(current.snapshot, authority.snapshot))
          throw new Error(
            'The legacy Plasmid reconstruction authority changed before publication.'
          );
        assertFileCurrent(marker.candidate, metadata.witness);
        assertFileCurrent(product.candidate, productSource.witness);
      };
      assertCurrent();
      const adopted = buildLegacyAcceptedPlasmidReconstruction({
        document,
        source: authority.source,
        schema: authority.schema,
        registryId: authority.registryId,
        updatedAt: new Date().toISOString(),
      });
      const content = serializeSequencePackageDocument(adopted);
      if (Buffer.byteLength(content, 'utf8') > MAX_WORKSPACE_BINARY_WRITE_BYTES)
        throw new Error('Reconstructed legacy Plasmid metadata exceeds the Files size limit.');
      const result = await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: marker.root,
          path: marker.candidate,
          content,
          mode: 'replace',
          expectedContentHash: input.expectedMetadataSha256,
          artifactNoun: 'legacy Plasmid metadata',
        },
        { durable: true, beforePublish: assertCurrent }
      );
      return { kind: 'published', metadataSha256: result.contentHash };
    },
    createRegisteredSequencePackagePublicationContext({ db, runDatabase })
  );
}
