import { createHash } from 'node:crypto';

import {
  assertReferenceSemanticGroupIntegrityV1,
  REFERENCE_SEMANTICS_V1,
  REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
  REFERENCE_SEMANTIC_VOCABULARY_REVISION,
  reconcileReferenceMemberSemantics,
  type ReferenceMoleculeClassV1,
  type ReferenceSemanticSourceV1,
  type ReferenceSemanticsV1,
  type SemanticEvidenceSourceV1,
} from '@waypoint/genome-data';

import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog-types';
import {
  HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1,
  type HostedReferenceSemanticSourceCatalogEntryV1,
} from './hosted-reference-semantic-sources.v1';

export {
  HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1,
  type HostedReferenceSemanticSourceCatalogEntryV1,
};

export const HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1: Readonly<Record<string, string>> =
  Object.freeze({
    hg19: 'hg19',
    mm10: 'mm10',
    susScrHxylV2: 'GCF_054392235.1',
    arsUcd2: 'GCF_002263795.3',
    criGriPicrh1: 'GCF_003668045.3',
    panTro6: 'panTro6',
    medakaHdRr31: 'GCF_053564925.1',
    grcz12ab: 'GCF_052040795.1',
    galGal6: 'GCF_000002315.5',
    canFam6: 'GCF_000002285.5',
    canFam3: 'GCF_000002285.3',
    susScr11: 'GCF_000003025.6',
    bosTau9: 'GCF_002263795.1',
    pomBase: 'GCF_000002945.1',
    tomatoSlmR21: 'GCF_036512215.1',
    irgsp1: 'GCF_001433935.1',
    soybeanV4: 'GCF_000004515.6',
    ntK326: 'GCF_000715075.1',
    kphaffiiGs115: 'GCF_000027005.1',
    kphaffiiCbs7435: 'GCA_000223565.1',
    candidaSC5314: 'GCF_000182965.3',
    anidulansFgscA4: 'GCF_000011425.1',
    pfalciparum3d7: 'GCF_000002765.6',
    agambiaeF1: 'GCF_943734735.2',
    t2tMfa8v11: 'GCF_037993035.2',
    sbicolorNcbiv3: 'GCF_000003195.3',
  });

export interface HostedReferenceGff3SemanticCandidateV1 {
  readonly sourceSeqId: string;
  readonly type: 'centromere' | 'SO:0000577' | 'origin_of_replication' | 'SO:0000296';
  readonly start: number;
  readonly end: number;
}

export interface MatureHostedReferenceSemanticsOptionsV1 {
  readonly assemblyIdentitySha256?: string;
  readonly gff3Candidates?: readonly HostedReferenceGff3SemanticCandidateV1[];
}

export function assertHostedReferenceSemanticCoverageV1(
  hostedCatalog: readonly HostedReferenceCatalogDefinitionV1[],
  semanticCatalog: readonly HostedReferenceSemanticSourceCatalogEntryV1[]
): void {
  const hostedIds = new Set<string>();
  for (const definition of hostedCatalog) {
    if (hostedIds.has(definition.id)) {
      throw new Error(`Hosted reference catalog contains duplicate ID ${definition.id}.`);
    }
    hostedIds.add(definition.id);
  }

  const semanticById = new Map<string, HostedReferenceSemanticSourceCatalogEntryV1>();
  for (const source of semanticCatalog) {
    if (semanticById.has(source.id)) {
      throw new Error(`Hosted semantic catalog contains duplicate ID ${source.id}.`);
    }
    semanticById.set(source.id, source);
  }

  const stale = [...semanticById.keys()].filter((id) => !hostedIds.has(id));
  const staleCompatibility = Object.keys(HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1).filter(
    (id) => !hostedIds.has(id)
  );
  if (stale.length > 0 || staleCompatibility.length > 0) {
    throw new Error(
      `Hosted semantic coverage mismatch (missing: none; stale: ${[...stale, ...staleCompatibility].join(', ')}).`
    );
  }

  for (const definition of hostedCatalog) {
    const source = semanticById.get(definition.id);
    if (!source) {
      continue;
    }
    if (source.assemblyAccession !== definition.provenance.datasetId) {
      throw new Error(
        `Hosted semantic assembly identity mismatch for ${definition.id}: ${source.assemblyAccession} != ${definition.provenance.datasetId}.`
      );
    }
    assertSourceCatalogEntry(definition, source);
  }
}

