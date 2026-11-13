import type { SequencePackageDocument } from './sequence-package';
import { projectSequencePackageRegistrySchema } from '../shared/managed-sequence-registry-projection';
export {
  canonicalSequencePackageRegistryValue,
  projectSequencePackageRegistrySchema,
} from '../shared/managed-sequence-registry-projection';
import {
  MANAGED_SEQUENCE_CONTENT_FIELD,
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  type ManagedSequenceDocumentRef,
  type ManagedSequenceContentSummary,
} from '../shared/managed-sequence-document';

export function projectSequencePackageRegistryFields(
  doc: SequencePackageDocument,
  managedDocument: ManagedSequenceDocumentRef | undefined,
  productSummary: ManagedSequenceContentSummary | undefined
): Record<string, unknown> {
  const schema = projectSequencePackageRegistrySchema(doc);
  return {
    ...doc.entity.fields,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.schemaRevisionId,
    packageKind: 'sequence',
    _managedSequenceProjectionVersion: 2,
    ...((doc.product.genBankChecksum ||
      doc.product.sequenceChecksum ||
      doc.product.topology ||
      productSummary) && {
      [MANAGED_SEQUENCE_CONTENT_FIELD]: {
        ...(doc.product.genBankChecksum ? { fileContentHash: doc.product.genBankChecksum } : {}),
        ...(doc.product.sequenceChecksum
          ? { normalizedSequenceHash: doc.product.sequenceChecksum }
          : {}),
        ...(productSummary ?? (doc.product.topology ? { topology: doc.product.topology } : {})),
      },
    }),
    ...(managedDocument ? { [MANAGED_SEQUENCE_DOCUMENT_FIELD]: managedDocument } : {}),
  };
}
