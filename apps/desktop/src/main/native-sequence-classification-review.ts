import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { parseSequenceFile } from '@waypoint/sequence-utils';
import { limsEntityFromRow, type LimsEntity } from '../shared/lims';
import {
  assessOligoClassification,
  parseOligoClassificationEvidence,
  type OligoClassificationReview,
  type OligoClassificationEvidence,
} from '../shared/oligo-classification';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { getEntityRowById, getSchemaRevisionForEntity } from './lims-engine-core';
import { parseSequenceContent } from './lims-sequence-io';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';

export function readNativeSequenceClassificationReview(
  db: Database.Database,
  entityId: string
): OligoClassificationReview {
  const loaded = loadNativeSequenceClassificationReview(db, entityId);
  return loaded.status === 'unavailable' ? loaded : loaded.review;
}

export function loadNativeSequenceClassificationReview(
  db: Database.Database,
  entityId: string
): ClassificationLoadResult {
  assertLimsSafetyNotQuarantined(db);
  const entity = limsEntityFromRow(getEntityRowById(db, entityId));
  if (entity.tombstone || entity.archivedAt !== null) return unavailable('archived_sequence');
  if (!isGenericSequenceEntity(entity)) return unavailable('not_generic_sequence');
  const context = loadClassificationManifestContext(db, entityId, entity);
  if (context.status === 'unavailable') return context;
  const sequence = loadClassificationSequence(db, entityId, entity, context);
  if (sequence.status === 'unavailable') return sequence;
  const { evidence, evidenceLimited } = collectClassificationEvidence(
    context.manifest,
    context.targetSourceId
  );
  const assessment = assessOligoClassification({
    sequence: {
      available: true,
      molecule: sequence.molecule,
      length: sequence.length,
      topology: 'linear',
    },
    evidence,
    targetSourceId: context.targetSourceId,
    evidenceLimited,
  });
  if (assessment.status === 'unavailable') return unavailable(assessment.reason);
  return buildLoadedClassificationReview({
    db,
    entityId,
    entity,
    context,
    sequence,
    evidence,
    evidenceLimited,
    assessment,
  });
}

type ClassificationUnavailable = Extract<OligoClassificationReview, { status: 'unavailable' }>;
type GenericSequenceEntity = LimsEntity & { kind: 'dna_sequence' | 'rna_sequence' };
type ClassificationWorkspace = {
  id: number;
  path: string;
  scope: ReturnType<typeof workspaceScopeKey>;
};
type ClassificationManifestContext = {
  status: 'loaded';
  workspace: ClassificationWorkspace;
  portable: NativeWorkspaceManifestEntityV2;
  relativePath: string;
  manifest: NativeWorkspaceManifestV2;
  manifestBytes: Buffer;
  targetSourceId: string;
};
type ClassificationSequence = {
  status: 'loaded';
  molecule: 'dna' | 'rna';
  length: number;
  fileSha256: string;
  normalizedSequenceHash: string;
};
type LoadedClassificationReview = {
  status: 'loaded';
  review: Extract<OligoClassificationReview, { status: 'review' }>;
  entity: GenericSequenceEntity;
  portable: NativeWorkspaceManifestEntityV2;
  manifest: NativeWorkspaceManifestV2;
  manifestBytes: Buffer;
  manifestSha256: string;
  fileSha256: string;
  workspace: ClassificationWorkspace;
};
type ClassificationLoadResult = ClassificationUnavailable | LoadedClassificationReview;

type ActiveWorkspaceRow = {
  id: number;
  path: string;
  repo_uuid: string | null;
  catalog_status: 'active';
};

function unavailable(reason: string): ClassificationUnavailable {
  return { status: 'unavailable', reason };
}

function isGenericSequenceEntity(entity: LimsEntity): entity is GenericSequenceEntity {
  return entity.kind === 'dna_sequence' || entity.kind === 'rna_sequence';
}

