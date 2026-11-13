import {
  makeIdentityEvidence,
  type IdentityEvidence,
  type ProteinIdentityLedger,
  type StructureIdentity,
} from './protein-identity';
import type {
  ResolverResult,
  ResolverSource,
  StructureDrawerRequest,
} from '../types/structure-drawer';

type UniProtExternalProtein = Extract<
  ProteinIdentityLedger['externalProteins'][number],
  { kind: 'uniprot' }
>;

export function attachResolverIdentityLedger(
  result: ResolverResult,
  request: StructureDrawerRequest
): ResolverResult {
  if (result.proteinIdentity || !request.proteinIdentity) return result;
  return {
    ...result,
    proteinIdentity: buildResolverIdentityLedger(request.proteinIdentity, result, request),
  };
}

function buildResolverIdentityLedger(
  ledger: ProteinIdentityLedger,
  result: ResolverResult,
  request: StructureDrawerRequest
): ProteinIdentityLedger {
  const resolverEvidence = makeResolverEvidence(result, request);
  const validationEvidence =
    result.structure.kind === 'uniprot'
      ? makeIdentityEvidence({
          kind: 'provider_validation',
          source: 'alphafold',
          confidence: 'strong',
          label: 'AlphaFold structure validation',
          details: { accession: result.structure.accession },
        })
      : null;
  const evidence = validationEvidence ? [resolverEvidence, validationEvidence] : [resolverEvidence];
  const structures = structureIdentitiesForResult(
    result,
    evidence.map((item) => item.id)
  );
  const externalProtein = externalProteinForResult(
    result,
    evidence.map((item) => item.id)
  );
  const resolutionSet =
    externalProtein && result.structure.kind === 'uniprot'
      ? [
          {
            kind: 'protein_resolution_set' as const,
            queryMd5: ledger.sequence.digests.md5 ?? '',
            selectedExternalProteinId: externalProtein.id,
            matches: [
              {
                id: externalProtein.id,
                kind: 'uniprot' as const,
                accession: externalProtein.accession,
                providerIdentityKey: externalProtein.providerIdentityKey,
                reviewed: externalProtein.reviewed,
                match: externalProtein.match,
                sequenceIdentity: externalProtein.sequenceIdentity,
                checksumMd5: externalProtein.checksumMd5,
                rank: 0,
                rankReasons: externalProtein.rankReasons ?? [result.source],
                selected: true,
                evidenceIds: externalProtein.evidenceIds,
              },
            ],
            evidenceIds: externalProtein.evidenceIds,
          },
        ]
      : [];

  return {
    ...ledger,
    externalProteins: externalProtein
      ? [
          ...ledger.externalProteins.filter((protein) => protein.id !== externalProtein.id),
          externalProtein,
        ]
      : ledger.externalProteins,
    resolutionSets: [...ledger.resolutionSets, ...resolutionSet],
    structures: mergeStructureIdentities(ledger.structures, structures),
    evidence: dedupeEvidence([...ledger.evidence, ...evidence]),
  };
}

function makeResolverEvidence(
  result: ResolverResult,
  request: StructureDrawerRequest
): IdentityEvidence {
  const source = resolverEvidenceSource(result.source);
  return makeIdentityEvidence({
    kind: resolverEvidenceKind(result.source),
    source,
    confidence:
      result.source === 'gene_organism'
        ? 'heuristic'
        : result.source === 'gene_sequence_overlap'
          ? 'strong'
          : 'authoritative',
    label: resolverEvidenceLabel(result.source),
    details: {
      resolverSource: result.source,
      identity: result.identity,
      pdbId: result.structure.kind === 'pdb' ? result.structure.pdbId : undefined,
      accession: result.structure.kind === 'uniprot' ? result.structure.accession : undefined,
      proteinId: request.hints.proteinId,
      locusTag: request.hints.locusTag,
      geneName: request.hints.geneName,
      taxonId: request.hints.taxonId,
    },
  });
}

