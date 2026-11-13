import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { assertDeclaredFastaKindInDb } from './fasta-kind-authority';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatEntityReferenceIpcRow } from '../shared/chat-turn-ipc';
import { canonicalJson } from '../shared/canonical-json';
import { isAbsolutePathLike, pathIsAtOrUnder } from '../shared/path-boundary';
import { resolveMolecularReference } from '../shared/molecular-reference';
import {
  assertEntityReferenceMolecularTarget,
  classifyAuthoredEntityReference,
  isFrozenMolecularReference,
  referenceJsonObject,
  sameEntityReferenceContent,
  updatedEntityReferenceRow,
  validatePreparedEntityReferenceRow,
  type EntityReferenceUpdates,
  type EntityReferenceRevisionInput,
  type EntityReferenceRevisionRow,
} from '../shared/entity-reference-ipc';
import { canonicalPrimerReferenceSnapshot } from '../shared/primers/primer-reference-contract';
import { readCanonicalPrimerReferenceArtifactInDb } from './primer-projection';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { resolveCurrentCatalogFileSourceInDb } from './catalog-file-binding';
import { parseLimsSchemaFields } from '../shared/lims';

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function sameRoot(left: string, right: string): boolean {
  return workspaceMutationRootIdentity(left) === workspaceMutationRootIdentity(right);
}

function assertActiveReferenceRoot(db: Database.Database, root: string | null): void {
  if (!root || !tableExists(db, 'workspaces')) return;
  const owners = db.prepare('SELECT path,archived_at,trashed_at FROM workspaces').all() as Array<{
    path: string;
    archived_at: number | null;
    trashed_at: number | null;
  }>;
  const known = owners.filter((row) => sameRoot(row.path, root));
  if (known.some((row) => row.archived_at !== null || row.trashed_at !== null))
    throw new Error('The saved reference project is archived or trashed.');
}

function assertPrimerReference(db: Database.Database, row: ChatEntityReferenceIpcRow): void {
  const data = referenceJsonObject(row.data);
  if (
    !data ||
    typeof data.registryEntityId !== 'string' ||
    row.locator !== `entity://primer/${data.registryEntityId}`
  )
    throw new Error('A primer reference requires its existing canonical Registry identity.');
  const entity = db
    .prepare(
      "SELECT id,name,fields,workspace_id FROM lims_entity WHERE id=? AND kind IN ('oligo','rna_oligo') AND tombstone=0 AND archived_at IS NULL"
    )
    .get(data.registryEntityId) as
    | { id: string; name: string; fields: string; workspace_id: number | null }
    | undefined;
  if (!entity)
    throw new Error(
      'The reference requires an existing active canonical oligo; reference data cannot create one.'
    );
  let expected: ReturnType<typeof canonicalPrimerReferenceSnapshot>;
  if (data.localOnly === true) {
    const fields = referenceJsonObject(entity.fields);
    const artifact =
      fields?.artifact && typeof fields.artifact === 'object'
        ? (fields.artifact as Record<string, unknown>)
        : null;
    const retainedFile = db
      .prepare(
        "SELECT 1 FROM catalog_entity_files f LEFT JOIN primers p ON p.id=f.entity_id WHERE f.file_kind='primer-artifact' AND (f.entity_id=? OR CASE WHEN json_valid(p.origin_details) THEN json_extract(p.origin_details,'$.limsEntityId') END=?) LIMIT 1"
      )
      .get(entity.id, entity.id);
    if (artifact?.schema === 'dnaforge.primer' || retainedFile)
      throw new Error('Project-owned canonical oligos must retain their exact artifact owner.');
    const provenance =
      entity.workspace_id === null
        ? null
        : (db
            .prepare('SELECT path,archived_at,trashed_at FROM workspaces WHERE id=?')
            .get(entity.workspace_id) as
            | { path: string; archived_at: number | null; trashed_at: number | null }
            | undefined);
    if (
      entity.workspace_id !== null &&
      (!provenance ||
        provenance.archived_at !== null ||
        provenance.trashed_at !== null ||
        !row.workspace_root_path ||
        !sameRoot(provenance.path, row.workspace_root_path))
    )
      throw new Error('The database-owned oligo must retain its active provenance project.');
    if (entity.workspace_id === null && row.workspace_root_path !== null)
      throw new Error('A global Registry oligo cannot acquire a project owner.');
    expected = canonicalPrimerReferenceSnapshot(
      entity,
      undefined,
      undefined,
      provenance?.path ?? null
    );
  } else {
    if (typeof data.primerId !== 'string' || !row.workspace_root_path)
      throw new Error('A project primer reference requires its exact artifact and owning project.');
    const owned = readCanonicalPrimerReferenceArtifactInDb(db, data.primerId);
    if (
      owned.artifact.registry.entityId !== entity.id ||
      !sameRoot(owned.workspaceRoot, row.workspace_root_path)
    )
      throw new Error('The canonical oligo reference and artifact owner disagree.');
    const binding =
      data.bindingId === undefined
        ? undefined
        : owned.artifact.bindings.find((binding) => binding.id === data.bindingId);
    if (
      data.bindingId !== undefined &&
      (!binding ||
        (binding.target.projectId &&
          !owned.resolvedBindings.some((entry) => entry.binding.id === binding.id)))
    )
      throw new Error(
        'The primer reference attachment is missing or its source project is unavailable.'
      );
    expected = canonicalPrimerReferenceSnapshot(
      entity,
      { primerId: owned.artifact.id, workspaceRoot: owned.workspaceRoot },
      binding
    );
  }
  if (
    canonicalJson(data) !== canonicalJson(expected.data) ||
    canonicalJson(referenceJsonObject(row.deep_link_params)) !==
      canonicalJson(expected.deepLinkParams)
  )
    throw new Error('The primer reference disagrees with its canonical oligo or exact attachment.');
}