function parseActiveWorkspaceRow(value: unknown): ActiveWorkspaceRow | null {
  if (!value || typeof value !== 'object') return null;
  if (!('id' in value) || typeof value.id !== 'number') return null;
  if (!('path' in value) || typeof value.path !== 'string') return null;
  if (!('repo_uuid' in value)) return null;
  if (value.repo_uuid !== null && typeof value.repo_uuid !== 'string') return null;
  if (!('catalog_status' in value) || value.catalog_status !== 'active') return null;
  return {
    id: value.id,
    path: value.path,
    repo_uuid: value.repo_uuid,
    catalog_status: value.catalog_status,
  };
}

function observedSequenceSourceIds(portable: NativeWorkspaceManifestEntityV2): Set<string> {
  return new Set(
    portable.sourceIdentities
      ?.filter(
        (identity) =>
          identity.provider === 'benchling' &&
          identity.objectClass === 'sequence' &&
          identity.bindingKind === 'observed' &&
          identity.stableObjectId.startsWith('seq_')
      )
      .map((identity) => identity.stableObjectId)
  );
}

function loadClassificationManifestContext(
  db: Database.Database,
  entityId: string,
  entity: GenericSequenceEntity
): ClassificationManifestContext | ClassificationUnavailable {
  const workspace = parseActiveWorkspaceRow(
    db
      .prepare(
        `SELECT w.id,w.path,w.repo_uuid,c.status AS catalog_status FROM workspaces w
      JOIN catalog_entities c ON c.workspace_id=w.id
      WHERE c.id=? AND c.type='sequence' AND w.id=? AND w.archived_at IS NULL AND w.trashed_at IS NULL`
      )
      .get(entityId, entity.workspaceId)
  );
  if (!workspace) return unavailable('no_active_workspace');
  const scope = workspaceScopeKey(workspace.repo_uuid, workspace.id);
  const manifestBytes = readClassificationFile(
    workspace.path,
    join(workspace.path, NATIVE_WORKSPACE_MANIFEST_PATH),
    32 * 1024 * 1024
  );
  const manifest = parseNativeWorkspaceManifest(manifestBytes.toString('utf8'));
  if (manifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA)
    return unavailable('no_portable_catalog');
  const portable = manifest.entities.find(
    (item) => scopedProjectionId(scope, item.id) === entity.id
  );
  if (
    !portable ||
    portable.type !== 'sequence' ||
    portable.placement.kind !== 'file' ||
    !portable.lims ||
    portable.lims.kind !== entity.kind
  )
    return unavailable('no_portable_sequence');
  const sourceIds = observedSequenceSourceIds(portable);
  const targetSourceId = [...sourceIds][0];
  if (sourceIds.size !== 1 || !targetSourceId) return unavailable('ambiguous_source_identity');
  return {
    status: 'loaded',
    workspace: { id: workspace.id, path: workspace.path, scope },
    portable,
    relativePath: portable.placement.relativePath,
    manifest,
    manifestBytes,
    targetSourceId,
  };
}

type ReviewedFileSequenceReference = {
  mode: 'file';
  relPath: string;
  topology: 'linear' | 'circular';
  length?: unknown;
  normalizedSequenceHash?: unknown;
  contentHash?: unknown;
};

function parseReviewedFileSequenceReference(
  value: unknown,
  path: string
): ReviewedFileSequenceReference | null {
  if (!value || typeof value !== 'object') return null;
  if (!('mode' in value) || value.mode !== 'file') return null;
  if (!('relPath' in value) || typeof value.relPath !== 'string') return null;
  if (resolve(value.relPath) !== resolve(path)) return null;
  if (!('topology' in value) || (value.topology !== 'linear' && value.topology !== 'circular'))
    return null;
  return {
    mode: value.mode,
    relPath: value.relPath,
    topology: value.topology,
    length: 'length' in value ? value.length : undefined,
    normalizedSequenceHash:
      'normalizedSequenceHash' in value ? value.normalizedSequenceHash : undefined,
    contentHash: 'contentHash' in value ? value.contentHash : undefined,
  };
}

