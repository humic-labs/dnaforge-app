import type {
  MolecularDocumentLocation,
  ReconcileMolecularDocumentSourcesRequest,
  MolecularDocumentSourceProjection,
  SavedMolecularDocument,
  SaveMolecularDocumentRequest,
  StoredMolecularDocument,
} from '../molecular-document';
import { defineGroup, invoke } from './contract';

export const molecularDocumentsContract = defineGroup('molecularDocuments', {
  reconcileSourceLinks: invoke<
    [request: ReconcileMolecularDocumentSourcesRequest, mutationToken?: string],
    MolecularDocumentSourceProjection
  >(),
  read: invoke<[request: MolecularDocumentLocation], PackedMolecularDocumentFile>(),
  save: invoke<[request: PackedMolecularDocumentSave], PackedMolecularDocumentFile>(),
});

type PackedMolecularDocumentFile = Omit<SavedMolecularDocument, 'document'> & {
  document: StoredMolecularDocument;
};
type PackedMolecularDocumentSave = Omit<SaveMolecularDocumentRequest, 'document'> & {
  document: StoredMolecularDocument;
};
