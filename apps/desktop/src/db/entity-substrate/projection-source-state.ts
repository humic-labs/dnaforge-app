import { platform } from '../../platform';
import type { EntityReconcileContext, WorkspaceEntityAdapter } from './adapter-contract';
import type { EntityProjectionSourceKey } from '../../shared/entity-projection-source';
export type { EntityProjectionSourceKey } from '../../shared/entity-projection-source';

export interface ProjectionSynchronizationStore {
  read(key: EntityProjectionSourceKey): Promise<string | null>;
  settle(
    key: EntityProjectionSourceKey,
    fingerprint: string,
    mutationToken?: string
  ): Promise<void>;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function projectionSourceKey(
  adapter: WorkspaceEntityAdapter,
  entityId: string,
  path: string,
  ctx: EntityReconcileContext
): EntityProjectionSourceKey {
  const normalizedPath = normalizePath(path);
  const root = ctx.workspaceRoot ? normalizePath(ctx.workspaceRoot) : null;
  return {
    adapterKind: adapter.kind,
    entityId,
    workspaceKey: ctx.workspaceScope
      ? `scope:${ctx.workspaceScope}`
      : ctx.workspaceId != null
        ? `workspace:${ctx.workspaceId}`
        : root
          ? `root:${root}`
          : 'unbound',
    relativePath:
      root && normalizedPath.startsWith(`${root}/`)
        ? normalizedPath.slice(root.length + 1)
        : normalizedPath,
    projectionVersion: adapter.projectionVersion ?? 1,
  };
}

function parameters(key: EntityProjectionSourceKey): [string, string, string, string, number] {
  return [key.adapterKind, key.entityId, key.workspaceKey, key.relativePath, key.projectionVersion];
}

export const sqliteProjectionSynchronizationStore: ProjectionSynchronizationStore = {
  async read(key) {
    const rows = await platform().db.select<{ synchronized_fingerprint: string }[]>(
      `SELECT synchronized_fingerprint FROM entity_projection_sources
       WHERE adapter_kind = ? AND entity_id = ? AND workspace_key = ?
         AND relative_path = ? AND projection_version = ?`,
      parameters(key)
    );
    return rows[0]?.synchronized_fingerprint ?? null;
  },
  async settle(key, fingerprint, mutationToken) {
    await platform().db.settleEntityProjectionSource({ key, fingerprint }, mutationToken);
  },
};
