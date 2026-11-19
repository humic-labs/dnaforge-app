import { getDb } from './database';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
import { reconcileMolecularDocumentSourceLinksInMain } from '../molecular-document-projection-authority';
import { handleGroup } from '../../shared/ipc-contract';
import type {
  MolecularDocumentLocation,
  SaveMolecularDocumentRequest,
} from '../../shared/molecular-document';
import { MolecularDocumentLibrary } from '../molecular-document-library';
import { molecularDocumentsContract } from '../../shared/ipc/molecular-documents.contract';
import { userMessage } from '@waypoint/user-messages';
import { molecularDocumentReadFailure } from '../../shared/molecular-document-read-failure';
import { readRegisteredMolecularDocument } from '../registered-molecular-document';

export function registerMolecularDocumentIpcHandlers(): void {
  const library = new MolecularDocumentLibrary();
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
    read: async (_event, request: MolecularDocumentLocation) => {
      try {
        return await readRegisteredMolecularDocument(getDb(), request);
      } catch (error) {
        throw new Error(userMessage(molecularDocumentReadFailure(error)), { cause: error });
      }
    },
    save: (_event, request: SaveMolecularDocumentRequest) => library.save(request),
  });
}
