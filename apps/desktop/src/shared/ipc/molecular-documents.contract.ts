import type {
  MolecularDocumentLocation,
  ReconcileMolecularDocumentSourcesRequest,
  MolecularDocumentSourceProjection,
  SaveMolecularDocumentRequest,
  SavedMolecularDocument,
} from '../molecular-document';
import { defineGroup, invoke } from './contract';

export const molecularDocumentsContract = defineGroup('molecularDocuments', {
  reconcileSourceLinks: invoke<
    [request: ReconcileMolecularDocumentSourcesRequest, mutationToken?: string],
    MolecularDocumentSourceProjection
  >(),
  read: invoke<[request: MolecularDocumentLocation], SavedMolecularDocument>(),
  save: invoke<[request: SaveMolecularDocumentRequest], SavedMolecularDocument>(),
});
