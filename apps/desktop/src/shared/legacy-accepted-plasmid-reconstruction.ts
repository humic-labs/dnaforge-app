import type { SequencePackageDocument } from '../db/sequence-package';
import { fromPackageRelative } from '../db/sequence-package';
import type { LimsEntity } from './lims';
import {
  BUILTIN_SEQUENCE_SCHEMA_ID,
  createSequenceEntityMetadataForSchema,
  type SequenceSchemaDefinitionView,
} from './sequence-entity-schema';
import { validatedSequenceEntityRegistrationStatus } from './entity-record';

export const MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD = '_managedSequenceProjectionVersion';
export const MANAGED_SEQUENCE_PROJECTION_VERSION = 2;

export interface LegacyAcceptedPlasmidReconstructionInput {
  workspaceId: number;
  packageId: string;
  metadataPath: string;
  expectedMetadataSha256: string;
  expectedProductSha256: string;
}

export type LegacyAcceptedPlasmidReconstructionResult =
  | { kind: 'not-applicable' }
  | { kind: 'published'; metadataSha256: string };

export function parseLegacyAcceptedPlasmidReconstructionInput(
  value: unknown
): LegacyAcceptedPlasmidReconstructionInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('workspaceId' in value) ||
    typeof value.workspaceId !== 'number' ||
    !Number.isSafeInteger(value.workspaceId) ||
    value.workspaceId <= 0 ||
    !('packageId' in value) ||
    typeof value.packageId !== 'string' ||
    value.packageId.length === 0 ||
    value.packageId.length > 512 ||
    !('metadataPath' in value) ||
    typeof value.metadataPath !== 'string' ||
    value.metadataPath.length === 0 ||
    value.metadataPath.length > 4096 ||
    !('expectedMetadataSha256' in value) ||
    typeof value.expectedMetadataSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedMetadataSha256) ||
    !('expectedProductSha256' in value) ||
    typeof value.expectedProductSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedProductSha256) ||
    Object.keys(value).some(
      (key) =>
        ![
          'workspaceId',
          'packageId',
          'metadataPath',
          'expectedMetadataSha256',
          'expectedProductSha256',
        ].includes(key)
    )
  )
    throw new Error('Legacy Plasmid reconstruction requires bounded source identity and SHA-256.');
  return {
    workspaceId: value.workspaceId,
    packageId: value.packageId,
    metadataPath: value.metadataPath,
    expectedMetadataSha256: value.expectedMetadataSha256,
    expectedProductSha256: value.expectedProductSha256,
  };
}

export function isLegacyAcceptedPlasmidPackage(document: SequencePackageDocument): boolean {
  return (
    document.entity.schema.schemaId === BUILTIN_SEQUENCE_SCHEMA_ID &&
    Boolean(document.assembly?.accepted)
  );
}

export function legacyAcceptedPlasmidProjectionId(
  document: SequencePackageDocument
): string | null {
  const accepted = document.assembly?.accepted;
  const versionId = accepted?.acceptedAssemblyVersionId ?? accepted?.acceptedVersionId;
  return typeof versionId === 'string' && versionId === document.id
    ? `accepted-assembly-${versionId}`
    : null;
}

export function matchesLegacyAcceptedPlasmidProjection(
  document: SequencePackageDocument,
  packageRoot: string,
  candidate: LimsEntity
): boolean {
  if (
    candidate.id !== legacyAcceptedPlasmidProjectionId(document) ||
    candidate.tombstone ||
    candidate.kind !== 'plasmid' ||
    candidate.fields.acceptedAssemblyVersionId !== document.id
  )
    return false;
  const sequence = candidate.fields.sequence;
  return Boolean(
    sequence &&
    typeof sequence === 'object' &&
    'mode' in sequence &&
    sequence.mode === 'file' &&
    'relPath' in sequence &&
    sequence.relPath === fromPackageRelative(document.product.file, packageRoot)
  );
}

export function needsLegacyAcceptedPlasmidReconstruction(
  document: SequencePackageDocument,
  source: LimsEntity
): boolean {
  return (
    isLegacyAcceptedPlasmidPackage(document) &&
    source.kind === 'plasmid' &&
    source.fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD] !== MANAGED_SEQUENCE_PROJECTION_VERSION
  );
}

export function buildLegacyAcceptedPlasmidReconstruction(input: {
  document: SequencePackageDocument;
  source: LimsEntity;
  schema: SequenceSchemaDefinitionView;
  registryId: string | null;
  updatedAt: string;
}): SequencePackageDocument {
  const { document, source, schema } = input;
  const keys = new Set(schema.fields.map((field) => field.key));
  const fields: Record<string, unknown> = { ...document.entity.fields };
  for (const [key, value] of Object.entries(source.fields)) {
    if (keys.has(key)) fields[key] = value;
  }
  const metadata = createSequenceEntityMetadataForSchema(schema);
  return {
    ...document,
    entity: {
      ...metadata,
      fields,
      registrationStatus: validatedSequenceEntityRegistrationStatus(
        metadata.schema,
        fields,
        source.registrationStatus
      ),
      domainStatus: source.domainStatus,
      registryId: input.registryId,
      relationships: document.entity.relationships,
      ...(document.entity.source ? { source: document.entity.source } : {}),
    },
    updatedAt: input.updatedAt,
  };
}