function assertCatalogReference(
  db: Database.Database,
  row: ChatEntityReferenceIpcRow,
  id: string,
  types: readonly string[],
  sourceDocumentId = id
): void {
  const entity = db
    .prepare('SELECT id,type,status,workspace_id FROM catalog_entities WHERE id=?')
    .get(id) as
    | { id: string; type: string; status: string; workspace_id: number | null }
    | undefined;
  if (!entity || entity.status !== 'active' || !types.includes(entity.type))
    throw new Error('The reference target is unavailable or its entity kind disagrees.');
  if (entity.workspace_id !== null) {
    const owner = db
      .prepare('SELECT path,archived_at,trashed_at FROM workspaces WHERE id=?')
      .get(entity.workspace_id) as
      | { path: string; archived_at: number | null; trashed_at: number | null }
      | undefined;
    if (
      !owner ||
      owner.archived_at !== null ||
      owner.trashed_at !== null ||
      !row.workspace_root_path ||
      !sameRoot(owner.path, row.workspace_root_path)
    )
      throw new Error('The saved entity reference does not match its active project owner.');
  } else if (row.workspace_root_path)
    throw new Error('An unbound entity cannot acquire another project owner through a reference.');
  if (
    row.workspace_root_path &&
    ['sequence', 'sequence_region', 'annotation', 'protein'].includes(row.entity_type)
  ) {
    const files = db
      .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
      .all(id) as Array<{ path: string }>;
    for (const file of files)
      assertDeclaredFastaKindInDb(
        db,
        { path: file.path, workspaceRoot: row.workspace_root_path },
        row.entity_type === 'protein' ? 'protein' : 'sequence'
      );
  }
  const data = referenceJsonObject(row.data);
  const descriptor =
    data?.locator && typeof data.locator === 'object'
      ? (data.locator as Record<string, unknown>)
      : null;
  if (
    (data?.documentId !== undefined && data.documentId !== sourceDocumentId) ||
    (descriptor?.documentId !== undefined && descriptor.documentId !== sourceDocumentId)
  )
    throw new Error('The saved selection disagrees with its document identity.');
}

export function assertEntityReferenceTargetInDb(
  db: Database.Database,
  row: ChatEntityReferenceIpcRow
): void {
  prepareValidatedEntityReferenceInDb(db, row);
}

