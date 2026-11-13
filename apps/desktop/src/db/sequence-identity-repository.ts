import type { ArtifactIO } from '../shared/artifact-io';
import type { ClientOf } from '../shared/ipc/contract';
import type { dbContract } from '../shared/ipc/db.contract';
export function createSequenceIdentityRepository(
  database: Pick<ArtifactIO['db'], 'select'> &
    Pick<ClientOf<typeof dbContract>, 'ensureSequenceIndex'>
) {
  async function ensureSequenceIdentity(
    documentId: string,
    filePath: string,
    _name: string,
    _length: number,
    _circular: boolean,
    workspaceRoot?: string
  ): Promise<number> {
    return database.ensureSequenceIndex({ documentId, filePath, workspaceRoot });
  }
  async function getSequenceIdByDocumentId(documentId: string): Promise<number | null> {
    const result = await database.select<{ id: number }[]>(
      'SELECT id FROM sequences WHERE document_id = ? ORDER BY id LIMIT 1',
      [documentId]
    );
    return result[0]?.id ?? null;
  }
  return { ensureSequenceIdentity, getSequenceIdByDocumentId };
}
