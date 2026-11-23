import { getDb } from './database';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
import { reconcileMolecularDocumentSourceLinksInMain } from '../molecular-document-projection-authority';
import { handleGroup } from '../../shared/ipc-contract';
import { packMolecularDocument, unpackMolecularDocument } from '../../shared/molecular-document';
import { MolecularDocumentLibrary } from '../molecular-document-library';
import { molecularDocumentsContract } from '../../shared/ipc/molecular-documents.contract';
import { userMessage } from '@waypoint/user-messages';
import { molecularDocumentReadFailure } from '../../shared/molecular-document-read-failure';
import { readRegisteredMolecularDocument } from '../registered-molecular-document';

export function registerMolecularDocumentIpcHandlers(): void {
  const library = new MolecularDocumentLibrary({ db: getDb });
  handleGroup(molecularDocumentsContract, {
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
      try {
        const saved = await readRegisteredMolecularDocument(getDb(), request);
        return { ...saved, document: packMolecularDocument(saved.document) };
      } catch (error) {
        throw new Error(userMessage(molecularDocumentReadFailure(error)), { cause: error });
      }
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
