import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { canonicalJson } from '../shared/canonical-json';
import {
  FASTA_KIND_DECLARATION_EVENT,
  fastaKindClassificationSchema,
  fastaKindInspectionSchema,
  isFastaKindSourcePath,
  type DeclaredFastaKindAuthority,
  type FastaKind,
  type FastaKindAuthority,
  type FastaKindClassification,
  type FastaKindInspection,
  type FastaKindReadAuthority,
} from '../shared/fasta-kind';
import type { CatalogFileBindingRow } from '../shared/catalog-binding';
import type { CatalogEntityRow } from '../shared/catalog-registration';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  nativeWorkspaceEntityPrimaryFile,
  parseNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import { contentHashInMain } from './content-hash';
import {
  findCatalogManifestEntity,
  requireCatalogSourceOwner,
  type CatalogSourceOwner,
} from './catalog-source-authority';
import { readClassificationFile } from './native-sequence-classification-review';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

type RunDatabase = <T>(operation: () => T) => T;
interface DeclarationRow {
  id: string;
  payload: string | null;
}
interface KindSnapshot {
  entity: CatalogEntityRow;
  binding: CatalogFileBindingRow;
  owner: CatalogSourceOwner;
  path: string;
  file: ReturnType<typeof sourceStat>;
  declaration: { id: string; kind: FastaKind; payload: Record<string, unknown> } | null;
  canonical: { kind: FastaKind; fingerprint: string } | null;
  registry: { kind: string; schema_revision_id: string | null } | null;
}

