import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parsePrimerArtifact,
  serializePrimerArtifact,
  type PrimerArtifactV1,
  type PrimerArtifactBindingV1,
} from '../shared/primers/primer-artifact';
import {
  primerLegacyProjectionFromArtifact,
  primerRegistryProjectionFromArtifact,
} from '../shared/primers/primer-artifact-projection';
import { pathIsAtOrUnder, pathRelativeToBoundary } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import type Database from 'better-sqlite3';
import type {
  LimsRegisterEntityInput,
  LimsUpdateEntityInput,
  LimsEntityActionInput,
} from '../shared/lims';
import type { PrimerLegacyProjectionInput } from '../shared/primer-projection-ipc';
import { assertCanonicalSequenceSourceInDb } from './sequence-index-command';
import { isFastaKindSourcePath } from '../shared/fasta-kind';
import { readAcceptedPrimerProjectionSourceInDb } from './scientific-primer-projection-source';

import {
  restorePrimerRegistryRelationshipsInsideTx,
  type VerifiedPrimerRelationshipAuthority,
} from './primer-registry-relationships';
import { materializeLimsGitExportForWorkspaceIds } from './lims-export-sync';

const DEFAULT_PREFIX = 'P';
const MIN_DIGITS = 3;
const CATALOG_RESERVATION_PREFIX = 'primer_catalog_reservation:';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function allocatePrimerCatalogNumberInDb(
  db: Database.Database,
  workspaceId = 0,
  now = Date.now()
): string {
  return db.transaction(() => {
    const prefixRow = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(`primer_prefix_${workspaceId}`) as { value: string } | undefined;
    const prefix = prefixRow?.value?.trim() || DEFAULT_PREFIX;
    const counterKey = `primer_counter_global_${prefix}`;
    const counterRow = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(counterKey) as
      | { value: string }
      | undefined;
    const existing = db
      .prepare(`SELECT catalog_number FROM primers WHERE catalog_number IS NOT NULL`)
      .all() as Array<{ catalog_number: string }>;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
    const existingMax = existing.reduce((max, row) => {
      const match = pattern.exec(row.catalog_number);
      return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
    }, 0);
    const stored = counterRow ? Number.parseInt(counterRow.value, 10) : 0;
    let next = Math.max(Number.isFinite(stored) ? stored : 0, existingMax) + 1;
    let catalogNumber = `${prefix}${String(next).padStart(MIN_DIGITS, '0')}`;
    const catalogExists = db.prepare(`SELECT 1 FROM primers WHERE catalog_number = ? LIMIT 1`);
    const reservationExists = db.prepare(`SELECT 1 FROM settings WHERE key = ? LIMIT 1`);
    while (
      catalogExists.get(catalogNumber) ||
      reservationExists.get(`${CATALOG_RESERVATION_PREFIX}${catalogNumber}`)
    ) {
      next++;
      catalogNumber = `${prefix}${String(next).padStart(MIN_DIGITS, '0')}`;
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(counterKey, String(next), now);

    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
      `${CATALOG_RESERVATION_PREFIX}${catalogNumber}`,
      prefix,
      now
    );
    return catalogNumber;
  })();
}

export function replacePrimerLegacyProjectionInDb(
  db: Database.Database,
  input: PrimerLegacyProjectionInput,
  relationshipAuthority?: VerifiedPrimerRelationshipAuthority
): void {
  db.transaction(() => replacePrimerLegacyProjectionInsideTx(db, input, relationshipAuthority))();
  if (relationshipAuthority?.relationships.length)
    materializeLimsGitExportForWorkspaceIds(db, [input.workspaceId]);
}

