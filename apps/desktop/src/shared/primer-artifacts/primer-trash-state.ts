import type { PrimerRecoveryDependencies } from './primer-recovery-port';
export function createPrimerTrashReader(dependencies: PrimerRecoveryDependencies) {
  const platform = dependencies.io;

  async function findTrashedPrimerDocument(entityId: string, expectedPath?: string) {
    const files = await platform().db.select<
      Array<{
        path: string;
        workspace_id: number | null;
        status: string;
        file_kind: string;
      }>
    >(
      'SELECT path, workspace_id, status, file_kind FROM catalog_entity_files WHERE entity_id = ?',
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
    const events = await platform().db.select<Array<{ payload: string | null }>>(
      `SELECT payload FROM catalog_entity_events WHERE entity_id = ? AND event_type = 'file_missing'
     ORDER BY created_at DESC, rowid DESC`,
      [entityId]
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
      return 'reason' in payload && payload.reason === 'moved-to-trash' ? file : null;
    }
    return null;
  }
  return { findTrashedPrimerDocument };
}
