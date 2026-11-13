import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { limsEntityFromRow, type LimsEntity, type LimsEntityRow } from '../shared/lims';
import type {
  OrganizationRegistryCachedRecordDetails,
  OrganizationRegistryLocalAvailability,
  OrganizationRegistryRecordDetails,
  OrganizationRegistryRecordDetailsRequest,
} from '../shared/org-registry-sync';
import { registryRepresentationForEntity } from '../shared/registry-entity-opening';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { readCheckedEntityArtifactSnapshot } from './entity-artifact-mutations';
import { readOrgRegistryRecordDetails } from './org-registry-sync-cache';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import {
  readWorkspaceSyncAccessBinding,
  type WorkspaceSyncAccessBindingRow,
} from './workspace-sync-access-record';
import { withWorkspaceMutation } from './workspace-sync-mutation-lease';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';

type Home = {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
};
type FileBinding = { path: string; workspace_id: number | null; file_kind: string };
type LocalCandidate = {
  status: 'candidate';
  entity: LimsEntity;
  home: Home;
  binding: WorkspaceSyncAccessBindingRow;
  files: FileBinding[];
};
type Unavailable = Extract<OrganizationRegistryLocalAvailability, { status: 'unavailable' }>;

export async function readOrganizationRegistryRecordDetailsInDb(
  db: Database.Database,
  context: { accountId: string; orgId: string },
  request: OrganizationRegistryRecordDetailsRequest,
  assertCurrentAccount: () => Promise<void>
): Promise<OrganizationRegistryRecordDetails> {
  const readCached = () => readOrgRegistryRecordDetails(db, { ...context, ...request });
  const initial = readCached();
  const assertCachedCurrent = () => {
    const latest = readCached();

    const content = ({ scope: _scope, ...rest }: OrganizationRegistryCachedRecordDetails) => rest;
    if (!isDeepStrictEqual(content(initial), content(latest))) {
      throw Object.assign(
        new Error('This Registry record changed. Refresh Details before opening it.'),
        { code: 'FORBIDDEN' }
      );
    }
    return latest;
  };
  const candidate = readLocalCandidate(db, context, initial);
  if (candidate.status === 'unavailable') {
    await assertCurrentAccount();
    return { ...assertCachedCurrent(), local: candidate };
  }
  return withWorkspaceMutation(candidate.home.path, async () => {
    await assertCurrentAccount();
    assertCachedCurrent();
    if (!isDeepStrictEqual(readLocalCandidate(db, context, initial), candidate)) {
      return {
        ...assertCachedCurrent(),
        local: unavailable(
          'source_unavailable',
          'The local record or its home changed. Review it again before opening.'
        ),
      };
    }
    let verified: OrganizationRegistryLocalAvailability;
    try {
      if (!statSync(candidate.home.path).isDirectory())
        throw new Error('Project directory unavailable.');
      accessSync(candidate.home.path, constants.R_OK);
      const representation = registryRepresentationForEntity(candidate.entity);
      if (!representation.canOpen) {
        verified = unavailable(
          'no_saved_document',
          'This record has no saved local document that can be opened.'
        );
      } else {
        const source = localDocumentPath(candidate, representation.openTarget);
        if (!source) throw new Error('Saved local document unavailable.');
        assertWorkspaceProjectionPathSafe(candidate.home.path, source);
        const stat = statSync(source);
        if (!stat.isFile() && !stat.isDirectory())
          throw new Error('Saved local document unavailable.');
        accessSync(source, constants.R_OK);
        if (isEntityRecordArtifactProjection(candidate.entity.fields)) {
          const saved = await readCheckedEntityArtifactSnapshot({
            db,
            runDatabase: (work) => work(),
            entityId: candidate.entity.id,
          });
          if (
            saved.owner.workspaceId !== candidate.home.id ||
            !isDeepStrictEqual(saved.current, candidate.entity)
          ) {
            throw new Error('Saved record identity or home changed.');
          }
        }

        verified = {
          status: 'available',
          workspaceId: candidate.home.id,
          workspaceUuid: candidate.binding.workspace_uuid,
          homeWorkspaceId: initial.entity.homeWorkspaceId,
          summary: {
            id: candidate.entity.id,
            kind: candidate.entity.kind,
            name: candidate.entity.name,
            archived: candidate.entity.tombstone,
            representation,
          },
        };
      }
    } catch {
      verified = unavailable(
        'source_unavailable',
        'The saved local document could not be verified. Open its home project and resolve its saved state first.'
      );
    }
    await assertCurrentAccount();
    assertCachedCurrent();
    if (!isDeepStrictEqual(readLocalCandidate(db, context, initial), candidate)) {
      return {
        ...assertCachedCurrent(),
        local: unavailable(
          'source_unavailable',
          'The local record or its home changed. Review it again before opening.'
        ),
      };
    }
    return { ...assertCachedCurrent(), local: verified };
  });
}

