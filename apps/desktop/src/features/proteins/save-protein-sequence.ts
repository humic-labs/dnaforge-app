import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import {
  ProteinProjectionError,
  type PublishedProteinDraft,
  type RecordProteinInput,
} from './protein-artifact-owner';
import { computeChecksum } from '@waypoint/sequence-utils';
import {
  bindCatalogEntityToFile,
  getCatalogEntityForFilePath,
  getCatalogWorkspaceRootForFilePath,
  getWorkspaceRootById,
  recordCatalogEvent,
  resolveWorkspaceId,
} from '../../db/workspace-catalog';
import { reconcileEntityFile } from '../../db/entity-substrate/adapter';
import { limsEntityArtifactAdapter } from '../../db/entity-substrate/lims-entity-adapter';
import { platform } from '../../platform';
import { updateLimsEntity } from '../../services/lims-entity-mutations';
import { serializeAminoAcidFasta } from '../../shared/amino-acid-sequence';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../../shared/path-boundary';
import {
  LIMS_GIT_EXPORT_RELATIVE_PATH,
  type AminoAcidSequenceRef,
  type FileAminoAcidSequenceRef,
  type LimsEntity,
  type ProteinSequenceRef,
} from '../../shared/lims';
import {
  ENTITY_ARTIFACT_SCHEMA,
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifact,
} from '../lims/public/entity-artifact';
import { emitLimsRegistrationChanged } from '../lims/public/events';
import { queryLimsEntities } from '../lims/public/operations';
import {
  buildInlineProteinSequenceRef,
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '../lims/public/protein-sequence';
import { gitCommitPaths, isGitRepo } from '../workspace/public/git';

export type SavedProteinSequence = {
  status: 'saved';
  entity: LimsEntity;
  bases: string;
  expectedContentHash: string;
};

export type ProteinAuthorityMissing = { status: 'missing-authority' };
export type SaveProteinSequenceResult = SavedProteinSequence | ProteinAuthorityMissing;

export interface ProteinEntityArtifactRevision {
  artifact: EntityArtifact;
  artifactPath: string;
  relativePath: string;
  workspaceRoot: string;
  workspaceId: number;
  content: string;
  contentHash: string;
}

export type ProteinEntityArtifactResolution =
  | { status: 'ready'; revision: ProteinEntityArtifactRevision }
  | ProteinAuthorityMissing;

type EntityArtifactLocator = {
  schema?: unknown;
  relativePath?: unknown;
};

function joinPath(left: string, right: string): string {
  const separator = left.includes('\\') ? '\\' : '/';
  return `${left.replace(/[\\/]+$/, '')}${separator}${right.replace(/\//gu, separator)}`;
}

async function readProteinEntityArtifactRevision(input: {
  entityId: string;
  locator: { relativePath: string };
  workspaceRoot: string;
  workspaceId: number;
}): Promise<ProteinEntityArtifactRevision | null> {
  const artifactPath = joinPath(input.workspaceRoot, input.locator.relativePath);
  if (!(await platform().fs.exists(artifactPath))) return null;
  const content = await platform().fs.readTextFile(artifactPath);
  const artifact = parseEntityArtifact(content);
  if (artifact.id !== input.entityId || artifact.kind !== 'protein') return null;
  return {
    artifact,
    artifactPath,
    relativePath: input.locator.relativePath,
    workspaceRoot: input.workspaceRoot,
    workspaceId: input.workspaceId,
    content,
    contentHash: await computeChecksum(content),
  };
}

async function missingProteinAuthority(_entity: LimsEntity): Promise<ProteinAuthorityMissing> {
  return { status: 'missing-authority' };
}

export async function resolveProteinEntityArtifactRevision(input: {
  entity: LimsEntity;
  workspaceRoots: readonly string[];
}): Promise<ProteinEntityArtifactResolution> {
  const locator = input.entity.fields.artifact as EntityArtifactLocator | undefined;
  if (
    (locator?.schema !== ENTITY_ARTIFACT_SCHEMA &&
      locator?.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA) ||
    typeof locator.relativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(locator.relativePath)
  ) {
    return missingProteinAuthority(input.entity);
  }
  const artifactLocator = { relativePath: locator.relativePath };

  const ownerRoot = await getWorkspaceRootById(input.entity.workspaceId);
  if (ownerRoot && input.entity.workspaceId != null) {
    const revision = await readProteinEntityArtifactRevision({
      entityId: input.entity.id,
      locator: artifactLocator,
      workspaceRoot: ownerRoot,
      workspaceId: input.entity.workspaceId,
    });
    return revision ? { status: 'ready', revision } : missingProteinAuthority(input.entity);
  }

  const matches: ProteinEntityArtifactRevision[] = [];
  for (const workspaceRoot of new Set(input.workspaceRoots)) {
    const workspaceId = await resolveWorkspaceId(workspaceRoot);
    if (workspaceId == null) continue;
    const revision = await readProteinEntityArtifactRevision({
      entityId: input.entity.id,
      locator: artifactLocator,
      workspaceRoot,
      workspaceId,
    });
    if (revision) matches.push(revision);
  }
  if (matches.length === 0) return missingProteinAuthority(input.entity);
  if (matches.length > 1) {
    throw new Error('More than one open project contains this protein package identity.');
  }

  const revision = matches[0];
  const stat = await platform().fs.stat(revision.artifactPath);
  await reconcileEntityFile(
    limsEntityArtifactAdapter,
    revision.content,
    revision.artifactPath,
    stat.mtime,
    { workspaceRoot: revision.workspaceRoot, workspaceId: revision.workspaceId }
  );
  return { status: 'ready', revision };
}

async function savePackageProteinSequence(input: {
  entity: LimsEntity;
  bases: string;
  expectedContentHash: string;
  workspaceRoots: readonly string[];
}): Promise<SaveProteinSequenceResult> {
  const resolution = await resolveProteinEntityArtifactRevision(input);
  if (resolution.status === 'missing-authority') return resolution;
  return writePackageProteinRevision(resolution.revision, input.bases, input.expectedContentHash);
}

export async function updatePublishedProteinDraft(
  input: RecordProteinInput,
  published: PublishedProteinDraft
) {
  if (!input.name.trim()) throw new Error('Protein name is required.');
  if (!published.id || !isSafeWorkspaceRelativePath(published.relativePath)) {
    throw new Error('The original protein package location is unavailable.');
  }
  const path = joinPath(input.workspaceRoot, published.relativePath);
  const fileName = pathRelativeToBoundary(
    path,
    input.dir ?? joinPath(input.workspaceRoot, 'proteins')
  );
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
    throw withUserMessage(
      new Error('The original protein destination changed.'),
      userMessagePayload('document.saveLocationChanged', { name: userMessageValue(input.name) })
    );
  }
  const workspaceId = await resolveWorkspaceId(input.workspaceRoot);
  if (workspaceId == null) throw new Error('The original protein project is unavailable.');
  const revision = await readProteinEntityArtifactRevision({
    entityId: published.id,
    locator: { relativePath: published.relativePath },
    workspaceRoot: input.workspaceRoot,
    workspaceId,
  });
  if (!revision) throw new Error('The original protein package is unavailable.');
  const bases = normalizeProteinSequence(input.sequence);
  const error = proteinSequenceValidationError(bases);
  if (error) throw new Error(error);
  const result = await writePackageProteinRevision(revision, bases, published.contentHash, input);
  return {
    artifactPath: published.relativePath,
    contentHash: result.expectedContentHash,
    limsEntity: result.entity,
  };
}

