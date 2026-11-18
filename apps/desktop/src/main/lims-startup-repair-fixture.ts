import type Database from 'better-sqlite3';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseSequencePackageDocument, sequencePackageMetaPaths } from '../db/sequence-package';
import { entitySchemaRevisionContent } from '../shared/entity-schema';
import type {
  SeedMissingAuthorityArchiveRequest,
  SeedMissingAuthorityArchiveResult,
} from '../shared/internal-fixtures';
import { limsEntityFromRow, type LimsEntity, type LimsEntityRow } from '../shared/lims';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import {
  NATIVE_ENTITY_PROJECTION_VERSIONS,
  readCanonicalFileRegistryProjection,
  readNativeProjectionSources,
  resolveNativeProjectionSourceOwner,
  type NativeFileRegistryProjection,
} from './entity-projection-receipts';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';
import { reconstructFileBackedRegistryEntity } from './file-backed-registry-mutation';
import { archiveLimsEntityInDb } from './lims';
import { hasAcceptedScientificWorkspace } from './scientific-object-store';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';

const REGISTER_ACTOR = 'e2e-startup-repair-seed';
const ARCHIVE_ACTOR = 'workspace-reconcile-missing-authority';

export class LimsStartupRepairFixturePublicationError extends Error {
  readonly code = 'LIMS_STARTUP_REPAIR_FIXTURE_INCOMPLETE';
  readonly stateMayHaveChanged = true;