export function matureHostedReferenceSemanticsV1(
  definition: HostedReferenceCatalogDefinitionV1,
  options: MatureHostedReferenceSemanticsOptionsV1 = {}
): ReferenceSemanticsV1 {
  const source = HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.find(
    (candidate) => candidate.id === definition.id
  );
  if (!source) {
    return maturePreMaturationCompatibilitySemanticsV1(definition, options);
  }
  if (source.assemblyAccession !== definition.provenance.datasetId) {
    throw new Error(`Hosted semantic assembly identity is stale for ${definition.id}.`);
  }
  assertSourceCatalogEntry(definition, source);

  const candidatesBySourceSeqId = groupAndValidateGff3Candidates(
    definition,
    options.gff3Candidates ?? []
  );
  const producerGffEvidence = producerGffEvidenceForCandidates(
    definition,
    source,
    candidatesBySourceSeqId.size > 0
  );
  const evidence =
    producerGffEvidence && !source.evidence.includes(producerGffEvidence)
      ? [...source.evidence, producerGffEvidence]
      : source.evidence;
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  const members = definition.contigs.map((contig) => {
    const specificSources = source.memberSourcesByChrom[contig.chrom];
    const catalogSources: readonly ReferenceSemanticSourceV1[] = specificSources ?? [
      {
        kind: 'reviewed-architecture',
        evidenceId: `${source.id}-assembly-record`,
        value: 'unsupported',
      },
    ];
    const candidateRows = candidatesBySourceSeqId.get(contig.sourceSeqId);
    const producerGffEvidenceId = producerGffEvidence?.id;
    if (candidateRows && !producerGffEvidenceId) {
      throw new Error(`Hosted semantic GFF3 evidence is missing for ${definition.id}.`);
    }
    const sources: readonly ReferenceSemanticSourceV1[] =
      candidateRows && producerGffEvidenceId
        ? [
            ...catalogSources,
            {
              kind: 'gff3-features',
              evidenceId: producerGffEvidenceId,
              records: candidateRows,
            },
          ]
        : catalogSources;
    for (const evidenceId of sourceEvidenceIds(sources)) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `Hosted semantic source ${definition.id}/${contig.chrom} cites unknown evidence ${evidenceId}.`
        );
      }
    }
    return reconcileReferenceMemberSemantics({
      chrom: contig.chrom,
      sourceSeqId: contig.sourceSeqId,
      lengthBp: contig.lengthBp,
      role: contig.role,
      circular: contig.circular,
      moleculeClass: moleculeClassForContig(contig.role, contig.circular, sources),
      sources,
    });
  });
  assertReferenceSemanticGroupIntegrityV1(members);

  return {
    contract: REFERENCE_SEMANTICS_V1,
    assemblyIdentitySha256:
      options.assemblyIdentitySha256 ?? semanticAssemblyBindingSha256(definition),
    vocabularyRevision: REFERENCE_SEMANTIC_VOCABULARY_REVISION,
    adjudicationRevision: REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
    evidence,
    members,
  };
}

export function hasHostedReferenceSemanticDispositionV1(
  definition: HostedReferenceCatalogDefinitionV1
): boolean {
  return (
    HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.some(({ id }) => id === definition.id) ||
    HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1[definition.id] ===
      definition.provenance.datasetId
  );
}