function prepareValidatedEntityReferenceInDb(
  db: Database.Database,
  row: ChatEntityReferenceIpcRow
): ChatEntityReferenceIpcRow {
  validatePreparedEntityReferenceRow(row);
  assertActiveReferenceRoot(db, row.workspace_root_path);
  const representation = classifyAuthoredEntityReference(row);
  const molecular = resolveMolecularReference(row);
  if (molecular?.kind === 'document') {
    assertCatalogReference(
      db,
      row,
      scopedProjectionId(molecular.document.projectId, molecular.document.documentId),
      ['molecular-document'],
      molecular.document.documentId
    );
    return row;
  }
  if (molecular?.kind === 'view' || molecular?.kind === 'selection') {
    const target = molecular.target;
    if (target) {
      const parent = db
        .prepare('SELECT * FROM entity_references WHERE id=?')
        .get(target.viewReferenceId) as ChatEntityReferenceIpcRow | undefined;
      assertEntityReferenceMolecularTarget(row, () => parent ?? null);
      if (
        parent?.workspace_root_path &&
        row.workspace_root_path &&
        !sameRoot(parent.workspace_root_path, row.workspace_root_path)
      )
        throw new Error('The molecular reference cannot replace its saved project owner.');
    }
  }
  const route = /^entity:\/\/([^/]+)\/(.+)$/u.exec(row.locator);
  const id = route ? decodeURIComponent(route[2]) : row.locator;
  if (row.entity_type === 'primer' || route?.[1] === 'primer') {
    if (row.entity_type !== 'primer')
      throw new Error('The reference type disagrees with its canonical primer target.');
    assertPrimerReference(db, row);
    return row;
  }
  if (row.locator.startsWith('git://')) {
    const parts = row.locator.slice('git://'.length).split('/').slice(1);
    const path = row.workspace_root_path
      ? resolve(row.workspace_root_path, parts.join('/').replace(/@[a-f0-9]+$/u, ''))
      : null;
    if (
      !parts.length ||
      parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
    )
      throw new Error('The historical filesystem reference has an unsafe locator.');
    if (
      row.workspace_root_path &&
      ['sequence', 'sequence_region', 'annotation', 'protein'].includes(row.entity_type)
    )
      assertDeclaredFastaKindInDb(
        db,
        {
          path: path!,
          workspaceRoot: row.workspace_root_path,
        },
        row.entity_type === 'protein' ? 'protein' : 'sequence'
      );
    if (row.entity_type === 'protein' && path && row.workspace_root_path) {
      const data = referenceJsonObject(row.data) ?? {};
      const source = resolveCurrentCatalogFileSourceInDb(db, {
        path,
        workspaceRoot: row.workspace_root_path,
      });
      if (source) {
        const registry = db
          .prepare(
            'SELECT l.kind,l.workspace_id,r.fields AS schema_fields FROM lims_entity l LEFT JOIN lims_schema_revision r ON r.id=l.schema_revision_id WHERE l.id=? AND l.tombstone=0 AND l.archived_at IS NULL'
          )
          .get(source.entity.id) as
          | { kind: string; workspace_id: number | null; schema_fields: string | null }
          | undefined;
        if (
          source.entity.type !== 'protein' &&
          !(
            registry?.workspace_id === source.owner.id &&
            (registry.kind === 'protein' ||
              (registry.schema_fields &&
                parseLimsSchemaFields(registry.schema_fields).baseKind === 'protein'))
          )
        )
          throw new Error('The file reference kind disagrees with its canonical target.');
        if (data.documentId !== undefined && data.documentId !== source.entity.id)
          throw new Error('The file reference identity disagrees with its canonical target.');
        return { ...row, data: JSON.stringify({ ...data, documentId: source.entity.id }) };
      }
      if (data.documentId !== undefined)
        throw new Error(
          'The file reference identity has no canonical target in its owning project.'
        );
    }
    return row;
  }
  if (
    representation === 'molecular' ||
    representation === 'compute-result' ||
    representation === 'developer-result' ||
    representation === 'external'
  )
    return row;
  if (representation === 'inspection-continuation') {
    const documentId = referenceJsonObject(row.data)?.documentId;
    if (typeof documentId !== 'string')
      throw new Error('The inspection source identity is unavailable.');
    assertCatalogReference(db, row, documentId, ['sequence', 'construct']);
    return row;
  }
  if (representation === 'registry') {
    const entity = db
      .prepare('SELECT kind FROM lims_entity WHERE id=? AND tombstone=0 AND archived_at IS NULL')
      .get(id) as { kind: string } | undefined;
    if (
      !entity ||
      (row.entity_type === 'protein' && entity.kind !== 'protein') ||
      (row.entity_type === 'record' && ['oligo', 'rna_oligo'].includes(entity.kind))
    )
      throw new Error('The Registry reference kind disagrees with its canonical target.');
    if (row.workspace_root_path) assertCatalogReference(db, row, id, [row.entity_type]);
    return row;
  }
  if (
    row.entity_type === 'notebook' &&
    !row.workspace_root_path &&
    db.prepare('SELECT 1 FROM pages WHERE id=?').get(id)
  )
    return row;
  const types = ['sequence', 'sequence_region', 'annotation'].includes(row.entity_type)
    ? ['sequence', 'construct']
    : row.entity_type === 'notebook'
      ? ['notebook']
      : row.entity_type === 'assembly'
        ? ['design', 'construct']
        : [row.entity_type];
  assertCatalogReference(db, row, id, types);
  return row;
}

