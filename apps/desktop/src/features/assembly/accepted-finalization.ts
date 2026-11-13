import {
  buildAcceptedAssemblyProjectionInput,
  isAcceptedAssemblyValidationSnapshotCurrent,
  type BuildAcceptedAssemblyInputOptions,
} from './accepted-canonical';
import {
  ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
  type AcceptedAssemblyPrimerOligo,
  type AcceptedAssemblySourceProvenanceSnapshot,
  type AcceptedAssemblyValidationSnapshot,
  type AcceptedAssemblyVersion,
} from './accepted-types';
import type { SequenceDesign } from '../design/public/types';

export type BuildAcceptedAssemblyVersionInput = {
  design: SequenceDesign;
  sourceProvenance: readonly AcceptedAssemblySourceProvenanceSnapshot[];
  validationSnapshot: AcceptedAssemblyValidationSnapshot;
  acceptedAt?: string;
  acceptedBy?: string;
  createId?: () => string;
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
};

export async function buildAcceptedAssemblyVersion(
  input: BuildAcceptedAssemblyVersionInput
): Promise<AcceptedAssemblyVersion> {
  const projectionInput = await buildAcceptedAssemblyProjectionInput(input.design, {
    sourceProvenance: input.sourceProvenance,
  } satisfies BuildAcceptedAssemblyInputOptions);

  if (
    !isAcceptedAssemblyValidationSnapshotCurrent(input.validationSnapshot, {
      designId: input.design.id,
      designVersion: input.design.version,
      assemblyMethod: input.design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
    })
  ) {
    throw new Error('Accepted assembly requires a current validation snapshot.');
  }

  if (!input.validationSnapshot.clean) {
    throw new Error('Accepted assembly cannot be finalized with validation errors.');
  }

  return {
    id: input.createId?.() ?? createAcceptedAssemblyId(),
    schemaVersion: ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
    lifecycleState: 'accepted',
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
    acceptedBy: input.acceptedBy,
    canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
    projectionInput,
    validationSnapshot: input.validationSnapshot,
    ...(input.savedPrimerOligos?.length
      ? { savedPrimerOligos: sortedPrimerOligos(input.savedPrimerOligos) }
      : {}),
  };
}

function sortedPrimerOligos(
  oligos: readonly AcceptedAssemblyPrimerOligo[]
): AcceptedAssemblyPrimerOligo[] {
  return [...oligos].sort((left, right) => left.primerId.localeCompare(right.primerId));
}

export function appendAcceptedAssemblyVersionToDesign(
  design: SequenceDesign,
  acceptedVersion: AcceptedAssemblyVersion,
  options: { updatedAt?: Date } = {}
): SequenceDesign {
  const activatesDesign = acceptedAssemblyVersionActivatesDesign(acceptedVersion);
  return {
    ...design,
    constructId: design.constructId ?? acceptedVersion.projectionInput.constructId,
    acceptedAssemblyVersions: [...(design.acceptedAssemblyVersions ?? []), acceptedVersion],
    activeAcceptedAssemblyVersionId: activatesDesign
      ? acceptedVersion.id
      : (design.activeAcceptedAssemblyVersionId ?? null),
    assemblyState: activatesDesign ? 'assembled' : design.assemblyState,
    status: activatesDesign ? 'assembled' : design.status,
    version: design.version + 1,
    updatedAt: options.updatedAt ?? new Date(),
  };
}

export function acceptedAssemblyVersionActivatesDesign(
  acceptedVersion: Pick<AcceptedAssemblyVersion, 'lifecycleState'>
): boolean {
  return (
    acceptedVersion.lifecycleState === 'accepted' || acceptedVersion.lifecycleState === 'written'
  );
}

function createAcceptedAssemblyId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `accepted-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