function readLocalCandidate(
  db: Database.Database,
  context: { accountId: string; orgId: string },
  details: OrganizationRegistryCachedRecordDetails
): LocalCandidate | Unavailable {
  const row = db
    .prepare(`SELECT * FROM lims_entity WHERE id=? AND (${registrySourceEligibilitySql(db)})`)
    .get(details.entity.id) as LimsEntityRow | undefined;
  if (!row || row.tombstone || row.archived_at !== null) {
    return unavailable(
      'not_on_device',
      'No active saved copy of this record is available on this device.'
    );
  }
  const entity = limsEntityFromRow(row);
  const home =
    entity.workspaceId === null
      ? undefined
      : (db
          .prepare(
            'SELECT id,name,path,repo_uuid,archived_at,trashed_at FROM workspaces WHERE id=?'
          )
          .get(entity.workspaceId) as Home | undefined);
  if (!home || !home.repo_uuid || home.archived_at !== null || home.trashed_at !== null) {
    return unavailable(
      'project_unavailable',
      'The local home project is unavailable or must be restored first.'
    );
  }
  const binding = readWorkspaceSyncAccessBinding(db, home.repo_uuid);
  if (
    !binding ||
    binding.workspace_id !== home.id ||
    binding.workspace_uuid !== home.repo_uuid ||
    binding.owner_account_id !== context.accountId ||
    binding.owner_org_id !== context.orgId ||
    binding.detached_reason !== null ||
    !isWorkspaceSyncRemoteUuid(binding.remote_workspace_id) ||
    binding.remote_workspace_id !== details.entity.homeWorkspaceId
  ) {
    return unavailable(
      'home_mismatch',
      'No saved local copy is bound to this account, organization and home project.'
    );
  }
  const files = db
    .prepare(
      "SELECT path,workspace_id,file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current' ORDER BY id"
    )
    .all(entity.id) as FileBinding[];
  if (files.length > 1 || files.some((file) => file.workspace_id !== home.id)) {
    return unavailable(
      'source_unavailable',
      'The saved document has conflicting local ownership. Resolve its home project before opening.'
    );
  }
  return { status: 'candidate', entity, home, binding, files };
}

function localDocumentPath(
  candidate: LocalCandidate,
  target: ReturnType<typeof registryRepresentationForEntity>['openTarget']
): string | null {
  let path: string | undefined = candidate.files[0]?.path;
  if (!path && target.kind === 'managed_sequence') path = target.document.packageRoot;
  if (!path && target.kind === 'primer' && isSafeWorkspaceRelativePath(target.artifactRelativePath))
    path = target.artifactRelativePath;
  if (!path && (target.kind === 'protein_sequence' || target.kind === 'notebook'))
    path = target.filePath;
  const artifact = candidate.entity.fields.artifact;
  if (
    !path &&
    artifact &&
    typeof artifact === 'object' &&
    'relativePath' in artifact &&
    typeof artifact.relativePath === 'string' &&
    isSafeWorkspaceRelativePath(artifact.relativePath)
  )
    path = artifact.relativePath;
  const sequence = candidate.entity.fields.sequence;
  if (
    !path &&
    target.kind === 'sequence_file' &&
    sequence &&
    typeof sequence === 'object' &&
    'relPath' in sequence &&
    typeof sequence.relPath === 'string'
  )
    path = sequence.relPath;
  return path ? (isAbsolute(path) ? path : resolve(candidate.home.path, path)) : null;
}

function unavailable(reason: Unavailable['reason'], message: string): Unavailable {
  return { status: 'unavailable', reason, message };
}
