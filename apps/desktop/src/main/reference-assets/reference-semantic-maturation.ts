import {
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
import type { DnaIndexerAssemblySemanticCandidate } from './prepared-reference-assembly-materializer';
import type { LoadedReferencePreparationManifestV2 } from './reference-preparation-manifest-v2';
import { matureHostedReferenceSemanticsV1 } from './reference-semantic-source-catalog';

const SHA256 = /^[0-9a-f]{64}$/i;

export function matureHostedPreparedReferenceSemanticsV1(
  definition: HostedReferenceCatalogDefinitionV1,
  assemblyIdentitySha256: string,
  candidates: readonly DnaIndexerAssemblySemanticCandidate[]
): ReferenceSemanticsV1 {
  if (!SHA256.test(assemblyIdentitySha256)) {
    throw new Error('Hosted semantic maturation requires an exact assembly identity SHA-256.');
  }
  return matureHostedReferenceSemanticsV1(definition, {
    assemblyIdentitySha256: assemblyIdentitySha256.toLowerCase(),
    gff3Candidates: candidates,
  });
}

export function validateHostedReferenceSemanticMaturationV1(
  definition: HostedReferenceCatalogDefinitionV1,
  candidates: readonly DnaIndexerAssemblySemanticCandidate[]
): ReferenceSemanticsV1 {
  return matureHostedReferenceSemanticsV1(definition, { gff3Candidates: candidates });
}

export function maturePreparedReferenceSemanticsV1(
  preparation: LoadedReferencePreparationManifestV2,
  candidates: readonly DnaIndexerAssemblySemanticCandidate[]
): ReferenceSemanticsV1 {
  const candidateBySourceSeqId = new Map<string, DnaIndexerAssemblySemanticCandidate[]>();
  for (const candidate of candidates) {
    const rows = candidateBySourceSeqId.get(candidate.sourceSeqId) ?? [];
    rows.push(candidate);
    candidateBySourceSeqId.set(candidate.sourceSeqId, rows);
  }
  const sourceUrl = preparation.provenance.sourceUrl;
  const canAdmitGffEvidence =
    preparation.source.gffSha256 !== undefined &&
    sourceUrl !== undefined &&
    URL.canParse(sourceUrl) &&
    sourceUrl.startsWith('https://');
  const gffEvidence: SemanticEvidenceSourceV1 | undefined = canAdmitGffEvidence
    ? {
        id: 'producer-gff3',
        kind: 'gff3-features',
        provider: preparation.provenance.provider,
        assemblyAccession: preparation.provenance.datasetId,
        sourceUrl,
        sha256: preparation.source.gffSha256,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-gff3-semantic-adapter.v1',
      }
    : undefined;
  const members = preparation.entry.members.map((member) => {
    const sourceSeqId = member.importSource?.sourceSeqId;
    if (!sourceSeqId || member.lengthBp === undefined) {
      throw new Error(`Prepared semantic maturation member ${member.chrom} is incomplete.`);
    }
    const rows = candidateBySourceSeqId.get(sourceSeqId);
    const sources: readonly ReferenceSemanticSourceV1[] =
      rows && gffEvidence
        ? [{ kind: 'gff3-features', evidenceId: gffEvidence.id, records: rows }]
        : [];
    return reconcileReferenceMemberSemantics({
      chrom: member.chrom,
      sourceSeqId,
      lengthBp: member.lengthBp,
      role: member.role,
      circular: member.circular,
      moleculeClass: moleculeClass(member.role, member.circular),
      sources,
    });
  });
  return {
    contract: REFERENCE_SEMANTICS_V1,
    assemblyIdentitySha256: preparation.assemblyIdentity.sha256,
    vocabularyRevision: REFERENCE_SEMANTIC_VOCABULARY_REVISION,
    adjudicationRevision: REFERENCE_SEMANTIC_ADJUDICATION_REVISION,
    evidence: gffEvidence ? [gffEvidence] : [],
    members,
  };
}

function moleculeClass(
  role: LoadedReferencePreparationManifestV2['entry']['members'][number]['role'],
  circular: boolean | undefined
): ReferenceMoleculeClassV1 {
  if (role === 'mitochondrion' || role === 'plastid') return 'organelle';
  if (role === 'unlocalized-scaffold' || role === 'unplaced-scaffold') return 'scaffold';
  if (role !== 'assembled-molecule' || circular === true) return 'generic-contig';
  return 'whole-chromosome';
}
