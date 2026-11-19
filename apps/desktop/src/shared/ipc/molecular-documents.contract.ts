import type {
  ImportedCoordinateLocation,
  MolecularDocumentLocation,
  ReconcileMolecularDocumentSourcesRequest,
  MolecularDocumentSourceProjection,
  SaveMolecularDocumentRequest,
  SavedMolecularDocument,
} from '../molecular-document';
import { defineGroup, invoke } from './contract';

export const molecularDocumentsContract = defineGroup('molecularDocuments', {
  resolveImportedCoordinate: invoke<
    [request: ImportedCoordinateLocation],
    MolecularDocumentLocation | null
  >(),
  reconcileSourceLinks: invoke<
    [request: ReconcileMolecularDocumentSourcesRequest, mutationToken?: string],
    MolecularDocumentSourceProjection
  >(),
  read: invoke<[request: MolecularDocumentLocation], SavedMolecularDocument>(),
  save: invoke<[request: SaveMolecularDocumentRequest], SavedMolecularDocument>(),
});
