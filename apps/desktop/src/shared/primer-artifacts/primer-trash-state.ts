import type { PrimerRecoveryDependencies } from './primer-recovery-port';
export function createPrimerTrashReader(dependencies: PrimerRecoveryDependencies) {
  const platform = dependencies.io;

  async function findTrashedPrimerDocument(entityId: string, expectedPath?: string) {
    const files = await platform().db.select<
      Array<{
        id: string;
        path: string;
        workspace_id: number | null;
        status: string;
        file_kind: string;
        missing_since: number | null;
      }>
    >(
      'SELECT id, path, workspace_id, status, file_kind, missing_since FROM catalog_entity_files WHERE entity_id = ?',
      [entityId]
    );
    if (files.some((file) => file.status === 'current')) return null;
    const missing = files.filter(
      (file) =>
        file.status === 'missing' &&
        file.file_kind === 'primer-artifact' &&
        (expectedPath === undefined || file.path === expectedPath)
    );
    if (missing.length !== 1 || (await platform().fs.exists(missing[0].path))) return null;
    const file = missing[0];
    if (file.missing_since === null) return null;
    const events = await platform().db.select<Array<{ payload: string | null }>>(
      `SELECT e.payload FROM catalog_entity_files f
       JOIN catalog_entity_events e ON e.entity_id = f.entity_id
       WHERE f.id = ? AND f.entity_id = ? AND f.path = ? AND f.status = 'missing'
         AND f.missing_since = ? AND e.event_type = 'file_missing' AND e.created_at >= f.missing_since
         AND NOT EXISTS (SELECT 1 FROM catalog_entity_files c WHERE c.entity_id = f.entity_id AND c.status = 'current')
       ORDER BY e.rowid DESC`,
      [file.id, entityId, file.path, file.missing_since]
    );
    for (const event of events) {
      let payload: unknown;
      try {
        payload = event.payload ? JSON.parse(event.payload) : null;
      } catch {
        continue;
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('path' in payload) ||
        payload.path !== file.path
      )
        continue;
      if ('bindingId' in payload && payload.bindingId !== file.id) continue;
      if ('reason' in payload) {
        if (payload.reason === 'moved-to-trash') return file;
        if (payload.reason === 'deleted') return null;
      }
      if ('startsMissingInterval' in payload && payload.startsMissingInterval === true) return null;
    }
    return null;
  }
  return { findTrashedPrimerDocument };
}