function maturePreMaturationCompatibilitySemanticsV1(
  definition: HostedReferenceCatalogDefinitionV1,
  options: MatureHostedReferenceSemanticsOptionsV1
): ReferenceSemanticsV1 {
  const expectedAssembly = HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1[definition.id];
  if (expectedAssembly && expectedAssembly !== definition.provenance.datasetId) {
    throw new Error(`Hosted semantic compatibility identity is stale for ${definition.id}.`);
  }
  const assemblyAccession = expectedAssembly ?? definition.provenance.datasetId;
  if (!assemblyAccession) {
    throw new Error(`Hosted semantic coverage is missing for ${definition.id}.`);
  }
  const evidenceId = `${definition.id}-pre-maturation-assembly-record`;
  const evidence: SemanticEvidenceSourceV1 = {
    id: evidenceId,
    kind: 'reviewed-assertion',
    provider: definition.provenance.provider,
    assemblyAccession,
    sourceUrl:
      definition.provenance.sourceUrl ??
      `https://www.ncbi.nlm.nih.gov/datasets/genome/${assemblyAccession}/`,
    adapterContract: 'dnaforge-pre-maturation-generic-fallback.v1',
  };
  const members = definition.contigs.map((contig) =>
    reconcileReferenceMemberSemantics({
      chrom: contig.chrom,
      sourceSeqId: contig.sourceSeqId,
      lengthBp: contig.lengthBp,
      role: contig.role,
      circular: contig.circular,
      moleculeClass: moleculeClassForContig(contig.role, contig.circular, []),
      sources: [
        {
          kind: 'reviewed-architecture',
          evidenceId,
          value: 'unsupported',
        },
      ],
    })
  );
  assertReferenceSemanticGroupIntegrityV1(members);
  return {
    contract: REFERENCE_SEMANTICS_V1,
    assemblyIdentitySha256:
      options.assemblyIdentitySha256 ?? semanticAssemblyBindingSha256(definition),
    vocabularyRevision: REFERENCE_SEMANTIC_VOCABULARY_REVISION,
    adjudicationRevision: REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
    evidence: [evidence],
    members,
  };
}

function groupAndValidateGff3Candidates(
  definition: HostedReferenceCatalogDefinitionV1,
  candidates: readonly HostedReferenceGff3SemanticCandidateV1[]
): Map<string, HostedReferenceGff3SemanticCandidateV1[]> {
  const membersBySourceSeqId = new Map(
    definition.contigs.map((contig) => [contig.sourceSeqId, contig] as const)
  );
  const grouped = new Map<string, HostedReferenceGff3SemanticCandidateV1[]>();
  for (const candidate of candidates) {
    const member = membersBySourceSeqId.get(candidate.sourceSeqId);
    if (!member) {
      throw new Error(
        `Hosted semantic candidate references unknown source sequence ${candidate.sourceSeqId}.`
      );
    }
    if (
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start < 1 ||
      candidate.end < candidate.start ||
      candidate.end > member.lengthBp
    ) {
      throw new Error(
        `Hosted semantic candidate for ${candidate.sourceSeqId} has an invalid interval.`
      );
    }
    const rows = grouped.get(candidate.sourceSeqId) ?? [];
    rows.push(candidate);
    grouped.set(candidate.sourceSeqId, rows);
  }
  return grouped;
}

function producerGffEvidenceForCandidates(
  definition: HostedReferenceCatalogDefinitionV1,
  source: HostedReferenceSemanticSourceCatalogEntryV1,
  hasCandidates: boolean
): SemanticEvidenceSourceV1 | undefined {
  if (!hasCandidates) return undefined;
  const existing = source.evidence.find(
    (evidence) =>
      evidence.kind === 'gff3-features' &&
      (!evidence.sha256 || evidence.sha256 === definition.sources.annotations.sha256)
  );
  if (existing) return existing;
  return {
    id: `${definition.id}-producer-gff3`,
    kind: 'gff3-features',
    provider: definition.provenance.provider,
    assemblyAccession: definition.provenance.datasetId,
    sourceUrl:
      definition.provenance.sourceUrl ??
      `https://www.ncbi.nlm.nih.gov/datasets/genome/${definition.provenance.datasetId}/`,
    sha256: definition.sources.annotations.sha256,
    byteLength: definition.sources.annotations.byteLength,
    mediaType: 'application/gzip',
    adapterContract: 'dnaforge-gff3-semantic-adapter.v1',
  };
}

