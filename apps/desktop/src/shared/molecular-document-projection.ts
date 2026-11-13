import { contentFingerprint } from './content-fingerprint';
import {
  molecularDocumentSummary,
  serializeMolecularDocument,
  type MolecularDocument,
} from './molecular-document';

export function molecularDocumentProjectionFields(
  document: MolecularDocument
): Record<string, string | number> {
  return {
    artifactFingerprint: contentFingerprint(serializeMolecularDocument(document)),
    ...molecularDocumentSummary(document),
  };
}