function hasCurrentClassificationBinding(
  db: Database.Database,
  entityId: string,
  workspaceId: number,
  path: string
): boolean {
  const bindings = db
    .prepare(
      "SELECT path FROM catalog_entity_files WHERE entity_id=? AND workspace_id=? AND status='current'"
    )
    .all(entityId, workspaceId);
  const binding = bindings[0];
  if (bindings.length !== 1 || !binding || typeof binding !== 'object') return false;
  if (!('path' in binding) || typeof binding.path !== 'string') return false;
  return resolve(binding.path) === resolve(path);
}

function readClassificationSequenceBytes(
  workspaceRoot: string,
  path: string
): Buffer | ClassificationUnavailable {
  try {
    return readClassificationFile(workspaceRoot, path, 16 * 1024 * 1024);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return unavailable('missing_sequence');
    throw error;
  }
}

function parseClassificationSequenceFile(
  bytes: Buffer,
  path: string,
  topology: 'linear' | 'circular'
): ReturnType<typeof parseSequenceContent> | ClassificationUnavailable {
  const content = path.toLowerCase().endsWith('.dna') ? bytes : bytes.toString('utf8');
  try {
    const records = parseSequenceFile(content, { filename: basename(path) });
    if (records.length !== 1) return unavailable('multiple_sequences');
    if (!records[0].sequence) return unavailable('missing_sequence');
    return parseSequenceContent(content, path, topology);
  } catch {
    return unavailable('missing_sequence');
  }
}

function declaredSequenceMolecule(bytes: Buffer, path: string): string | undefined {
  if (path.toLowerCase().endsWith('.dna')) return undefined;
  return /^LOCUS\s+.*\b(?:bp|aa)\s+(DNA|RNA)\b/imu.exec(bytes.toString('utf8'))?.[1].toLowerCase();
}

function moleculeConflicts(
  molecule: 'dna' | 'rna',
  declaredMolecule: string | undefined,
  sequence: string
): boolean {
  return (
    (Boolean(declaredMolecule) && declaredMolecule !== molecule) ||
    (molecule === 'dna' && /U/iu.test(sequence)) ||
    (molecule === 'rna' && /T/iu.test(sequence))
  );
}

function sequenceProjectionIsCurrent(
  reference: ReviewedFileSequenceReference,
  length: number,
  fileSha256: string,
  normalizedSequenceHash: string
): boolean {
  const storedHash =
    typeof reference.normalizedSequenceHash === 'string' ? reference.normalizedSequenceHash : null;
  return (
    reference.length === length &&
    (storedHash ? storedHash === normalizedSequenceHash : reference.contentHash === fileSha256)
  );
}

function loadClassificationSequence(
  db: Database.Database,
  entityId: string,
  entity: GenericSequenceEntity,
  context: ClassificationManifestContext
): ClassificationSequence | ClassificationUnavailable {
  const path = join(context.workspace.path, context.relativePath);
  if (!hasCurrentClassificationBinding(db, entityId, context.workspace.id, path))
    return unavailable('sequence_binding_changed');
  const reference = parseReviewedFileSequenceReference(entity.fields.sequence, path);
  if (!reference) return unavailable('missing_sequence');
  const bytes = readClassificationSequenceBytes(context.workspace.path, path);
  if ('status' in bytes) return bytes;
  const parsed = parseClassificationSequenceFile(bytes, path, reference.topology);
  if ('status' in parsed) return parsed;
  if (!parsed.sequence || !/^[ACGTURYSWKMBDHVN]+$/iu.test(parsed.sequence))
    return unavailable('missing_sequence');
  if (parsed.circular) return unavailable('circular_sequence');
  const molecule = entity.kind === 'rna_sequence' ? 'rna' : 'dna';
  if (moleculeConflicts(molecule, declaredSequenceMolecule(bytes, path), parsed.sequence))
    return unavailable('conflicting_molecule');
  const fileSha256 = hash(bytes);
  const normalizedSequenceHash = hash(parsed.sequence.toUpperCase());
  if (
    !sequenceProjectionIsCurrent(
      reference,
      parsed.sequence.length,
      fileSha256,
      normalizedSequenceHash
    )
  )
    return unavailable('sequence_projection_outdated');
  return {
    status: 'loaded',
    molecule,
    length: parsed.sequence.length,
    fileSha256,
    normalizedSequenceHash,
  };
}