function resolverEvidenceKind(resultSource: ResolverSource): IdentityEvidence['kind'] {
  if (resultSource === 'protein_id') return 'genbank_protein_id';
  if (resultSource === 'locus_tag') return 'genbank_locus_tag';
  if (resultSource === 'gene_organism' || resultSource === 'gene_sequence_overlap') {
    return 'genbank_gene_name';
  }
  return 'genbank_db_xref';
}

function resolverEvidenceSource(resultSource: ResolverSource): IdentityEvidence['source'] {
  return resultSource === 'gene_organism' || resultSource === 'gene_sequence_overlap'
    ? 'waypoint'
    : 'genbank';
}

function resolverEvidenceLabel(resultSource: ResolverSource): string {
  switch (resultSource) {
    case 'saved_coordinates':
      return 'Saved coordinate snapshot';
    case 'computed_coordinates':
      return 'Computed coordinate model';
    case 'pdb_xref':
      return 'GenBank PDB cross-reference';
    case 'uniprot_xref':
      return 'GenBank UniProt cross-reference';
    case 'protein_id':
      return 'GenBank protein_id cross-reference';
    case 'refseq_xref':
      return 'GenBank RefSeq cross-reference';
    case 'geneid_xref':
      return 'GenBank GeneID cross-reference';
    case 'locus_tag':
      return 'GenBank locus_tag lookup';
    case 'gene_sequence_overlap':
      return 'Gene lookup with sequence-overlap validation';
    case 'gene_organism':
      return 'Gene and organism lookup';
    case 'protein_sequence':
      return 'Protein sequence resolver';
    case 'rcsb_sequence':
      return 'RCSB polymer sequence resolver';
  }
}

function externalProteinForResult(
  result: ResolverResult,
  evidenceIds: string[]
): UniProtExternalProtein | null {
  if (result.structure.kind !== 'uniprot') return null;
  const accession = result.structure.accession.toUpperCase();
  return {
    kind: 'uniprot',
    id: `uniprot:${accession}`,
    accession,
    providerIdentityKey: accession,
    match:
      result.source === 'gene_organism' || result.source === 'gene_sequence_overlap'
        ? 'name_search'
        : 'xref',
    sequenceIdentity: result.identity,
    rankReasons: [result.source],
    evidenceIds,
  };
}

function structureIdentitiesForResult(
  result: ResolverResult,
  evidenceIds: string[]
): StructureIdentity[] {
  if (result.structure.kind === 'pdb') {
    const pdbId = result.structure.pdbId.toUpperCase();
    const providerIdentityKey = result.structure.providerIdentityKey ?? `RCSB:${pdbId}:ENTRY`;
    return [
      {
        kind: 'rcsb',
        id: providerIdentityKey,
        pdbId,
        providerIdentityKey,
        pdbEntityId: result.structure.pdbEntityId,
        labelAsymIds: result.structure.labelAsymIds,
        authAsymIds: result.structure.authAsymIds,
        assemblyId: result.structure.assemblyId,
        source: result.source === 'pdb_xref' ? 'direct_xref' : 'uniprot_xref',
        sequenceIdentity: result.identity,
        evidenceIds,
      },
    ];
  }
  if (result.structure.kind === 'uniprot') {
    const accession = result.structure.accession.toUpperCase();
    const fragment = result.structure.fragment ?? 'F1';
    const version = result.structure.version ?? 'LATEST';
    const providerIdentityKey =
      result.structure.providerIdentityKey ?? `AF:${accession}:${fragment}:${version}`;
    return [
      {
        kind: 'alphafold',
        id: providerIdentityKey,
        accession,
        providerIdentityKey,
        fragment,
        version,
        modelId: result.structure.modelId,
        source: 'provider_validation',
        evidenceIds,
      },
    ];
  }
  return [];
}

function dedupeEvidence(items: IdentityEvidence[]): IdentityEvidence[] {
  const byId = new Map<string, IdentityEvidence>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeStructureIdentities(
  existing: ProteinIdentityLedger['structures'],
  next: StructureIdentity[]
): ProteinIdentityLedger['structures'] {
  const byId = new Map<string, StructureIdentity>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}
