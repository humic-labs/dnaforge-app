import type { AssemblySequenceRole } from './assembly-sequence-role';
import {
  canonicalCoordinateSemanticForSourceTerm,
  REFERENCE_SEMANTIC_VOCABULARY_REVISION,
  type CanonicalCoordinateSemantic,
} from './reference-semantic-vocabulary';

export const REFERENCE_SEMANTICS_V1 = 'dnaforge-reference-semantics.v1' as const;
export const REFERENCE_SEMANTIC_ADJUDICATION_REVISION = 1 as const;

export interface NormalizedReferenceIntervalV1 {
  readonly startBp: number;
  readonly endBp: number;
}

export type CentromereTopologyV1 = 'internal' | 'terminal-start' | 'terminal-end';

export type CytogeneticCentromereClassV1 =
  | 'metacentric'
  | 'submetacentric'
  | 'acrocentric'
  | 'telocentric';

export type CytogeneticShortArmSideV1 = 'start' | 'end';

export type ReferenceMoleculeClassV1 =
  | 'whole-chromosome'
  | 'chromosome-arm'
  | 'organelle'
  | 'scaffold'
  | 'generic-contig';

export type GenericDispositionReasonV1 =
  | 'missing-semantics'
  | 'ambiguous-evidence'
  | 'conflicting-evidence'
  | 'unsupported-architecture'
  | 'acentric'
  | 'ineligible-member';

export type ChromosomeMorphologyV1 =
  | Readonly<{
      kind: 'localized';
      interval: NormalizedReferenceIntervalV1;
      topology: CentromereTopologyV1;
    }>
  | Readonly<{
      kind: 'localized-boundary';
      positionBp: number;
      topology: CentromereTopologyV1;
    }>
  | Readonly<{
      kind: 'schematic';
      centromereClass: CytogeneticCentromereClassV1;
      shortArmAt: CytogeneticShortArmSideV1;
    }>
  | Readonly<{ kind: 'between-members'; groupId: string; side: 'left' | 'right' }>
  | Readonly<{ kind: 'holocentric' }>
  | Readonly<{ kind: 'unlocalized-centromere' }>
  | Readonly<{ kind: 'generic-contig'; reason: GenericDispositionReasonV1 }>;

export type CentromereArchitectureV1 = 'localized' | 'holocentric' | 'acentric' | 'unsupported';

export type ReferenceSemanticPropertyV1 = Readonly<{
  type: 'centromere-architecture';
  value: CentromereArchitectureV1;
  evidenceIds: readonly string[];
}>;

export type ReferenceSemanticFeatureV1 =
  | Readonly<{
      type: 'centromere-region';
      interval: NormalizedReferenceIntervalV1;
      topology: CentromereTopologyV1;
      evidenceIds: readonly string[];
    }>
  | Readonly<{
      type: 'centromere-boundary';
      positionBp: number;
      topology: CentromereTopologyV1;
      evidenceIds: readonly string[];
    }>
  | Readonly<{
      type: 'centromere-between-members';
      leftChrom: string;
      rightChrom: string;
      evidenceIds: readonly string[];
    }>
  | Readonly<{
      type: 'origin-of-replication';
      interval: NormalizedReferenceIntervalV1;
      evidenceIds: readonly string[];
    }>;

export interface ReferenceChromosomeGroupV1 {
  readonly id: string;
  readonly segmentIndex: number;
  readonly orientation: 'telomere-to-centromere' | 'centromere-to-telomere';
}

export interface ReferenceMemberSemanticsV1 {
  readonly chrom: string;
  readonly sourceSeqId: string;
  readonly lengthBp: number;
  readonly moleculeClass: ReferenceMoleculeClassV1;
  readonly chromosomeGroup?: ReferenceChromosomeGroupV1;
  readonly properties: readonly ReferenceSemanticPropertyV1[];
  readonly features: readonly ReferenceSemanticFeatureV1[];
  readonly morphology: ChromosomeMorphologyV1;
  readonly diagnostics: readonly string[];
}

