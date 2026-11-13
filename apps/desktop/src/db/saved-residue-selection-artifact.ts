import {
  SAVED_RESIDUE_SELECTION_SCHEMA,
  parseSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
  type SavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import { platform } from '../platform';
import {
  bindCatalogEntityToFile,
  getCatalogEntityForFilePath,
  recordCatalogEvent,
  registerCatalogEntity,
  updateCatalogEntityName,
  type DBCatalogEntity,
} from './workspace-catalog';
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
} from './project-memory';

export const SAVED_SELECTION_FILE_KIND = 'waypoint-residue-selection' as const;

export interface ArtifactProjectionWarning {
  stage:
    | 'project-memory'
    | 'atomic-cleanup'
    | 'catalog-registration'
    | 'catalog-name'
    | 'catalog-file-binding'
    | 'catalog-event';
  error: string;
}

export interface SavedResidueSelectionArtifactResult {
  path: string;
  name: string;
  fileKind: typeof SAVED_SELECTION_FILE_KIND;
  selection: SavedResidueSelectionDocument;
  warnings?: ArtifactProjectionWarning[];
}

export interface ResolvedSavedResidueSelectionArtifact {
  path: string;
  entity: DBCatalogEntity;
  selection: SavedResidueSelectionDocument;
  repaired: boolean;
}

interface WriteSavedResidueSelectionArtifactRevisionInput {
  workspaceRoot: string;
  path: string;
  document: SavedResidueSelectionDocument;
}

const revisionWriteQueues = new Map<string, Promise<void>>();

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sanitizeFilePart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[/:\\?%*"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return cleaned || fallback;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function artifactName(document: SavedResidueSelectionDocument): string {
  const name = sanitizeFilePart(document.name, 'Selection');
  const id = sanitizeFilePart(document.id, 'selection');
  return `${name}.${id}.wpselection.json`;
}

function enqueueRevisionWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
  const prior = revisionWriteQueues.get(path) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  revisionWriteQueues.set(path, settled);
  void settled.then(() => {
    if (revisionWriteQueues.get(path) === settled) revisionWriteQueues.delete(path);
  });
  return next;
}

