import {
  commitSavedFileSource,
  captureSavedFileMembers,
  prepareSavedFileSource,
  recordSavedFilePublicationWitness,
} from './saved-file-sources';
import { assertSharedProjectContentWritable } from './shared-project-write-access';
import { open, readFile } from 'node:fs/promises';
import {
  mutateEntityArtifact as mutatePublishedEntityArtifact,
  recoverEntityArtifactPublications,
  resolveEntityArtifactAuthority,
} from './entity-artifact-mutations';
import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { entitySchemaRevisionContent } from '../shared/entity-schema';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';
import {
  assertRelationshipSchemaSnapshotsMatchInDb,
  readRelationshipSchemaSnapshotInDb,
} from './relationship-schema-snapshot';
import { parseEntityArtifact, serializeEntityArtifact } from '../shared/entity-artifact';
import {
  limsEntityFromRow,
  type LimsUpdateEntityInput,
  type LimsEntityActionInput,
  type LimsRevertEntityResult,
  type LimsReplaceOutgoingRelationshipsInput,
  type LimsReplaceOutgoingRelationshipsResult,
  type LimsLinkRow,
  limsLinkFromRow,
} from '../shared/lims';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import { replaceLimsOutgoingRelationshipsInsideTx } from './lims-relationship-projection';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';
import { getEntityRowById, insertAuditEvent, updateLimsEntityInsideTx } from './lims-engine-core';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  revertLimsEntityInsideTx,
} from './lims-entity-lifecycle';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import {
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function sameTargetSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function readRelationshipTarget(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size > MAX_WORKSPACE_BINARY_WRITE_BYTES
    )
      throw new Error(
        'Relationship target must be a regular portable file within the Files size bound.'
      );
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        count,
        Math.min(1024 * 1024, bytes.length - count),
        count
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== before.size || !sameTargetSnapshot(before, await file.stat()))
      throw new Error('Relationship target changed during inspection.');
    return {
      artifact: parseEntityArtifact(bytes.subarray(0, count).toString('utf8')),
      stat: before,
    };
  } finally {
    await file.close();
  }
}
type Mutation = { db: Database.Database; runDatabase: <T>(operation: () => T) => T } & (
  | { action: 'update'; input: LimsUpdateEntityInput }
  | { action: 'archive' | 'restore' | 'revert'; input: LimsEntityActionInput }
  | {
      action: 'relationships';
      input: LimsEntityActionInput & Pick<LimsReplaceOutgoingRelationshipsInput, 'relationships'>;
    }
);
type ArtifactMutationResult = LimsRevertEntityResult & {
  relationships?: LimsReplaceOutgoingRelationshipsResult;
};

export async function mutateEntityArtifact(request: Mutation): Promise<ArtifactMutationResult> {
  request.runDatabase(() => {
    const entity = limsEntityFromRow(getEntityRowById(request.db, request.input.id));
    const owner = resolveEntityArtifactAuthority(request.db, entity);
    assertSharedProjectContentWritable(request.db, owner.workspacePath);
  });
  const legacyReceipt = request.runDatabase(() =>
    request.db
      .prepare('SELECT 1 FROM lims_audit WHERE idempotency_key=?')
      .get(`entity-artifact:${request.input.operationId}`)
  );
  if (request.action === 'relationships' || legacyReceipt)
    return mutateLegacyEntityArtifact(request);
  if (request.action === 'revert') {
    const latest = request.runDatabase(() =>
      request.db
        .prepare(
          "SELECT payload FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? AND event_type='entity_artifact_saved' ORDER BY event_seq DESC LIMIT 1"
        )
        .get(request.input.id)
    ) as { payload: string } | undefined;

    if (
      latest &&
      (JSON.parse(latest.payload) as { result: ArtifactMutationResult }).result.entity.eventSeq ===
        request.input.expectedEventSeq
    )
      return mutateLegacyEntityArtifact(request);
  }
  return mutatePublishedEntityArtifact(request);
}