export interface ReferenceSemanticsV1 {
  readonly contract: typeof REFERENCE_SEMANTICS_V1;
  readonly assemblyIdentitySha256: string;
  readonly vocabularyRevision: typeof REFERENCE_SEMANTIC_VOCABULARY_REVISION;
  readonly adjudicationRevision: typeof REFERENCE_SEMANTIC_ADJUDICATION_REVISION;
  readonly evidence: readonly SemanticEvidenceSourceV1[];
  readonly members: readonly ReferenceMemberSemanticsV1[];
}

export interface SemanticEvidenceSourceV1 {
  readonly id: string;
  readonly kind:
    | 'gff3-features'
    | 'insdc-features'
    | 'ncbi-assembly-gaps'
    | 'ncbi-ideogram'
    | 'ucsc-cytobands'
    | 'reviewed-assertion';
  readonly provider: string;
  readonly assemblyAccession: string;
  readonly sourceUrl: string;
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly mediaType?: string;
  readonly adapterContract: string;
}

interface OneBasedRecord {
  readonly start: number;
  readonly end: number;
}

export type ReferenceSemanticSourceV1 =
  | Readonly<{
      kind: 'gff3-features';
      evidenceId: string;
      records: ReadonlyArray<OneBasedRecord & { readonly type: string }>;
    }>
  | Readonly<{
      kind: 'insdc-features';
      evidenceId: string;
      records: ReadonlyArray<
        OneBasedRecord & {
          readonly key: string;
          readonly locationStatus: 'exact' | 'fuzzy' | 'compound';
        }
      >;
    }>
  | Readonly<{
      kind: 'ncbi-assembly-gaps';
      evidenceId: string;
      records: ReadonlyArray<OneBasedRecord & { readonly gapType: string }>;
    }>
  | Readonly<{
      kind: 'ncbi-ideogram-arms';
      evidenceId: string;
      records: ReadonlyArray<{
        readonly arm: 'p' | 'q';
        readonly start: number;
        readonly stop: number;
      }>;
    }>
  | Readonly<{
      kind: 'ucsc-cytobands';
      evidenceId: string;
      records: ReadonlyArray<{
        readonly start: number;
        readonly end: number;
        readonly stain: string;
      }>;
    }>
  | Readonly<{
      kind: 'reviewed-architecture';
      evidenceId: string;
      value: CentromereArchitectureV1;
    }>
  | Readonly<{
      kind: 'reviewed-centromere-topology';
      evidenceId: string;
      topology: CentromereTopologyV1;
    }>
  | Readonly<{
      kind: 'reviewed-centromere-region';
      evidenceId: string;
      interval: NormalizedReferenceIntervalV1;
    }>
  | Readonly<{
      kind: 'reviewed-cytogenetic-morphology';
      evidenceId: string;
      centromereClass: CytogeneticCentromereClassV1;
      shortArmAt: CytogeneticShortArmSideV1;
    }>
  | Readonly<{
      kind: 'reviewed-chromosome-arm';
      evidenceId: string;
      groupId: string;
      segmentIndex: number;
      orientation: ReferenceChromosomeGroupV1['orientation'];
    }>;

export interface ReconcileReferenceMemberSemanticsInput {
  readonly chrom: string;
  readonly sourceSeqId: string;
  readonly lengthBp: number;
  readonly role: AssemblySequenceRole | undefined;
  readonly circular: boolean | undefined;
  readonly moleculeClass: ReferenceMoleculeClassV1;
  readonly sources: readonly ReferenceSemanticSourceV1[];
}

interface CandidateFeature {
  readonly type: CanonicalCoordinateSemantic;
  readonly interval: NormalizedReferenceIntervalV1;
  readonly evidenceId: string;
}

interface CandidateBoundary {
  readonly positionBp: number;
  readonly topology: CentromereTopologyV1;
  readonly evidenceId: string;
}

