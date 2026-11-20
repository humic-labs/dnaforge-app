import { getDb } from './database';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
import { reconcileMolecularDocumentSourceLinksInMain } from '../molecular-document-projection-authority';
import { handleGroup } from '../../shared/ipc-contract';
import { packMolecularDocument, unpackMolecularDocument } from '../../shared/molecular-document';
import { MolecularDocumentLibrary } from '../molecular-document-library';
import { molecularDocumentsContract } from '../../shared/ipc/molecular-documents.contract';
import { resolveImportedCoordinate } from '../imported-coordinate-location';

export function registerMolecularDocumentIpcHandlers(): void {
  const library = new MolecularDocumentLibrary();
  handleGroup(molecularDocumentsContract, {
    resolveImportedCoordinate: (_event, request) => resolveImportedCoordinate(getDb(), request),
    reconcileSourceLinks: (event, request, mutationToken) => {
      const db = getDb();
      return withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: event.sender.id,
        workspaceRoot: request.workspaceRoot,
        mutationPaths: [request.path],
        mutationToken,
        operation: () =>
          reconcileMolecularDocumentSourceLinksInMain(db, request, (run) =>
            withRendererDatabaseStatement(db, event.sender, run)
          ),
      });
    },
    read: async (_event, request) => {
      const saved = await library.read(request);
      return { ...saved, document: packMolecularDocument(saved.document) };
    },
    save: async (_event, request) => {
      const saved = await library.save({
        ...request,
        document: unpackMolecularDocument(request.document),
      });
      return { ...saved, document: packMolecularDocument(saved.document) };
    },
  });
}
