import { isPrimerDesignConstraints } from '../design/public/primer-design-constraints';
import {
  ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
  type AcceptedAssemblySidecarPayload,
  type AcceptedAssemblySourceAnnotationSnapshot,
  type AcceptedAssemblyVersion,
} from './accepted-types';
import type {
  DesignAnnotation,
  DesignRegion,
  DesignSpacer,
  GoldenGateEnzyme,
  SequenceDesign,
} from '../design/public/types';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
  issuesToValidationErrors,
} from './issues/assembly-issues';
import {
  fromPackageRelative,
  isSequencePackageSchema,
  parseSequencePackageDocument,
  sequencePackagePaths,
  stripSequenceProductExtension,
} from '../../db/sequence-package';

export function acceptedAssemblySidecarPathForProduct(productPath: string): string {
  const withoutGenBankExtension = stripSequenceProductExtension(productPath);
  return `${withoutGenBankExtension}.waypoint-assembly.json`;
}

export function acceptedAssemblyRecordCandidates(productPath: string): {
  packageRoot: string;

  productFile: string;
  packageMetaPath: string;
  legacySidecarPath: string;
} {
  const normalized = productPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const packageRoot = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
  return {
    packageRoot,
    productFile: normalized.slice(lastSlash + 1),

    packageMetaPath: sequencePackagePaths(packageRoot).metaPath,
    legacySidecarPath: acceptedAssemblySidecarPathForProduct(productPath),
  };
}

export function parseAcceptedAssemblyRecord(
  content: string,
  options: {
    packageRoot: string | null;

    productFile?: string;
  }
): AcceptedAssemblySidecarPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Accepted assembly record is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Accepted assembly record must be a JSON object.');
  }

  if (!isSequencePackageSchema(parsed.schema)) {
    return parseAcceptedAssemblySidecar(content);
  }

  const doc = parseSequencePackageDocument(content);
  if (options.productFile && options.productFile !== doc.product.file) {
    throw new Error(
      `"${options.productFile}" is not the product of this plasmid package ` +
        `("${doc.product.file}"), so its build record does not describe it.`
    );
  }
  if (!doc.assembly?.accepted) {
    throw new Error(
      'This plasmid package has no assembly build record — it was not produced by an assembly.'
    );
  }

  const packageRoot = options.packageRoot;
  return parseAcceptedAssemblyPayload(doc.assembly.accepted, { packageRoot });
}

export function parseAcceptedAssemblyPayload(
  value: unknown,
  options: { packageRoot: string | null }
): AcceptedAssemblySidecarPayload {
  if (!isRecord(value)) throw new Error('Accepted assembly payload must be a JSON object.');
  const embedded = value as unknown as AcceptedAssemblySidecarPayload;
  const payload = options.packageRoot
    ? absolutizeAcceptedArtifacts(embedded, options.packageRoot)
    : embedded;
  assertAcceptedSidecarPayload(payload);
  if (payload.type !== 'accepted_assembly') {
    throw new Error('Accepted assembly record has the wrong type.');
  }
  return payload;
}