interface CollectedCandidates {
  readonly coordinateFeatures: CandidateFeature[];
  readonly boundaries: CandidateBoundary[];
  readonly architectures: Array<{
    readonly value: CentromereArchitectureV1;
    readonly evidenceId: string;
  }>;
  readonly topologies: Array<{
    readonly topology: CentromereTopologyV1;
    readonly evidenceId: string;
  }>;
  readonly cytogeneticMorphologies: Array<{
    readonly centromereClass: CytogeneticCentromereClassV1;
    readonly shortArmAt: CytogeneticShortArmSideV1;
    readonly evidenceId: string;
  }>;
  readonly groups: Array<{
    readonly groupId: string;
    readonly segmentIndex: number;
    readonly orientation: ReferenceChromosomeGroupV1['orientation'];
    readonly evidenceId: string;
  }>;
  readonly diagnostics: string[];
}

export function reconcileReferenceMemberSemantics(
  input: ReconcileReferenceMemberSemanticsInput
): ReferenceMemberSemanticsV1 {
  const candidates = collectCandidates(input.sources, input.lengthBp);
  const base = {
    chrom: input.chrom,
    sourceSeqId: input.sourceSeqId,
    lengthBp: input.lengthBp,
    moleculeClass: input.moleculeClass,
  } as const;
  const coordinateFeatures = reconcileCoordinateFeatures(
    candidates.coordinateFeatures,
    input.lengthBp
  );
  const boundaryFeatures = reconcileBoundaryFeatures(candidates.boundaries);
  const diagnostics = [
    ...candidates.diagnostics,
    ...coordinateFeatures.diagnostics,
    ...boundaryFeatures.diagnostics,
  ];
  const features: ReferenceSemanticFeatureV1[] = [...coordinateFeatures.origins];
  const topologyValues = unique(candidates.topologies.map(({ topology }) => topology));

  if (!eligibleForChromosomeMorphology(input)) {
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'ineligible-member' },
      diagnostics,
    };
  }

  const architectureValues = unique(candidates.architectures.map(({ value }) => value));
  const groupValues = uniqueBy(candidates.groups, groupKey);
  const cytogeneticValues = uniqueBy(candidates.cytogeneticMorphologies, cytogeneticKey);
  if (
    architectureValues.length > 1 ||
    topologyValues.length > 1 ||
    groupValues.length > 1 ||
    cytogeneticValues.length > 1 ||
    (groupValues.length === 1 &&
      (coordinateFeatures.centromere !== null ||
        boundaryFeatures.centromere !== null ||
        architectureValues.length > 0)) ||
    (cytogeneticValues.length === 1 &&
      (groupValues.length > 0 ||
        coordinateFeatures.centromere !== null ||
        boundaryFeatures.centromere !== null ||
        topologyValues.length > 0))
  ) {
    const cytogeneticConflict = cytogeneticValues.length > 1;
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'conflicting-evidence' },
      diagnostics: [
        ...diagnostics,
        cytogeneticConflict
          ? 'conflicting-cytogenetic-morphology'
          : 'conflicting-centromere-architecture',
      ],
    };
  }

  if (coordinateFeatures.centromereConflict) {
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'conflicting-evidence' },
      diagnostics: [...diagnostics, 'conflicting-centromere-regions'],
    };
  }

  if (
    boundaryFeatures.centromereConflict ||
    (boundaryFeatures.centromere !== null && coordinateFeatures.centromere !== null)
  ) {
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'conflicting-evidence' },
      diagnostics: [...diagnostics, 'conflicting-centromere-boundaries'],
    };
  }

  if (
    topologyValues.length === 1 &&
    coordinateFeatures.centromere === null &&
    boundaryFeatures.centromere === null
  ) {
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'ambiguous-evidence' },
      diagnostics: [...diagnostics, 'topology-without-centromere-region'],
    };
  }

  if (
    diagnostics.includes('ambiguous-centromere-location') ||
    diagnostics.includes('ambiguous-centromere-boundary')
  ) {
    return {
      ...base,
      properties: [],
      features,
      morphology: { kind: 'generic-contig', reason: 'ambiguous-evidence' },
      diagnostics,
    };
  }

  const group = groupValues[0];
  if (group) {
    return {
      ...base,
      chromosomeGroup: withoutEvidenceId(group),
      properties: [],
      features,
      morphology: {
        kind: 'between-members',
        groupId: group.groupId,
        side: group.orientation === 'telomere-to-centromere' ? 'right' : 'left',
      },
      diagnostics,
    };
  }

  const cytogenetic = cytogeneticValues[0];
  if (cytogenetic) {
    const evidenceIds = sortedUnique(
      candidates.cytogeneticMorphologies
        .filter((candidate) => cytogeneticKey(candidate) === cytogeneticKey(cytogenetic))
        .map(({ evidenceId }) => evidenceId)
    );
    return {
      ...base,
      properties: [
        {
          type: 'centromere-architecture',
          value: 'localized',
          evidenceIds,
        },
      ],
      features,
      morphology: {
        kind: 'schematic',
        centromereClass: cytogenetic.centromereClass,
        shortArmAt: cytogenetic.shortArmAt,
      },
      diagnostics,
    };
  }

  const architecture = architectureValues[0];
  const architectureEvidenceIds = sortedUnique(
    candidates.architectures
      .filter((candidate) => candidate.value === architecture)
      .map(({ evidenceId }) => evidenceId)
  );
  if (architecture === 'holocentric') {
    if (coordinateFeatures.centromere || boundaryFeatures.centromere) {
      return {
        ...base,
        properties: [],
        features,
        morphology: { kind: 'generic-contig', reason: 'conflicting-evidence' },
        diagnostics: [...diagnostics, 'conflicting-centromere-architecture'],
      };
    }
    return {
      ...base,
      properties: [
        {
          type: 'centromere-architecture',
          value: architecture,
          evidenceIds: architectureEvidenceIds,
        },
      ],
      features,
      morphology: { kind: 'holocentric' },
      diagnostics,
    };
  }
  if (architecture === 'acentric' || architecture === 'unsupported') {
    return {
      ...base,
      properties: [
        {
          type: 'centromere-architecture',
          value: architecture,
          evidenceIds: architectureEvidenceIds,
        },
      ],
      features,
      morphology: {
        kind: 'generic-contig',
        reason: architecture === 'acentric' ? 'acentric' : 'unsupported-architecture',
      },
      diagnostics,
    };
  }

  if (boundaryFeatures.centromere) {
    const centromere = boundaryFeatures.centromere;
    const propertyEvidenceIds = sortedUnique([
      ...architectureEvidenceIds,
      ...centromere.evidenceIds,
    ]);
    features.push(centromere);
    return {
      ...base,
      properties: [
        { type: 'centromere-architecture', value: 'localized', evidenceIds: propertyEvidenceIds },
      ],
      features,
      morphology: {
        kind: 'localized-boundary',
        positionBp: centromere.positionBp,
        topology: centromere.topology,
      },
      diagnostics,
    };
  }

  if (coordinateFeatures.centromere) {
    const centromere = topologyValues[0]
      ? {
          ...coordinateFeatures.centromere,
          topology: topologyValues[0],
          evidenceIds: sortedUnique([
            ...coordinateFeatures.centromere.evidenceIds,
            ...candidates.topologies.map(({ evidenceId }) => evidenceId),
          ]),
        }
      : coordinateFeatures.centromere;
    const propertyEvidenceIds = sortedUnique([
      ...architectureEvidenceIds,
      ...centromere.evidenceIds,
    ]);
    features.push(centromere);
    return {
      ...base,
      properties: [
        { type: 'centromere-architecture', value: 'localized', evidenceIds: propertyEvidenceIds },
      ],
      features,
      morphology: {
        kind: 'localized',
        interval: centromere.interval,
        topology: centromere.topology,
      },
      diagnostics,
    };
  }

  return {
    ...base,
    properties:
      architecture === 'localized'
        ? [
            {
              type: 'centromere-architecture',
              value: architecture,
              evidenceIds: architectureEvidenceIds,
            },
          ]
        : [],
    features,
    morphology:
      architecture === 'localized' && input.moleculeClass === 'whole-chromosome'
        ? { kind: 'unlocalized-centromere' }
        : { kind: 'generic-contig', reason: 'missing-semantics' },
    diagnostics,
  };
}

