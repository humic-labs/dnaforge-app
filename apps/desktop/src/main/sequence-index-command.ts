import { assertDeclaredFastaKindInDb, getFastaKindReadAuthorityInDb } from './fasta-kind-authority';
import { isFastaKindSourcePath } from '../shared/fasta-kind';
import type Database from 'better-sqlite3';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { SequenceIndexRequest } from '../shared/sequence-index-command';
import {
  findContainingPathBoundary,
  pathIsAtOrUnder,
  pathRelativeToBoundary,
} from '../shared/path-boundary';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { isBinarySequencePath, parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { loadCatalogManifestEntity } from './catalog-source-authority';
import type { CatalogEntityRow } from '../shared/catalog-registration';
import { nativeWorkspaceEntityPrimaryFile } from '../shared/native-workspace-manifest';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import {
  isSequencePackageFileKind,
  parseSequencePackageDocument,
  resolveSequenceProductFile,
  sequencePackageMetaPaths,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import { readClassificationFile } from './native-sequence-classification-review';
import { parseResourceId } from '@waypoint/workspace-revisions';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';

interface WorkspaceOwner {
  id: number;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface BoundSequence {
  id: string;
  entity_id: string;
  workspace_id: number;
  path: string;
  file_kind: string;
  object_uuid: string | null;
  entity_type: string;
}

function canonicalOwnerPath(owner: WorkspaceOwner, path: string): string {
  const root = realpathSync(owner.path);
  const relativePath =
    pathRelativeToBoundary(path, owner.path) ?? pathRelativeToBoundary(path, root);
  if (relativePath === null) throw new Error('Sequence file is outside its catalog project owner.');
  return join(root, relativePath);
}

function resolveOwner(db: Database.Database, request: SequenceIndexRequest): WorkspaceOwner {
  const owners = db
    .prepare('SELECT id,path,repo_uuid,archived_at,trashed_at FROM workspaces')
    .all() as WorkspaceOwner[];
  const candidates = owners.map((owner) => {
    let path = owner.path;
    try {
      path = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { ...owner, path };
  });
  let target = request.filePath;
  const explicit =
    request.workspaceRoot === undefined
      ? null
      : owners.find((owner) => owner.path === request.workspaceRoot);
  if (request.workspaceRoot !== undefined && !explicit)
    throw new Error('Sequence project owner is not registered.');
  if (explicit) target = canonicalOwnerPath(explicit, target);
  const candidate = findContainingPathBoundary(candidates, target);
  const owner = candidate ? owners.find((owner) => owner.id === candidate.id) : null;
  if (!owner || (explicit && owner.id !== explicit.id))
    throw new Error('Could not identify the project that owns sequence file.');
  if (owner.archived_at !== null || owner.trashed_at !== null)
    throw new Error('The sequence project owner is inactive.');
  return owner;
}

function boundSource(
  db: Database.Database,
  owner: WorkspaceOwner,
  request: SequenceIndexRequest
): { binding: BoundSequence; path: string; identities: string[] } {
  const sourcePath = canonicalOwnerPath(owner, request.filePath);
  const bindings = db
    .prepare(
      `SELECT f.*,e.type AS entity_type FROM catalog_entity_files f
    JOIN catalog_entities e ON e.id=f.entity_id
    WHERE f.workspace_id=? AND e.workspace_id=? AND f.status='current' AND e.status='active'`
    )
    .all(owner.id, owner.id) as BoundSequence[];
  const matches: Array<{ binding: BoundSequence; path: string; identities: string[] }> = [];
  function bindingIdentities(binding: BoundSequence): string[] {
    const entity = db
      .prepare('SELECT * FROM catalog_entities WHERE id=?')
      .get(binding.entity_id) as CatalogEntityRow;
    const source = loadCatalogManifestEntity(db, entity);
    const portableId =
      source &&
      nativeWorkspaceEntityPrimaryFile(source.portable) ===
        pathRelativeToBoundary(binding.path, owner.path)
        ? source.portable.id
        : null;
    return [binding.entity_id, binding.object_uuid, portableId].filter(
      (id): id is string => typeof id === 'string'
    );
  }
  for (const binding of bindings) {
    const boundPath = canonicalOwnerPath(owner, binding.path);
    const packageRoot =
      sequencePackageRootForMetaPath(boundPath) ??
      (isSequencePackageFileKind(binding.file_kind) ? boundPath : null);
    if (packageRoot) {
      if (!pathIsAtOrUnder(sourcePath, packageRoot)) continue;
      const metadataPaths = sequencePackageRootForMetaPath(boundPath)
        ? [boundPath]
        : sequencePackageMetaPaths(packageRoot);
      let metadata: string | null = null;
      for (const path of metadataPaths) {
        try {
          metadata = readClassificationFile(
            realpathSync(owner.path),
            path,
            4 * 1024 * 1024
          ).toString('utf8');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (metadata === null) throw new Error('Sequence package identity metadata is unavailable.');
      const document = parseSequencePackageDocument(metadata);
      const expectedProjectionId = scopedProjectionId(
        workspaceScopeKey(owner.repo_uuid, owner.id),
        document.id
      );
      if (binding.entity_id !== document.id && binding.entity_id !== expectedProjectionId)
        throw new Error('Sequence package identity differs from its catalog identity.');
      if (![document.id, binding.entity_id, binding.object_uuid].includes(request.documentId))
        continue;
      const product = resolveSequenceProductFile(
        document.product.file,
        readdirSync(packageRoot, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
        }))
      );
      const productPath = join(packageRoot, product);
      if (sourcePath !== productPath)
        throw new Error('Sequence index must use the exact package product file.');
      matches.push({
        binding,
        path: productPath,
        identities: [
          document.id,
          binding.entity_id,
          ...(binding.object_uuid ? [binding.object_uuid] : []),
        ],
      });
    } else if (
      sourcePath === boundPath &&
      ['sequence', 'trace', 'construct', 'file'].includes(binding.entity_type) &&
      bindingIdentities(binding).includes(request.documentId)
    ) {
      matches.push({ binding, path: boundPath, identities: bindingIdentities(binding) });
    }
  }
  if (matches.length !== 1)
    throw new Error('Sequence document identity has no unique canonical catalog file owner.');
  return matches[0];
}

function assertSequenceIndexRequest(request: SequenceIndexRequest): void {
  if (
    !request ||
    typeof request.documentId !== 'string' ||
    !request.documentId.trim() ||
    request.documentId.includes('\0') ||
    typeof request.filePath !== 'string' ||
    resolve(request.filePath) !== request.filePath ||
    request.filePath.includes('\0')
  )
    throw new Error('Sequence index identity and source path are invalid.');
}

export function assertCanonicalSequenceSourceInDb(
  db: Database.Database,
  request: SequenceIndexRequest
): void {
  assertSequenceIndexRequest(request);
  const owner = resolveOwner(db, request);
  const { binding, path } = boundSource(db, owner, request);
  if (isFastaKindSourcePath(path) && !isSequencePackageFileKind(binding.file_kind))
    assertDeclaredFastaKindInDb(db, { path, workspaceRoot: owner.path }, 'sequence');
}

interface SequenceIndexMetadata {
  name: string;
  length: number;
  circular: 0 | 1;
}

function acceptedSequenceMetadata(
  db: Database.Database,
  workspaceId: number,
  entityId: string,
  path: string
): SequenceIndexMetadata | null {
  if (!hasAcceptedScientificWorkspace(db, workspaceId)) return null;
  const resourceId = parseResourceId(entityId);
  if (!resourceId.ok) return null;
  const document = new ScientificObjectStore(db, workspaceId)
    .read()
    .reader.current(resourceId.value)?.document;
  if (document?.kind !== 'sequence') return null;
  return {
    name: document.name || basename(path),
    length: document.bases.length,
    circular: document.topology === 'circular' ? 1 : 0,
  };
}

function workingSequenceMetadata(owner: WorkspaceOwner, path: string): SequenceIndexMetadata {
  const bytes = readClassificationFile(realpathSync(owner.path), path, HARD_CAP_BYTES);
  const document = parseSequenceFileAsDocument(
    isBinarySequencePath(path) ? bytes : bytes.toString('utf8'),
    path
  );
  return {
    name: document.sequence.name || basename(path),
    length: document.sequence.sequence.length,
    circular: document.sequence.circular ? 1 : 0,
  };
}

export function ensureSequenceIndexInDb(
  db: Database.Database,
  request: SequenceIndexRequest
): number {
  assertSequenceIndexRequest(request);
  return db.transaction(() => {
    const owner = resolveOwner(db, request);
    const { binding, path, identities } = boundSource(db, owner, request);
    if (isFastaKindSourcePath(path) && !isSequencePackageFileKind(binding.file_kind)) {
      const authority = getFastaKindReadAuthorityInDb(db, { path, workspaceRoot: owner.path });
      if (
        authority.status === 'needs-classification' ||
        (authority.status === 'declared'
          ? authority.kind !== 'sequence'
          : authority.legacyReadView !== 'sequence')
      )
        throw new Error(
          'FASTA_KIND_CLASSIFICATION_REQUIRED: A legacy protein view cannot become a nucleotide index.'
        );
    }
    const metadata =
      acceptedSequenceMetadata(db, owner.id, binding.entity_id, path) ??
      workingSequenceMetadata(owner, path);
    const existingFile = db
      .prepare('SELECT id,workspace_id,path FROM indexed_files WHERE path=?')
      .get(request.filePath) as { id: number; workspace_id: number; path: string } | undefined;
    if (existingFile && existingFile.workspace_id !== owner.id) {
      const prior = db
        .prepare('SELECT path FROM workspaces WHERE id=?')
        .get(existingFile.workspace_id) as { path: string } | undefined;
      if (!prior || pathIsAtOrUnder(existingFile.path, prior.path))
        throw new Error('Sequence indexed file belongs to a different project owner.');
      db.prepare('UPDATE indexed_files SET workspace_id=? WHERE id=?').run(
        owner.id,
        existingFile.id
      );
    }
    const existingDocuments = db
      .prepare(
        `SELECT s.id,s.file_id,s.document_id,f.workspace_id,f.path FROM sequences s JOIN indexed_files f ON f.id=s.file_id WHERE s.document_id=? OR (f.workspace_id=? AND s.document_id IN (${identities.map(() => '?').join(',')}))`
      )
      .all(request.documentId, owner.id, ...identities) as Array<{
      id: number;
      file_id: number;
      document_id: string;
      workspace_id: number;
      path: string;
    }>;
    if (existingDocuments.length > 1) throw new Error('Sequence document identity is ambiguous.');
    const current = existingDocuments[0];
    if (current && current.path !== request.filePath) {
      const previous = db
        .prepare('SELECT entity_id,workspace_id FROM catalog_entity_files WHERE path=?')
        .get(current.path) as { entity_id: string; workspace_id: number } | undefined;
      let previousSourceMissing = false;
      try {
        lstatSync(canonicalOwnerPath(owner, current.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        previousSourceMissing = true;
      }
      const sameCatalogOwner =
        previous?.workspace_id === owner.id && previous.entity_id === binding.entity_id;
      const checkedAbsentLocator =
        previous === undefined && previousSourceMissing && identities.includes(current.document_id);
      if (current.workspace_id !== owner.id || (!sameCatalogOwner && !checkedAbsentLocator))
        throw new Error(
          'Sequence document identity cannot take over another catalog file or project owner.'
        );
    }
    const fileId =
      existingFile?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO indexed_files(workspace_id,path,name,extension,indexed_at) VALUES(?,?,?,?,?)`
          )
          .run(
            owner.id,
            request.filePath,
            basename(request.filePath),
            extname(request.filePath).slice(1),
            Date.now()
          ).lastInsertRowid
      );
    const sameFile = db
      .prepare('SELECT id,document_id FROM sequences WHERE file_id=? ORDER BY id')
      .all(fileId) as Array<{ id: number; document_id: string }>;
    if (
      sameFile.some(
        (row) =>
          !identities.includes(row.document_id) && !row.document_id.startsWith('legacy-sequence:')
      )
    )
      throw new Error('Sequence indexed file already has a different document identity.');
    const legacy = sameFile.filter((row) => row.document_id.startsWith('legacy-sequence:'));
    if (!current && legacy.length > 1) throw new Error('Sequence legacy identity is ambiguous.');
    const id = current?.id ?? legacy[0]?.id;
    if (id !== undefined) {
      db.prepare(
        'UPDATE sequences SET document_id=?,file_id=?,name=?,length=?,circular=? WHERE id=?'
      ).run(
        current?.document_id ?? request.documentId,
        fileId,
        metadata.name,
        metadata.length,
        metadata.circular,
        id
      );
      return id;
    }
    return Number(
      db
        .prepare(
          'INSERT INTO sequences(file_id,document_id,name,length,circular) VALUES(?,?,?,?,?)'
        )
        .run(fileId, request.documentId, metadata.name, metadata.length, metadata.circular)
        .lastInsertRowid
    );
  })();
}
