import type { SequencePackageDocument } from '../db/sequence-package';
import { contentFingerprint } from './content-fingerprint';
import { canonicalEntityArtifactValue } from './entity-artifact-projection';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  type ManagedSequenceContentSummary,
  type ManagedSequenceDocumentRef,
} from './managed-sequence-document';
import {
  managedSequenceRegistryFields,
  projectSequencePackageRegistrySchema,
} from './managed-sequence-registry-projection';

export const MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD = '_managedSequenceProjectionVersion';
export const MANAGED_SEQUENCE_PROJECTION_VERSION = 2;

export { canonicalEntityArtifactValue as canonicalSequencePackageRegistryValue };

export const sequencePackageRegistrySchema = projectSequencePackageRegistrySchema;

export function sequencePackageRegistryKind(doc: SequencePackageDocument): string {
  return doc.entity.schema.name || 'sequence';
}

export function sequencePackageProjectedFields(
  doc: SequencePackageDocument,
  managedDocument?: ManagedSequenceDocumentRef,
  productSummary?: ManagedSequenceContentSummary
): Record<string, unknown> {
  return {
    ...managedSequenceRegistryFields(doc, productSummary, 2),
    ...(managedDocument ? { [MANAGED_SEQUENCE_DOCUMENT_FIELD]: managedDocument } : {}),
  };
}

export function sequenceEntityProjectionFingerprint(entity: {
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: string;
  domainStatus: string | null;
}): string {
  return contentFingerprint(sequenceEntityProjectionContent(entity));
}

export function sequenceEntityProjectionContent(entity: {
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: string;
  domainStatus: string | null;
}): string {
  const fields = Object.fromEntries(
    Object.entries(entity.fields).filter(([key]) => key !== MANAGED_SEQUENCE_DOCUMENT_FIELD)
  );
  return JSON.stringify(
    canonicalEntityArtifactValue({
      kind: entity.kind,
      name: entity.name,
      fields,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
    })
  );
}

export function sequencePackageProjectionContent(
  doc: SequencePackageDocument,
  productSummary?: ManagedSequenceContentSummary
): string {
  return sequenceEntityProjectionContent({
    kind: sequencePackageRegistryKind(doc),
    name: doc.name,
    fields: sequencePackageProjectedFields(doc, undefined, productSummary),
    registrationStatus: doc.entity.registrationStatus,
    domainStatus: doc.entity.domainStatus,
  });
}

export function sequencePackageProjectionFingerprint(
  doc: SequencePackageDocument,
  productSummary?: ManagedSequenceContentSummary
): string {
  return contentFingerprint(sequencePackageProjectionContent(doc, productSummary));
}
