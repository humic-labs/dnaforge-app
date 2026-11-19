import type Database from 'better-sqlite3';
import type { CatalogEntityRow } from '../shared/catalog-registration';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import {
  fromPackageRelative,
  isSequencePackageFileKind,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
} from '../db/sequence-package';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { readClassificationFile } from './native-sequence-classification-review';
import { requireCatalogEntity, requireCatalogSourceOwner } from './catalog-source-authority';
import {
  ADOPT_OBJECT_UUID_SQL,
  buildCatalogFileBindingRow,
  parseCatalogFileBindingRequest,
  type CatalogFileBindingRequest,
  type CatalogFileBindingRow,
} from '../shared/catalog-binding';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import {
  fingerprintSequenceSource,
  isFingerprintableFileKind,
} from './sequence-source-fingerprint';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

function normalizedCatalogFileLocationInDb(
  db: Database.Database,
  input: Pick<CatalogFileBindingRequest, 'path' | 'workspaceRoot'>
): Pick<CatalogFileBindingRequest, 'path' | 'workspaceRoot'> {
  if (!input.workspaceRoot) return input;
  const rootIdentity = workspaceMutationRootIdentity(input.workspaceRoot);
  const workspaces = db.prepare('SELECT id,path FROM workspaces').all() as Array<{
    id: number;
    path: string;
  }>;
  const owners = workspaces.filter(
    (owner) => workspaceMutationRootIdentity(owner.path) === rootIdentity
  );
  if (owners.length !== 1)
    throw new Error('Catalog file binding has no unique canonical project owner.');
  const owner = owners[0];
  const pathIdentity = workspaceMutationRootIdentity(input.path);
  const relativePath = pathRelativeToBoundary(pathIdentity, rootIdentity);
  if (relativePath === null)
    throw new Error('Catalog file binding path is outside its canonical project.');
  const preferred = join(owner.path, relativePath);
  const spellings = [...new Set([input.path, pathIdentity, preferred])];
  const files = db
    .prepare(
      `SELECT path FROM catalog_entity_files WHERE path IN (${spellings.map(() => '?').join(',')})`
    )
    .all(...spellings) as Array<{ path: string }>;
  if (files.length > 1) throw new Error('Catalog file path has ambiguous canonical bindings.');
  return { ...input, workspaceRoot: owner.path, path: files[0]?.path ?? preferred };
}

function normalizedCatalogBindingInputInDb(
  db: Database.Database,
  input: CatalogFileBindingRequest
): CatalogFileBindingRequest {
  return { ...input, ...normalizedCatalogFileLocationInDb(db, input) };
}

export function resolveCurrentCatalogFileSourceInDb(
  db: Database.Database,
  input: { path: string; workspaceRoot: string }
) {
  const location = normalizedCatalogFileLocationInDb(db, input);
  const binding = db
    .prepare("SELECT * FROM catalog_entity_files WHERE path=? AND status='current'")
    .get(location.path) as CatalogFileBindingRow | undefined;
  if (!binding) return null;
  const entity = requireCatalogEntity(db, binding.entity_id);
  if (
    binding.workspace_id === null ||
    entity.workspace_id !== binding.workspace_id ||
    entity.status !== 'active'
  )
    throw new Error('The referenced file does not retain its active canonical project owner.');
  const owner = requireCatalogSourceOwner(db, binding.workspace_id);
  if (
    workspaceMutationRootIdentity(owner.path) !== workspaceMutationRootIdentity(input.workspaceRoot)
  )
    throw new Error('The referenced file belongs to a different canonical project owner.');
  return { binding, entity, owner };
}

export function catalogFileBindingAdmissionWitnessInDb(
  db: Database.Database,
  inputValue: CatalogFileBindingRequest
): string {
  const input = normalizedCatalogBindingInputInDb(db, inputValue);
  const file = db.prepare('SELECT * FROM catalog_entity_files WHERE path=?').get(input.path) as
    | CatalogFileBindingRow
    | undefined;
  const entities = db
    .prepare('SELECT * FROM catalog_entities WHERE id IN (?,?) ORDER BY id')
    .all(input.entityId, file?.entity_id ?? null);
  const workspace = input.workspaceRoot
    ? db
        .prepare('SELECT id,path,repo_uuid,archived_at,trashed_at FROM workspaces WHERE path=?')
        .get(input.workspaceRoot)
    : null;
  return JSON.stringify({
    registrations: db
      .prepare(
        "SELECT id,entity_id FROM catalog_entity_events WHERE entity_id IN (?,?) AND event_type='entity_registered' ORDER BY id"
      )
      .all(input.entityId, file?.entity_id ?? null),
    file: file ? { ...file, updated_at: undefined } : null,
    entities: (entities as CatalogEntityRow[]).map((entity) => ({
      ...entity,
      name: undefined,
      updated_at: undefined,
    })),
    workspace: workspace ?? null,
  });
}