export function assertReferenceSemanticGroupIntegrityV1(
  members: readonly ReferenceMemberSemanticsV1[]
): void {
  const grouped = new Map<string, Array<{ index: number; member: ReferenceMemberSemanticsV1 }>>();
  for (const [index, member] of members.entries()) {
    if (member.morphology.kind === 'between-members' && !member.chromosomeGroup) {
      throwIncompleteChromosomeGroup(member.morphology.groupId);
    }
    if (!member.chromosomeGroup) continue;
    if (
      member.morphology.kind !== 'between-members' ||
      member.morphology.groupId !== member.chromosomeGroup.id
    ) {
      throwIncompleteChromosomeGroup(member.chromosomeGroup.id);
    }
    const group = grouped.get(member.chromosomeGroup.id) ?? [];
    group.push({ index, member });
    grouped.set(member.chromosomeGroup.id, group);
  }

  for (const [groupId, group] of grouped) {
    if (group.length !== 2) throwIncompleteChromosomeGroup(groupId);
    const ordered = [...group].sort((left, right) => {
      const leftGroup = left.member.chromosomeGroup;
      const rightGroup = right.member.chromosomeGroup;
      if (!leftGroup || !rightGroup) throwIncompleteChromosomeGroup(groupId);
      return leftGroup.segmentIndex - rightGroup.segmentIndex;
    });
    const [left, right] = ordered;
    const leftGroup = left.member.chromosomeGroup;
    const rightGroup = right.member.chromosomeGroup;
    if (
      !leftGroup ||
      !rightGroup ||
      left.index + 1 !== right.index ||
      leftGroup.segmentIndex !== 0 ||
      rightGroup.segmentIndex !== 1 ||
      leftGroup.orientation !== 'telomere-to-centromere' ||
      rightGroup.orientation !== 'centromere-to-telomere' ||
      left.member.morphology.kind !== 'between-members' ||
      left.member.morphology.side !== 'right' ||
      right.member.morphology.kind !== 'between-members' ||
      right.member.morphology.side !== 'left'
    ) {
      throwIncompleteChromosomeGroup(groupId);
    }
  }
}

