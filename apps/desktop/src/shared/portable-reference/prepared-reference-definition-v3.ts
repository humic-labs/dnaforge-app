import { sha256Hex } from '../sha256-sync';

import {
  assertReferenceSemanticGroupIntegrityV1,
  REFERENCE_SEMANTICS_V1,
  REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
  REFERENCE_SEMANTIC_VOCABULARY_REVISION,
  type CentromereArchitectureV1,
  type CentromereTopologyV1,
  type ChromosomeMorphologyV1,
  type CytogeneticCentromereClassV1,
  type CytogeneticShortArmSideV1,
  type GenericDispositionReasonV1,
  type ReferenceMemberSemanticsV1,
  type ReferenceMoleculeClassV1,
  type ReferenceSemanticFeatureV1,
  type ReferenceSemanticPropertyV1,
  type ReferenceSemanticsV1,
  type SemanticEvidenceSourceV1,
} from '@waypoint/genome-data';

export { assertReferenceSemanticGroupIntegrityV1 };

import type { ReferenceAssemblyEntry } from '../../features/sequence/reference-catalog';
import {
  PREPARED_REFERENCE_DEFINITION_V2,
  type PreparedReferenceDefinitionV2,
  parsePreparedReferenceDefinitionV2,
  preparedReferenceAssemblyEntryV2,
} from './prepared-reference-definition-v2';
import {
  assertOnlyKeys,
  optionalPositiveInteger,
  optionalText,
  requireContractToken,
  requireDigest,
  requirePositiveInteger,
  requireRecord,
  requireSafeId,
  requireText,
} from './reference-preparation-validation';

export const PREPARED_REFERENCE_DEFINITION_V3 =
  'dnaforge-prepared-reference-definition.v3' as const;
export const REFERENCE_PREPARATION_PIPELINE_REVISION_V3 = 3 as const;

const SHA256 = /^[0-9a-f]{64}$/i;
const EVIDENCE_KINDS = new Set<SemanticEvidenceSourceV1['kind']>([
  'gff3-features',
  'insdc-features',
  'ncbi-assembly-gaps',
  'ncbi-ideogram',
  'ucsc-cytobands',
  'reviewed-assertion',
]);
const MOLECULE_CLASSES = new Set<ReferenceMoleculeClassV1>([
  'whole-chromosome',
  'chromosome-arm',
  'organelle',
  'scaffold',
  'generic-contig',
]);
const ARCHITECTURES = new Set<CentromereArchitectureV1>([
  'localized',
  'holocentric',
  'acentric',
  'unsupported',
]);
const TOPOLOGIES = new Set<CentromereTopologyV1>(['internal', 'terminal-start', 'terminal-end']);
const CYTOGENETIC_CLASSES = new Set<CytogeneticCentromereClassV1>([
  'metacentric',
  'submetacentric',
  'acrocentric',
  'telocentric',
]);
const CYTOGENETIC_SHORT_ARM_SIDES = new Set<CytogeneticShortArmSideV1>(['start', 'end']);
const GENERIC_REASONS = new Set<GenericDispositionReasonV1>([
  'missing-semantics',
  'ambiguous-evidence',
  'conflicting-evidence',
  'unsupported-architecture',
  'acentric',
  'ineligible-member',
]);

export interface PreparedReferenceDefinitionV3 extends Omit<
  PreparedReferenceDefinitionV2,
  'contract' | 'pipelineRevision'
> {
  readonly contract: typeof PREPARED_REFERENCE_DEFINITION_V3;
  readonly pipelineRevision: typeof REFERENCE_PREPARATION_PIPELINE_REVISION_V3;
  readonly semanticDigestSha256: string;
  readonly semantics: ReferenceSemanticsV1;
}

export function preparedReferenceDefinitionV3(
  base: PreparedReferenceDefinitionV2,
  semantics: ReferenceSemanticsV1
): PreparedReferenceDefinitionV3 {
  const parsedSemantics = parseReferenceSemanticsV1(
    semantics,
    base.members,
    base.assemblyIdentity.sha256
  );
  return {
    ...base,
    contract: PREPARED_REFERENCE_DEFINITION_V3,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
    semanticDigestSha256: referenceSemanticsSha256V1(parsedSemantics),
    semantics: parsedSemantics,
  };
}

