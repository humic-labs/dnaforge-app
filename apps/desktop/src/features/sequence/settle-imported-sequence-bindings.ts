import {
  bindCatalogEntityToFile,
  getCurrentSequenceFileForDocumentId,
  registerCatalogEntity,
} from '../../db/workspace-catalog';
import { isSequencePackageFileKind } from '../../db/sequence-package';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../../shared/managed-sequence-document';
import type { ResolvedManagedSequenceDocument } from './managed-sequence-repository-types';

export async function settleImportedSequenceBindings(
  documents: readonly ResolvedManagedSequenceDocument[],
  workspaceRoot: string
): Promise<void> {
  for (const { document, ref } of documents) {
    if (
      ref.packageId !== document.id ||
      pathRelativeToBoundary(ref.packageRoot, workspaceRoot) === null
    )
      throw new Error('Imported sequence identity is outside its destination project.');
    const existing = await getCurrentSequenceFileForDocumentId(document.id);
    if (existing) {
      if (existing.path !== ref.packageRoot || !isSequencePackageFileKind(existing.file_kind))
        throw new Error('Imported sequence already belongs to another catalog binding.');
      continue;
    }
    const entity = await registerCatalogEntity({
      id: document.id,
      type: 'sequence',
      name: document.name,
      locator: `entity://sequence/${document.id}`,
      storageType: 'file',
      workspaceRoot,
      metadata: { [MANAGED_SEQUENCE_DOCUMENT_FIELD]: ref, packageKind: 'sequence' },
    });
    if (entity.id !== document.id) throw new Error('Imported sequence catalog identity changed.');
    await bindCatalogEntityToFile({
      entityId: document.id,
      path: ref.packageRoot,
      fileKind: 'waypoint-sequence',
      workspaceRoot,
      status: 'current',
    });
    const published = await getCurrentSequenceFileForDocumentId(document.id);
    if (published?.path !== ref.packageRoot || !isSequencePackageFileKind(published.file_kind))
      throw new Error('Imported sequence is saved but its canonical lookup is not ready.');
  }
}