async function writePackageProteinRevision(
  revision: ProteinEntityArtifactRevision,
  bases: string,
  previousHash: string,
  draft?: RecordProteinInput
): Promise<SavedProteinSequence> {
  const expectedContentHash = normalizeSha256(previousHash);
  if (!expectedContentHash) throw new Error('The opened protein revision is unavailable.');
  if (normalizeSha256(revision.contentHash) !== expectedContentHash) {
    throw new Error('This protein package changed after it was opened. Reopen it before saving.');
  }

  const context = { workspaceRoot: revision.workspaceRoot, workspaceId: revision.workspaceId };
  const beforeProjection = await reconcileEntityFile(
    limsEntityArtifactAdapter,
    revision.content,
    revision.artifactPath,
    (await platform().fs.stat(revision.artifactPath)).mtime,
    context
  );
  if (beforeProjection.outcome === 'conflict')
    throw new Error('Protein file and Registry disagree. Preserve both versions before saving.');
  const nextArtifact: EntityArtifact = {
    ...revision.artifact,
    ...(draft ? { name: draft.name.trim() } : {}),
    fields: {
      ...revision.artifact.fields,
      ...(draft
        ? { sourceCds: draft.sourceCds, organism: draft.organism, notes: draft.notes }
        : {}),
      sequence: await buildInlineProteinSequenceRef(bases),
    },
  };
  const content = serializeEntityArtifact(nextArtifact);
  const write = await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: revision.workspaceRoot,
    path: revision.artifactPath,
    content,
    mode: 'replace',
    expectedContentHash,
    artifactNoun: 'protein package',
  });
  try {
    const stat = await platform().fs.stat(revision.artifactPath);
    const projected = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      content,
      revision.artifactPath,
      stat.mtime,
      {
        workspaceRoot: revision.workspaceRoot,
        workspaceId: revision.workspaceId,
      }
    );
    if (projected.outcome === 'conflict')
      throw new Error(
        'Protein file was saved, but Registry has a conflicting edit. Preserve both versions before continuing.'
      );
    const [entity] = await queryLimsEntities({
      id: revision.artifact.id,
      includeArchived: true,
      limit: 1,
    });
    if (!entity)
      throw new Error('Registry projection did not return after saving the protein package.');
    if (await isGitRepo(revision.workspaceRoot)) {
      await gitCommitPaths(revision.workspaceRoot, `Update protein ${entity.name}`, [
        revision.relativePath,
        LIMS_GIT_EXPORT_RELATIVE_PATH,
      ]);
    }
    emitLimsRegistrationChanged({ filePath: revision.artifactPath, entityId: entity.id });
    return {
      status: 'saved',
      entity,
      bases,
      expectedContentHash: write.contentHash,
    };
  } catch (error) {
    if (!draft) throw error;
    throw new ProteinProjectionError(
      revision.relativePath,
      revision.artifactPath,
      nextArtifact,
      false,
      error
    );
  }
}

