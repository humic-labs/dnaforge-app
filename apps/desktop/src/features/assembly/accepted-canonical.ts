import { computeChecksum } from '@waypoint/sequence-utils';
import {
  ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
  type AcceptedAssemblyCanonicalDraftInput,
  type AcceptedAssemblyProjectionInput,
  type AcceptedAssemblyQualifierBag,
  type AcceptedAssemblySourceAnnotationSnapshot,
  type AcceptedAssemblySourceProvenanceSnapshot,
  type AcceptedAssemblyValidationIssue,
  type AcceptedAssemblyValidationSnapshot,
} from './accepted-types';
import {
  getComposedSequence,
  type AssemblyMethod,
  type DesignAnnotation,
  type DesignRegion,
  type DesignSpacer,
  type SequenceDesign,
} from '../design/public/types';
import { buildAssemblyOptimizationInput } from './assembly-optimization-input';
import { requireConstructId } from './accepted-construct-id';

export type BuildAcceptedAssemblyInputOptions = {
  sourceProvenance: readonly AcceptedAssemblySourceProvenanceSnapshot[];
  productSequence?: string;
  constructId?: string;
};

export function canonicalizeAcceptedAssemblyValue(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

export async function computeAcceptedDraftChecksum(
  input: AcceptedAssemblyCanonicalDraftInput
): Promise<string> {
  return computeChecksum(canonicalizeAcceptedAssemblyValue(input));
}

export async function buildAcceptedAssemblyProjectionInput(
  design: SequenceDesign,
  options: BuildAcceptedAssemblyInputOptions
): Promise<AcceptedAssemblyProjectionInput> {
  const canonical = buildAcceptedAssemblyCanonicalDraftInput(design, options);
  return {
    ...canonical,
    canonicalDraftChecksum: await computeAcceptedDraftChecksum(canonical),
  };
}

export function buildAcceptedAssemblyCanonicalDraftInput(
  design: SequenceDesign,
  options: BuildAcceptedAssemblyInputOptions
): AcceptedAssemblyCanonicalDraftInput {
  assertSourceProvenanceCoversRegions(design.regions, options.sourceProvenance);
  const optimizationInput = buildAssemblyOptimizationInput(design);

  return {
    schemaVersion: ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
    designId: design.id,
    constructId: requireConstructId(
      options.constructId ?? design.constructId,
      'Accepted assembly draft'
    ),
    parentAcceptedAssemblyVersionId: design.parentAcceptedAssemblyVersionId,
    designName: design.name,
    topology: design.topology,
    assemblyMethod: design.assemblyMethod,
    backboneSequenceId: design.backboneSequenceId ?? null,
    defaultHomologyLength: design.defaultHomologyLength,
    ...(design.pcrPolymerase != null ? { pcrPolymerase: design.pcrPolymerase } : {}),
    ...(design.primerDesignConstraints
      ? { primerDesignConstraints: { ...design.primerDesignConstraints } }
      : {}),
    productSequence: options.productSequence ?? getComposedSequence(design.regions, design.spacers),
    regions: design.regions.map(projectRegion),
    spacers: projectSpacers(design.spacers),
    homologyRegions: [...design.homologyRegions].sort(compareByJunctionThenId),
    goldenGateConfig: design.goldenGateConfig,
    goldenGateJunctions: design.goldenGateJunctions
      ? [...design.goldenGateJunctions].sort(compareByJunctionThenOverhangStart)
      : undefined,
    designPrimers: design.designPrimers,
    optimizationFingerprint: optimizationInput.optimizationFingerprint,
    assemblyWorkbench: design.assemblyWorkbench,
    sourceProvenance: options.sourceProvenance,
    historicalComponentSources: design.historicalComponentSources,
  };
}

export function buildSourceProvenanceSnapshot(
  region: DesignRegion,
  options: Partial<
    Omit<
      AcceptedAssemblySourceProvenanceSnapshot,
      | 'regionId'
      | 'sourceType'
      | 'sourceSequenceId'
      | 'sourceSequenceName'
      | 'selectedSourceRange'
      | 'includedSourceSegments'
      | 'sourceAnnotations'
      | 'copiedAnnotations'
      | 'rdEnds'
    >
  > & {
    selectedSourceRange?: AcceptedAssemblySourceProvenanceSnapshot['selectedSourceRange'];
    includedSourceSegments?: AcceptedAssemblySourceProvenanceSnapshot['includedSourceSegments'];
    sourceAnnotations?: readonly AcceptedAssemblySourceAnnotationSnapshot[];
  } = {}
): AcceptedAssemblySourceProvenanceSnapshot {
  const selectedSourceRange = options.selectedSourceRange ?? {
    start: region.sourceStart,
    end: region.sourceEnd,
    wraps: region.sourceEnd < region.sourceStart ? true : undefined,
  };
  return {
    regionId: region.id,
    sourceType: region.sourceType === 'rd' || region.rdEnds ? 'restriction-digest' : 'pcr',
    sourceSequenceId: region.sourceSequenceId,
    sourceSequenceName: region.sourceSequenceName,
    sourceConstructId: options.sourceConstructId,
    sourceSequenceVersionId: options.sourceSequenceVersionId,
    sourceLocator: options.sourceLocator,
    sourceSequenceChecksum: options.sourceSequenceChecksum,
    sourceLength: options.sourceLength ?? region.sourceSequence?.length,
    sourceIsCircular: options.sourceIsCircular ?? region.sourceIsCircular,
    copiedDirection: options.copiedDirection ?? 'forward',
    selectedSourceRange,
    includedSourceSegments: options.includedSourceSegments ?? [
      {
        ...selectedSourceRange,
        strand: options.copiedDirection === 'reverse-complement' ? 'reverse' : 'forward',
        role: 'included-template',
      },
    ],
    sourceAnnotations:
      options.sourceAnnotations ?? (region.sourceAnnotations ?? []).map(projectAnnotation),
    copiedAnnotations: region.annotations.map(projectAnnotation),
    rdEnds: region.rdEnds,
  };
}

export function buildAcceptedAssemblyValidationSnapshot(params: {
  designId: string;
  designVersion: number;
  assemblyMethod: AssemblyMethod;
  projectionInputChecksum: string;
  issues?: readonly AcceptedAssemblyValidationIssue[];
  validatedAt?: string;
}): AcceptedAssemblyValidationSnapshot {
  const issues = params.issues ?? [];
  return {
    schemaVersion: ACCEPTED_ASSEMBLY_SCHEMA_VERSION,
    designId: params.designId,
    designVersion: params.designVersion,
    assemblyMethod: params.assemblyMethod,
    projectionInputChecksum: params.projectionInputChecksum,
    validatedAt: params.validatedAt ?? new Date().toISOString(),
    clean: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}

export function isAcceptedAssemblyValidationSnapshotCurrent(
  snapshot: AcceptedAssemblyValidationSnapshot,
  params: {
    designId: string;
    designVersion: number;
    assemblyMethod: AssemblyMethod;
    projectionInputChecksum: string;
  }
): boolean {
  return (
    snapshot.schemaVersion === ACCEPTED_ASSEMBLY_SCHEMA_VERSION &&
    snapshot.designId === params.designId &&
    snapshot.designVersion === params.designVersion &&
    snapshot.assemblyMethod === params.assemblyMethod &&
    snapshot.projectionInputChecksum === params.projectionInputChecksum
  );
}

export function assertSourceProvenanceCoversRegions(
  regions: readonly DesignRegion[],
  sourceProvenance: readonly AcceptedAssemblySourceProvenanceSnapshot[]
): void {
  const expectedIds = new Set(regions.map((region) => region.id));
  const seenIds = new Set<string>();

  for (const snapshot of sourceProvenance) {
    if (!expectedIds.has(snapshot.regionId)) {
      throw new Error(
        `Accepted assembly source provenance references unknown region: ${snapshot.regionId}.`
      );
    }
    if (seenIds.has(snapshot.regionId)) {
      throw new Error(
        `Accepted assembly source provenance contains duplicate region: ${snapshot.regionId}.`
      );
    }
    seenIds.add(snapshot.regionId);
  }

  const missing = [...expectedIds].filter((regionId) => !seenIds.has(regionId));
  if (missing.length > 0) {
    throw new Error(
      `Accepted assembly source provenance is missing region snapshots: ${missing.join(', ')}.`
    );
  }
}

function projectRegion(region: DesignRegion) {
  return {
    id: region.id,
    colorIndex: region.colorIndex,
    sourceSequenceId: region.sourceSequenceId,
    sourceSequenceName: region.sourceSequenceName,
    sourceType: region.sourceType ?? 'pcr',
    sourceStart: region.sourceStart,
    sourceEnd: region.sourceEnd,
    sequence: region.sequence,
    annotations: region.annotations.map(projectAnnotation),
    ggType: region.ggType,
    rdOverhangs: region.rdOverhangs,
    rdSourceEnzyme: region.rdSourceEnzyme,
    rdSourceEnzymeName: region.rdSourceEnzymeName,
    rdEnds: region.rdEnds,
    rdSiblingOverhangs: region.rdSiblingOverhangs,
  };
}

function projectSpacers(spacers: readonly DesignSpacer[]) {
  return [...spacers]
    .sort(
      (left, right) => left.junctionIndex - right.junctionIndex || left.id.localeCompare(right.id)
    )
    .map((spacer) => ({
      id: spacer.id,
      junctionIndex: spacer.junctionIndex,
      sequence: spacer.sequence,
      name: spacer.name,
    }));
}

function projectAnnotation(annotation: DesignAnnotation): AcceptedAssemblySourceAnnotationSnapshot {
  return {
    name: annotation.name,
    type: annotation.type,
    start: annotation.start,
    end: annotation.end,
    strand: annotation.strand,
    color: annotation.color,
    qualifiers: normalizeQualifierBag(annotation.qualifiers),
  };
}

function normalizeQualifierBag(
  qualifiers: DesignAnnotation['qualifiers'] | undefined
): AcceptedAssemblyQualifierBag | undefined {
  if (!qualifiers) return undefined;
  const normalized: AcceptedAssemblyQualifierBag = {};
  for (const key of Object.keys(qualifiers).sort()) {
    const value = (qualifiers as Record<string, string | readonly string[]>)[key];
    normalized[key] = Array.isArray(value) ? [...value] : value;
  }
  return normalized;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(normalizeForCanonicalJson);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Accepted assembly canonical JSON cannot encode non-finite numbers.');
    }
    return value;
  }
  if (typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = normalizeForCanonicalJson(record[key]);
    if (child !== undefined) {
      normalized[key] = child;
    }
  }
  return normalized;
}

function compareByJunctionThenId(
  left: { junctionIndex: number; id?: string },
  right: { junctionIndex: number; id?: string }
): number {
  return left.junctionIndex - right.junctionIndex || (left.id ?? '').localeCompare(right.id ?? '');
}

function compareByJunctionThenOverhangStart(
  left: { junctionIndex: number; overhangStart: number },
  right: { junctionIndex: number; overhangStart: number }
): number {
  return left.junctionIndex - right.junctionIndex || left.overhangStart - right.overhangStart;
}
