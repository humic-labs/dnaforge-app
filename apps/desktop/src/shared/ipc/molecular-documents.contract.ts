import type {
  MolecularDocumentLocation,
  SaveMolecularDocumentRequest,
  SavedMolecularDocument,
} from '../molecular-document';
import { defineGroup, invoke } from './contract';

export const molecularDocumentsContract = defineGroup('molecularDocuments', {
  read: invoke<[request: MolecularDocumentLocation], SavedMolecularDocument>(),
  save: invoke<[request: SaveMolecularDocumentRequest], SavedMolecularDocument>(),
});