function collectClassificationEvidence(
  manifest: NativeWorkspaceManifestV2,
  targetSourceId: string
): { evidence: OligoClassificationEvidence[]; evidenceLimited: boolean } {
  const evidence: OligoClassificationEvidence[] = [];
  let evidenceLimited = false;
  for (const source of manifest.entities) {
    if (source.type !== 'notebook' && source.type !== 'protocol') continue;
    const raw = source.metadata?.classificationEvidence;
    if (raw === undefined) continue;
    const packet = parseOligoClassificationEvidence(raw);
    const ownerIds = new Set(
      source.sourceIdentities
        ?.filter(
          (identity) => identity.provider === 'benchling' && identity.bindingKind === 'observed'
        )
        .map((identity) => identity.stableObjectId)
    );
    if (!packet || packet.facts.some((fact) => !ownerIds.has(fact.sourceObjectId))) {
      evidenceLimited = true;
      continue;
    }
    evidenceLimited ||= packet.limited;
    for (const fact of packet.facts) {
      if (fact.targetSourceId !== targetSourceId) continue;
      if (evidence.length >= 4096) {
        evidenceLimited = true;
        break;
      }
      evidence.push(fact);
    }
  }
  return { evidence, evidenceLimited };
}

type BuildLoadedClassificationReviewArgs = {
  db: Database.Database;
  entityId: string;
  entity: GenericSequenceEntity;
  context: ClassificationManifestContext;
  sequence: ClassificationSequence;
  evidence: OligoClassificationEvidence[];
  evidenceLimited: boolean;
  assessment: Exclude<ReturnType<typeof assessOligoClassification>, { status: 'unavailable' }>;
};

function buildLoadedClassificationReview({
  db,
  entityId,
  entity,
  context,
  sequence,
  evidence,
  evidenceLimited,
  assessment,
}: BuildLoadedClassificationReviewArgs): LoadedClassificationReview {
  const manifestSha256 = hash(context.manifestBytes);
  const {
    eventSeq: _eventSeq,
    updatedAt: _updatedAt,
    actor: _lastActor,
    fields,
    ...reviewedEntity
  } = entity;
  const { sequence: _derivedReference, ...reviewedFields } = fields;
  const review: Extract<OligoClassificationReview, { status: 'review' }> = {
    status: 'review',
    entityId,
    entityName: entity.name,
    currentKind: entity.kind,
    targetSourceId: context.targetSourceId,
    sequence: { molecule: sequence.molecule, length: sequence.length, topology: 'linear' },
    evidence,
    evidenceLimited,
    assessment,
    reviewToken: hash(
      JSON.stringify({
        policy: 'oligo-review-v2',
        schema: getSchemaRevisionForEntity(db, getEntityRowById(db, entityId)),
        entity: { ...reviewedEntity, fields: reviewedFields },
        manifestSha256,
        fileSha256: sequence.fileSha256,
        normalizedSequenceHash: sequence.normalizedSequenceHash,
        workspaceId: context.workspace.id,
        workspaceRoot: context.workspace.path,
      })
    ),
  };
  return {
    status: 'loaded' as const,
    review,
    entity,
    portable: context.portable,
    manifest: context.manifest,
    manifestBytes: context.manifestBytes,
    manifestSha256,
    fileSha256: sequence.fileSha256,
    workspace: context.workspace,
  };
}

export function readClassificationFile(
  workspaceRoot: string,
  path: string,
  maxBytes: number
): Buffer {
  assertWorkspaceProjectionPathSafe(workspaceRoot, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes)
      throw new Error('Classification source must be a bounded regular file.');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Classification source changed while it was read.');
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function hash(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
