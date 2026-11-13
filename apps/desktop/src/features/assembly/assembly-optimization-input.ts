import {
  getComposedSequence,
  type DesignRegion,
  type GoldenGateJunction,
  type HomologyRegion,
  type SequenceDesign,
} from '../design/public/types';

export const ASSEMBLY_OPTIMIZATION_INPUT_SCHEMA_VERSION = 2 as const;

export type AssemblyOptimizationInput = {
  schemaVersion: typeof ASSEMBLY_OPTIMIZATION_INPUT_SCHEMA_VERSION;
  optimizationFingerprint: string;
  method: SequenceDesign['assemblyMethod'];
  topology: SequenceDesign['topology'];
  productSequence: string;
  regions: readonly AssemblyOptimizationRegionInput[];
  spacers: readonly AssemblyOptimizationSpacerInput[];
  primerPbsConstraints: readonly AssemblyOptimizationPrimerPbsConstraintInput[];
  homologyRegions: readonly AssemblyOptimizationHomologyInput[];
  goldenGate?: AssemblyOptimizationGoldenGateInput;
};

export type AssemblyOptimizationRegionInput = {
  id: string;
  sourceSequenceId: string;
  sourceType: NonNullable<DesignRegion['sourceType']>;
  sourceStart: number;
  sourceEnd: number;
  sequence: string;
  rdOverhangs?: DesignRegion['rdOverhangs'];
  rdSourceEnzyme?: string;
  rdEnds?: DesignRegion['rdEnds'];
};

export type AssemblyOptimizationSpacerInput = {
  id: string;
  junctionIndex: number;
  sequence: string;
};

export type AssemblyOptimizationPrimerPbsConstraintInput = {
  fragmentIndex: number;
  regionId: string;
  direction: 'forward' | 'reverse';
  length: number;
};

export type AssemblyOptimizationHomologyInput = Pick<
  HomologyRegion,
  'id' | 'junctionIndex' | 'junctionPosition' | 'start' | 'end' | 'encoding' | 'templateBasis'
>;

export type AssemblyOptimizationGoldenGateJunctionInput = Pick<
  GoldenGateJunction,
  | 'junctionIndex'
  | 'junctionPosition'
  | 'offset'
  | 'overhangStart'
  | 'overhangEnd'
  | 'overhang'
  | 'source'
>;

export type AssemblyOptimizationGoldenGateInput = {
  enzyme: NonNullable<SequenceDesign['goldenGateConfig']>['enzyme'] | 'BsaI';
  offsetLimitBp?: number;
  junctions: readonly AssemblyOptimizationGoldenGateJunctionInput[];
};

type AssemblyOptimizationInputWithoutFingerprint = Omit<
  AssemblyOptimizationInput,
  'optimizationFingerprint'
>;

export function buildAssemblyOptimizationInput(design: SequenceDesign): AssemblyOptimizationInput {
  const input: AssemblyOptimizationInputWithoutFingerprint = {
    schemaVersion: ASSEMBLY_OPTIMIZATION_INPUT_SCHEMA_VERSION,
    method: design.assemblyMethod,
    topology: design.topology,
    productSequence: getComposedSequence(design.regions, design.spacers),
    regions: design.regions.map(projectOptimizationRegion),
    spacers: [...design.spacers]
      .sort(
        (left, right) => left.junctionIndex - right.junctionIndex || left.id.localeCompare(right.id)
      )
      .map((spacer) => ({
        id: spacer.id,
        junctionIndex: spacer.junctionIndex,
        sequence: spacer.sequence,
      })),
    primerPbsConstraints: design.designPrimers
      .flatMap((pair) => [pair.forward, pair.reverse])
      .map((primer) => ({
        fragmentIndex: primer.fragmentIndex,
        regionId: design.regions[primer.fragmentIndex]?.id ?? '',
        direction: primer.direction,
        length: primer.pbs.end - primer.pbs.start,
      }))
      .filter((constraint) => constraint.regionId.length > 0 && constraint.length > 0)
      .sort(
        (left, right) =>
          left.fragmentIndex - right.fragmentIndex ||
          left.direction.localeCompare(right.direction) ||
          left.regionId.localeCompare(right.regionId)
      ),
    homologyRegions: [...design.homologyRegions]
      .sort(
        (left, right) => left.junctionIndex - right.junctionIndex || left.id.localeCompare(right.id)
      )
      .map((homology) => ({
        id: homology.id,
        junctionIndex: homology.junctionIndex,
        junctionPosition: homology.junctionPosition,
        start: homology.start,
        end: homology.end,
        encoding: homology.encoding,
        templateBasis: homology.templateBasis,
      })),
    goldenGate:
      design.assemblyMethod === 'goldengate'
        ? {
            enzyme: design.goldenGateConfig?.enzyme ?? 'BsaI',
            offsetLimitBp: design.goldenGateConfig?.offsetLimitBp,
            junctions: [...(design.goldenGateJunctions ?? [])]
              .sort((left, right) => left.junctionIndex - right.junctionIndex)
              .map((junction) => ({
                junctionIndex: junction.junctionIndex,
                junctionPosition: junction.junctionPosition,
                offset: junction.offset,
                overhangStart: junction.overhangStart,
                overhangEnd: junction.overhangEnd,
                overhang: junction.overhang,
                source: junction.source,
              })),
          }
        : undefined,
  };

  return {
    ...input,
    optimizationFingerprint: fingerprintAssemblyOptimizationInput(input),
  };
}

function projectOptimizationRegion(region: DesignRegion): AssemblyOptimizationRegionInput {
  return {
    id: region.id,
    sourceSequenceId: region.sourceSequenceId,
    sourceType: region.sourceType ?? 'pcr',
    sourceStart: region.sourceStart,
    sourceEnd: region.sourceEnd,
    sequence: region.sequence,
    rdOverhangs: region.rdOverhangs,
    rdSourceEnzyme: region.rdSourceEnzyme,
    rdEnds: region.rdEnds,
  };
}

function fingerprintAssemblyOptimizationInput(
  input: AssemblyOptimizationInputWithoutFingerprint
): string {
  const canonical = stableJsonStringify(projectOptimizationProblemFingerprintInput(input));
  return `assembly-opt-v${ASSEMBLY_OPTIMIZATION_INPUT_SCHEMA_VERSION}:${stableTextHash(
    canonical
  )}:${canonical.length}`;
}

function projectOptimizationProblemFingerprintInput(
  input: AssemblyOptimizationInputWithoutFingerprint
): AssemblyOptimizationInputWithoutFingerprint {
  return {
    ...input,
    goldenGate: input.goldenGate
      ? {
          ...input.goldenGate,
          junctions: input.goldenGate.junctions.map(projectGoldenGateJunctionFingerprintInput),
        }
      : undefined,
  };
}

function projectGoldenGateJunctionFingerprintInput(
  junction: AssemblyOptimizationGoldenGateJunctionInput
): AssemblyOptimizationGoldenGateJunctionInput {
  if (junction.source.type !== 'pcr-designed') return junction;
  return {
    junctionIndex: junction.junctionIndex,
    junctionPosition: junction.junctionPosition,
    offset: 0,
    overhangStart: junction.junctionPosition - 2,
    overhangEnd: junction.junctionPosition + 2,
    overhang: '',
    source: junction.source,
  };
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

function normalizeStableJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeStableJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeStableJson(entry)])
  );
}

function stableTextHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