export function createEntityReferenceInDb(
  db: Database.Database,
  input: ChatEntityReferenceIpcRow
): ChatEntityReferenceIpcRow {
  return db.transaction(() => {
    const row = prepareValidatedEntityReferenceInDb(db, input);
    if (row.status !== 'created')
      throw new Error('New entity references must have created status.');
    const existing = db.prepare('SELECT * FROM entity_references WHERE id=?').get(row.id) as
      | ChatEntityReferenceIpcRow
      | undefined;
    if (existing) {
      if (!sameEntityReferenceContent(existing, row))
        throw new Error(
          'The entity reference ID already belongs to another immutable target or content.'
        );
      return existing;
    }
    db.prepare(
      `INSERT INTO entity_references(id,entity_type,display_label,locator,deep_link_params,data,source,status,workspace_scope,workspace_root_path,created_at,updated_at)
      VALUES(@id,@entity_type,@display_label,@locator,@deep_link_params,@data,@source,@status,@workspace_scope,@workspace_root_path,@created_at,@updated_at)`
    ).run(row);
    return row;
  })();
}

export function updateEntityReferenceInDb(
  db: Database.Database,
  id: string,
  updates: EntityReferenceUpdates
): void {
  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM entity_references WHERE id=?').get(id) as
      | ChatEntityReferenceIpcRow
      | undefined;
    if (!existing) return;
    const row = updatedEntityReferenceRow(existing, updates);
    if (row === existing) return;
    if (row.locator !== existing.locator) {
      if (!existing.workspace_root_path) throw new Error('A saved reference target is immutable.');
      const file = db
        .prepare(
          "SELECT path FROM catalog_entity_files WHERE entity_id=? AND file_kind<>'folder' AND status='current'"
        )
        .get(row.locator) as { path: string } | undefined;
      const legacy = existing.locator.startsWith('git://')
        ? existing.locator.slice('git://'.length).split('/').slice(1).join('/')
        : existing.locator;
      const priorPath = isAbsolutePathLike(legacy)
        ? legacy
        : resolve(existing.workspace_root_path, legacy);
      if (
        !file ||
        !sameRoot(file.path, priorPath) ||
        !pathIsAtOrUnder(priorPath, existing.workspace_root_path)
      )
        throw new Error(
          'A saved reference target is immutable; only its exact historical identity may be upgraded.'
        );
    }
    assertEntityReferenceTargetInDb(db, row);
    db.prepare(
      'UPDATE entity_references SET display_label=?,locator=?,deep_link_params=?,data=?,status=?,updated_at=? WHERE id=?'
    ).run(
      row.display_label,
      row.locator,
      row.deep_link_params,
      row.data,
      row.status,
      row.updated_at,
      id
    );
  })();
}