export function parsePreparedReferenceDefinitionV3(
  value: unknown,
  expectedAssetCacheKey?: string
): PreparedReferenceDefinitionV3 {
  const root = requireRecord(value, 'prepared reference definition');
  assertOnlyKeys(
    root,
    [
      'contract',
      'pipelineRevision',
      'id',
      'name',
      'organism',
      'taxId',
      'assembly',
      'description',
      'assetCacheKey',
      'assemblyIdentity',
      'source',
      'provenance',
      'members',
      'semanticDigestSha256',
      'semantics',
    ],
    'prepared reference definition'
  );
  if (root.contract !== PREPARED_REFERENCE_DEFINITION_V3) {
    throw new Error(
      `prepared reference definition.contract must be "${PREPARED_REFERENCE_DEFINITION_V3}".`
    );
  }
  if (root.pipelineRevision !== REFERENCE_PREPARATION_PIPELINE_REVISION_V3) {
    throw new Error(
      `prepared reference definition.pipelineRevision must be ${REFERENCE_PREPARATION_PIPELINE_REVISION_V3}.`
    );
  }
  if (root.semantics === undefined) {
    throw new Error('prepared reference definition.semantics is required.');
  }

  const v2Like: Record<string, unknown> = {
    ...root,
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: 2,
  };
  delete v2Like.semanticDigestSha256;
  delete v2Like.semantics;
  const base = parsePreparedReferenceDefinitionV2(v2Like, expectedAssetCacheKey, 'cache-key');
  const semantics = parseReferenceSemanticsV1(
    root.semantics,
    base.members,
    base.assemblyIdentity.sha256
  );
  const semanticDigestSha256 = requireDigest(
    root.semanticDigestSha256,
    SHA256,
    'prepared reference definition.semanticDigestSha256'
  );
  if (semanticDigestSha256 !== referenceSemanticsSha256V1(semantics)) {
    throw new Error('prepared reference definition semantic digest does not match its semantics.');
  }
  return {
    ...base,
    contract: PREPARED_REFERENCE_DEFINITION_V3,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
    semanticDigestSha256,
    semantics,
  };
}

export function preparedReferenceAssemblyEntryV3(
  definition: PreparedReferenceDefinitionV3
): ReferenceAssemblyEntry {
  const base = preparedReferenceAssemblyEntryV2({
    ...definition,
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: 2,
  });
  return {
    ...base,
    members: base.members.map((member, index) => ({
      ...member,
      morphology: definition.semantics.members[index].morphology,
    })),
  };
}

export function referenceSemanticsSha256V1(semantics: ReferenceSemanticsV1): string {
  return sha256Hex(`${REFERENCE_SEMANTICS_V1}\0`, JSON.stringify(semantics));
}

function parseReferenceSemanticsV1(
  value: unknown,
  members: PreparedReferenceDefinitionV2['members'],
  assemblyIdentitySha256: string
): ReferenceSemanticsV1 {
  const root = requireRecord(value, 'prepared reference definition.semantics');
  assertOnlyKeys(
    root,
    [
      'contract',
      'assemblyIdentitySha256',
      'vocabularyRevision',
      'adjudicationRevision',
      'evidence',
      'members',
    ],
    'prepared reference definition.semantics'
  );
  if (root.contract !== REFERENCE_SEMANTICS_V1) {
    throw new Error(
      `prepared reference definition.semantics.contract must be "${REFERENCE_SEMANTICS_V1}".`
    );
  }
  const declaredIdentity = requireDigest(
    root.assemblyIdentitySha256,
    SHA256,
    'prepared reference definition.semantics.assemblyIdentitySha256'
  );
  if (declaredIdentity !== assemblyIdentitySha256) {
    throw new Error('prepared reference definition semantics assembly identity does not match.');
  }
  if (root.vocabularyRevision !== REFERENCE_SEMANTIC_VOCABULARY_REVISION) {
    throw new Error('prepared reference definition semantics vocabulary revision is unsupported.');
  }
  if (root.adjudicationRevision !== REFERENCE_SEMANTIC_ADJUDICATION_REVISION) {
    throw new Error(
      'prepared reference definition semantics adjudication revision is unsupported.'
    );
  }
  const evidence = parseEvidence(root.evidence);
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  if (!Array.isArray(root.members) || root.members.length !== members.length) {
    throw new Error('prepared reference definition semantics member binding is incomplete.');
  }
  const parsedMembers = root.members.map((raw, index) =>
    parseSemanticMember(raw, members[index], evidenceIds, index)
  );
  assertReferenceSemanticGroupIntegrityV1(parsedMembers);
  return {
    contract: REFERENCE_SEMANTICS_V1,
    assemblyIdentitySha256: declaredIdentity,
    vocabularyRevision: REFERENCE_SEMANTIC_VOCABULARY_REVISION,
    adjudicationRevision: REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
    evidence,
    members: parsedMembers,
  };
}

