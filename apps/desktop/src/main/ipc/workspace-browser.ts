import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { handleGroup } from '../../shared/ipc-contract';
import type { CatalogRecordPresentationKind } from '../../shared/catalog-entity';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder } from '../../shared/path-boundary';
import type {
  WorkspaceBrowserCatalogEntry,
  WorkspaceBrowserFilesystemEntry,
  WorkspaceListChildrenRequest,
  WorkspaceListChildrenResult,
  NativeCatalogRecordReconcileRequest,
} from '../../shared/workspace-browser-types';
import { getDb } from './database';
import { assertSafePath } from './path-allowlist';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
import { reconcileNativeCatalogRecordsFromFile } from '../native-catalog-record-reconcile';
import { developerImportSourceRootsInDb } from '../registry-source-eligibility';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import { workspaceBrowserContract } from '../../shared/ipc/workspace-browser.contract';
import { catalogIconContext } from '../../shared/catalog-icon-context';

type WorkspaceRow = Readonly<{ id: number; path: string }>;

export async function listWorkspaceChildren(
  db: Database.Database,
  request: WorkspaceListChildrenRequest
): Promise<WorkspaceListChildrenResult> {
  const workspaceRoot = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
  const parentRelativePath = normalizeParentRelativePath(request.parentRelativePath);
  const importSource = isDeveloperImportSourcePath(
    workspaceRoot,
    developerImportSourceRootsInDb(db)
  );
  const workspace = importSource
    ? undefined
    : (db
        .prepare(
          `SELECT id, path
       FROM workspaces
       WHERE path = ?
         AND archived_at IS NULL
         AND trashed_at IS NULL`
        )
        .get(workspaceRoot) as WorkspaceRow | undefined);
  if (!workspace && !importSource) {
    throw new Error('WORKSPACE_BROWSER_NOT_MOUNTED: the requested workspace is not active.');
  }

  const parentPath = parentRelativePath
    ? resolve(workspaceRoot, parentRelativePath)
    : workspaceRoot;
  if (!pathIsAtOrUnder(parentPath, workspaceRoot)) {
    throw new Error('WORKSPACE_BROWSER_UNSAFE_PARENT: parent escapes the workspace.');
  }
  const safeParentPath = await assertSafePath(parentPath, { requireAbsolute: true });
  if (!pathIsAtOrUnder(safeParentPath, workspaceRoot)) {
    throw new Error('WORKSPACE_BROWSER_UNSAFE_PARENT: parent resolves outside the workspace.');
  }

  let filesystemEntries = (await readdir(safeParentPath, { withFileTypes: true })).map(
    (entry): WorkspaceBrowserFilesystemEntry => ({
      kind: 'filesystem',
      entryId: `filesystem:${join(safeParentPath, entry.name)}`,
      name: entry.name,
      path: join(safeParentPath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })
  );

  if (!workspace) {
    return {
      workspaceId: null,
      parentRelativePath,
      entries: filesystemEntries,
      partialError: null,
    };
  }

  let catalogEntries: WorkspaceBrowserCatalogEntry[] = [];
  let partialError: WorkspaceListChildrenResult['partialError'] = null;
  try {
    const contexts = new Map<string, ReturnType<typeof catalogIconContext>>();
    for (let offset = 0; offset < filesystemEntries.length; offset += 500) {
      const paths = filesystemEntries.slice(offset, offset + 500).map((entry) => entry.path);
      const rows = db
        .prepare(
          `SELECT binding.path, entity.type, entity.metadata, lims.kind AS icon_kind
           FROM catalog_entity_files AS binding
           JOIN catalog_entities AS entity ON entity.id = binding.entity_id
           LEFT JOIN lims_entity AS lims ON lims.id = entity.id
           WHERE binding.workspace_id = ?
             AND entity.workspace_id = ?
             AND binding.status = 'current'
             AND entity.status = 'active'
             AND binding.path IN (${paths.map(() => '?').join(', ')})`
        )
        .all(workspace.id, workspace.id, ...paths) as Array<{
        path: string;
        type: string;
        metadata: string | null;
        icon_kind: string | null;
      }>;
      for (const row of rows) {
        contexts.set(
          row.path,
          catalogIconContext({
            kind: row.icon_kind ?? row.type,
            path: row.path,
            metadata: row.metadata,
          })
        );
      }
    }
    filesystemEntries = filesystemEntries.map((entry) => {
      const iconContext = contexts.get(entry.path);
      return iconContext ? { ...entry, iconContext } : entry;
    });
    catalogEntries = db
      .prepare(
        `SELECT placement.entity_id, placement.parent_relative_path,
                placement.display_name, placement.presentation_kind,
                entity.metadata, lims.kind AS icon_kind,
                (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(binding.stable_object_id) ELSE NULL END
                   FROM catalog_provider_bindings AS binding
                  WHERE binding.entity_id = placement.entity_id
                    AND binding.provider = 'benchling'
                    AND binding.binding_kind IN ('observed', 'reviewed')) AS source_record_id
         FROM catalog_workspace_placements AS placement
         JOIN catalog_entities AS entity ON entity.id = placement.entity_id
         LEFT JOIN lims_entity AS lims ON lims.id = entity.id
         WHERE placement.workspace_id = ?
           AND placement.parent_relative_path = ?
           AND placement.status = 'active'
           AND entity.status = 'active'
         ORDER BY placement.normalized_sibling_name, placement.entity_id`
      )
      .all(workspace.id, parentRelativePath)
      .map((row) => {
        const placement = row as {
          entity_id: string;
          parent_relative_path: string;
          display_name: string;
          presentation_kind: CatalogRecordPresentationKind;
          source_record_id: string | null;
          metadata: string | null;
          icon_kind: string | null;
        };
        const iconContext = catalogIconContext({
          kind: placement.icon_kind,
          metadata: placement.metadata,
        });
        return {
          kind: 'catalog' as const,
          entryId: `catalog:${placement.entity_id}`,
          workspaceId: workspace.id,
          entityId: placement.entity_id,
          sourceRecordId: placement.source_record_id,
          name: placement.display_name,
          parentRelativePath: placement.parent_relative_path,
          presentationKind: placement.presentation_kind,
          ...(iconContext ? { iconContext } : {}),
        };
      });
  } catch (error) {
    partialError = {
      source: 'catalog',
      code: 'catalog_listing_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    workspaceId: workspace.id,
    parentRelativePath,
    entries: [...filesystemEntries, ...catalogEntries],
    partialError,
  };
}

export function registerWorkspaceBrowserHandlers(): void {
  handleGroup(workspaceBrowserContract, {
    reconcileNativeRecords: async (event, request: NativeCatalogRecordReconcileRequest) => {
      const workspaceRoot = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
      const db = getDb();
      return withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: event.sender.id,
        workspaceRoot,
        mutationToken: request.mutationToken,
        operation: async () =>
          withRendererDatabaseStatement(db, event.sender, () =>
            reconcileNativeCatalogRecordsFromFile(db, { ...request, workspaceRoot })
          ),
      });
    },
    listChildren: (_event, request: WorkspaceListChildrenRequest) =>
      listWorkspaceChildren(getDb(), request),
  });
}

function normalizeParentRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized) return '';
  if (!isSafeWorkspaceRelativePath(normalized)) {
    throw new Error('WORKSPACE_BROWSER_UNSAFE_PARENT: parent path is invalid.');
  }
  return normalized;
}