function absolutizeAcceptedArtifacts(
  accepted: AcceptedAssemblySidecarPayload,
  packageRoot: string
): AcceptedAssemblySidecarPayload {
  const artifacts = accepted.artifacts as Record<string, unknown>;
  const resolved: Record<string, unknown> = { ...artifacts };
  for (const key of [
    'productGenBankPath',
    'sidecarJsonPath',
    'primerCsvPath',
    'primerFastaPath',
  ] as const) {
    const value = artifacts[key];
    if (typeof value !== 'string' || !value) continue;
    resolved[key] = isAbsolutePath(value) ? value : fromPackageRelative(value, packageRoot);
  }
  return { ...accepted, artifacts: resolved } as AcceptedAssemblySidecarPayload;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function parseAcceptedAssemblySidecar(content: string): AcceptedAssemblySidecarPayload {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Accepted assembly sidecar must be a JSON object.');
  }
  if (parsed.type !== 'accepted_assembly') {
    throw new Error('Accepted assembly sidecar has the wrong type.');
  }
  if (parsed.schemaVersion !== ACCEPTED_ASSEMBLY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported accepted assembly schema version: ${String(parsed.schemaVersion)}.`
    );
  }

  const payload = parsed as AcceptedAssemblySidecarPayload;
  assertAcceptedSidecarPayload(payload);
  return payload;
}

export function acceptedAssemblyVersionFromSidecar(
  sidecar: AcceptedAssemblySidecarPayload,
  options: { sidecarChecksum?: string } = {}
): AcceptedAssemblyVersion {
  return {
    id:
      sidecar.acceptedAssemblyVersionId ??
      sidecar.acceptedVersionId ??
      fallbackAcceptedVersionId(sidecar),
    schemaVersion: sidecar.schemaVersion,
    lifecycleState: sidecar.lifecycleState ?? 'written',
    acceptedAt: sidecar.acceptedAt,
    acceptedBy: sidecar.acceptedBy,
    canonicalDraftChecksum: sidecar.projectionInput.canonicalDraftChecksum,
    projectionInput: sidecar.projectionInput,
    validationSnapshot: sidecar.validationSnapshot,
    ...(sidecar.savedPrimerOligos?.length ? { savedPrimerOligos: sidecar.savedPrimerOligos } : {}),
    artifacts: {
      productGenBankPath: sidecar.artifacts.productGenBankPath,
      sidecarJsonPath: sidecar.artifacts.sidecarJsonPath,
      primerCsvPath: sidecar.artifacts.primerCsvPath ?? '',
      primerFastaPath: sidecar.artifacts.primerFastaPath ?? '',
      productSequenceChecksum: sidecar.artifacts.productSequenceChecksum,
      primerCsvChecksum: sidecar.artifacts.primerCsvChecksum ?? 'sha256:unknown-primer-csv',
      primerFastaChecksum: sidecar.artifacts.primerFastaChecksum ?? 'sha256:unknown-primer-fasta',
      sidecarChecksum:
        sidecar.artifacts.sidecarChecksum ?? options.sidecarChecksum ?? 'sha256:unknown-sidecar',
      canonicalDraftChecksum: sidecar.artifacts.canonicalDraftChecksum,
    },
  };
}

export function sequenceDesignFromAcceptedAssemblyVersion(
  acceptedVersion: AcceptedAssemblyVersion,
  options: {
    designId: string;
    now?: Date;
    name?: string;
  }
): SequenceDesign {
  const projectionInput = acceptedVersion.projectionInput;
  const now = options.now ?? new Date();
  const provenanceByRegionId = new Map(
    projectionInput.sourceProvenance.map((snapshot) => [snapshot.regionId, snapshot])
  );

  const design: SequenceDesign = {
    id: options.designId,
    constructId: projectionInput.constructId ?? projectionInput.designId,
    parentAcceptedAssemblyVersionId: acceptedVersion.id,
    name: options.name ?? projectionInput.designName,
    topology: projectionInput.topology,
    regions: projectionInput.regions.map((region): DesignRegion => {
      const provenance = provenanceByRegionId.get(region.id);
      return {
        id: region.id,
        colorIndex: region.colorIndex,
        sourceSequenceId: region.sourceSequenceId,
        sourceSequenceName: region.sourceSequenceName,
        sourceStart: region.sourceStart,
        sourceEnd: region.sourceEnd,
        sequence: region.sequence,
        annotations: snapshotsToDesignAnnotations(region.annotations),
        sourceAnnotations: provenance
          ? snapshotsToDesignAnnotations(provenance.sourceAnnotations)
          : undefined,
        sourceIsCircular: provenance?.sourceIsCircular,
        sourceType: region.sourceType,
        ggType: region.ggType,
        rdOverhangs: region.rdOverhangs,
        rdSourceEnzyme: goldenGateEnzymeOrUndefined(region.rdSourceEnzyme),
        rdSourceEnzymeName: region.rdSourceEnzymeName,
        rdEnds: region.rdEnds,
        rdSiblingOverhangs: region.rdSiblingOverhangs ? [...region.rdSiblingOverhangs] : undefined,
      };
    }),
    spacers: projectionInput.spacers.map(
      (spacer): DesignSpacer => ({
        id: spacer.id,
        junctionIndex: spacer.junctionIndex,
        sequence: spacer.sequence,
        name: spacer.name,
      })
    ),
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: projectionInput.assemblyMethod,
    backboneSequenceId: projectionInput.backboneSequenceId,
    defaultHomologyLength: projectionInput.defaultHomologyLength,
    ...(projectionInput.pcrPolymerase != null
      ? { pcrPolymerase: projectionInput.pcrPolymerase }
      : {}),
    ...(projectionInput.primerDesignConstraints
      ? { primerDesignConstraints: { ...projectionInput.primerDesignConstraints } }
      : {}),
    homologyRegions: [...projectionInput.homologyRegions],
    goldenGateConfig: projectionInput.goldenGateConfig,
    goldenGateJunctions: projectionInput.goldenGateJunctions
      ? [...projectionInput.goldenGateJunctions]
      : undefined,
    designPrimers: [...projectionInput.designPrimers],
    assemblyWorkbench: projectionInput.assemblyWorkbench,
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    acceptedAssemblyVersions: [acceptedVersion],
    activeAcceptedAssemblyVersionId: acceptedVersion.id,
    createdAt: now,
    updatedAt: now,
  };

  const currentIssues = deriveAssemblyIssues({ design });
  const hasRunBlockers = currentIssues.some((issue) => issueBlocksGate(issue, 'run'));
  return {
    ...design,
    assemblyState: hasRunBlockers ? 'drafting' : 'ready',
    status: hasRunBlockers ? 'draft' : 'computed',
    validationErrors: issuesToValidationErrors(currentIssues),
  };
}

function assertAcceptedSidecarPayload(payload: AcceptedAssemblySidecarPayload): void {
  if (!payload.projectionInput || !payload.validationSnapshot || !payload.artifacts) {
    throw new Error('Accepted assembly sidecar is missing required construction data.');
  }
  if (
    payload.construction.canonicalDraftChecksum !== payload.projectionInput.canonicalDraftChecksum
  ) {
    throw new Error('Accepted assembly sidecar construction checksum does not match projection.');
  }
  if (
    payload.validationSnapshot.projectionInputChecksum !==
    payload.projectionInput.canonicalDraftChecksum
  ) {
    throw new Error('Accepted assembly sidecar validation checksum does not match projection.');
  }
  if (
    payload.projectionInput.pcrPolymerase != null &&
    typeof payload.projectionInput.pcrPolymerase !== 'string'
  ) {
    throw new Error('Accepted assembly sidecar PCR polymerase must be a string.');
  }
  if (
    payload.projectionInput.primerDesignConstraints !== undefined &&
    !isPrimerDesignConstraints(payload.projectionInput.primerDesignConstraints)
  ) {
    throw new Error('Accepted assembly sidecar contains invalid primer rules.');
  }
  if (!Array.isArray(payload.projectionInput.regions)) {
    throw new Error('Accepted assembly sidecar projection is missing regions.');
  }
  if (!Array.isArray(payload.projectionInput.spacers)) {
    throw new Error('Accepted assembly sidecar projection is missing spacers.');
  }
  if (!Array.isArray(payload.projectionInput.sourceProvenance)) {
    throw new Error('Accepted assembly sidecar projection is missing source provenance.');
  }
}

function snapshotsToDesignAnnotations(
  snapshots: readonly AcceptedAssemblySourceAnnotationSnapshot[]
): DesignAnnotation[] {
  return snapshots.map((snapshot) => ({
    name: snapshot.name,
    type: snapshot.type,
    start: snapshot.start,
    end: snapshot.end,
    strand: snapshot.strand,
    color: snapshot.color,
    qualifiers: qualifierBagToDesignQualifiers(snapshot.qualifiers),
  }));
}

function qualifierBagToDesignQualifiers(
  qualifiers: AcceptedAssemblySourceAnnotationSnapshot['qualifiers']
): Record<string, string> | undefined {
  if (!qualifiers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) result[key] = first;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function fallbackAcceptedVersionId(sidecar: AcceptedAssemblySidecarPayload): string {
  return `accepted-${sidecar.projectionInput.canonicalDraftChecksum.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48)}`;
}

function goldenGateEnzymeOrUndefined(value: string | undefined): GoldenGateEnzyme | undefined {
  return value === 'BsaI' || value === 'BbsI' || value === 'BsmBI' || value === 'SapI'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