async function saveLegacyProteinSequence(input: {
  entity: LimsEntity;
  ref: FileAminoAcidSequenceRef;
  bases: string;
  expectedContentHash: string;
}): Promise<SavedProteinSequence> {
  const expectedContentHash = normalizeSha256(input.expectedContentHash);
  if (!expectedContentHash) throw new Error('The opened protein revision is unavailable.');
  const workspaceRoot = await getCatalogWorkspaceRootForFilePath(input.ref.relPath);
  if (!workspaceRoot) throw new Error('The protein is not bound to a mounted workspace.');
  const catalogEntity = await getCatalogEntityForFilePath(input.ref.relPath);
  if (!catalogEntity) throw new Error('The protein is not registered in the project catalog.');

  const content = serializeAminoAcidFasta(input.entity.name, input.bases);
  const write = await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path: input.ref.relPath,
    content,
    mode: 'replace',
    expectedContentHash,
    artifactNoun: 'protein',
  });
  const stat = await platform().fs.stat(input.ref.relPath);
  const fileContentHash = `sha256:${write.contentHash}`;
  const nextRef: FileAminoAcidSequenceRef = {
    mode: 'file',
    relPath: input.ref.relPath,
    length: input.bases.length,
    contentHash: fileContentHash,
    fileContentHash,
    normalizedSequenceHash: await computeChecksum(input.bases),
    sourceFormat: 'fasta',
    sizeBytes: stat.size,
    modifiedAt: stat.mtime,
  };
  const entity = await updateLimsEntity({
    id: input.entity.id,
    fields: { sequence: nextRef },
    actor: 'local-user',
  });
  await bindCatalogEntityToFile({
    entityId: catalogEntity.id,
    path: input.ref.relPath,
    fileKind: 'fasta',
    workspaceRoot,
    contentHash: fileContentHash,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime,
    status: 'current',
  });
  await recordCatalogEvent({
    entityId: catalogEntity.id,
    eventType: 'edited',
    actor: 'user',
    summary: 'Edited protein sequence',
  });
  return { status: 'saved', entity, bases: input.bases, expectedContentHash: write.contentHash };
}

export async function saveProteinSequence(input: {
  entity: LimsEntity;
  bases: string;
  expectedContentHash: string;
  workspaceRoots?: readonly string[];
}): Promise<SaveProteinSequenceResult> {
  const ref = input.entity.fields.sequence as AminoAcidSequenceRef | ProteinSequenceRef | undefined;
  const bases = normalizeProteinSequence(input.bases);
  const validationError = proteinSequenceValidationError(bases);
  if (validationError) throw new Error(validationError);
  if (ref?.mode === 'inline' && 'aminoAcids' in ref) {
    return savePackageProteinSequence({
      ...input,
      bases,
      workspaceRoots: input.workspaceRoots ?? [],
    });
  }
  if (ref?.mode === 'file' && !('representation' in ref)) {
    return saveLegacyProteinSequence({
      entity: input.entity,
      ref,
      bases,
      expectedContentHash: input.expectedContentHash,
    });
  }
  throw new Error('This protein sequence representation cannot be edited yet.');
}

function normalizeSha256(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, '');
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}
