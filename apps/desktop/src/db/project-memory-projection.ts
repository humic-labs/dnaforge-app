import { platform } from '../platform';
import { isDesktopRuntime } from '../utils/environment';
import { withRendererWorkspaceMutation } from '../services/workspace-mutation-transaction';
import {
  bindCatalogEntityToFile,
  clearCatalogProjectionForWorkspaceRoot,
  linkCatalogEntities,
  recordCatalogEvent,
  registerCatalogEntity,
  type CatalogEntityType,
  type CatalogFileBindingStatus,
  type CatalogStorageType,
} from './workspace-catalog';
import {
  readProjectMemory,
  type ProjectMemoryEntity,
  type ProjectMemoryEntityKind,
  type ProjectMemoryFile,
  type ProjectMemorySnapshot,
} from './project-memory';
import {
  reconcileWorkspaceRoot,
  type WorkspaceReconcileResult,
} from '../services/workspace-reconcile';

export interface RebuildWorkspaceCatalogProjectionInput {
  workspaceRoot: string;
  clearExisting?: boolean;
  scanFilesystem?: boolean;
}

export interface RebuildWorkspaceCatalogProjectionResult {
  workspaceRoot: string;
  cleared: {
    workspaceId: number | null;
    entities: number;
    files: number;
    links: number;
    events: number;
  };
  projectMemory: {
    events: number;
    entities: number;
    files: number;
    links: number;
    conflicts: string[];
  };
  filesystemScan: WorkspaceReconcileResult | null;
}

function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.endsWith('/') ? workspaceRoot.replace(/\/+$/, '') : workspaceRoot;
  return relativePath.length > 0 ? `${root}/${relativePath}` : root;
}

function catalogTypeForProjectMemoryKind(kind: ProjectMemoryEntityKind): CatalogEntityType {
  if (kind === 'result' || kind === 'workflow_run') return 'report';
  return kind;
}

function storageTypeForProjectMemoryKind(kind: ProjectMemoryEntityKind): CatalogStorageType {
  if (kind === 'notebook') return 'database';
  if (kind === 'design') return 'localStorage';
  return 'file';
}

function catalogFileKindForProjectMemoryFile(file: ProjectMemoryFile): string {
  if (file.fileKind === 'notebook') return 'waypoint-notebook';
  if (file.fileKind === 'design') return 'waypoint-design';
  return file.fileKind;
}

function catalogStatusForProjectMemoryStatus(
  status: ProjectMemoryFile['status']
): CatalogFileBindingStatus {
  if (status === 'current' || status === 'historical' || status === 'missing') return status;
  return 'conflict';
}

function currentFileForEntity(
  snapshot: ProjectMemorySnapshot,
  entityId: string
): ProjectMemoryFile | null {
  return (
    snapshot.files.find((file) => file.entityId === entityId && file.status === 'current') ?? null
  );
}

function locatorForProjectMemoryEntity(input: {
  workspaceRoot: string;
  entity: ProjectMemoryEntity;
  currentFile: ProjectMemoryFile | null;
}): string {
  if (input.entity.kind === 'notebook') return `entity://page/${input.entity.id}`;
  if (input.entity.kind === 'design') return `entity://design/${input.entity.id}`;
  if (input.entity.kind === 'primer') return `entity://primer/${input.entity.id}`;
  if (input.entity.kind === 'sequence') return `entity://sequence/${input.entity.id}`;
  if (input.currentFile) {
    return `file://${absoluteWorkspacePath(input.workspaceRoot, input.currentFile.path)}`;
  }
  return `entity://${input.entity.kind}/${input.entity.id}`;
}

async function replayProjectMemoryIntoEmptyCatalog(
  input: RebuildWorkspaceCatalogProjectionInput,
  snapshot: ProjectMemorySnapshot,
  mutationToken?: string
) {
  const cleared = await clearCatalogProjectionForWorkspaceRoot(input.workspaceRoot);
  for (const entity of snapshot.entities) {
    const currentFile = currentFileForEntity(snapshot, entity.id);
    await registerCatalogEntity({
      id: entity.id,
      type: catalogTypeForProjectMemoryKind(entity.kind),
      name: entity.displayName,
      locator: locatorForProjectMemoryEntity({
        workspaceRoot: input.workspaceRoot,
        entity,
        currentFile,
      }),
      storageType: storageTypeForProjectMemoryKind(entity.kind),
      status: entity.status,
      workspaceRoot: input.workspaceRoot,
      metadata: {
        source: 'project-memory-rebuild',
        projectMemoryKind: entity.kind,
        currentPath: currentFile?.path ?? null,
        createdByEventId: entity.createdByEventId,
        updatedByEventId: entity.updatedByEventId,
      },
    });
  }

  for (const file of snapshot.files) {
    await bindCatalogEntityToFile({
      entityId: file.entityId,
      path: absoluteWorkspacePath(input.workspaceRoot, file.path),
      fileKind: catalogFileKindForProjectMemoryFile(file),
      mutationToken,
      workspaceRoot: input.workspaceRoot,
      sizeBytes: file.sizeBytes ?? null,
      modifiedAt: file.modifiedAt ? Date.parse(file.modifiedAt) : null,
      status: catalogStatusForProjectMemoryStatus(file.status),
      missingSince: file.status === 'missing' ? Date.now() : null,
    });
  }

  for (const link of snapshot.links) {
    await linkCatalogEntities({
      sourceEntityId: link.sourceEntityId,
      relation: link.relation,
      targetEntityId: link.targetEntityId,
      confidence: link.confidence,
      evidence: {
        ...link.evidence,
        source: 'project-memory-rebuild',
        createdByEventId: link.createdByEventId,
        updatedByEventId: link.updatedByEventId,
      },
    });
  }

  for (const event of snapshot.events) {
    const entityId = event.entityIds[0];
    if (!entityId) continue;
    await recordCatalogEvent({
      id: `pm-${event.eventId}`,
      entityId,
      eventType: event.eventType,
      actor: event.actor.kind,
      summary: `Replayed project memory event: ${event.eventType}`,
      payload: {
        source: 'project-memory-rebuild',
        eventId: event.eventId,
        operationId: event.operationId,
        idempotencyKey: event.idempotencyKey,
        paths: event.paths,
      },
    });
  }

  return cleared;
}

export async function rebuildWorkspaceCatalogProjection(
  input: RebuildWorkspaceCatalogProjectionInput
): Promise<RebuildWorkspaceCatalogProjectionResult> {
  const snapshot = await readProjectMemory(input.workspaceRoot);
  const cleared = await withRendererWorkspaceMutation(
    input.workspaceRoot,
    async (mutationToken) => {
      if (!isDesktopRuntime())
        return replayProjectMemoryIntoEmptyCatalog(input, snapshot, mutationToken);
      const db = platform().db;
      await db.execute('BEGIN IMMEDIATE');
      try {
        const empty = await replayProjectMemoryIntoEmptyCatalog(input, snapshot, mutationToken);
        await db.execute('COMMIT');
        return empty;
      } catch (error) {
        await db.execute('ROLLBACK');
        throw error;
      }
    }
  );

  const filesystemScan = input.scanFilesystem
    ? await reconcileWorkspaceRoot(input.workspaceRoot)
    : null;

  return {
    workspaceRoot: input.workspaceRoot,
    cleared,
    projectMemory: {
      events: snapshot.events.length,
      entities: snapshot.entities.length,
      files: snapshot.files.length,
      links: snapshot.links.length,
      conflicts: snapshot.conflicts,
    },
    filesystemScan,
  };
}