function parseEvidence(value: unknown): SemanticEvidenceSourceV1[] {
  if (!Array.isArray(value)) {
    throw new Error('prepared reference definition.semantics.evidence must be an array.');
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const label = `prepared reference definition.semantics.evidence[${index}]`;
    const record = requireRecord(raw, label);
    assertOnlyKeys(
      record,
      [
        'id',
        'kind',
        'provider',
        'assemblyAccession',
        'sourceUrl',
        'sha256',
        'byteLength',
        'mediaType',
        'adapterContract',
      ],
      label
    );
    const id = requireSafeId(record.id, `${label}.id`);
    if (seen.has(id)) throw new Error(`${label}.id duplicates evidence "${id}".`);
    seen.add(id);
    if (
      typeof record.kind !== 'string' ||
      !EVIDENCE_KINDS.has(record.kind as SemanticEvidenceSourceV1['kind'])
    ) {
      throw new Error(`${label}.kind is unsupported.`);
    }
    const sourceUrl = requireText(record.sourceUrl, `${label}.sourceUrl`);
    if (!URL.canParse(sourceUrl) || !sourceUrl.startsWith('https://')) {
      throw new Error(`${label}.sourceUrl must be an HTTPS URL.`);
    }
    return {
      id,
      kind: record.kind as SemanticEvidenceSourceV1['kind'],
      provider: requireText(record.provider, `${label}.provider`),
      assemblyAccession: requireText(record.assemblyAccession, `${label}.assemblyAccession`),
      sourceUrl,
      sha256:
        record.sha256 === undefined
          ? undefined
          : requireDigest(record.sha256, SHA256, `${label}.sha256`),
      byteLength: optionalPositiveInteger(record.byteLength, `${label}.byteLength`),
      mediaType: optionalText(record.mediaType, `${label}.mediaType`),
      adapterContract: requireContractToken(record.adapterContract, `${label}.adapterContract`),
    };
  });
}