export function replacePrimerLegacyProjectionInsideTx(
  db: Database.Database,
  input: PrimerLegacyProjectionInput,
  relationshipAuthority?: VerifiedPrimerRelationshipAuthority
): void {
  if (!db.inTransaction) throw new Error('Primer projection requires an active transaction.');
  const authority = primerProjectionAuthority(db, input);
  if (!authority) legacyPrimerProjectionOwner(db, input);
  if (input.retireArtifact) {
    retirePrimerProjection(db, input, authority);
    return;
  }
  if (authority) {
    const { artifact, resolvedBindings } = readCheckedCanonicalPrimerArtifact(
      db,
      input.id,
      authority
    );
    const expected = primerLegacyProjectionFromArtifact(
      artifact,
      authority.workspaceId,
      resolvedBindings
    );
    const { registryRelationships: _relationships, ...physicalInput } = input;
    if (!isDeepStrictEqual(physicalInput, expected))
      throw new Error('Primer compatibility projection does not match its authoritative artifact.');
  }

  db.prepare(
    `INSERT INTO primers (
      id, catalog_number, name, sequence, length, tm, gc_percent, origin, origin_details,
      status, vendor, modifications, application, notes, workspace_id, created_at, updated_at,
      order_date, scale, purification, stock_location, concentration
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      catalog_number = excluded.catalog_number,
      name = excluded.name,
      sequence = excluded.sequence,
      length = excluded.length,
      tm = excluded.tm,
      gc_percent = excluded.gc_percent,
      origin = excluded.origin,
      origin_details = excluded.origin_details,
      status = excluded.status,
      vendor = excluded.vendor,
      modifications = excluded.modifications,
      application = excluded.application,
      notes = excluded.notes,
      order_date = CASE WHEN ? THEN excluded.order_date ELSE primers.order_date END,
      scale = CASE WHEN ? THEN excluded.scale ELSE primers.scale END,
      purification = CASE WHEN ? THEN excluded.purification ELSE primers.purification END,
      stock_location = CASE WHEN ? THEN excluded.stock_location ELSE primers.stock_location END,
      concentration = CASE WHEN ? THEN excluded.concentration ELSE primers.concentration END,
      workspace_id = excluded.workspace_id,
      updated_at = excluded.updated_at`
  ).run(
    input.id,
    input.catalogNumber,
    input.name,
    input.sequence,
    input.length,
    input.tm,
    input.gcPercent,
    input.origin,
    JSON.stringify(input.originDetails),
    input.status ?? 'designed',
    input.vendor,
    input.modifications,
    input.application,
    input.notes,
    input.workspaceId,
    input.createdAt,
    input.updatedAt,
    input.orderDate ?? null,
    input.scale ?? null,
    input.purification ?? null,
    input.stockLocation ?? null,
    input.concentration ?? null,
    ...['orderDate', 'scale', 'purification', 'stockLocation', 'concentration'].map((key) =>
      Object.prototype.hasOwnProperty.call(input, key) ? 1 : 0
    )
  );

  db.prepare(`DELETE FROM primer_bindings WHERE primer_id = ?`).run(input.id);
  const insertBinding = db.prepare(
    `INSERT INTO primer_bindings (
      id, primer_id, sequence_id, binding_start, binding_end, strand, source,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const binding of input.bindings) {
    insertBinding.run(
      binding.id,
      input.id,
      binding.sequenceId,
      binding.bindingStart,
      binding.bindingEnd,
      binding.strand,
      binding.source,
      binding.createdAt ?? input.createdAt,
      binding.updatedAt ?? input.updatedAt
    );
  }
  restorePrimerRegistryRelationshipsInsideTx(db, input, relationshipAuthority);
}

export function resolvePrimerProjectionWorkspaceRootInDb(
  db: Database.Database,
  input: PrimerLegacyProjectionInput
): string | null {
  return (
    primerProjectionAuthority(db, input)?.workspaceRoot ?? legacyPrimerProjectionOwner(db, input)
  );
}

export function assertPrimerRegistryProjection(
  db: Database.Database,
  input: LimsRegisterEntityInput | LimsUpdateEntityInput | LimsEntityActionInput,
  action: 'register' | 'update' | 'archive' | 'restore' | 'revert'
): boolean {
  const request = input as Partial<LimsRegisterEntityInput & LimsUpdateEntityInput>;
  const existing =
    typeof request.id === 'string'
      ? (db
          .prepare(
            'SELECT id,name,kind,fields,workspace_id,registration_status,domain_status FROM lims_entity WHERE id=?'
          )
          .get(request.id) as
          | {
              id: string;
              name: string;
              kind: string;
              fields: string;
              workspace_id: number | null;
              registration_status: string;
              domain_status: string | null;
            }
          | undefined)
      : undefined;
  const storedFields = existing ? (JSON.parse(existing.fields) as Record<string, unknown>) : null;
  const marker = (fields: Record<string, unknown> | null | undefined) =>
    fields?.artifact && typeof fields.artifact === 'object'
      ? (fields.artifact as Record<string, unknown>)
      : null;
  const previousMarker = marker(storedFields);
  const requestedMarker = marker(request.fields);
  const known =
    typeof request.id === 'string' &&
    db.prepare("SELECT 1 FROM catalog_entities WHERE id=? AND type='primer'").get(request.id);
  if (
    previousMarker?.schema !== 'dnaforge.primer' &&
    requestedMarker?.schema !== 'dnaforge.primer' &&
    !known
  )
    return false;
  if (action === 'revert')
    throw new Error(
      'Canonical primers must be revised through their authoritative file lifecycle.'
    );
  const source = requestedMarker?.schema === 'dnaforge.primer' ? requestedMarker : previousMarker;
  if (
    !source ||
    typeof request.id !== 'string' ||
    !request.id ||
    typeof source.relativePath !== 'string'
  )
    throw new Error('The canonical primer Registry projection has no checked artifact identity.');
  const workspaceId = existing?.workspace_id ?? request.workspaceId;
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId == null ||
    (request.workspaceId !== undefined && request.workspaceId !== workspaceId)
  )
    throw new Error(
      'The canonical primer Registry projection cannot replace its native workspace owner.'
    );
  const owner = db
    .prepare('SELECT path,archived_at,trashed_at FROM workspaces WHERE id=?')
    .get(workspaceId) as
    | { path: string; archived_at: number | null; trashed_at: number | null }
    | undefined;
  if (!owner || owner.archived_at !== null || owner.trashed_at !== null)
    throw new Error('The canonical primer project owner is unavailable.');
  const root = realpathSync(owner.path);
  const relativePath = source.relativePath;
  const path = resolve(root, relativePath);
  if (
    !relativePath ||
    !pathIsAtOrUnder(path, root) ||
    pathRelativeToBoundary(path, root) !== relativePath
  )
    throw new Error('The canonical primer artifact path escapes its native workspace.');
  const bindings = db
    .prepare(
      "SELECT f.entity_id,f.workspace_id,f.relative_path,f.path,f.content_hash FROM catalog_entity_files f WHERE f.file_kind='primer-artifact' AND f.status='current' AND (f.entity_id=? OR (f.workspace_id=? AND f.relative_path=?))"
    )
    .all(request.id, workspaceId, relativePath) as Array<{
    entity_id: string;
    workspace_id: number;
    relative_path: string;
    path: string;
    content_hash: string | null;
  }>;
  if (bindings.length > 1) throw new Error('The canonical primer Registry source is ambiguous.');
  const binding = bindings[0];
  if (
    binding &&
    (binding.workspace_id !== workspaceId ||
      binding.relative_path !== relativePath ||
      !sameNativePrimerPath(binding.path, path))
  )
    throw new Error('The canonical primer Registry source disagrees with its native binding.');
  if (action === 'archive') {
    if (
      !existing ||
      existsSync(path) ||
      previousMarker?.schema !== 'dnaforge.primer' ||
      (binding && binding.content_hash !== `sha256:${String(previousMarker.contentHash)}`)
    )
      throw new Error('Canonical primer archive requires its checked source file removal.');
    return true;
  }
  const hash = source.contentHash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))
    throw new Error('The canonical primer Registry projection requires its actual artifact hash.');
  const checked = readCheckedCanonicalPrimerArtifact(db, binding?.entity_id ?? null, {
    path,
    relativePath,
    workspaceRoot: owner.path,
    workspaceId,
    contentHash: `sha256:${hash}`,
    status: 'current',
    artifactRevision: Number(source.revision),
  });
  const artifact = checked.artifact;
  if (
    artifact.registry.entityId !== request.id ||
    (request.kind !== undefined && request.kind !== artifact.registry.kind) ||
    (existing && existing.kind !== artifact.registry.kind)
  )
    throw new Error('The canonical primer Registry identity or kind disagrees with its artifact.');
  const expected = primerRegistryProjectionFromArtifact(artifact, hash);
  const prospectiveFields = request.fields
    ? request.replaceFields || action === 'register'
      ? request.fields
      : { ...storedFields, ...request.fields }
    : storedFields;
  if (
    !isDeepStrictEqual(prospectiveFields, expected.fields) ||
    (request.name ?? existing?.name) !== artifact.name ||
    (request.registrationStatus ?? existing?.registration_status ?? 'registered') !==
      expected.registrationStatus ||
    (request.domainStatus !== undefined
      ? request.domainStatus
      : existing
        ? existing.domain_status
        : 'designed') !== expected.domainStatus
  )
    throw new Error(
      'Canonical primer Registry changes must exactly project the authoritative artifact.'
    );
  if (
    (request.schemaRevisionId !== undefined &&
      request.schemaRevisionId !== artifact.entity?.schema.schemaRevisionId) ||
    (request.schemaSnapshot !== undefined &&
      !isDeepStrictEqual(request.schemaSnapshot, artifact.entity?.schema))
  )
    throw new Error(
      'The canonical primer Registry schema disagrees with its authoritative artifact.'
    );
  return true;
}

function sameNativePrimerPath(left: string, right: string): boolean {
  return workspaceMutationRootIdentity(left) === workspaceMutationRootIdentity(right);
}

function legacyPrimerProjectionOwner(
  db: Database.Database,
  input: PrimerLegacyProjectionInput
): string | null {
  const row = db.prepare('SELECT workspace_id FROM primers WHERE id=?').get(input.id) as
    | { workspace_id: number | null }
    | undefined;
  if (!row)
    throw new Error(
      'New primer authoring requires a canonical artifact; legacy creation is unsupported.'
    );
  if (row.workspace_id !== input.workspaceId)
    throw new Error('A legacy primer identity cannot acquire another workspace owner.');
  if (row.workspace_id === null) return null;
  const owner = db.prepare('SELECT path FROM workspaces WHERE id=?').get(row.workspace_id) as
    | { path: string }
    | undefined;
  if (!owner) throw new Error('The legacy primer workspace owner is unavailable.');
  assertWorkspaceWriteAllowed(db, [owner.path]);
  return owner.path;
}

function readCheckedCanonicalPrimerArtifact(
  db: Database.Database,
  id: string | null,
  authority: PrimerProjectionAuthority
) {
  const accepted = id
    ? readAcceptedPrimerProjectionSourceInDb(db, authority.workspaceId, id)
    : null;
  if (accepted) {
    if (
      accepted.relativePath !== authority.relativePath ||
      accepted.contentHash !== authority.contentHash ||
      accepted.artifact.artifactRevision !== authority.artifactRevision
    )
      throw new Error('The accepted primer projection disagrees with its native binding.');
    return { ...accepted, workspaceRoot: authority.workspaceRoot };
  }
  const leaf = lstatSync(authority.path, { bigint: true });
  if (!leaf.isFile() || leaf.isSymbolicLink())
    throw new Error('Canonical primer projection requires its regular authoritative file.');
  if (!pathIsAtOrUnder(realpathSync(authority.path), realpathSync(authority.workspaceRoot)))
    throw new Error('Canonical primer artifact escapes its native workspace.');
  const bytes = readFileSync(authority.path);
  const artifact = parsePrimerArtifact(bytes.toString('utf8'));
  if (
    createHash('sha256').update(artifact.sequence.bases).digest('hex') !==
    artifact.sequence.contentHash
  )
    throw new Error('The canonical primer sequence hash does not match its authoritative bases.');
  if (
    authority.contentHash !==
    `sha256:${createHash('sha256').update(serializePrimerArtifact(artifact)).digest('hex')}`
  )
    throw new Error(
      'The canonical primer artifact changed before projection. Reconcile its checked file first.'
    );
  if (
    (id !== null && artifact.id !== id) ||
    artifact.file.workspaceRelativePath !== authority.relativePath
  )
    throw new Error('The canonical primer artifact identity does not match its native binding.');
  const current = lstatSync(authority.path, { bigint: true });
  if (
    current.ino !== leaf.ino ||
    current.dev !== leaf.dev ||
    current.size !== leaf.size ||
    current.mtimeNs !== leaf.mtimeNs ||
    current.ctimeNs !== leaf.ctimeNs
  )
    throw new Error('The canonical primer artifact changed during projection.');
  return {
    artifact,
    resolvedBindings: nativePrimerBindings(db, artifact, authority),
    workspaceRoot: authority.workspaceRoot,
  };
}

export function readCanonicalPrimerReferenceArtifactInDb(db: Database.Database, primerId: string) {
  const row = db
    .prepare('SELECT workspace_id,origin_details FROM primers WHERE id=?')
    .get(primerId) as { workspace_id: number | null; origin_details: string | null } | undefined;
  if (!row) throw new Error('The canonical primer projection is unavailable.');
  const authority = primerProjectionAuthority(db, {
    id: primerId,
    workspaceId: row.workspace_id,
    originDetails: JSON.parse(row.origin_details ?? '{}'),
  } as PrimerLegacyProjectionInput);
  if (!authority)
    throw new Error(
      'A legacy primer must be translated to its canonical Registry identity before linking.'
    );
  return readCheckedCanonicalPrimerArtifact(db, primerId, authority);
}

interface PrimerProjectionAuthority {
  path: string;
  relativePath: string;
  workspaceRoot: string;
  workspaceId: number;
  contentHash: string | null;
  status: string;
  artifactRevision: number;
}

function primerProjectionAuthority(
  db: Database.Database,
  input: PrimerLegacyProjectionInput
): PrimerProjectionAuthority | null {
  const hasCatalog = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_entity_files'")
    .get();
  const rows = hasCatalog
    ? (db
        .prepare(
          `SELECT f.path,f.relative_path,f.workspace_id,f.content_hash,f.status,e.metadata,w.path AS workspace_root
    FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
    JOIN workspaces w ON w.id=f.workspace_id WHERE f.entity_id=? AND f.file_kind='primer-artifact'
    ORDER BY CASE WHEN f.status='current' THEN 0 ELSE 1 END,f.updated_at DESC`
        )
        .all(input.id) as Array<{
        path: string;
        relative_path: string;
        workspace_id: number;
        content_hash: string | null;
        status: string;
        metadata: string | null;
        workspace_root: string;
      }>)
    : [];
  const claimsArtifact = input.originDetails?.authority === 'primer_artifact';
  if (rows.length === 0) {
    const stored = db.prepare('SELECT origin_details FROM primers WHERE id=?').get(input.id) as
      | { origin_details: string | null }
      | undefined;
    const marker = stored?.origin_details
      ? (JSON.parse(stored.origin_details) as Record<string, unknown>).authority ===
        'primer_artifact'
      : false;
    const canonical =
      hasCatalog &&
      db
        .prepare(
          "SELECT 1 FROM catalog_entities WHERE id=? AND type='primer' UNION ALL SELECT 1 FROM lims_entity WHERE id=? AND kind IN ('oligo','rna_oligo') LIMIT 1"
        )
        .get(input.id, input.id);
    if (claimsArtifact || input.retireArtifact || canonical || marker)
      throw new Error('Canonical primer projection has no native artifact binding.');
    return null;
  }
  const current = rows.filter((row) => row.status === 'current');
  if (!input.retireArtifact && current.length !== 1)
    throw new Error('Canonical primer projection has no unique current artifact.');
  const row = input.retireArtifact
    ? rows.find((row) => row.relative_path === input.retireArtifact!.artifactPath)
    : current[0];
  if (
    !row ||
    !claimsArtifact ||
    input.workspaceId !== row.workspace_id ||
    input.originDetails.artifactPath !== row.relative_path
  )
    throw new Error('Canonical primer projection identity or workspace owner is inconsistent.');
  const root = realpathSync(row.workspace_root);
  const path = resolve(root, row.relative_path);
  if (!pathIsAtOrUnder(path, root) || !sameNativePrimerPath(row.path, path))
    throw new Error('Canonical primer projection path escapes its native workspace.');
  const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
  return {
    path,
    relativePath: row.relative_path,
    workspaceRoot: row.workspace_root,
    workspaceId: row.workspace_id,
    contentHash: row.content_hash,
    status: row.status,
    artifactRevision: Number(metadata.artifactRevision),
  };
}

function nativePrimerBindings(
  db: Database.Database,
  artifact: PrimerArtifactV1,
  authority: PrimerProjectionAuthority
) {
  const resolved: Array<{ binding: PrimerArtifactBindingV1; sequenceId: number }> = [];
  for (const binding of artifact.bindings) {
    let owner = authority.workspaceId;
    let targetRoot = authority.workspaceRoot;
    if (binding.target.projectId) {
      const workspaces = db
        .prepare(
          'SELECT id,repo_uuid,path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL'
        )
        .all() as Array<{ id: number; repo_uuid: string | null; path: string }>;
      const matching = workspaces.filter(
        (row) => workspaceScopeKey(row.repo_uuid, row.id) === binding.target.projectId
      );
      if (matching.length !== 1) continue;
      owner = matching[0].id;
      targetRoot = matching[0].path;
    }
    const rows = binding.target.documentId
      ? db
          .prepare(
            `SELECT s.id,s.document_id,s.length,s.circular,f.path FROM sequences s JOIN indexed_files f ON f.id=s.file_id WHERE s.document_id=? AND f.workspace_id=?`
          )
          .all(binding.target.documentId, owner)
      : db
          .prepare(
            `SELECT s.id,s.document_id,s.length,s.circular,f.path FROM sequences s JOIN indexed_files f ON f.id=s.file_id WHERE f.path=? AND f.workspace_id=?`
          )
          .all(resolve(targetRoot, binding.target.legacyWorkspaceRelativePath ?? ''), owner);
    if (rows.length > 1) throw new Error('Canonical primer target sequence identity is ambiguous.');
    const row = rows[0] as
      | { id: number; document_id: string; length: number; circular: number; path: string }
      | undefined;
    if (!row || !existsSync(row.path)) continue;
    if (isFastaKindSourcePath(row.path))
      assertCanonicalSequenceSourceInDb(db, {
        documentId: binding.target.documentId ?? row.document_id,
        filePath: row.path,
        workspaceRoot: targetRoot,
      });
    if (
      row.length !== binding.target.length ||
      (row.circular === 1 ? 'circular' : 'linear') !== binding.target.topology
    )
      throw new Error('Canonical primer target changed before projection.');
    resolved.push({ binding, sequenceId: row.id });
  }
  return resolved;
}

function retirePrimerProjection(
  db: Database.Database,
  input: PrimerLegacyProjectionInput,
  authority: PrimerProjectionAuthority | null
) {
  if (
    !authority ||
    authority.status === 'current' ||
    existsSync(authority.path) ||
    input.retireArtifact!.expectedArtifactRevision !== authority.artifactRevision
  )
    throw new Error(
      'Canonical primer retirement requires its checked file removal and historical binding.'
    );
  const row = db
    .prepare('SELECT archived_at,tombstone FROM lims_entity WHERE id=?')
    .get(input.id) as { archived_at: number | null; tombstone: number } | undefined;
  if (!row || (row.archived_at === null && row.tombstone !== 1))
    throw new Error('Canonical primer retirement requires its archived Registry identity.');
  db.prepare('DELETE FROM primers WHERE id=?').run(input.id);
}