function throwIncompleteChromosomeGroup(groupId: string): never {
  throw new Error(`Semantic chromosome-arm group ${groupId} is not a complete adjacent pair.`);
}

function collectCandidates(
  sources: readonly ReferenceSemanticSourceV1[],
  lengthBp: number
): CollectedCandidates {
  const coordinateFeatures: CandidateFeature[] = [];
  const boundaries: CandidateBoundary[] = [];
  const architectures: CollectedCandidates['architectures'] = [];
  const topologies: CollectedCandidates['topologies'] = [];
  const cytogeneticMorphologies: CollectedCandidates['cytogeneticMorphologies'] = [];
  const groups: CollectedCandidates['groups'] = [];
  const diagnostics: string[] = [];

  for (const source of sources) {
    if (source.kind === 'reviewed-architecture') {
      architectures.push({ value: source.value, evidenceId: source.evidenceId });
      continue;
    }
    if (source.kind === 'reviewed-centromere-topology') {
      topologies.push({ topology: source.topology, evidenceId: source.evidenceId });
      continue;
    }
    if (source.kind === 'reviewed-cytogenetic-morphology') {
      cytogeneticMorphologies.push({
        centromereClass: source.centromereClass,
        shortArmAt: source.shortArmAt,
        evidenceId: source.evidenceId,
      });
      architectures.push({ value: 'localized', evidenceId: source.evidenceId });
      continue;
    }
    if (source.kind === 'reviewed-chromosome-arm') {
      if (
        source.groupId.length > 0 &&
        Number.isSafeInteger(source.segmentIndex) &&
        source.segmentIndex >= 0
      ) {
        groups.push({
          groupId: source.groupId,
          segmentIndex: source.segmentIndex,
          orientation: source.orientation,
          evidenceId: source.evidenceId,
        });
      } else {
        diagnostics.push('invalid-chromosome-group');
      }
      continue;
    }
    if (source.kind === 'ncbi-ideogram-arms') {
      const boundary = boundaryFromNcbiIdeogramArms(source.records, lengthBp, source.evidenceId);
      if (boundary) boundaries.push(boundary);
      else diagnostics.push('ambiguous-centromere-boundary');
      continue;
    }

    const sourceCoordinates: CandidateFeature[] = [];
    if (source.kind === 'reviewed-centromere-region') {
      pushCoordinateCandidate(
        sourceCoordinates,
        'centromere-region',
        source.interval,
        source.evidenceId,
        lengthBp,
        diagnostics
      );
    } else if (source.kind === 'ucsc-cytobands') {
      for (const record of source.records) {
        if (record.stain !== 'acen') continue;
        pushCoordinateCandidate(
          sourceCoordinates,
          'centromere-region',
          { startBp: record.start, endBp: record.end },
          source.evidenceId,
          lengthBp,
          diagnostics
        );
      }
    } else if (source.kind === 'ncbi-assembly-gaps') {
      for (const record of source.records) {
        if (record.gapType !== 'centromere') continue;
        pushOneBasedCandidate(
          sourceCoordinates,
          'centromere-region',
          record,
          source.evidenceId,
          lengthBp,
          diagnostics
        );
      }
    } else if (source.kind === 'gff3-features') {
      for (const record of source.records) {
        const semantic = canonicalCoordinateSemanticForSourceTerm(record.type);
        if (!semantic) continue;
        pushOneBasedCandidate(
          sourceCoordinates,
          semantic,
          record,
          source.evidenceId,
          lengthBp,
          diagnostics
        );
      }
    } else {
      for (const record of source.records) {
        const semantic = canonicalCoordinateSemanticForSourceTerm(record.key);
        if (!semantic) continue;
        if (record.locationStatus !== 'exact') {
          if (semantic === 'centromere-region') diagnostics.push('ambiguous-centromere-location');
          continue;
        }
        pushOneBasedCandidate(
          sourceCoordinates,
          semantic,
          record,
          source.evidenceId,
          lengthBp,
          diagnostics
        );
      }
    }
    coordinateFeatures.push(...mergeWithinSource(sourceCoordinates));
  }
  return {
    coordinateFeatures,
    boundaries,
    architectures,
    topologies,
    cytogeneticMorphologies,
    groups,
    diagnostics: sortedUnique(diagnostics),
  };
}