function assertSourceCatalogEntry(
  definition: HostedReferenceCatalogDefinitionV1,
  source: HostedReferenceSemanticSourceCatalogEntryV1
): void {
  if (source.discoveryAudit.contract !== 'dnaforge-semantic-discovery-audit.v1') {
    throw new Error(`Hosted semantic source ${source.id} has an unsupported discovery audit.`);
  }
  if (source.discoveryAudit.assemblyAccession !== source.assemblyAccession) {
    throw new Error(`Hosted semantic source ${source.id} has a stale discovery audit.`);
  }
  if (source.discoveryAudit.reviewedAt.length === 0) {
    throw new Error(`Hosted semantic source ${source.id} has no discovery review date.`);
  }
  const requiredChecks = [
    'producer-annotation',
    'ncbi-feature-table',
    'ncbi-assembly-gaps',
    'ncbi-ideogram',
    'ucsc-cytobands',
    'primary-literature',
    'organism-database',
  ] as const;
  const auditedChecks = new Set(source.discoveryAudit.checks);
  if (
    auditedChecks.size !== source.discoveryAudit.checks.length ||
    requiredChecks.some((check) => !auditedChecks.has(check))
  ) {
    throw new Error(`Hosted semantic source ${source.id} has an incomplete discovery audit.`);
  }
  const eligibleNuclearMembers = definition.contigs.filter(
    (contig) => contig.role === 'assembled-molecule' && !contig.circular
  );
  const resolvedNuclearMembers = eligibleNuclearMembers.filter((contig) =>
    memberSourcesResolveMorphology(source.memberSourcesByChrom[contig.chrom] ?? [])
  );
  if (
    source.discoveryAudit.outcome === 'resolved' &&
    resolvedNuclearMembers.length !== eligibleNuclearMembers.length
  ) {
    throw new Error(`Hosted semantic source ${source.id} claims incomplete resolved coverage.`);
  }
  if (
    source.discoveryAudit.outcome === 'partially-resolved' &&
    (resolvedNuclearMembers.length === 0 ||
      resolvedNuclearMembers.length === eligibleNuclearMembers.length)
  ) {
    throw new Error(`Hosted semantic source ${source.id} has an inconsistent partial audit.`);
  }
  if (
    source.discoveryAudit.outcome === 'unresolved-after-audit' &&
    resolvedNuclearMembers.length !== 0
  ) {
    throw new Error(`Hosted semantic source ${source.id} has an inconsistent unresolved audit.`);
  }
  if (source.evidence.length === 0) {
    throw new Error(`Hosted semantic source ${source.id} has no evidence.`);
  }
  const evidenceIds = new Set<string>();
  for (const evidence of source.evidence) {
    if (evidenceIds.has(evidence.id)) {
      throw new Error(`Hosted semantic source ${source.id} duplicates evidence ${evidence.id}.`);
    }
    evidenceIds.add(evidence.id);
    if (evidence.assemblyAccession !== source.assemblyAccession) {
      throw new Error(`Hosted semantic evidence ${evidence.id} has stale assembly identity.`);
    }
    if (!URL.canParse(evidence.sourceUrl) || !evidence.sourceUrl.startsWith('https://')) {
      throw new Error(`Hosted semantic evidence ${evidence.id} must use an HTTPS source URL.`);
    }
    if (evidence.sha256 && !/^[0-9a-f]{64}$/i.test(evidence.sha256)) {
      throw new Error(`Hosted semantic evidence ${evidence.id} has an invalid SHA-256.`);
    }
    if (
      evidence.byteLength !== undefined &&
      (!Number.isSafeInteger(evidence.byteLength) || evidence.byteLength <= 0)
    ) {
      throw new Error(`Hosted semantic evidence ${evidence.id} has an invalid byte length.`);
    }
  }
  const auditEvidenceIds = new Set(source.discoveryAudit.evidenceIds);
  if (
    auditEvidenceIds.size !== source.discoveryAudit.evidenceIds.length ||
    auditEvidenceIds.size !== evidenceIds.size ||
    source.discoveryAudit.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))
  ) {
    throw new Error(`Hosted semantic source ${source.id} has stale discovery evidence locks.`);
  }

  const contigByChrom = new Map(definition.contigs.map((contig) => [contig.chrom, contig]));
  for (const [chrom, sources] of Object.entries(source.memberSourcesByChrom)) {
    if (!contigByChrom.has(chrom)) {
      throw new Error(`Hosted semantic source ${source.id} references unknown member ${chrom}.`);
    }
    if (sources.length === 0) {
      throw new Error(`Hosted semantic source ${source.id}/${chrom} has no semantic records.`);
    }
    for (const evidenceId of sourceEvidenceIds(sources)) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `Hosted semantic source ${source.id}/${chrom} cites unknown evidence ${evidenceId}.`
        );
      }
    }
  }
}