function parseSemanticMember(
  value: unknown,
  boundMember: PreparedReferenceDefinitionV2['members'][number],
  evidenceIds: ReadonlySet<string>,
  index: number
): ReferenceMemberSemanticsV1 {
  const label = `prepared reference definition.semantics.members[${index}]`;
  const record = requireRecord(value, label);
  assertOnlyKeys(
    record,
    [
      'chrom',
      'sourceSeqId',
      'lengthBp',
      'moleculeClass',
      'chromosomeGroup',
      'properties',
      'features',
      'morphology',
      'diagnostics',
    ],
    label
  );
  const chrom = requireSafeId(record.chrom, `${label}.chrom`);
  const sourceSeqId = requireText(record.sourceSeqId, `${label}.sourceSeqId`);
  const lengthBp = requirePositiveInteger(record.lengthBp, `${label}.lengthBp`);
  if (
    chrom !== boundMember.chrom ||
    sourceSeqId !== boundMember.sourceSeqId ||
    lengthBp !== boundMember.lengthBp
  ) {
    throw new Error(`${label} member binding does not match the prepared member.`);
  }
  if (
    typeof record.moleculeClass !== 'string' ||
    !MOLECULE_CLASSES.has(record.moleculeClass as ReferenceMoleculeClassV1)
  ) {
    throw new Error(`${label}.moleculeClass is unsupported.`);
  }
  const chromosomeGroup = parseChromosomeGroup(record.chromosomeGroup, label);
  const properties = parseProperties(record.properties, evidenceIds, label);
  const features = parseFeatures(record.features, evidenceIds, label, lengthBp);
  const morphology = parseMorphology(record.morphology, label, lengthBp);
  const diagnostics = parseTextArray(record.diagnostics, `${label}.diagnostics`);
  if (
    morphology.kind === 'holocentric' &&
    !properties.some(
      (property) => property.type === 'centromere-architecture' && property.value === 'holocentric'
    )
  ) {
    throw new Error(`${label}.morphology holocentric requires a matching architecture property.`);
  }
  if (morphology.kind === 'between-members' && chromosomeGroup?.id !== morphology.groupId) {
    throw new Error(`${label}.morphology between-members requires a matching chromosome group.`);
  }
  if (
    morphology.kind === 'localized' &&
    !features.some(
      (feature) =>
        feature.type === 'centromere-region' &&
        feature.interval.startBp === morphology.interval.startBp &&
        feature.interval.endBp === morphology.interval.endBp &&
        feature.topology === morphology.topology
    )
  ) {
    throw new Error(`${label}.morphology localized requires a matching centromere feature.`);
  }
  if (
    morphology.kind === 'localized-boundary' &&
    !features.some(
      (feature) =>
        feature.type === 'centromere-boundary' &&
        feature.positionBp === morphology.positionBp &&
        feature.topology === morphology.topology
    )
  ) {
    throw new Error(
      `${label}.morphology localized-boundary requires a matching centromere feature.`
    );
  }
  const architectureValues = new Set(
    properties
      .filter((property) => property.type === 'centromere-architecture')
      .map((property) => property.value)
  );
  if (
    morphology.kind === 'schematic' &&
    (architectureValues.size !== 1 || !architectureValues.has('localized'))
  ) {
    throw new Error(
      `${label}.morphology schematic requires exactly one localized architecture value.`
    );
  }
  if (
    morphology.kind === 'schematic' &&
    (chromosomeGroup !== undefined ||
      features.some(
        (feature) =>
          feature.type === 'centromere-region' ||
          feature.type === 'centromere-boundary' ||
          feature.type === 'centromere-between-members'
      ))
  ) {
    throw new Error(`${label} schematic morphology must remain non-positional.`);
  }
  if (
    morphology.kind === 'unlocalized-centromere' &&
    (record.moleculeClass !== 'whole-chromosome' ||
      architectureValues.size !== 1 ||
      !architectureValues.has('localized'))
  ) {
    throw new Error(
      `${label}.morphology unlocalized-centromere requires one localized whole-chromosome architecture.`
    );
  }
  if (
    morphology.kind === 'unlocalized-centromere' &&
    (chromosomeGroup !== undefined ||
      features.some(
        (feature) =>
          feature.type === 'centromere-region' ||
          feature.type === 'centromere-boundary' ||
          feature.type === 'centromere-between-members'
      ))
  ) {
    throw new Error(`${label} unlocalized-centromere morphology must remain non-positional.`);
  }
  return {
    chrom,
    sourceSeqId,
    lengthBp,
    moleculeClass: record.moleculeClass as ReferenceMoleculeClassV1,
    ...(chromosomeGroup ? { chromosomeGroup } : {}),
    properties,
    features,
    morphology,
    diagnostics,
  };
}

function parseChromosomeGroup(value: unknown, memberLabel: string) {
  if (value === undefined) return undefined;
  const label = `${memberLabel}.chromosomeGroup`;
  const record = requireRecord(value, label);
  assertOnlyKeys(record, ['id', 'segmentIndex', 'orientation'], label);
  if (
    record.orientation !== 'telomere-to-centromere' &&
    record.orientation !== 'centromere-to-telomere'
  ) {
    throw new Error(`${label}.orientation is unsupported.`);
  }
  if (!Number.isSafeInteger(record.segmentIndex) || (record.segmentIndex as number) < 0) {
    throw new Error(`${label}.segmentIndex must be a nonnegative safe integer.`);
  }
  return {
    id: requireSafeId(record.id, `${label}.id`),
    segmentIndex: record.segmentIndex as number,
    orientation: record.orientation,
  } as const;
}