function boundaryFromNcbiIdeogramArms(
  records: ReadonlyArray<{
    readonly arm: 'p' | 'q';
    readonly start: number;
    readonly stop: number;
  }>,
  lengthBp: number,
  evidenceId: string
): CandidateBoundary | null {
  if (evidenceId.length === 0 || !Number.isSafeInteger(lengthBp) || lengthBp <= 0) return null;
  if (
    records.some(
      ({ start, stop }) =>
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(stop) ||
        start < 0 ||
        stop < start ||
        stop > lengthBp
    )
  ) {
    return null;
  }
  const pArms = records.filter(({ arm }) => arm === 'p');
  const qArms = records.filter(({ arm }) => arm === 'q');
  const reachesEnd = (stop: number) => stop === lengthBp - 1 || stop === lengthBp;
  if (pArms.length === 1 && qArms.length === 1 && records.length === 2) {
    const [p] = pArms;
    const [q] = qArms;
    if (p.start !== 0 || !reachesEnd(q.stop) || p.stop !== q.start) return null;
    if (p.stop <= 0 || p.stop >= lengthBp) return null;
    return { positionBp: p.stop, topology: 'internal', evidenceId };
  }
  if (pArms.length === 0 && qArms.length === 1 && records.length === 1) {
    const [q] = qArms;
    if (q.start !== 0 || !reachesEnd(q.stop)) return null;
    return { positionBp: 0, topology: 'terminal-start', evidenceId };
  }
  if (pArms.length === 1 && qArms.length === 0 && records.length === 1) {
    const [p] = pArms;
    if (p.start !== 0 || !reachesEnd(p.stop)) return null;
    return { positionBp: lengthBp, topology: 'terminal-end', evidenceId };
  }
  return null;
}