  constructor(
    readonly entityId: string,
    cause: unknown
  ) {
    super(
      `LIMS_STARTUP_REPAIR_FIXTURE_INCOMPLETE: Registry state for ${entityId} was retained. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

async function physicalDirectory(root: string, path: string) {
  const relativePath = relative(root, path);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
    throw new Error('The historical sequence package must stay inside its owning project.');
  let current = root;
  let stat = await lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error('The historical fixture requires a physical canonical project directory.');
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('The historical fixture cannot traverse symbolic links or non-directories.');
  }
  return stat;
}

function currentEntity(db: Database.Database, id: string): LimsEntity | null {
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as
    | LimsEntityRow
    | undefined;
  return row ? limsEntityFromRow(row) : null;
}

function assertCanonicalEntity(
  db: Database.Database,
  entity: LimsEntity,
  canonical: NativeFileRegistryProjection
): asserts entity is LimsEntity & { eventSeq: number } {
  if (
    entity.id !== canonical.id ||
    entity.kind !== canonical.kind ||
    entity.name !== canonical.name ||
    entity.workspaceId !== canonical.workspaceId ||
    entity.schemaRevisionId !== canonical.schemaSnapshot?.schemaRevisionId ||
    entity.schemaId !== canonical.schemaSnapshot?.schemaId ||
    entity.registrationStatus !== canonical.registrationStatus ||
    entity.domainStatus !== canonical.domainStatus ||
    entity.tombstone ||
    entity.archivedAt !== null ||
    typeof entity.eventSeq !== 'number' ||
    !Number.isSafeInteger(entity.eventSeq) ||
    entity.eventSeq < 1 ||
    !isDeepStrictEqual(entity.fields, canonical.fields) ||
    !canonical.schemaSnapshot ||
    !isDeepStrictEqual(
      entitySchemaRevisionContent(readEntitySchemaSnapshotInDb(db, entity.id)),
      entitySchemaRevisionContent(canonical.schemaSnapshot)
    )
  )
    throw new Error('The historical fixture cannot replace existing Registry state.');
}

export async function seedMissingAuthorityArchiveInMain({
  db,
  input,
  assertCurrent,
}: {
  db: Database.Database;
  input: SeedMissingAuthorityArchiveRequest;
  assertCurrent: () => void;
}): Promise<SeedMissingAuthorityArchiveResult> {
  const fields = ['workspaceRoot', 'packageRelativeRoot', 'expectedPackageId'];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== fields.length ||
    fields.some((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      return (
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        !descriptor.value.trim() ||
        descriptor.value.includes('\0')
      );
    }) ||
    !isAbsolute(input.workspaceRoot) ||
    !isSafeWorkspaceRelativePath(input.packageRelativeRoot) ||
    input.packageRelativeRoot.includes('\\')
  )
    throw new Error('The historical fixture requires an exact project, package and identity.');

  const checkCurrent = () => {
    const checked: unknown = assertCurrent();
    if (checked !== undefined) {
      void Promise.resolve(checked).catch(() => undefined);
      throw new Error('Historical fixture authority must be checked synchronously.');
    }
    assertKnownWorkspaceContentWritable(db, input.workspaceRoot);
    const owners = db
      .prepare(
        `SELECT id,path FROM workspaces WHERE path=?
         AND access_mode='writable' AND archived_at IS NULL AND trashed_at IS NULL`
      )
      .all(input.workspaceRoot) as Array<{ id: number; path: string }>;
    if (owners.length !== 1)
      throw new Error('The historical fixture requires one exact active writable project.');
    const owner = owners[0];
    if (
      hasAcceptedScientificWorkspace(db, owner.id) ||
      db
        .prepare('SELECT 1 FROM org_registry_local_records WHERE entity_id=?')
        .get(input.expectedPackageId)
    )
      throw new Error(
        'The historical fixture cannot change accepted or registered sequence ownership.'
      );
    return owner;
  };
  const workspace = checkCurrent();
  const runDatabase = <T>(work: () => T): T => {
    const current = checkCurrent();
    if (current.id !== workspace.id)
      throw new Error('The historical fixture project owner changed.');
    return work();
  };
  const packageRoot = join(input.workspaceRoot, input.packageRelativeRoot);
  const rootIdentity = await physicalDirectory(input.workspaceRoot, input.workspaceRoot);
  const packageIdentity = await physicalDirectory(input.workspaceRoot, packageRoot);
  const markers: string[] = [];
  for (const path of sequencePackageMetaPaths(packageRoot)) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('The historical package marker must be a physical regular file.');
    markers.push(path);
  }
  if (markers.length !== 1)
    throw new Error('The historical fixture requires one exact current package marker.');
  await physicalDirectory(input.workspaceRoot, dirname(markers[0]));
  const owner = runDatabase(() =>
    resolveNativeProjectionSourceOwner(db, {
      adapterKind: 'sequence',
      entityId: input.expectedPackageId,
      workspaceKey: `workspace:${workspace.id}`,
      relativePath: relative(input.workspaceRoot, markers[0]).split(sep).join('/'),
      projectionVersion: NATIVE_ENTITY_PROJECTION_VERSIONS.sequence,
    })
  );
  const markerSources = await readNativeProjectionSources(owner);
  const document = parseSequencePackageDocument(await markerSources.readTextFile(owner.sourcePath));
  if (document.id !== input.expectedPackageId || document.entity.lifecycle?.archived)
    throw new Error('The historical fixture requires its exact live sequence package identity.');
  const snapshot = await readCanonicalFileRegistryProjection(db, owner, runDatabase);
  const canonical = snapshot.canonical;
  if (
    canonical.id !== document.id ||
    canonical.workspaceId !== workspace.id ||
    canonical.archived ||
    !canonical.schemaSnapshot
  )
    throw new Error('The historical fixture has no complete canonical package projection.');
  const existing = runDatabase(() => currentEntity(db, canonical.id));
  runDatabase(() => {
    if (existing) assertCanonicalEntity(db, existing, canonical);
    else if (
      db
        .prepare("SELECT 1 FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=?")
        .get(canonical.id)
    )
      throw new Error('The historical fixture cannot replace retained Registry history.');
  });
  const assertSourcesCurrent = async () => {
    runDatabase(() => {});
    const root = await physicalDirectory(input.workspaceRoot, input.workspaceRoot);
    const source = await physicalDirectory(input.workspaceRoot, packageRoot);
    if (
      root.dev !== rootIdentity.dev ||
      root.ino !== rootIdentity.ino ||
      source.dev !== packageIdentity.dev ||
      source.ino !== packageIdentity.ino
    )
      throw new Error('The historical fixture source directory changed.');
    await markerSources.assertUnchanged();
    await snapshot.assertSourcesUnchanged();
    runDatabase(() => {});
  };
  await assertSourcesCurrent();
  let projectionInstalled = false;
  try {
    const registered = await reconstructFileBackedRegistryEntity(
      db,
      {
        action: 'register',
        input: {
          id: canonical.id,
          kind: canonical.kind,
          name: canonical.name,
          fields: canonical.fields,
          workspaceId: workspace.id,
          schemaRevisionId: canonical.schemaSnapshot.schemaRevisionId,
          schemaSnapshot: canonical.schemaSnapshot,
          registrationStatus: canonical.registrationStatus,
          domainStatus: canonical.domainStatus,
          actor: REGISTER_ACTOR,
        },
      },
      runDatabase
    );
    if (!registered) throw new Error('The native package Registry publication was not installed.');
    projectionInstalled = true;
    runDatabase(() => assertCanonicalEntity(db, registered, canonical));
    await assertSourcesCurrent();
    const archived = runDatabase(() => {
      const current = currentEntity(db, canonical.id);
      if (!current || current.eventSeq !== registered.eventSeq)
        throw new Error('The historical fixture Registry state changed before archiving.');
      assertCanonicalEntity(db, current, canonical);
      return archiveLimsEntityInDb(db, {
        id: canonical.id,
        expectedEventSeq: current.eventSeq,
        actor: ARCHIVE_ACTOR,
      });
    });
    await assertSourcesCurrent();
    return runDatabase(() => {
      const current = currentEntity(db, canonical.id);
      const event = db
        .prepare(
          `SELECT event_type,actor,event_seq,after FROM lims_audit
           WHERE subject_table='lims_entity' AND subject_id=? ORDER BY event_seq DESC LIMIT 1`
        )
        .get(canonical.id) as
        | { event_type: string; actor: string; event_seq: number; after: string | null }
        | undefined;
      if (
        !current ||
        !isDeepStrictEqual(current, archived) ||
        !current.tombstone ||
        current.actor !== ARCHIVE_ACTOR ||
        typeof current.eventSeq !== 'number' ||
        !Number.isSafeInteger(current.eventSeq) ||
        event?.event_type !== 'entity_archived' ||
        event.actor !== ARCHIVE_ACTOR ||
        event.event_seq !== current.eventSeq ||
        !event.after ||
        !isDeepStrictEqual(JSON.parse(event.after), current)
      )
        throw new Error('The historical archive publication could not be read back exactly.');
      return {
        entityId: current.id,
        workspaceId: workspace.id,
        archiveEventSeq: current.eventSeq,
      };
    });
  } catch (cause) {
    if (projectionInstalled)
      throw new LimsStartupRepairFixturePublicationError(input.expectedPackageId, cause);
    throw cause;
  }
}
