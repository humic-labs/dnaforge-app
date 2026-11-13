import type Database from 'better-sqlite3';
import { registerLimsEntityInsideTx, updateLimsEntityInsideTx } from './lims-engine-core';
import { queryLimsEntitiesInDb } from './lims-registry-projection';

export function settleNotebookPresentationInDb(
  db: Database.Database,
  input: {
    pageId: string;
    title: string;
    packageRoot: string;
    workspaceId: number;
  }
): void {
  db.transaction(() => {
    db.prepare('UPDATE catalog_entities SET name=?,updated_at=? WHERE id=?').run(
      input.title,
      Date.now(),
      input.pageId
    );
    const existing = queryLimsEntitiesInDb(db, {
      id: input.pageId,
      includeArchived: true,
      limit: 1,
    })[0];
    if (existing) {
      if (existing.kind !== 'notebook')
        throw new Error('The notebook Registry identity belongs to another kind.');
      if (
        existing.name === input.title &&
        existing.workspaceId === input.workspaceId &&
        existing.fields.packagePath === input.packageRoot
      )
        return;
      updateLimsEntityInsideTx(db, {
        id: input.pageId,
        name: input.title,
        fields: { packagePath: input.packageRoot },
        workspaceId: input.workspaceId,
        actor: 'workspace-reconcile',
        expectedEventSeq: existing.eventSeq ?? undefined,
      });
    } else
      registerLimsEntityInsideTx(db, {
        id: input.pageId,
        kind: 'notebook',
        name: input.title,
        fields: { packagePath: input.packageRoot },
        workspaceId: input.workspaceId,
        registrationStatus: 'registered',
      });
  })();
}