function fail(code: string, message: string): never {
  throw new Error(`FASTA_KIND_${code}: ${message}`);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function sourceStat(path: string) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) fail('SOURCE_INVALID', 'The FASTA source is not a regular file.');
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
  };
}
function readSnapshot(db: Database.Database, input: FastaKindInspection): KindSnapshot {
  const path = workspaceMutationRootIdentity(input.path);
  if (!isFastaKindSourcePath(path)) fail('SOURCE_INVALID', 'The source must be a FASTA file.');
  const root = workspaceMutationRootIdentity(input.workspaceRoot);
  const owners = db.prepare('SELECT * FROM workspaces').all() as CatalogSourceOwner[];
  const matchingOwners = owners.filter(
    (owner) => workspaceMutationRootIdentity(owner.path) === root
  );
  if (matchingOwners.length > 1)
    fail('OWNER_AMBIGUOUS', 'The physical FASTA project has more than one native owner.');
  const owner = matchingOwners[0];
  if (!owner) fail('OWNER_MISMATCH', 'The requested FASTA project has no native owner.');
  if (owner.archived_at !== null || owner.trashed_at !== null)
    fail('OWNER_INACTIVE', 'The FASTA project must be restored before it can be used.');
  assertWorkspaceProjectionPathSafe(root, path);
  const relativePath = relative(root, path);
  const spellings = [...new Set([resolve(input.path), path, join(owner.path, relativePath)])];
  const matches = db
    .prepare(
      `SELECT * FROM catalog_entity_files WHERE status='current' AND
    (path IN (${spellings.map(() => '?').join(',')}) OR (workspace_id=? AND relative_path=?))`
    )
    .all(...spellings, owner.id, relativePath) as CatalogFileBindingRow[];
  const bindings = matches.filter((row) => workspaceMutationRootIdentity(row.path) === path);
  if (bindings.length !== 1)
    fail('BINDING_UNAVAILABLE', 'Exactly one current FASTA binding is required.');
  const binding = bindings[0];
  if (binding.file_kind !== 'fasta')
    fail('REPRESENTATION_MISMATCH', 'The native binding does not identify a FASTA representation.');
  const entity = db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(binding.entity_id) as
    | CatalogEntityRow
    | undefined;
  if (
    !entity ||
    entity.status !== 'active' ||
    !['sequence', 'protein'].includes(entity.type) ||
    entity.workspace_id === null ||
    entity.workspace_id !== binding.workspace_id ||
    entity.workspace_id !== owner.id
  )
    fail('OWNER_INVALID', 'The FASTA must retain one active scientific entity and project owner.');
  const file = sourceStat(path);
  const rows = db
    .prepare(
      'SELECT id,payload FROM catalog_entity_events WHERE entity_id=? AND event_type=? ORDER BY rowid DESC'
    )
    .all(entity.id, FASTA_KIND_DECLARATION_EVENT) as DeclarationRow[];
  let declaration: KindSnapshot['declaration'] = null;
  if (rows.length) {
    const payload = rows[0].payload
      ? (JSON.parse(rows[0].payload) as Record<string, unknown>)
      : null;
    if (
      !payload ||
      payload.version !== 1 ||
      payload.entityId !== entity.id ||
      payload.workspaceId !== owner.id ||
      !['sequence', 'protein'].includes(String(payload.kind))
    )
      fail('HISTORY_INVALID', 'The native kind declaration history is invalid.');
    declaration = { id: rows[0].id, kind: payload.kind as FastaKind, payload };
    if (declaration.kind !== entity.type)
      fail('HISTORY_CONFLICT', 'The catalog kind disagrees with its native declaration.');
  }
  let canonical: KindSnapshot['canonical'] = null;
  let manifestBytes: Buffer | null = null;
  try {
    manifestBytes = readClassificationFile(
      root,
      join(root, NATIVE_WORKSPACE_MANIFEST_PATH),
      16 * 1024 * 1024
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifestBytes) {
    const bytes = manifestBytes;
    const manifest = parseNativeWorkspaceManifest(bytes.toString('utf8'));
    const portable = findCatalogManifestEntity(owner, entity.id, manifest.entities);
    if (portable) {
      const source = nativeWorkspaceEntityPrimaryFile(portable);
      if (!source || realpathSync(join(root, source)) !== realpathSync(path))
        fail('SOURCE_CONFLICT', 'The canonical declaration points to another source.');
      if (portable.type !== 'sequence' && portable.type !== 'protein')
        fail('SCHEMA_CONFLICT', 'The canonical source declares another scientific kind.');
      if (
        portable.lims?.kind &&
        ((portable.type === 'protein' && portable.lims.kind !== 'protein') ||
          (portable.type === 'sequence' && portable.lims.kind === 'protein'))
      )
        fail('SCHEMA_CONFLICT', 'The canonical schema and scientific kind disagree.');
      canonical = {
        kind: portable.type,
        fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      };
    }
  }
  const registry = db
    .prepare('SELECT kind,schema_revision_id FROM lims_entity WHERE id=? AND tombstone=0')
    .get(entity.id) as KindSnapshot['registry'] | undefined;
  return { entity, binding, owner, path, file, declaration, canonical, registry: registry ?? null };
}
function snapshotIdentity(snapshot: KindSnapshot) {
  return {
    entity: snapshot.entity,
    binding: snapshot.binding,
    owner: snapshot.owner,
    path: snapshot.path,
    file: snapshot.file,
    declaration: snapshot.declaration,
    canonical: snapshot.canonical,
    registry: snapshot.registry,
  };
}
async function loadCurrent(
  db: Database.Database,
  input: FastaKindInspection,
  runDatabase: RunDatabase
) {
  const before = runDatabase(() => readSnapshot(db, input));
  const root = workspaceMutationRootIdentity(before.owner.path);
  const fingerprint = await contentHashInMain({
    workspaceRoot: root,
    workspaceRelativePath: relative(root, before.path),
  });
  const after = runDatabase(() => readSnapshot(db, input));
  if (canonicalJson(snapshotIdentity(before)) !== canonicalJson(snapshotIdentity(after)))
    fail('STALE', 'The FASTA source or owning binding changed while it was inspected.');
  return {
    snapshot: after,
    fingerprint,
    revision: hash({ ...snapshotIdentity(after), fingerprint }),
  };
}
function authority(current: {
  snapshot: KindSnapshot;
  fingerprint: string;
  revision: string;
}): FastaKindAuthority {
  const { snapshot, fingerprint, revision } = current;
  const common = {
    path: snapshot.path,
    workspaceRoot: snapshot.owner.path,
    entityId: snapshot.entity.id,
    bindingId: snapshot.binding.id,
    objectUuid: snapshot.binding.object_uuid,
    sourceFingerprint: fingerprint,
    revision,
  };
  const kind = snapshot.canonical?.kind ?? snapshot.declaration?.kind;
  if (kind)
    return {
      ...common,
      status: 'declared',
      kind,
      authority: snapshot.canonical ? 'canonical-source' : 'native-declaration',
    };
  const storedKind = snapshot.entity.type as FastaKind;
  const ambiguous = storedKind === 'sequence' && extname(snapshot.path).toLowerCase() === '.faa';
  return {
    ...common,
    status: ambiguous ? 'needs-classification' : 'legacy-compatible',
    storedKind,
    legacyReadView: ambiguous ? 'protein' : storedKind,
    readOnly: true,
  };
}
export function getFastaKindReadAuthorityInDb(
  db: Database.Database,
  value: FastaKindInspection
): FastaKindReadAuthority {
  const parsed = fastaKindInspectionSchema.safeParse(value);
  if (!parsed.success) fail('REQUEST_INVALID', 'Expected a FASTA path and owning project.');
  const snapshot = readSnapshot(db, parsed.data);
  const result = authority({ snapshot, fingerprint: '', revision: '' });
  const { sourceFingerprint: _sourceFingerprint, revision: _revision, ...read } = result;
  return read;
}

export async function getFastaKindAuthorityInMain(
  db: Database.Database,
  value: FastaKindInspection,
  runDatabase: RunDatabase = (operation) => operation()
): Promise<FastaKindAuthority> {
  const input = fastaKindInspectionSchema.safeParse(value);
  if (!input.success) fail('REQUEST_INVALID', 'Expected a FASTA path and owning project.');
  return authority(await loadCurrent(db, input.data, runDatabase));
}
export function recordInitialFastaKindDeclarationInDb(
  db: Database.Database,
  entity: CatalogEntityRow
): void {
  if (
    entity.storage_type !== 'file' ||
    !['sequence', 'protein'].includes(entity.type) ||
    entity.workspace_id === null
  )
    return;
  const owner = requireCatalogSourceOwner(db, entity.workspace_id);
  if (owner.access_mode !== 'writable') return;
  db.prepare(
    'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(
    randomUUID(),
    entity.id,
    FASTA_KIND_DECLARATION_EVENT,
    'native-catalog',
    'Scientific kind declared through native registration',
    JSON.stringify({
      version: 1,
      operation: 'registration',
      entityId: entity.id,
      workspaceId: owner.id,
      kind: entity.type,
    }),
    Date.now()
  );
}
export async function classifyFastaInMain(
  db: Database.Database,
  value: FastaKindClassification,
  runDatabase: RunDatabase = (operation) => operation()
): Promise<DeclaredFastaKindAuthority> {
  const input = fastaKindClassificationSchema.safeParse(value);
  if (!input.success)
    fail('REQUEST_INVALID', 'Expected a FASTA kind and unchanged native inspection revision.');
  const current = await loadCurrent(db, input.data, runDatabase);
  if (current.revision !== input.data.expectedRevision)
    fail('STALE', 'Inspect the current FASTA again before choosing its kind.');
  const { snapshot } = current;
  return runDatabase(() =>
    db.transaction(() => {
      assertWorkspaceWriteAllowed(db, [snapshot.owner.path, snapshot.path]);
      const checked = readSnapshot(db, input.data);
      if (canonicalJson(snapshotIdentity(checked)) !== canonicalJson(snapshotIdentity(snapshot)))
        fail('STALE', 'The FASTA authority changed before classification.');
      if (snapshot.canonical && snapshot.canonical.kind !== input.data.kind)
        fail(
          'SCHEMA_CONFLICT',
          'Change the owning canonical source declaration through its own operation.'
        );
      if (
        snapshot.registry?.schema_revision_id &&
        (snapshot.registry.kind === 'protein') !== (input.data.kind === 'protein')
      )
        fail('SCHEMA_CONFLICT', 'The frozen Registry schema declares another scientific kind.');
      if (snapshot.declaration?.kind === input.data.kind)
        return authority(current) as DeclaredFastaKindAuthority;
      if (input.data.kind === 'protein') {
        const attached = db
          .prepare(
            'SELECT 1 FROM primer_bindings b JOIN sequences s ON s.id=b.sequence_id JOIN indexed_files f ON f.id=s.file_id WHERE f.workspace_id=? AND f.path=? LIMIT 1'
          )
          .get(snapshot.owner.id, snapshot.binding.path);
        if (attached)
          fail(
            'DEPENDENCIES',
            'Retain the nucleotide attachments through their owning operation before reclassification.'
          );
        db.prepare('DELETE FROM indexed_files WHERE workspace_id=? AND path=?').run(
          snapshot.owner.id,
          snapshot.binding.path
        );
      }
      db.prepare('UPDATE catalog_entities SET type=?,updated_at=? WHERE id=?').run(
        input.data.kind,
        Date.now(),
        snapshot.entity.id
      );
      db.prepare(
        'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(
        randomUUID(),
        snapshot.entity.id,
        FASTA_KIND_DECLARATION_EVENT,
        'native-catalog',
        'FASTA kind explicitly classified',
        JSON.stringify({
          version: 1,
          operation: 'classification',
          entityId: snapshot.entity.id,
          workspaceId: snapshot.owner.id,
          kind: input.data.kind,
          previousKind: snapshot.entity.type,
          bindingId: snapshot.binding.id,
          objectUuid: snapshot.binding.object_uuid,
          sourceFingerprint: current.fingerprint,
          expectedRevision: input.data.expectedRevision,
        }),
        Date.now()
      );
      if (canonicalJson(sourceStat(snapshot.path)) !== canonicalJson(snapshot.file))
        fail('STALE', 'The FASTA source changed before classification committed.');
      const settled = readSnapshot(db, input.data);
      const result = authority({
        snapshot: settled,
        fingerprint: current.fingerprint,
        revision: hash({ ...snapshotIdentity(settled), fingerprint: current.fingerprint }),
      });
      if (result.status !== 'declared')
        fail('HISTORY_INVALID', 'The native classification was not retained.');
      return result;
    })()
  );
}

export function assertDeclaredFastaKindInDb(
  db: Database.Database,
  input: FastaKindInspection,
  kind: FastaKind
): void {
  if (!isFastaKindSourcePath(input.path)) return;
  const read = getFastaKindReadAuthorityInDb(db, input);
  if (read.status !== 'declared')
    fail('CLASSIFICATION_REQUIRED', 'Classify this FASTA before canonical scientific authoring.');
  if (read.kind !== kind)
    fail('KIND_MISMATCH', 'The declared FASTA kind does not match this scientific operation.');
}
