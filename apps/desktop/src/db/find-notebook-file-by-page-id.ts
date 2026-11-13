import { platform } from '../platform';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';
import { WORKSPACE_SCOPE_SEP, stripWorkspaceScope } from '../shared/workspace-scoped-identity';

export interface NotebookFileForPage {
  path: string;
  entityId: string;
}

interface Row {
  path: string;
  relative_path: string | null;
  entity_id: string;
}

export async function findNotebookFileByPageId(
  pageId: string,
  workspaceRoot: string | null
): Promise<NotebookFileForPage[]> {
  const raw = stripWorkspaceScope(pageId);
  if (!raw || !workspaceRoot) return [];

  const root = stripTrailingSep(workspaceRoot);

  const rows = await platform().db.select<Row[]>(
    `SELECT f.path, f.relative_path, f.entity_id
       FROM catalog_entity_files f
       JOIN catalog_entities e ON e.id = f.entity_id
      WHERE f.status = 'current'
        AND e.type = 'notebook'
      ORDER BY f.path`
  );

  return rows.flatMap((row) => {
    const rowRaw = row.entity_id.includes(WORKSPACE_SCOPE_SEP)
      ? stripWorkspaceScope(row.entity_id)
      : row.entity_id;
    if (rowRaw !== raw) return [];
    if (!pathIsAtOrUnder(row.path, root)) return [];
    const relative = row.relative_path ?? pathRelativeToBoundary(row.path, root);
    if (!relative) return [];
    return [{ path: relative, entityId: row.entity_id }];
  });
}
