import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from './sequence-entity-schema';
import { computeChecksum } from '@waypoint/sequence-utils';
import {
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../db/sequence-package';
import {
  MANAGED_SEQUENCE_CONTENT_FIELD,
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  type ManagedSequenceContentSummary,
} from './managed-sequence-document';

export const MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD = '_managedSequenceProjectionVersion';
export const MANAGED_SEQUENCE_PROJECTION_VERSION = 3;
export const MANAGED_SEQUENCE_SNAPSHOT_FIELD = '_managedSequenceSnapshot';
export type ManagedSequenceProjectionVersion = 2 | 3;

export function managedSequenceProjectionVersionForExistingRecord(
  fields: Record<string, unknown>
): ManagedSequenceProjectionVersion {
  const version = fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD];
  if (typeof version === 'number' && version > MANAGED_SEQUENCE_PROJECTION_VERSION)
    throw new Error('This saved sequence requires a newer Registry projection reader.');
  return version === 2 ? 2 : MANAGED_SEQUENCE_PROJECTION_VERSION;
}

export interface ManagedSequenceRegistryProjection {
  id: string;
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  schemaRevisionId: string;
  schemaSnapshot: SequencePackageDocument['entity']['schema'];
  registrationStatus: SequencePackageDocument['entity']['registrationStatus'];
  domainStatus: SequencePackageDocument['entity']['domainStatus'];
}

export async function projectManagedSequenceRegistry(
  document: SequencePackageDocument,
  productSummary?: ManagedSequenceContentSummary,
  projectionVersion: ManagedSequenceProjectionVersion = MANAGED_SEQUENCE_PROJECTION_VERSION,
  sourceMarkerContent?: string
): Promise<ManagedSequenceRegistryProjection> {
  const serializedDocument = serializeSequencePackageDocument(document);
  if (
    sourceMarkerContent !== undefined &&
    serializeSequencePackageDocument(parseSequencePackageDocument(sourceMarkerContent)) !==
      serializedDocument
  )
    throw new Error('The saved sequence marker does not match the projected document.');
  const schema = projectSequencePackageRegistrySchema(document);
  return {
    id: document.id,
    kind: document.entity.schema.name || 'sequence',
    name: document.name,
    fields: managedSequenceRegistryFields(
      document,
      productSummary,
      projectionVersion,
      projectionVersion === 3
        ? await computeChecksum(sourceMarkerContent ?? serializedDocument)
        : undefined
    ),
    schemaRevisionId: schema.schemaRevisionId,
    schemaSnapshot: schema,
    registrationStatus: document.entity.registrationStatus,
    domainStatus: document.entity.domainStatus,
  };
}

export function managedSequenceRegistryFields(
  document: SequencePackageDocument,
  productSummary: ManagedSequenceContentSummary | undefined,
  projectionVersion: ManagedSequenceProjectionVersion,
  markerSha256?: string
): Record<string, unknown> {
  if (projectionVersion === 3 && !markerSha256)
    throw new Error('The saved sequence snapshot requires its marker digest.');
  const schema = projectSequencePackageRegistrySchema(document);
  return {
    ...document.entity.fields,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.schemaRevisionId,
    packageKind: 'sequence',
    [MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD]: projectionVersion,
    ...(projectionVersion === 3 && {
      [MANAGED_SEQUENCE_SNAPSHOT_FIELD]: {
        version: 1,
        markerSha256: markerSha256,
      },
    }),
    ...((document.product.genBankChecksum ||
      document.product.sequenceChecksum ||
      document.product.topology ||
      productSummary) && {
      [MANAGED_SEQUENCE_CONTENT_FIELD]: {
        ...(document.product.genBankChecksum
          ? { fileContentHash: document.product.genBankChecksum }
          : {}),
        ...(document.product.sequenceChecksum
          ? { normalizedSequenceHash: document.product.sequenceChecksum }
          : {}),
        ...(productSummary ??
          (document.product.topology ? { topology: document.product.topology } : {})),
      },
    }),
  };
}

export function semanticManagedSequenceProjectionFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== MANAGED_SEQUENCE_DOCUMENT_FIELD)
  );
}

export function canonicalSequencePackageRegistryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSequencePackageRegistryValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalSequencePackageRegistryValue(child)])
  );
}

export function projectSequencePackageRegistrySchema(doc: SequencePackageDocument) {
  const schema = doc.entity.schema;
  const canonical = BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT;
  if (
    schema.schemaRevisionId === 'schema-entity-sequence-builtin-description-v3' &&
    JSON.stringify(
      canonicalSequencePackageRegistryValue({
        ...schema,
        schemaRevisionId: canonical.schemaRevisionId,
      })
    ) === JSON.stringify(canonicalSequencePackageRegistryValue(canonical))
  ) {
    return { ...schema, schemaRevisionId: canonical.schemaRevisionId };
  }
  return schema;
}