function pushOneBasedCandidate(
  candidates: CandidateFeature[],
  type: CanonicalCoordinateSemantic,
  record: OneBasedRecord,
  evidenceId: string,
  lengthBp: number,
  diagnostics: string[]
): void {
  pushCoordinateCandidate(
    candidates,
    type,
    { startBp: record.start - 1, endBp: record.end },
    evidenceId,
    lengthBp,
    diagnostics
  );
}

function pushCoordinateCandidate(
  candidates: CandidateFeature[],
  type: CanonicalCoordinateSemantic,
  interval: NormalizedReferenceIntervalV1,
  evidenceId: string,
  lengthBp: number,
  diagnostics: string[]
): void {
  if (!validInterval(interval, lengthBp) || evidenceId.length === 0) {
    diagnostics.push(type === 'centromere-region' ? 'invalid-centromere-region' : 'invalid-origin');
    return;
  }
  candidates.push({ type, interval, evidenceId });
}

function mergeWithinSource(candidates: readonly CandidateFeature[]): CandidateFeature[] {
  const merged: CandidateFeature[] = [];
  for (const type of ['centromere-region', 'origin-of-replication'] as const) {
    const ordered = candidates
      .filter((candidate) => candidate.type === type)
      .sort(
        (left, right) =>
          left.interval.startBp - right.interval.startBp ||
          left.interval.endBp - right.interval.endBp
      );
    for (const candidate of ordered) {
      const previous = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (
        previous?.type === type &&
        previous.evidenceId === candidate.evidenceId &&
        candidate.interval.startBp <= previous.interval.endBp
      ) {
        merged[merged.length - 1] = {
          ...previous,
          interval: {
            startBp: previous.interval.startBp,
            endBp: Math.max(previous.interval.endBp, candidate.interval.endBp),
          },
        };
      } else {
        merged.push(candidate);
      }
    }
  }
  return merged;
}

function reconcileCoordinateFeatures(
  candidates: readonly CandidateFeature[],
  memberLengthBp: number
): {
  readonly centromere: Extract<ReferenceSemanticFeatureV1, { type: 'centromere-region' }> | null;
  readonly centromereConflict: boolean;
  readonly origins: Array<Extract<ReferenceSemanticFeatureV1, { type: 'origin-of-replication' }>>;
  readonly diagnostics: string[];
} {
  const centromeres = groupEquivalentCandidates(
    candidates.filter((candidate) => candidate.type === 'centromere-region')
  );
  const origins = groupEquivalentCandidates(
    candidates.filter((candidate) => candidate.type === 'origin-of-replication')
  ).map(({ interval, evidenceIds }) => ({
    type: 'origin-of-replication' as const,
    interval,
    evidenceIds,
  }));
  const centromere = centromeres[0];
  return {
    centromere:
      centromeres.length === 1
        ? {
            type: 'centromere-region',
            interval: centromere.interval,
            topology: topologyForInterval(centromere.interval, memberLengthBp),
            evidenceIds: centromere.evidenceIds,
          }
        : null,
    centromereConflict: centromeres.length > 1,
    origins,
    diagnostics: [],
  };
}