function parseProperties(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
  memberLabel: string
): ReferenceSemanticPropertyV1[] {
  if (!Array.isArray(value)) throw new Error(`${memberLabel}.properties must be an array.`);
  return value.map((raw, index) => {
    const label = `${memberLabel}.properties[${index}]`;
    const record = requireRecord(raw, label);
    assertOnlyKeys(record, ['type', 'value', 'evidenceIds'], label);
    if (record.type !== 'centromere-architecture') throw new Error(`${label}.type is unsupported.`);
    if (
      typeof record.value !== 'string' ||
      !ARCHITECTURES.has(record.value as CentromereArchitectureV1)
    ) {
      throw new Error(`${label}.value is unsupported.`);
    }
    return {
      type: 'centromere-architecture',
      value: record.value as CentromereArchitectureV1,
      evidenceIds: parseEvidenceIds(record.evidenceIds, evidenceIds, label),
    };
  });
}

function parseFeatures(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
  memberLabel: string,
  lengthBp: number
): ReferenceSemanticFeatureV1[] {
  if (!Array.isArray(value)) throw new Error(`${memberLabel}.features must be an array.`);
  return value.map((raw, index) => {
    const label = `${memberLabel}.features[${index}]`;
    const record = requireRecord(raw, label);
    if (record.type === 'centromere-region') {
      assertOnlyKeys(record, ['type', 'interval', 'topology', 'evidenceIds'], label);
      if (
        typeof record.topology !== 'string' ||
        !TOPOLOGIES.has(record.topology as CentromereTopologyV1)
      ) {
        throw new Error(`${label}.topology is unsupported.`);
      }
      return {
        type: 'centromere-region',
        interval: parseInterval(record.interval, `${label}.interval`, lengthBp),
        topology: record.topology as CentromereTopologyV1,
        evidenceIds: parseEvidenceIds(record.evidenceIds, evidenceIds, label),
      };
    }
    if (record.type === 'centromere-between-members') {
      assertOnlyKeys(record, ['type', 'leftChrom', 'rightChrom', 'evidenceIds'], label);
      return {
        type: 'centromere-between-members',
        leftChrom: requireSafeId(record.leftChrom, `${label}.leftChrom`),
        rightChrom: requireSafeId(record.rightChrom, `${label}.rightChrom`),
        evidenceIds: parseEvidenceIds(record.evidenceIds, evidenceIds, label),
      };
    }
    if (record.type === 'centromere-boundary') {
      assertOnlyKeys(record, ['type', 'positionBp', 'topology', 'evidenceIds'], label);
      if (
        typeof record.topology !== 'string' ||
        !TOPOLOGIES.has(record.topology as CentromereTopologyV1)
      ) {
        throw new Error(`${label}.topology is unsupported.`);
      }
      const topology = record.topology as CentromereTopologyV1;
      const positionBp = parseBoundaryPosition(
        record.positionBp,
        topology,
        lengthBp,
        `${label}.positionBp`
      );
      return {
        type: 'centromere-boundary',
        positionBp,
        topology,
        evidenceIds: parseEvidenceIds(record.evidenceIds, evidenceIds, label),
      };
    }
    if (record.type === 'origin-of-replication') {
      assertOnlyKeys(record, ['type', 'interval', 'evidenceIds'], label);
      return {
        type: 'origin-of-replication',
        interval: parseInterval(record.interval, `${label}.interval`, lengthBp),
        evidenceIds: parseEvidenceIds(record.evidenceIds, evidenceIds, label),
      };
    }
    throw new Error(`${label}.type is unsupported.`);
  });
}