export function deleteEntityReferenceInDb(db: Database.Database, id: string): void {
  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM entity_references WHERE id=?').get(id) as
      | ChatEntityReferenceIpcRow
      | undefined;
    if (!existing) return;
    if (
      isFrozenMolecularReference(existing) ||
      ['sequence_region', 'annotation', 'primer'].includes(existing.entity_type) ||
      db.prepare('SELECT 1 FROM message_references WHERE reference_id=? LIMIT 1').get(id)
    )
      throw new Error(
        'Saved snapshots, selections and referenced targets are immutable and cannot be deleted here.'
      );
    db.prepare('DELETE FROM entity_references WHERE id=?').run(id);
  })();
}

export function setEntityReferenceWorkspaceRootPathIfMissingInDb(
  db: Database.Database,
  id: string,
  root: string
): string | null {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM entity_references WHERE id=?').get(id) as
      | ChatEntityReferenceIpcRow
      | undefined;
    if (!row || row.workspace_root_path) return row?.workspace_root_path ?? null;
    if (!isAbsolutePathLike(root) || !row.locator.startsWith('git://'))
      throw new Error('Only a historical filesystem reference can recover its saved root.');
    let candidates: string[] = [];
    if (row.workspace_scope?.startsWith('folders:')) {
      const parsed: unknown = JSON.parse(row.workspace_scope.slice('folders:'.length));
      if (
        Array.isArray(parsed) &&
        parsed.every((value) => typeof value === 'string' && isAbsolutePathLike(value))
      )
        candidates = [...new Set(parsed)];
    } else if (
      row.workspace_scope?.startsWith('file:') ||
      row.workspace_scope?.endsWith('.waypoint-workspace')
    ) {
      candidates = (
        db
          .prepare(
            'SELECT DISTINCT c.workspace_path FROM message_references r JOIN messages m ON m.id=r.message_id JOIN conversations c ON c.id=m.conversation_id WHERE r.reference_id=? AND c.workspace_path IS NOT NULL'
          )
          .all(id) as Array<{ workspace_path: string }>
      ).map((row) => row.workspace_path);
    }
    if (candidates.length > 1) {
      const relative = row.locator.slice('git://'.length).split('/').slice(1).join('/');
      candidates = candidates.filter((candidate) => existsSync(resolve(candidate, relative)));
    }
    if (candidates.length !== 1 || !sameRoot(candidates[0], root))
      throw new Error(
        'The recovered reference root is not established by its saved ownership evidence.'
      );
    assertActiveReferenceRoot(db, root);
    db.prepare(
      'UPDATE entity_references SET workspace_root_path=?,updated_at=? WHERE id=? AND workspace_root_path IS NULL'
    ).run(root, Date.now(), id);
    return root;
  })();
}

export function recordEntityReferenceRevisionInDb(
  db: Database.Database,
  input: EntityReferenceRevisionInput
): EntityReferenceRevisionRow {
  return db.transaction(() => {
    if (
      !input ||
      typeof input.referenceId !== 'string' ||
      !input.referenceId ||
      !input.changedBy ||
      !input.changeType
    )
      throw new Error('A reference revision requires its exact reference and actor.');
    const reference = db
      .prepare('SELECT * FROM entity_references WHERE id=?')
      .get(input.referenceId) as ChatEntityReferenceIpcRow | undefined;
    if (!reference) throw new Error('The reference revision target is unavailable.');
    const prior = db
      .prepare(
        'SELECT COALESCE(MAX(revision_number),0) AS revision FROM entity_reference_revisions WHERE reference_id=?'
      )
      .get(input.referenceId) as { revision: number };
    const row = {
      id: randomUUID(),
      reference_id: input.referenceId,
      revision_number: prior.revision + 1,
      changed_by: input.changedBy,
      change_type: input.changeType,
      previous_state: input.previousState === null ? null : JSON.stringify(input.previousState),
      new_state: input.newState === null ? null : JSON.stringify(input.newState),
      created_at: Date.now(),
    };
    referenceJsonObject(row.previous_state);
    referenceJsonObject(row.new_state);
    db.prepare(
      'INSERT INTO entity_reference_revisions(id,reference_id,revision_number,changed_by,change_type,previous_state,new_state,created_at) VALUES(@id,@reference_id,@revision_number,@changed_by,@change_type,@previous_state,@new_state,@created_at)'
    ).run(row);
    return row;
  })();
}