function reconcileBoundaryFeatures(candidates: readonly CandidateBoundary[]): {
  readonly centromere: Extract<ReferenceSemanticFeatureV1, { type: 'centromere-boundary' }> | null;
  readonly centromereConflict: boolean;
  readonly diagnostics: string[];
} {
  const grouped = new Map<string, CandidateBoundary[]>();
  for (const candidate of candidates) {
    const key = `${candidate.positionBp}:${candidate.topology}`;
    const values = grouped.get(key) ?? [];
    values.push(candidate);
    grouped.set(key, values);
  }
  const groups = [...grouped.values()];
  const first = groups[0]?.[0];
  return {
    centromere:
      groups.length === 1 && first
        ? {
            type: 'centromere-boundary',
            positionBp: first.positionBp,
            topology: first.topology,
            evidenceIds: sortedUnique(groups[0].map(({ evidenceId }) => evidenceId)),
          }
        : null,
    centromereConflict: groups.length > 1,
    diagnostics: [],
  };
}

function topologyForInterval(
  interval: NormalizedReferenceIntervalV1,
  memberLengthBp: number
): CentromereTopologyV1 {
  if (interval.startBp === 0) return 'terminal-start';
  if (interval.endBp === memberLengthBp) return 'terminal-end';
  return 'internal';
}

function groupEquivalentCandidates(candidates: readonly CandidateFeature[]): Array<{
  readonly interval: NormalizedReferenceIntervalV1;
  readonly evidenceIds: readonly string[];
}> {
  const grouped = new Map<
    string,
    { interval: NormalizedReferenceIntervalV1; evidenceIds: string[] }
  >();
  for (const candidate of candidates) {
    const key = `${candidate.interval.startBp}:${candidate.interval.endBp}`;
    const existing = grouped.get(key);
    if (existing) existing.evidenceIds.push(candidate.evidenceId);
    else grouped.set(key, { interval: candidate.interval, evidenceIds: [candidate.evidenceId] });
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, evidenceIds: sortedUnique(group.evidenceIds) }))
    .sort(
      (left, right) =>
        left.interval.startBp - right.interval.startBp || left.interval.endBp - right.interval.endBp
    );
}

function eligibleForChromosomeMorphology(input: ReconcileReferenceMemberSemanticsInput): boolean {
  return (
    input.role === 'assembled-molecule' &&
    input.circular !== true &&
    (input.moleculeClass === 'whole-chromosome' || input.moleculeClass === 'chromosome-arm') &&
    Number.isSafeInteger(input.lengthBp) &&
    input.lengthBp > 0
  );
}

function validInterval(interval: NormalizedReferenceIntervalV1, lengthBp: number): boolean {
  return (
    Number.isSafeInteger(interval.startBp) &&
    Number.isSafeInteger(interval.endBp) &&
    interval.startBp >= 0 &&
    interval.endBp <= lengthBp &&
    interval.endBp > interval.startBp
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(key(value), value);
  return [...byKey.values()];
}

function groupKey(group: {
  readonly groupId: string;
  readonly segmentIndex: number;
  readonly orientation: ReferenceChromosomeGroupV1['orientation'];
}): string {
  return `${group.groupId}:${group.segmentIndex}:${group.orientation}`;
}

function cytogeneticKey(morphology: {
  readonly centromereClass: CytogeneticCentromereClassV1;
  readonly shortArmAt: CytogeneticShortArmSideV1;
}): string {
  return `${morphology.centromereClass}:${morphology.shortArmAt}`;
}

function withoutEvidenceId(group: {
  readonly groupId: string;
  readonly segmentIndex: number;
  readonly orientation: ReferenceChromosomeGroupV1['orientation'];
  readonly evidenceId: string;
}): ReferenceChromosomeGroupV1 {
  return { id: group.groupId, segmentIndex: group.segmentIndex, orientation: group.orientation };
}
