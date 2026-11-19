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
    read: (_event, request: MolecularDocumentLocation) => library.read(request),
    save: (_event, request: SaveMolecularDocumentRequest) => library.save(request),
  });
}