function projectionWarning(
  stage: ArtifactProjectionWarning['stage'],
  error: unknown
): ArtifactProjectionWarning {
  return {
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
}

function artifactMetadata(document: SavedResidueSelectionDocument, path: string) {
  const current = document.revisions.find((revision) => revision.id === document.currentRevisionId);
  return {
    artifactSchema: SAVED_RESIDUE_SELECTION_SCHEMA,
    recoveredFrom: path,
    currentRevisionId: document.currentRevisionId,
    polymerTargets:
      current?.members.map((member) => ({
        moleculeId: member.polymerRevision.moleculeId,
        moleculeKind: member.polymerRevision.moleculeKind,
        sequenceDigestSha256: member.polymerRevision.sequenceDigestSha256,
        scope: member.scope.kind,
      })) ?? [],
  };
}

async function registerSelectionDocument(input: {
  workspaceRoot: string;
  path: string;
  document: SavedResidueSelectionDocument;
}): Promise<DBCatalogEntity> {
  return registerCatalogEntity({
    id: input.document.id,
    type: 'selection',
    name: input.document.name,
    locator: `entity://selection/${input.document.id}`,
    storageType: 'file',
    workspaceRoot: input.workspaceRoot,
    metadata: artifactMetadata(input.document, input.path),
  });
}

export async function createSavedResidueSelectionArtifact(input: {
  workspaceRoot: string;
  document: SavedResidueSelectionDocument;
}): Promise<SavedResidueSelectionArtifactResult> {
  const workspaceRoot = trimTrailingSlash(input.workspaceRoot);
  const directory = `${workspaceRoot}/Selections`;
  const name = artifactName(input.document);
  const path = `${directory}/${name}`;
  if (await platform().fs.exists(path)) {
    throw new Error(`Saved selection artifact already exists: ${path}`);
  }

  const content = serializeSavedResidueSelectionDocument(input.document);
  const atomicWrite = await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path,
    content,
    mode: 'create',
  });
  const sizeBytes = byteLength(content);
  const warnings: ArtifactProjectionWarning[] = [];
  if (atomicWrite.cleanupWarning) {
    warnings.push({ stage: 'atomic-cleanup', error: atomicWrite.cleanupWarning });
  }

  try {
    await appendProjectMemoryEvent({
      workspaceRoot,
      event: createArtifactCreatedProjectMemoryEvent({
        workspaceRoot,
        entityId: input.document.id,
        entityKind: 'selection',
        displayName: input.document.name,
        filePath: path,
        fileKind: 'selection',
        sizeBytes,
        artifactSchema: SAVED_RESIDUE_SELECTION_SCHEMA,
      }),
    });
  } catch (error) {
    warnings.push(projectionWarning('project-memory', error));
  }

  try {
    await registerSelectionDocument({
      workspaceRoot,
      path,
      document: input.document,
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-registration', error));
  }
  try {
    await bindCatalogEntityToFile({
      entityId: input.document.id,
      path,
      fileKind: SAVED_SELECTION_FILE_KIND,
      workspaceRoot,
      sizeBytes,
      modifiedAt: Date.now(),
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-file-binding', error));
  }
  try {
    await recordCatalogEvent({
      entityId: input.document.id,
      eventType: 'artifact_created',
      summary: 'Created saved residue selection artifact',
      payload: {
        filePath: path,
        artifactSchema: SAVED_RESIDUE_SELECTION_SCHEMA,
        revisionId: input.document.currentRevisionId,
      },
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-event', error));
  }

  return {
    path,
    name,
    fileKind: SAVED_SELECTION_FILE_KIND,
    selection: input.document,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function writeSavedResidueSelectionArtifactRevision(
  input: WriteSavedResidueSelectionArtifactRevisionInput
): Promise<SavedResidueSelectionArtifactResult> {
  return enqueueRevisionWrite(input.path, () =>
    writeSavedResidueSelectionArtifactRevisionUnlocked(input)
  );
}

async function writeSavedResidueSelectionArtifactRevisionUnlocked(
  input: WriteSavedResidueSelectionArtifactRevisionInput
): Promise<SavedResidueSelectionArtifactResult> {
  const existingContent = await platform().fs.readTextFile(input.path);
  const existing = parseSavedResidueSelectionDocument(existingContent);
  if (existing.id !== input.document.id) {
    throw new Error(
      `Saved selection identity mismatch: ${existing.id} cannot be replaced by ${input.document.id}`
    );
  }
  if (input.document.revisions.length !== existing.revisions.length + 1) {
    throw new Error(
      `Saved selection update is stale: expected exactly one revision after ${existing.currentRevisionId}`
    );
  }
  for (let index = 0; index < existing.revisions.length; index += 1) {
    if (
      JSON.stringify(existing.revisions[index]) !== JSON.stringify(input.document.revisions[index])
    ) {
      throw new Error(
        `Saved selection historical revision was modified: ${existing.revisions[index].id}`
      );
    }
  }
  const appendedRevision = input.document.revisions[existing.revisions.length];
  if (
    appendedRevision.parentRevisionId !== existing.currentRevisionId ||
    input.document.currentRevisionId !== appendedRevision.id
  ) {
    throw new Error(
      `Saved selection update is stale: expected parent revision ${existing.currentRevisionId}`
    );
  }

  const content = serializeSavedResidueSelectionDocument(input.document);
  const atomicWrite = await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    content,
    mode: 'replace',
    expectedContentHash: await sha256Text(existingContent),
  });
  const stat = await platform().fs.stat(input.path);
  const warnings: ArtifactProjectionWarning[] = [];
  if (atomicWrite.cleanupWarning) {
    warnings.push({ stage: 'atomic-cleanup', error: atomicWrite.cleanupWarning });
  }
  try {
    await registerSelectionDocument({
      workspaceRoot: input.workspaceRoot,
      path: input.path,
      document: input.document,
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-registration', error));
  }
  try {
    await updateCatalogEntityName(input.document.id, input.document.name);
  } catch (error) {
    warnings.push(projectionWarning('catalog-name', error));
  }
  try {
    await bindCatalogEntityToFile({
      entityId: input.document.id,
      path: input.path,
      fileKind: SAVED_SELECTION_FILE_KIND,
      workspaceRoot: input.workspaceRoot,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-file-binding', error));
  }
  try {
    await recordCatalogEvent({
      entityId: input.document.id,
      eventType: 'artifact_updated',
      summary: 'Appended saved residue selection revision',
      payload: {
        filePath: input.path,
        artifactSchema: SAVED_RESIDUE_SELECTION_SCHEMA,
        revisionId: input.document.currentRevisionId,
        revisionCount: input.document.revisions.length,
      },
    });
  } catch (error) {
    warnings.push(projectionWarning('catalog-event', error));
  }

  return {
    path: input.path,
    name: input.path.split('/').pop() ?? input.path,
    fileKind: SAVED_SELECTION_FILE_KIND,
    selection: input.document,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function resolveSavedResidueSelectionArtifact(input: {
  workspaceRoot: string;
  path: string;
  mutationToken?: string;
}): Promise<ResolvedSavedResidueSelectionArtifact> {
  const document = parseSavedResidueSelectionDocument(await platform().fs.readTextFile(input.path));
  const existingAtPath = await getCatalogEntityForFilePath(input.path);
  const entity = await registerSelectionDocument({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    document,
  });
  const stat = await platform().fs.stat(input.path);
  await bindCatalogEntityToFile({
    entityId: entity.id,
    path: input.path,
    fileKind: SAVED_SELECTION_FILE_KIND,
    workspaceRoot: input.workspaceRoot,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime,
    status: 'current',
    mutationToken: input.mutationToken,
  });
  const repaired = existingAtPath?.id !== entity.id;
  await recordCatalogEvent({
    entityId: entity.id,
    eventType: repaired ? 'binding_repaired' : 'artifact_opened',
    summary: repaired
      ? 'Repaired saved residue selection file binding'
      : 'Opened saved residue selection artifact',
    payload: {
      filePath: input.path,
      artifactSchema: SAVED_RESIDUE_SELECTION_SCHEMA,
      revisionId: document.currentRevisionId,
    },
  });
  return { path: input.path, entity, selection: document, repaired };
}
