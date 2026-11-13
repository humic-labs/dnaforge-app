import type { InlineDnaSequenceRef, RnaSequenceRef } from '../lims';
import type { PrimerLegacyProjectionInput } from '../primer-projection-ipc';
import {
  primerArtifactMetadataFields,
  primerArtifactNotes,
  type PrimerArtifactV1,
} from './primer-artifact';
import type { Primer, PrimerOrigin } from './types';

export interface ResolvedPrimerArtifactBinding {
  binding: PrimerArtifactV1['bindings'][number];
  sequenceId: number;
}

export function primerOriginFromArtifactSource(
  source: PrimerArtifactV1['metadata']['source']
): PrimerOrigin {
  return source === 'assembly' ? 'assembly' : 'manual';
}

export function primerArtifactRegistryProjection(
  artifact: PrimerArtifactV1,
  sequenceRef: InlineDnaSequenceRef | Extract<RnaSequenceRef, { mode: 'inline' }>,
  artifactContentHash: string
) {
  const savedState = artifact.entity?.state;
  const registrationStatus = savedState?.registrationStatus ?? 'registered';
  const domainStatus = savedState ? savedState.domainStatus : 'designed';
  const fields: Record<string, unknown> = {
    ...primerArtifactMetadataFields(artifact),
    ...(artifact.entity?.otherFields ?? {}),
    ...(artifact.entity?.fields ?? {}),
    sequence: sequenceRef,
    use: 'primer',
    status: savedState && 'status' in savedState ? savedState.status : 'designed',

    source: savedState && 'source' in savedState ? savedState.source : artifact.metadata.source,
    catalogNumber: artifact.catalogNumber,
    artifact: {
      schema: artifact.schema,
      schemaVersion: artifact.schemaVersion,
      revision: artifact.artifactRevision,
      relativePath: artifact.file.workspaceRelativePath,
      contentHash: artifactContentHash,
    },
    bindings: artifact.bindings,
    ...(artifact.annealing ? { annealing: artifact.annealing } : {}),
    ...(artifact.oligo ? { oligo: artifact.oligo } : {}),
    tmCalculation: artifact.computed.tmCalculation,
  };

  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
  return { fields, registrationStatus, domainStatus };
}

export function primerArtifactLegacyProjection(
  artifact: PrimerArtifactV1,
  resolvedBindings: readonly ResolvedPrimerArtifactBinding[],
  workspaceId: number | null,
  registryRelationships?: { relativePath: string; contentHash: string }
): { input: PrimerLegacyProjectionInput; primer: Primer } {
  const createdAt = Date.parse(artifact.metadata.createdAt);
  const updatedAt = Date.parse(artifact.metadata.updatedAt);
  const originDetails = JSON.stringify({
    ...artifact.inventory?.originDetails,
    authority: 'primer_artifact',
    artifactPath: artifact.file.workspaceRelativePath,
    limsEntityId: artifact.registry.entityId,
    schemaVersion: artifact.schemaVersion,
    oligoOrderType: artifact.oligo?.orderType ?? 'dna',
  });
  const origin = (artifact.inventory?.origin ??
    primerOriginFromArtifactSource(artifact.metadata.source)) as PrimerOrigin;
  const inventory = {
    vendor: artifact.inventory ? artifact.inventory.vendor : (artifact.oligo?.vendor ?? null),
    modifications: artifact.inventory
      ? artifact.inventory.modifications
      : (artifact.oligo?.notation ?? null),
    orderDate: artifact.inventory?.orderDate ?? null,
    scale: artifact.inventory?.scale ?? null,
    purification: artifact.inventory?.purification ?? null,
    stockLocation: artifact.inventory?.stockLocation ?? null,
    concentration: artifact.inventory?.concentration ?? null,
  };

  const input: PrimerLegacyProjectionInput = {
    artifactRevision: artifact.artifactRevision,
    ...(registryRelationships ? { registryRelationships } : {}),
    id: artifact.id,
    catalogNumber: artifact.catalogNumber,
    name: artifact.name,
    sequence: artifact.sequence.bases,
    length: artifact.sequence.length,
    tm: artifact.computed.tmC,
    gcPercent: artifact.computed.gcPercent,
    origin,
    status: artifact.entity?.state?.archived
      ? 'archived'
      : (artifact.entity?.state?.status ?? 'designed'),
    originDetails: JSON.parse(originDetails) as Record<string, unknown>,
    ...(artifact.inventory
      ? inventory
      : { vendor: inventory.vendor, modifications: inventory.modifications }),
    application: artifact.metadata.application,
    notes: primerArtifactNotes(artifact),
    workspaceId,
    createdAt,
    updatedAt,
    bindings: resolvedBindings.map(({ binding, sequenceId }) => ({
      id: binding.id,
      sequenceId,
      bindingStart: binding.coordinates.start,
      bindingEnd: binding.coordinates.end,
      strand: binding.coordinates.strand,
      source: binding.history?.source ?? binding.source,
      createdAt: binding.history?.createdAt,
      updatedAt: binding.history?.updatedAt,
    })),
  };
  const primer: Primer = {
    id: artifact.id,
    catalogNumber: artifact.catalogNumber,
    name: artifact.name,
    sequence: artifact.sequence.bases,
    length: artifact.sequence.length,
    tm: artifact.computed.tmC,
    gcPercent: artifact.computed.gcPercent,
    origin,
    originDetails: JSON.parse(originDetails) as Record<string, unknown>,
    status: (artifact.entity?.state?.archived
      ? 'archived'
      : (artifact.entity?.state?.status ?? 'designed')) as Primer['status'],
    ...inventory,
    application: artifact.metadata.application,
    notes: primerArtifactNotes(artifact),
    workspaceId,
    createdAt,
    updatedAt,
  };
  return { input, primer };
}

export function primerArtifactRegistryFields(
  artifact: PrimerArtifactV1,
  hashes: { sequenceContentHash: string; artifactContentHash: string }
): Record<string, unknown> {
  const bases = artifact.sequence.bases.replace(/\s/g, '');
  return primerArtifactRegistryProjection(
    artifact,
    {
      mode: 'inline',
      bases,
      topology: 'linear',
      length: bases.length,
      contentHash: hashes.sequenceContentHash,
    },
    hashes.artifactContentHash
  ).fields;
}

export function primerRegistryProjectionFromArtifact(
  artifact: PrimerArtifactV1,
  artifactContentHash: string
) {
  const bases = artifact.sequence.bases.replace(/\s/g, '');
  return primerArtifactRegistryProjection(
    artifact,
    {
      mode: 'inline',
      bases,
      topology: 'linear',
      length: bases.length,
      contentHash: `sha256:${artifact.sequence.contentHash}`,
    },
    artifactContentHash
  );
}

export function primerRegistryFieldsFromArtifact(
  artifact: PrimerArtifactV1,
  artifactContentHash: string
): Record<string, unknown> {
  return primerRegistryProjectionFromArtifact(artifact, artifactContentHash).fields;
}

export function primerLegacyProjectionFromArtifact(
  artifact: PrimerArtifactV1,
  workspaceId: number | null,
  resolvedBindings: readonly ResolvedPrimerArtifactBinding[]
): PrimerLegacyProjectionInput & { origin: PrimerOrigin } {
  return primerArtifactLegacyProjection(artifact, resolvedBindings, workspaceId)
    .input as PrimerLegacyProjectionInput & { origin: PrimerOrigin };
}
