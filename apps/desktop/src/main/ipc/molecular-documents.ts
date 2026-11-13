import { handleGroup } from '../../shared/ipc-contract';
import type {
  MolecularDocumentLocation,
  SaveMolecularDocumentRequest,
} from '../../shared/molecular-document';
import { MolecularDocumentLibrary } from '../molecular-document-library';
import { molecularDocumentsContract } from '../../shared/ipc/molecular-documents.contract';

export function registerMolecularDocumentIpcHandlers(): void {
  const library = new MolecularDocumentLibrary();
  handleGroup(molecularDocumentsContract, {
    read: (_event, request: MolecularDocumentLocation) => library.read(request),
    save: (_event, request: SaveMolecularDocumentRequest) => library.save(request),
  });
}
