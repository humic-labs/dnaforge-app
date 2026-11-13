import type Database from 'better-sqlite3';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { basename } from 'node:path';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import {
  ADOPT_OBJECT_UUID_SQL,
  parseCatalogFileBindingRequest,
  type CatalogFileBindingRow,
} from '../shared/catalog-binding';
import { rebindCatalogFilesInDb } from './catalog-projection-commands';
import {
  bindCatalogEntityFileInDb,
  catalogFileBindingAdmissionWitnessInDb,
  resolveBindingSequenceFingerprint,
} from './catalog-file-binding';
import { randomUUID } from 'node:crypto';
import { recordInitialFastaKindDeclarationInDb } from './fasta-kind-authority';
import {
  parseCatalogEntityRegistration,
  planCatalogEntityRegistration,
  type CatalogEntityRegistrationRequest,
  type CatalogEntityRow,
  type CatalogWorkspaceFileRegistrationRequest,
} from '../shared/catalog-registration';

export function registerCatalogEntityInDb(
  db: Database.Database,
  inputValue: CatalogEntityRegistrationRequest
): CatalogEntityRow {
  return persistCatalogEntityInDb(db, inputValue, true);
}

function persistCatalogEntityInDb(
  db: Database.Database,
  inputValue: CatalogEntityRegistrationRequest,
  deliberate: boolean
): CatalogEntityRow {
  const input = parseCatalogEntityRegistration(inputValue);
  return db.transaction(() => {
    const workspace = input.workspaceRoot
      ? (db
          .prepare('SELECT id,repo_uuid FROM workspaces WHERE path = ?')
          .get(input.workspaceRoot) as { id: number; repo_uuid: string | null } | undefined)
      : undefined;
    if (input.workspaceRoot && !workspace)
      throw new Error('Catalog registration workspace owner is not registered.');
    const existing = db
      .prepare('SELECT * FROM catalog_entities WHERE id = ? OR locator = ?')
      .all(input.id ?? null, input.locator) as CatalogEntityRow[];
    const row = planCatalogEntityRegistration(
      input,
      workspace?.id ?? null,
      existing,
      Date.now(),
      randomUUID,
      workspaceScopeKey(workspace?.repo_uuid, workspace?.id)
    );
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
      VALUES(@id,@type,@name,@locator,@storage_type,@status,@workspace_id,@metadata,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type,name=excluded.name,locator=excluded.locator,
      storage_type=excluded.storage_type,status=excluded.status,metadata=excluded.metadata,
      updated_at=excluded.updated_at`
    ).run(row);
    if (deliberate && existing.length > 0)
      db.prepare(
        "INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,'entity_registered','system','Catalog entity registration reconciled',NULL,?)"
      ).run(randomUUID(), row.id, row.updated_at);
    if (deliberate && existing.length === 0) recordInitialFastaKindDeclarationInDb(db, row);
    return db
      .prepare('SELECT * FROM catalog_entities WHERE id = ?')
      .get(row.id) as CatalogEntityRow;
  })();
}

export function catalogWorkspaceFileAdmissionWitnessInDb(
  db: Database.Database,
  input: CatalogWorkspaceFileRegistrationRequest
): string {
  const binding = catalogFileBindingAdmissionWitnessInDb(db, { ...input, entityId: 'discovery' });
  const entities = db
    .prepare('SELECT * FROM catalog_entities WHERE locator=? ORDER BY id')
    .all(`file://${input.path}`);
  return JSON.stringify({ binding, entities });
}

export async function resolveWorkspaceFileSequenceFingerprintInDb(
  db: Database.Database,
  input: CatalogWorkspaceFileRegistrationRequest
): Promise<string | null | undefined> {
  const existing = db
    .prepare('SELECT file_kind FROM catalog_entity_files WHERE path=?')
    .get(input.path) as Pick<CatalogFileBindingRow, 'file_kind'> | undefined;
  return resolveBindingSequenceFingerprint(db, {
    ...input,
    entityId: 'discovery',
    fileKind: existing?.file_kind ?? input.fileKind,
  });
}

export function registerWorkspaceFileInDb(
  db: Database.Database,
  input: CatalogWorkspaceFileRegistrationRequest,
  sequenceFingerprint?: string | null,
  admissionWitness?: string
): CatalogEntityRow {
  parseCatalogFileBindingRequest({ ...input, entityId: 'discovery' });
  return db.transaction(() => {
    if (
      admissionWitness !== undefined &&
      catalogWorkspaceFileAdmissionWitnessInDb(db, input) !== admissionWitness
    )
      throw new Error(
        'Catalog file registration authority changed while waiting; retry discovery.'
      );
    const workspace = input.workspaceRoot
      ? (db
          .prepare('SELECT id,repo_uuid FROM workspaces WHERE path = ?')
          .get(input.workspaceRoot) as { id: number; repo_uuid: string | null } | undefined)
      : undefined;
    if (input.workspaceRoot && !workspace)
      throw new Error('Catalog file workspace owner is not registered.');
    const current = db
      .prepare('SELECT * FROM catalog_entity_files WHERE path = ?')
      .get(input.path) as CatalogFileBindingRow | undefined;
    if (current) {
      const owner = db
        .prepare('SELECT * FROM catalog_entities WHERE id = ?')
        .get(current.entity_id) as CatalogEntityRow | undefined;
      if (
        !owner ||
        owner.workspace_id !== (workspace?.id ?? null) ||
        current.workspace_id !== owner.workspace_id
      )
        throw new Error('Discovered file must use its existing entity workspace owner.');
      if (!owner.locator.startsWith('file://')) {
        bindCatalogEntityFileInDb(
          db,
          { ...input, entityId: owner.id, fileKind: current.file_kind },
          undefined,
          undefined,
          sequenceFingerprint
        );
        return owner;
      }
    }
    if (!current && input.contentHash?.startsWith('sha256:')) {
      const matches = db
        .prepare(ADOPT_OBJECT_UUID_SQL)
        .all(input.contentHash, workspace?.id ?? null) as Array<{ id: string }>;
      if (matches.length === 1) {
        const candidate = db
          .prepare('SELECT * FROM catalog_entity_files WHERE id = ?')
          .get(matches[0].id) as CatalogFileBindingRow;
        const entity = db
          .prepare('SELECT * FROM catalog_entities WHERE id = ?')
          .get(candidate.entity_id) as CatalogEntityRow | undefined;
        if (
          entity?.locator === `file://${candidate.path}` &&
          entity.workspace_id === (workspace?.id ?? null)
        )
          rebindCatalogFilesInDb(db, {
            oldPath: candidate.path,
            newPath: input.path,
            workspaceRoot: input.workspaceRoot,
            actor: 'file-discovery',
          });
      }
    }
    const boundKind = db
      .prepare(
        "SELECT e.type,f.file_kind FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id WHERE f.path=? AND f.status='current'"
      )
      .get(input.path) as { type: CatalogEntityRow['type']; file_kind: string } | undefined;
    const fileKind = boundKind?.file_kind ?? input.fileKind ?? 'file';
    const row = persistCatalogEntityInDb(
      db,
      {
        type:
          boundKind?.type ?? input.entityType ?? (input.fileKind === 'folder' ? 'folder' : 'file'),
        name: input.name ?? basename(input.path),
        locator: `file://${input.path}`,
        storageType: 'file',
        workspaceRoot: input.workspaceRoot,
        preserveExistingName: true,
        metadata: {
          ...input.metadata,
          path: input.path,
          relativePath: input.workspaceRoot
            ? pathRelativeToBoundary(input.path, input.workspaceRoot)
            : null,
          fileKind,
        },
      },
      false
    );
    bindCatalogEntityFileInDb(
      db,
      { ...input, entityId: row.id, fileKind },
      undefined,
      undefined,
      sequenceFingerprint
    );
    return row;
  })();
}
