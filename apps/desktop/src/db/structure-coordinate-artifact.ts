import type { SavedSelectionStructureRevision } from '@waypoint/workspace-editor';
import { platform } from '../platform';
import {
  bindCatalogEntityToFile,
  recordCatalogEvent,
  registerCatalogEntity,
} from './workspace-catalog';
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
} from './project-memory';

export type StructureCoordinateFormat = 'mmcif' | 'pdb';

export interface StructureArtifactProjectionWarning {
  stage:
    | 'atomic-cleanup'
    | 'project-memory'
    | 'catalog-registration'
    | 'catalog-file-binding'
    | 'catalog-event';
  error: string;
}

export interface MaterializedStructureCoordinateArtifact {
  path: string;
  revision: SavedSelectionStructureRevision;
  warnings?: StructureArtifactProjectionWarning[];
}

export async function materializeStructureCoordinateArtifact(input: {
  workspaceRoot: string;
  entityId: string;
  revisionId: string;
  structureId: string;
  label: string;
  providerIdentityKey?: string;
  assemblyId?: string;
  format: StructureCoordinateFormat;
  data: string;
  coordinateDigestSha256?: string;
}): Promise<MaterializedStructureCoordinateArtifact> {
  const workspaceRoot = input.workspaceRoot.replace(/\/+$/, '');
  const directory = `${workspaceRoot}/Structures`;
  const extension = input.format === 'mmcif' ? 'cif' : 'pdb';
  const name = `${sanitizeFilePart(input.label, 'Structure')}.${sanitizeFilePart(
    input.entityId,
    'structure'
  )}.${extension}`;
  const path = `${directory}/${name}`;
  if (await platform().fs.exists(path)) {
    throw new Error(`Structure coordinate artifact already exists: ${path}`);
  }
  const coordinateDigestSha256 =
    input.coordinateDigestSha256 ?? (await digestStructureCoordinateData(input.data));

  const atomicWrite = await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path,
    content: input.data,
    mode: 'create',
  });
  const sizeBytes = new TextEncoder().encode(input.data).length;
  const warnings: StructureArtifactProjectionWarning[] = [];
  if (atomicWrite.cleanupWarning) {
    warnings.push({ stage: 'atomic-cleanup', error: atomicWrite.cleanupWarning });
  }

  try {
    await appendProjectMemoryEvent({
      workspaceRoot,
      event: createArtifactCreatedProjectMemoryEvent({
        workspaceRoot,
        entityId: input.entityId,
        entityKind: 'structure',
        displayName: input.label,
        filePath: path,
        fileKind: 'structure',
        sizeBytes,
        artifactSchema: `structure-coordinates.${input.format}.v1`,
      }),
    });
  } catch (error) {
    warnings.push(structureProjectionWarning('project-memory', error));
  }

  try {
    await registerCatalogEntity({
      id: input.entityId,
      type: 'structure',
      name: input.label,
      locator: `entity://structure/${input.entityId}`,
      storageType: 'file',
      workspaceRoot,
      metadata: {
        structureId: input.structureId,
        providerIdentityKey: input.providerIdentityKey,
        assemblyId: input.assemblyId,
        coordinateDigestSha256,
        format: input.format,
      },
    });
  } catch (error) {
    warnings.push(structureProjectionWarning('catalog-registration', error));
  }
  try {
    await bindCatalogEntityToFile({
      entityId: input.entityId,
      path,
      fileKind: input.format,
      workspaceRoot,
      sizeBytes,
      modifiedAt: Date.now(),
    });
  } catch (error) {
    warnings.push(structureProjectionWarning('catalog-file-binding', error));
  }
  try {
    await recordCatalogEvent({
      entityId: input.entityId,
      eventType: 'artifact_created',
      summary: 'Materialized exact structure coordinate bytes',
      payload: {
        filePath: path,
        structureId: input.structureId,
        providerIdentityKey: input.providerIdentityKey,
        assemblyId: input.assemblyId,
        coordinateDigestSha256,
        format: input.format,
      },
    });
  } catch (error) {
    warnings.push(structureProjectionWarning('catalog-event', error));
  }

  return {
    path,
    revision: {
      id: input.revisionId,
      structureId: input.structureId,
      ...(input.providerIdentityKey ? { providerIdentityKey: input.providerIdentityKey } : {}),
      coordinateDigestSha256,
      ...(input.assemblyId ? { assemblyId: input.assemblyId } : {}),
      sourceArtifact: {
        entityId: input.entityId,
        path: path.slice(workspaceRoot.length + 1),
      },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function structureProjectionWarning(
  stage: StructureArtifactProjectionWarning['stage'],
  error: unknown
): StructureArtifactProjectionWarning {
  return { stage, error: error instanceof Error ? error.message : String(error) };
}

function sanitizeFilePart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[/:\\?%*"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return cleaned || fallback;
}

export async function digestStructureCoordinateData(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