function parseMorphology(
  value: unknown,
  memberLabel: string,
  lengthBp: number
): ChromosomeMorphologyV1 {
  const label = `${memberLabel}.morphology`;
  const record = requireRecord(value, label);
  if (record.kind === 'localized') {
    assertOnlyKeys(record, ['kind', 'interval', 'topology'], label);
    if (
      typeof record.topology !== 'string' ||
      !TOPOLOGIES.has(record.topology as CentromereTopologyV1)
    ) {
      throw new Error(`${label}.topology is unsupported.`);
    }
    return {
      kind: 'localized',
      interval: parseInterval(record.interval, `${label}.interval`, lengthBp),
      topology: record.topology as CentromereTopologyV1,
    };
  }
  if (record.kind === 'localized-boundary') {
    assertOnlyKeys(record, ['kind', 'positionBp', 'topology'], label);
    if (
      typeof record.topology !== 'string' ||
      !TOPOLOGIES.has(record.topology as CentromereTopologyV1)
    ) {
      throw new Error(`${label}.topology is unsupported.`);
    }
    const topology = record.topology as CentromereTopologyV1;
    return {
      kind: 'localized-boundary',
      positionBp: parseBoundaryPosition(
        record.positionBp,
        topology,
        lengthBp,
        `${label}.positionBp`
      ),
      topology,
    };
  }
  if (record.kind === 'between-members') {
    assertOnlyKeys(record, ['kind', 'groupId', 'side'], label);
    if (record.side !== 'left' && record.side !== 'right')
      throw new Error(`${label}.side is unsupported.`);
    return {
      kind: 'between-members',
      groupId: requireSafeId(record.groupId, `${label}.groupId`),
      side: record.side,
    };
  }
  if (record.kind === 'schematic') {
    assertOnlyKeys(record, ['kind', 'centromereClass', 'shortArmAt'], label);
    if (
      typeof record.centromereClass !== 'string' ||
      !CYTOGENETIC_CLASSES.has(record.centromereClass as CytogeneticCentromereClassV1)
    ) {
      throw new Error(`${label}.centromereClass is unsupported.`);
    }
    if (
      typeof record.shortArmAt !== 'string' ||
      !CYTOGENETIC_SHORT_ARM_SIDES.has(record.shortArmAt as CytogeneticShortArmSideV1)
    ) {
      throw new Error(`${label}.shortArmAt is unsupported.`);
    }
    return {
      kind: 'schematic',
      centromereClass: record.centromereClass as CytogeneticCentromereClassV1,
      shortArmAt: record.shortArmAt as CytogeneticShortArmSideV1,
    };
  }
  if (record.kind === 'holocentric') {
    assertOnlyKeys(record, ['kind'], label);
    return { kind: 'holocentric' };
  }
  if (record.kind === 'unlocalized-centromere') {
    assertOnlyKeys(record, ['kind'], label);
    return { kind: 'unlocalized-centromere' };
  }
  if (record.kind === 'generic-contig') {
    assertOnlyKeys(record, ['kind', 'reason'], label);
    if (
      typeof record.reason !== 'string' ||
      !GENERIC_REASONS.has(record.reason as GenericDispositionReasonV1)
    ) {
      throw new Error(`${label}.reason is unsupported.`);
    }
    return { kind: 'generic-contig', reason: record.reason as GenericDispositionReasonV1 };
  }
  throw new Error(`${label} kind is unsupported.`);
}

function parseInterval(value: unknown, label: string, lengthBp: number) {
  const record = requireRecord(value, label);
  assertOnlyKeys(record, ['startBp', 'endBp'], label);
  if (
    !Number.isSafeInteger(record.startBp) ||
    !Number.isSafeInteger(record.endBp) ||
    (record.startBp as number) < 0 ||
    (record.endBp as number) <= (record.startBp as number) ||
    (record.endBp as number) > lengthBp
  ) {
    throw new Error(`${label} must be a valid 0-based half-open interval.`);
  }
  return { startBp: record.startBp as number, endBp: record.endBp as number };
}

function parseBoundaryPosition(
  value: unknown,
  topology: CentromereTopologyV1,
  lengthBp: number,
  label: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > lengthBp ||
    (topology === 'internal' && ((value as number) === 0 || (value as number) === lengthBp)) ||
    (topology === 'terminal-start' && (value as number) !== 0) ||
    (topology === 'terminal-end' && (value as number) !== lengthBp)
  ) {
    throw new Error(`${label} must match its centromere topology and member length.`);
  }
  return value as number;
}

function parseEvidenceIds(value: unknown, knownIds: ReadonlySet<string>, label: string): string[] {
  const ids = parseTextArray(value, `${label}.evidenceIds`);
  for (const id of ids) {
    if (!knownIds.has(id)) throw new Error(`${label} cites unknown evidence "${id}".`);
  }
  return [...new Set(ids)].sort();
}

function parseTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => requireText(item, `${label}[${index}]`));
}