function memberSourcesResolveMorphology(sources: readonly ReferenceSemanticSourceV1[]): boolean {
  return sources.some((source) => {
    if (source.kind === 'reviewed-chromosome-arm') return true;
    if (source.kind === 'reviewed-centromere-region') return true;
    if (source.kind === 'reviewed-cytogenetic-morphology') return true;
    if (source.kind === 'ncbi-ideogram-arms') return source.records.length > 0;
    if (source.kind === 'reviewed-architecture') return source.value !== 'localized';
    if (source.kind === 'ucsc-cytobands') {
      return source.records.some(({ stain }) => stain === 'acen');
    }
    if (source.kind === 'ncbi-assembly-gaps') {
      return source.records.some(({ gapType }) => gapType === 'centromere');
    }
    if (source.kind === 'gff3-features') {
      return source.records.some(({ type }) => {
        const normalizedType = type.trim().toLowerCase();
        return normalizedType === 'centromere' || normalizedType === 'so:0000577';
      });
    }
    if (source.kind === 'insdc-features') {
      return source.records.some(({ key, locationStatus }) => {
        const normalizedKey = key.trim().toLowerCase();
        return (
          locationStatus === 'exact' &&
          (normalizedKey === 'centromere' || normalizedKey === 'so:0000577')
        );
      });
    }
    return false;
  });
}

function sourceEvidenceIds(sources: readonly ReferenceSemanticSourceV1[]): string[] {
  return sources.map(({ evidenceId }) => evidenceId);
}

function moleculeClassForContig(
  role: HostedReferenceCatalogDefinitionV1['contigs'][number]['role'],
  circular: boolean,
  sources: readonly ReferenceSemanticSourceV1[]
): ReferenceMoleculeClassV1 {
  if (role === 'mitochondrion' || role === 'plastid') return 'organelle';
  if (role === 'unlocalized-scaffold' || role === 'unplaced-scaffold') return 'scaffold';
  if (role !== 'assembled-molecule' || circular) return 'generic-contig';
  return sources.some(({ kind }) => kind === 'reviewed-chromosome-arm')
    ? 'chromosome-arm'
    : 'whole-chromosome';
}

function semanticAssemblyBindingSha256(definition: HostedReferenceCatalogDefinitionV1): string {
  const binding = {
    assemblyAccession: definition.provenance.datasetId,
    members: definition.contigs.map(({ chrom, sourceSeqId, lengthBp, role, circular }) => ({
      chrom,
      sourceSeqId,
      lengthBp,
      role,
      circular,
    })),
  };
  return createHash('sha256')
    .update(`${REFERENCE_SEMANTICS_V1}\0`, 'utf8')
    .update(JSON.stringify(binding), 'utf8')
    .digest('hex');
}