async function mutateLegacyEntityArtifact(request: Mutation): Promise<ArtifactMutationResult> {
  const { db, runDatabase, input, action } = request;
  if (input.expectedEventSeq === undefined || !input.operationId)
    throw new Error(
      'Refresh this record before changing it; its current edit version and operation ID are required.'
    );
  const operationKey = `entity-artifact:${input.operationId}`;
  const requestHash = digest(
    nativeMutationRequestBytes({ action, input }, NATIVE_MUTATION_REQUEST_VERSION)
  );
  const prior = runDatabase(() =>
    db.prepare('SELECT payload FROM lims_audit WHERE idempotency_key=?').get(operationKey)
  ) as { payload: string } | undefined;
  if (prior) {
    const receipt = JSON.parse(prior.payload) as {
      requestHash: string;
      result: ArtifactMutationResult;
    };
    if (receipt.requestHash !== requestHash)
      throw new Error('Record operation ID was reused with a different request.');

    runDatabase(() =>
      materializeLimsGitReadableExportInDb(db, {
        workspaceId: receipt.result.entity.workspaceId,
        durable: true,
      })
    );
    return receipt.result;
  }
  const before = runDatabase(() => limsEntityFromRow(getEntityRowById(db, input.id)));
  if (!isEntityRecordArtifactProjection(before.fields))
    throw new Error('Use the owning native document command for this record.');
  if (before.eventSeq !== input.expectedEventSeq)
    throw new Error('Record changed since it was inspected.');
  const workspace = runDatabase(() =>
    db
      .prepare('SELECT path,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?')
      .get(before.workspaceId)
  ) as
    | {
        path: string;
        access_mode: string | null;
        archived_at: number | null;
        trashed_at: number | null;
      }
    | undefined;
  if (
    !workspace ||
    workspace.access_mode === 'reference' ||
    workspace.archived_at !== null ||
    workspace.trashed_at !== null
  )
    throw new Error('The record owner is not an active writable project.');
  await recoverEntityArtifactPublications({ db, runDatabase, workspacePath: workspace.path });
  const owner = runDatabase(() => resolveEntityArtifactAuthority(db, before));
  if (owner.workspacePath !== workspace.path) throw new Error('Record file owner changed.');
  const { candidate: path, root: workspaceRoot } = await canonicalWorkspacePath({
    workspaceRoot: workspace.path,
    path: join(workspace.path, owner.relativePath),
    artifactNoun: 'registry record',
  });
  const previousBytes = await readFile(path, 'utf8');
  const artifact = parseEntityArtifact(previousBytes);
  let relationshipSchemaSnapshots = artifact.relationshipSchemaSnapshots;
  runDatabase(() => assertRelationshipSchemaSnapshotsMatchInDb(db, relationshipSchemaSnapshots));
  const targetSnapshots = new Map<string, Stats>();
  let relationshipChanges: LimsReplaceOutgoingRelationshipsInput['relationships'] | undefined;
  if (action === 'relationships') relationshipChanges = input.relationships;
  if (action === 'revert') {
    const latest = runDatabase(() =>
      db
        .prepare(
          "SELECT payload FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? AND event_type='entity_artifact_saved' ORDER BY event_seq DESC LIMIT 1"
        )
        .get(before.id)
    ) as { payload: string } | undefined;
    if (latest) {
      const receipt = JSON.parse(latest.payload) as {
        result: ArtifactMutationResult;
        previousRelationships?: typeof artifact.relationships;
        previousRelationshipSchemaSnapshots?: typeof artifact.relationshipSchemaSnapshots;
      };

      if (
        receipt.result.entity.eventSeq === before.eventSeq &&
        receipt.previousRelationships !== undefined
      ) {
        const previous = parseEntityArtifact(
          serializeEntityArtifact({
            ...artifact,
            relationships: receipt.previousRelationships,
            relationshipSchemaSnapshots: receipt.previousRelationshipSchemaSnapshots,
          })
        ).relationships;
        if (!isDeepStrictEqual(previous, artifact.relationships)) {
          relationshipChanges = previous;
          relationshipSchemaSnapshots = receipt.previousRelationshipSchemaSnapshots;
        }
      }
    }
  }
  if (
    artifact.id !== before.id ||
    artifact.kind !== before.kind ||
    (artifact.schemaSnapshot !== undefined &&
      !isDeepStrictEqual(
        entitySchemaRevisionContent(artifact.schemaSnapshot),
        runDatabase(() => entitySchemaRevisionContent(readEntitySchemaSnapshotInDb(db, before.id)))
      )) ||
    artifact.name !== before.name ||
    !isDeepStrictEqual(artifact.fields, before.fields) ||
    artifact.registrationStatus !== before.registrationStatus ||
    artifact.domainStatus !== before.domainStatus ||
    Boolean(artifact.archived) !== before.tombstone
  ) {
    throw new Error('Record file and Registry differ. Reconcile the project before editing.');
  }
  if (action === 'update') {
    if (input.workspaceId !== undefined && input.workspaceId !== before.workspaceId)
      throw new Error('Move records through the Files command, not a field edit.');
    for (const key of ['artifact', 'sourceMetadata']) {
      if (
        input.fields &&
        Object.hasOwn(input.fields, key) &&
        !isDeepStrictEqual(input.fields[key], before.fields[key])
      )
        throw new Error('Record source and file identity cannot be replaced by a field edit.');
    }
  }
  if (relationshipChanges !== undefined) {
    if (before.tombstone)
      throw new Error('Restore the archived record before editing relationships.');
    if (!Array.isArray(relationshipChanges))
      throw new Error('Supply the complete outgoing relationship list.');
    const captured = new Map(
      (relationshipSchemaSnapshots ?? []).map((snapshot) => [snapshot.name, snapshot])
    );
    relationshipSchemaSnapshots = [];
    for (const type of new Set(relationshipChanges.map((relationship) => relationship.type))) {
      const snapshot =
        captured.get(type) ?? runDatabase(() => readRelationshipSchemaSnapshotInDb(db, type));
      if (snapshot) relationshipSchemaSnapshots.push(snapshot);
    }
    const projected = runDatabase(() =>
      (
        db
          .prepare('SELECT * FROM lims_link WHERE from_entity_id=? AND tombstone=0')
          .all(before.id) as LimsLinkRow[]
      )
        .map(limsLinkFromRow)
        .map(({ type, fromEntityId, toEntityId, payload }) => ({
          type,
          fromEntityId,
          toEntityId,
          payload,
        }))
    );
    const sorted = <T extends { type: string; toEntityId: string }>(values: readonly T[]) =>
      [...values].sort((a, b) =>
        JSON.stringify([a.type, a.toEntityId]).localeCompare(JSON.stringify([b.type, b.toEntityId]))
      );
    if (!isDeepStrictEqual(sorted(artifact.relationships), sorted(projected)))
      throw new Error(
        'Record relationships and Registry differ. Reconcile the project before editing.'
      );
    for (const relationship of relationshipChanges) {
      if (
        !relationship ||
        typeof relationship.toEntityId !== 'string' ||
        typeof relationship.type !== 'string'
      )
        throw new Error('Relationship target and type are required.');
      const target = runDatabase(() =>
        limsEntityFromRow(getEntityRowById(db, relationship.toEntityId))
      );
      if (
        target.workspaceId !== before.workspaceId ||
        target.tombstone ||
        !isEntityRecordArtifactProjection(target.fields)
      )
        throw new Error('Choose an active portable record in the same project.');
      const targetLocator = target.fields.artifact as { relativePath?: unknown };
      if (typeof targetLocator?.relativePath !== 'string')
        throw new Error('Relationship target file binding is missing.');
      const targetPath = await canonicalWorkspacePath({
        workspaceRoot,
        path: join(workspaceRoot, targetLocator.relativePath),
        artifactNoun: 'relationship target',
      });
      const targetSnapshot = await readRelationshipTarget(targetPath.candidate);
      const targetArtifact = targetSnapshot.artifact;
      if (
        targetArtifact.id !== target.id ||
        targetArtifact.kind !== target.kind ||
        targetArtifact.archived
      )
        throw new Error('Relationship target file changed. Reconcile the project before editing.');
      targetSnapshots.set(targetPath.candidate, targetSnapshot.stat);
    }
  }
  const applyInsideTx = (): ArtifactMutationResult => {
    if (getEntityRowById(db, input.id).event_seq !== input.expectedEventSeq)
      throw new Error('Record changed while saving.');
    if (action === 'update')
      return { reverted: false, entity: updateLimsEntityInsideTx(db, input) };
    if (action === 'relationships') {
      const entity = updateLimsEntityInsideTx(db, { id: input.id, actor: input.actor });
      return {
        reverted: false,
        entity,
        relationships: replaceLimsOutgoingRelationshipsInsideTx(db, {
          entityId: input.id,
          relationships: input.relationships,
          schemaSnapshots: relationshipSchemaSnapshots,
          actor: input.actor,
          workspaceId: before.workspaceId,
        }),
      };
    }
    if (action === 'revert') {
      const result = revertLimsEntityInsideTx(db, input, { preserveArtifactBinding: true });
      return {
        ...result,
        ...(relationshipChanges !== undefined
          ? {
              relationships: replaceLimsOutgoingRelationshipsInsideTx(db, {
                entityId: input.id,
                relationships: relationshipChanges,
                schemaSnapshots: relationshipSchemaSnapshots,
                actor: input.actor,
                workspaceId: before.workspaceId,
              }),
            }
          : {}),
      };
    }
    return {
      reverted: false,
      entity:
        action === 'archive'
          ? archiveLimsEntityInsideTx(db, input)
          : restoreLimsEntityInsideTx(db, input).entity,
    };
  };

  const probeComplete = new Error('validation complete');
  let proposed: ArtifactMutationResult | undefined;
  runDatabase(() => {
    try {
      db.transaction(() => {
        proposed = applyInsideTx();
        throw probeComplete;
      })();
    } catch (error) {
      if (error !== probeComplete) throw error;
    }
  });
  if (!proposed) throw new Error('Native record validation did not return its result.');
  const after = proposed.entity;
  const nextBytes = serializeEntityArtifact({
    ...artifact,
    name: after.name,
    fields: after.fields,
    registrationStatus: after.registrationStatus,
    domainStatus: after.domainStatus,
    archived: after.tombstone,
    ...(proposed.relationships !== undefined
      ? {
          relationships: proposed.relationships.active.map(
            ({ type, fromEntityId, toEntityId, payload }) => ({
              type,
              fromEntityId,
              toEntityId,
              payload,
            })
          ),
          relationshipSchemaSnapshots,
        }
      : {}),
  });
  const source = { workspaceId: owner.workspaceId, entityId: input.id, path };
  await captureSavedFileMembers(
    db,
    { ...source, members: [{ relativePath: '', bytes: Buffer.from(previousBytes) }] },
    () => runDatabase(() => {})
  );
  const candidate = await prepareSavedFileSource(db, {
    ...source,
    members: [{ relativePath: '', bytes: Buffer.from(nextBytes) }],
  });
  const write = await writeWorkspaceTextFileAtomicInMain(
    {
      workspaceRoot,
      path,
      content: nextBytes,
      mode: 'replace',
      expectedContentHash: digest(previousBytes),
      artifactNoun: 'registry record',
    },
    {
      durable: true,
      beforePublish: (stagedPath) =>
        runDatabase(() => {
          if (getEntityRowById(db, input.id).event_seq !== input.expectedEventSeq)
            throw new Error('Record changed while saving.');
          for (const [targetPath, snapshot] of targetSnapshots) {
            const current = lstatSync(targetPath);
            if (
              !current.isFile() ||
              realpathSync(targetPath) !== targetPath ||
              !sameTargetSnapshot(snapshot, current)
            )
              throw new Error(
                'Relationship target changed during publication. Reconcile the project before editing.'
              );
          }
          recordSavedFilePublicationWitness(db, candidate, stagedPath);
        }),
    }
  );
  let result: ArtifactMutationResult;
  try {
    result = runDatabase(() =>
      db.transaction(() => {
        const result = applyInsideTx();
        commitSavedFileSource(db, candidate);
        insertAuditEvent(db, {
          eventType: 'entity_artifact_saved',
          operationId: input.operationId,
          idempotencyKey: operationKey,
          subjectTable: 'lims_entity',
          subjectId: input.id,
          workspaceId: before.workspaceId,
          actor: input.actor,
          payload: {
            requestHash,
            result,
            previousRelationships: artifact.relationships,
            previousRelationshipSchemaSnapshots: artifact.relationshipSchemaSnapshots ?? [],
          },
        });
        return result;
      })()
    );
  } catch (error) {
    try {
      await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot,
          path,
          content: previousBytes,
          mode: 'replace',
          expectedContentHash: write.contentHash,
          artifactNoun: 'registry record',
        },
        { durable: true }
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Record file was published but its Registry update failed; the file remains authoritative and needs reconciliation.'
      );
    }
    throw error;
  }
  runDatabase(() =>
    materializeLimsGitReadableExportInDb(db, { workspaceId: before.workspaceId!, durable: true })
  );
  return result;
}