function canonicalSequencePackageMarker(
  input: CatalogFileBindingRequest & { workspaceRoot: string }
) {
  const directory = lstatSync(input.path);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('Sequence package source must be an exact physical directory.');
  const markers = sequencePackageMetaPaths(input.path).filter((path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
  if (markers.length !== 1)
    throw new Error('Legacy sequence package adoption requires one exact canonical marker.');
  const document = parseSequencePackageDocument(
    readClassificationFile(input.workspaceRoot, markers[0], HARD_CAP_BYTES).toString('utf8')
  );
  if (document.id !== input.entityId)
    throw new Error('Sequence package marker identity does not match its catalog entity.');
  return { document, markerPath: markers[0] };
}

function canonicalSequencePackageBindingSource(input: CatalogFileBindingRequest) {
  if (!input.workspaceRoot)
    throw new Error('Sequence package binding requires its exact project owner.');
  const marker = canonicalSequencePackageMarker({ ...input, workspaceRoot: input.workspaceRoot });
  const productPath = fromPackageRelative(marker.document.product.file, input.path);
  const product = parseSequenceFileAsDocument(
    readClassificationFile(input.workspaceRoot, productPath, HARD_CAP_BYTES).toString('utf8'),
    productPath
  );
  if (!product.sequence.length)
    throw new Error('Sequence package product has no canonical scientific content.');
  return marker;
}

function previousPackageBinding(
  db: Database.Database,
  input: CatalogFileBindingRequest,
  workspaceId: number | null,
  current: CatalogFileBindingRow[]
): CatalogFileBindingRow | undefined {
  if (!workspaceId || !input.workspaceRoot || !isSequencePackageFileKind(input.fileKind)) return;
  const candidates = current.length
    ? current
    : (db
        .prepare(
          "SELECT * FROM catalog_entity_files WHERE entity_id=? AND workspace_id=? AND status='missing' AND object_uuid IS NOT NULL"
        )
        .all(input.entityId, workspaceId) as CatalogFileBindingRow[]);
  if (candidates.length !== 1) return;
  const previous = candidates[0];
  if (
    previous.workspace_id !== workspaceId ||
    previous.path === input.path ||
    !isSequencePackageFileKind(previous.file_kind) ||
    !previous.object_uuid ||
    existsSync(previous.path)
  )
    return;
  canonicalSequencePackageMarker({ ...input, workspaceRoot: input.workspaceRoot });
  return previous;
}

function adoptLegacyPackageBinding(
  db: Database.Database,
  input: CatalogFileBindingRequest,
  existing: CatalogFileBindingRow,
  workspaceId: number
): CatalogFileBindingRow {
  const entities = db
    .prepare(
      'SELECT id,type,storage_type,status,workspace_id FROM catalog_entities WHERE id IN (?,?)'
    )
    .all(existing.entity_id, input.entityId) as Array<{
    id: string;
    type: string;
    storage_type: string;
    status: string;
    workspace_id: number | null;
  }>;
  const previous = entities.find((entity) => entity.id === existing.entity_id);
  const next = entities.find((entity) => entity.id === input.entityId);
  if (
    !input.workspaceRoot ||
    !isSequencePackageFileKind(input.fileKind ?? '') ||
    (input.status !== undefined && input.status !== 'current') ||
    existing.status !== 'current' ||
    existing.workspace_id !== workspaceId ||
    previous?.workspace_id !== workspaceId ||
    next?.workspace_id !== workspaceId ||
    previous.status !== 'active' ||
    next.status !== 'active' ||
    !['sequence', 'construct'].includes(next.type) ||
    findKnownWorkspaceRoot(db, input.path) !== workspaceMutationRootIdentity(input.workspaceRoot) ||
    (input.objectUuid !== undefined && input.objectUuid !== existing.object_uuid)
  )
    throw new Error('Legacy sequence package binding has no exact current project authority.');
  const generic =
    previous.type === 'file' &&
    previous.storage_type === 'file' &&
    ['file', 'folder'].includes(existing.file_kind) &&
    !db.prepare('SELECT 1 FROM lims_entity WHERE id=?').get(previous.id);
  const design = previous.type === 'design' && isSequencePackageFileKind(existing.file_kind);
  if (!generic && !design)
    throw new Error('Sequence package binding belongs to an unrelated scientific entity.');
  const { document, markerPath } = canonicalSequencePackageBindingSource(input);
  const accepted = document.assembly?.accepted;
  if (
    design &&
    (accepted?.designId !== previous.id || accepted.acceptedAssemblyVersionId !== document.id)
  )
    throw new Error(
      'Legacy design binding does not match the package accepted design and version provenance.'
    );
  const conflicts = db
    .prepare(
      "SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current' AND path<>?"
    )
    .all(input.entityId, input.path);
  if (conflicts.length)
    throw new Error('Sequence package identity already has another current file authority.');
  const now = Date.now();
  if (design) {
    const evidence = JSON.stringify({
      source: 'sequence-package-root-binding-migration',
      packageId: document.id,
      packageRoot: input.path,
    });
    const link = db
      .prepare(
        "SELECT confidence,evidence FROM catalog_entity_links WHERE source_entity_id=? AND relation='produces' AND target_entity_id=?"
      )
      .get(previous.id, document.id) as { confidence: string; evidence: string | null } | undefined;
    if (link && (link.confidence !== 'confirmed' || link.evidence !== evidence))
      throw new Error('Legacy sequence package source lineage conflicts with existing authority.');
    if (!link)
      db.prepare(
        "INSERT INTO catalog_entity_links(id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at) VALUES(?,?,'produces',?,'confirmed',?,?,?)"
      ).run(randomUUID(), previous.id, document.id, evidence, now, now);
  }
  db.prepare(
    "INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,'file_historical','system','Legacy package binding adopted from its canonical marker',?,?)"
  ).run(
    randomUUID(),
    previous.id,
    JSON.stringify({
      path: existing.path,
      reason: 'canonical-sequence-package-adoption',
      previousBinding: existing,
      replacementEntityId: document.id,
      markerPath,
      ...(design ? { acceptedDesignId: previous.id, acceptedAssemblyVersionId: document.id } : {}),
    }),
    now
  );
  return { ...existing, entity_id: input.entityId };
}

export async function resolveBindingSequenceFingerprint(
  db: Database.Database,
  inputValue: CatalogFileBindingRequest
): Promise<string | null | undefined> {
  const input = normalizedCatalogBindingInputInDb(db, parseCatalogFileBindingRequest(inputValue));
  const fileKind = input.fileKind ?? inferCatalogFileKind(input.path);
  if ((input.status ?? 'current') !== 'current' || !isFingerprintableFileKind(fileKind)) {
    return undefined;
  }
  const existing = db
    .prepare('SELECT content_hash, sequence_fingerprint FROM catalog_entity_files WHERE path = ?')
    .get(input.path) as
    | { content_hash: string | null; sequence_fingerprint: string | null }
    | undefined;
  if (
    existing?.sequence_fingerprint &&
    input.contentHash &&
    existing.content_hash === input.contentHash
  ) {
    return existing.sequence_fingerprint;
  }
  return fingerprintSequenceSource(input.path, fileKind);
}

export function bindCatalogEntityFileInDb(
  db: Database.Database,
  inputValue: CatalogFileBindingRequest,
  allowedRoots?: ReadonlySet<string | null>,
  admissionWitness?: string,
  sequenceFingerprint?: string | null
): CatalogFileBindingRow {
  const input = normalizedCatalogBindingInputInDb(db, parseCatalogFileBindingRequest(inputValue));
  return db.transaction(() => {
    if (
      admissionWitness !== undefined &&
      catalogFileBindingAdmissionWitnessInDb(db, input) !== admissionWitness
    )
      throw new Error('Catalog binding authority changed while waiting; retry reconciliation.');
    const entity = db.prepare('SELECT * FROM catalog_entities WHERE id = ?').get(input.entityId) as
      | CatalogEntityRow
      | undefined;
    if (!entity) {
      throw new Error('Catalog file binding entity does not exist.');
    }
    const workspace = input.workspaceRoot
      ? (db
          .prepare(
            'SELECT id FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .get(input.workspaceRoot) as { id: number } | undefined)
      : undefined;
    if (input.workspaceRoot && !workspace)
      throw new Error('Catalog file binding workspace is not registered.');
    const workspaceId = workspace?.id ?? null;
    if (entity.workspace_id !== workspaceId)
      throw new Error('Catalog file binding must use its entity workspace owner.');
    let existing = db
      .prepare('SELECT * FROM catalog_entity_files WHERE path = ?')
      .get(input.path) as CatalogFileBindingRow | undefined;
    if (existing && existing.entity_id !== input.entityId) {
      if (workspaceId === null)
        throw new Error('Legacy package adoption requires its owning project.');
      existing = adoptLegacyPackageBinding(db, input, existing, workspaceId);
    }
    if (!existing && input.contentHash?.startsWith('sha256:')) {
      const candidates = db
        .prepare(ADOPT_OBJECT_UUID_SQL)
        .all(input.contentHash, workspaceId) as Array<{ id: string }>;
      const ownedCandidates = candidates.filter(
        (candidate) =>
          (
            db
              .prepare('SELECT entity_id FROM catalog_entity_files WHERE id = ?')
              .get(candidate.id) as { entity_id: string }
          ).entity_id === input.entityId
      );
      if (ownedCandidates.length === 1)
        existing = db
          .prepare('SELECT * FROM catalog_entity_files WHERE id = ?')
          .get(ownedCandidates[0].id) as CatalogFileBindingRow;
    }
    const now = Date.now();
    const siblings =
      (input.status ?? 'current') === 'current'
        ? (db
            .prepare(
              "SELECT * FROM catalog_entity_files WHERE entity_id = ? AND status = 'current'"
            )
            .all(input.entityId) as CatalogFileBindingRow[])
        : [];
    const moved = input.supersedesMovedPath
      ? siblings.find((file) => file.path === input.supersedesMovedPath)
      : !existing?.object_uuid && !input.objectUuid && (input.status ?? 'current') === 'current'
        ? previousPackageBinding(db, input, workspaceId, siblings)
        : undefined;
    const inheritedObjectUuid =
      !existing?.object_uuid && !input.objectUuid && moved && !existsSync(moved.path)
        ? moved.object_uuid
        : null;
    if (inheritedObjectUuid && moved?.status === 'missing') siblings.push(moved);
    if (
      moved &&
      !existsSync(moved.path) &&
      isSequencePackageFileKind(input.fileKind ?? '') &&
      entity.locator === `file://${moved.path}`
    ) {
      if (
        !['sequence', 'construct'].includes(entity.type) ||
        entity.storage_type !== 'file' ||
        entity.status !== 'active'
      )
        throw new Error('Converted sequence package has no active scientific catalog owner.');
      const { document } = canonicalSequencePackageBindingSource(input);
      db.prepare('UPDATE catalog_entities SET locator=?,updated_at=? WHERE id=? AND locator=?').run(
        `entity://sequence/${encodeURIComponent(document.id)}`,
        now,
        input.entityId,
        entity.locator
      );
    }
    const binding = buildCatalogFileBindingRow(
      inheritedObjectUuid ? { ...input, objectUuid: inheritedObjectUuid } : input,
      workspaceId,
      existing,
      now,
      randomUUID,
      sequenceFingerprint
    );
    for (const file of [binding, ...(existing ? [existing] : []), ...siblings]) {
      if (allowedRoots && !allowedRoots.has(findKnownWorkspaceRoot(db, file.path))) {
        throw new Error(
          'Catalog file bindings changed workspace while waiting; retry reconciliation.'
        );
      }
    }
    for (const sibling of siblings) {
      if (sibling.id === binding.id || sibling.path === input.path) continue;
      db.prepare(
        `UPDATE catalog_entity_files
          SET status = 'historical',
              object_uuid = CASE WHEN object_uuid IS ? THEN NULL ELSE object_uuid END,
              updated_at = ?
          WHERE id = ?`
      ).run(inheritedObjectUuid, now, sibling.id);
      db.prepare(
        `INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at)
        VALUES(?,?,'file_historical','user','Catalog file binding is historical',?,?)`
      ).run(
        randomUUID(),
        sibling.entity_id,
        JSON.stringify({
          path: sibling.path,
          reason: 'superseded-current-binding',
          fileKind: sibling.file_kind,
        }),
        now
      );
    }
    if (existing) {
      db.prepare(
        `UPDATE catalog_entity_files SET entity_id=?,workspace_id=?,path=?,relative_path=?,file_kind=?,
        content_hash=?,sequence_fingerprint=?,object_uuid=?,size_bytes=?,modified_at=?,status=?,last_seen_at=?,missing_since=?,updated_at=?
        WHERE id=?`
      ).run(
        binding.entity_id,
        binding.workspace_id,
        binding.path,
        binding.relative_path,
        binding.file_kind,
        binding.content_hash,
        binding.sequence_fingerprint,
        binding.object_uuid,
        binding.size_bytes,
        binding.modified_at,
        binding.status,
        binding.last_seen_at,
        binding.missing_since,
        binding.updated_at,
        binding.id
      );
    } else {
      db.prepare(
        `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,content_hash,
        sequence_fingerprint,object_uuid,size_bytes,modified_at,status,last_seen_at,missing_since,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        binding.id,
        binding.entity_id,
        binding.workspace_id,
        binding.path,
        binding.relative_path,
        binding.file_kind,
        binding.content_hash,
        binding.sequence_fingerprint,
        binding.object_uuid,
        binding.size_bytes,
        binding.modified_at,
        binding.status,
        binding.last_seen_at,
        binding.missing_since,
        binding.created_at,
        binding.updated_at
      );
    }
    return db
      .prepare('SELECT * FROM catalog_entity_files WHERE id = ?')
      .get(binding.id) as CatalogFileBindingRow;
  })();
}
